/**
 * server.ts
 *
 * Standalone HTTP server for BonsAIDE.
 *
 * Replaces the VS Code extension host with a plain Node.js HTTP server so the
 * tool can run outside of VS Code.  Communication with the browser reuses the
 * exact same message protocol as the VS Code webview, but transported over:
 *  - Server-Sent Events (GET /events)  for server → browser messages
 *  - HTTP POST /message                for browser → server messages
 *  - GET /export                       to download the current state as JSON
 *  - POST /import                      to upload a previously-exported JSON file
 *
 * Usage (after compiling with `npm run compile-server`):
 *   node out-server/server.js [port]
 *
 * Default port: 3000  (override with the PORT env var or a CLI argument).
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeLeafSimilaritiesForCode, SimilarityBranch, SimilarityNode } from './similarity';
import { analyzeCodeWithLizardServer } from './lizard-server';

// ---------------------------------------------------------------------------
// Types  (mirrors extension.ts)
// ---------------------------------------------------------------------------

type LizardMetrics = any;

interface CodeNode {
  id: number;
  prompt: string;
  code: string;
  parentId: number | null;
  children: CodeNode[];
  durationMs?: number;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  reasoning?: string;
  lizard?: LizardMetrics;
  isLeaf: boolean;
  activity: string;
}

interface Branch {
  id: string;
  name: string;
  nodes: CodeNode[];
}

// ---------------------------------------------------------------------------
// In-memory state  (equivalent to VS Code globalState + module-level vars)
// ---------------------------------------------------------------------------

let branches: Branch[] = [];
let activeBranchId: string | null = null;
let currentId = 0;
let selectedNodeId: number | null = null;
let baseUrl: string = process.env.BONSAI_LM_URL ?? 'localhost:1234/v1';
let LLMmodel: string = process.env.BONSAI_LM_MODEL ?? 'qwen/qwen2.5-coder-3b-instruct';
let bonsaiLogs: string[] = [];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function bonsaiLog(...args: any[]) {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}`;
  bonsaiLogs.push(line);
  console.log(line);
}

function getBonsaiLogs(): string[] { return bonsaiLogs; }

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) broadcast
// ---------------------------------------------------------------------------

const sseClients = new Set<http.ServerResponse>();

function broadcast(message: object): void {
  const data = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch { sseClients.delete(client); }
  }
}

// ---------------------------------------------------------------------------
// Graph / branch helpers  (mirrors extension.ts)
// ---------------------------------------------------------------------------

function getActivityColor(activity?: string): string {
  switch (activity) {
    case 'fix_with_context':    return '#834632';
    case 'fix_without_context': return '#83675e';
    case 'gen_tests':           return '#970071';
    case 'refactor':            return '#006d18';
    case 'exceptions':          return '#00b0b6';
    default:                    return '#777777';
  }
}

function createGraphFromBranch(branch?: Branch): { nodes: object[]; edges: object[] } {
  if (!branch) { return { nodes: [], edges: [] }; }

  const metricNodes = branch.nodes.filter(n => n.parentId !== null);
  const completionVals = metricNodes.map(n => n.tokens?.completion ?? 0);
  const minTokens = completionVals.length ? Math.min(...completionVals) : 0;
  const maxTokens = completionVals.length ? Math.max(...completionVals) : 0;
  const durationVals = metricNodes.map(n => n.durationMs ?? 0);
  const minDuration = durationVals.length ? Math.min(...durationVals) : 0;
  const maxDuration = durationVals.length ? Math.max(...durationVals) : 0;

  return {
    nodes: branch.nodes.map(s => {
      const tokens = s.tokens?.completion ?? 0;
      const size = (minTokens === maxTokens)
        ? 80
        : 40 + ((tokens - minTokens) / (maxTokens - minTokens)) * (120 - 40);

      const duration = s.durationMs ?? 0;
      const t = (maxDuration === minDuration)
        ? 0
        : (duration - minDuration) / (maxDuration - minDuration);
      const r = Math.round(255 * t);
      const b = Math.round(255 * (1 - t));
      const timeColor = `rgb(${r},0,${b})`;
      const activityColor = getActivityColor(s.activity);

      return {
        data: {
          id: 'n' + s.id, label: '#' + s.id,
          code: s.code, prompt: s.prompt, activity: s.activity, reasoning: s.reasoning,
          size: Math.round(size), activityColor, timeColor, duration, durationNorm: t
        }
      };
    }),
    edges: branch.nodes
      .filter(n => n.parentId !== null)
      .map(n => ({ data: { source: 'n' + n.parentId, target: 'n' + n.id } }))
  };
}

function recomputeLeafFlags(branch: Branch): void {
  const childCount = new Map<number, number>();
  for (const n of branch.nodes) { childCount.set(n.id, 0); }
  for (const n of branch.nodes) {
    if (n.parentId != null && childCount.has(n.parentId)) {
      childCount.set(n.parentId, (childCount.get(n.parentId) || 0) + 1);
    }
  }
  for (const n of branch.nodes) {
    n.isLeaf = (childCount.get(n.id) || 0) === 0;
  }
}

// ---------------------------------------------------------------------------
// LLM – fetchFromLocalLMStudio  (mirrors extension.ts)
// ---------------------------------------------------------------------------

async function fetchFromLocalLMStudio(
  prompt: string,
  code: string
): Promise<{ content: string; reasoning: string; tokens: { prompt: number; completion: number; total: number } }> {
  const systemPrompt = `
You are a code-generation assistant. You MUST return output using ONLY the two XML tags below, with nothing before or after them. Absolutely NO markdown, NO backticks, NO prose outside the tags.

### REQUIRED SCHEMA (use exactly these tags and order):
<code>
[ONLY the final code here — no comments, no prose]
</code>
<reasoning>
[ONLY the explanation here — plain text, no code fences]
</reasoning>

### RULES (strict):
1) Output MUST start with "<code>" on the first line and end with "</reasoning>" on the last line.
2) No additional tags, headers, or text outside the two blocks.
3) Put ALL executable or final code inside <code>. Do NOT include explanations, comments, or markdown there.
4) Put ALL explanation inside <reasoning>. Do NOT include code fences or pseudo-tags there.
5) Do NOT wrap anything in triple backticks.
6) If unsure, still produce both tags (they may be empty), but NEVER add anything else.

### GOOD EXAMPLE
<code>
print("Hello world")
</code>
<reasoning>
This prints "Hello world" in Python.
</reasoning>

### BAD EXAMPLES (DO NOT DO):
- \`\`\`python ...\`\`\`
- Any text before <code> or after </reasoning>
- Mixing code and explanation inside the same tag

Validate your output against the RULES before responding.
  `.trim();

  const fullPrompt = `${prompt}\n${code}`;
  const BASE_URL = baseUrl || 'localhost:1234/v1';
  const MODEL = LLMmodel || 'qwen/qwen2.5-coder-3b-instruct';
  const API_KEY = 'lm-studio';

  async function requestLLM(): Promise<{ response: string; usage?: any }> {
    const res = await fetch(`http://${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `User prompt:\n${fullPrompt}` },
        ],
        temperature: 0.8,
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }

    const json: any = await res.json();
    const output: string =
      json?.choices?.[0]?.message?.content?.trim?.() ??
      json?.choices?.[0]?.text?.trim?.() ?? '';
    return { response: output, usage: json?.usage };
  }

  while (true) {
    try {
      const data = await requestLLM();
      const output = data.response;
      const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
      const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
      const content = codeMatch?.[1]?.trim() ?? '';
      const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

      if (content || reasoning) {
        const usage = data.usage;
        const promptTokens = usage?.prompt_tokens ?? 0;
        const completionTokens =
          usage?.completion_tokens ?? output.split(/\s+/).filter(Boolean).length;
        const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
        return { content, reasoning, tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens } };
      } else {
        console.warn('No <code>/<reasoning> tags found in LLM response. Retrying...');
      }
    } catch (err) {
      console.warn('Error during LLM fetch/parsing:', (err as Error).message, 'Retrying...');
    }
    await new Promise(res => setTimeout(res, 1000));
  }
}

// ---------------------------------------------------------------------------
// LLM – processAgentMdWithLLM (processes Agent.md content to generate code)
// ---------------------------------------------------------------------------

async function processAgentMdWithLLM(
  agentMdContent: string
): Promise<{ content: string; reasoning: string }> {
  const systemPrompt = `
You are an expert code generation assistant. You will be given an Agent.md file that describes a task or specification.
Your job is to analyze the Agent.md content and generate the appropriate source code that implements the described task.

You MUST return output using ONLY the two XML tags below, with nothing before or after them. Absolutely NO markdown, NO backticks, NO prose outside the tags.

### REQUIRED SCHEMA (use exactly these tags and order):
<code>
[ONLY the final generated source code here — no comments explaining the code, no prose]
</code>
<reasoning>
[ONLY the explanation of what the code does and how it implements the Agent.md specification — plain text, no code fences]
</reasoning>

### RULES (strict):
1) Output MUST start with "<code>" on the first line and end with "</reasoning>" on the last line.
2) No additional tags, headers, or text outside the two blocks.
3) Put ALL generated source code inside <code>. Do NOT include explanations or markdown there.
4) Put ALL explanation inside <reasoning>. Do NOT include code fences there.
5) Do NOT wrap anything in triple backticks.
6) Generate complete, working code that implements the specification from the Agent.md file.

Validate your output against the RULES before responding.
  `.trim();

  const BASE_URL = baseUrl || 'localhost:1234/v1';
  const MODEL = LLMmodel || 'qwen/qwen2.5-coder-3b-instruct';
  const API_KEY = 'lm-studio';

  async function requestLLM(): Promise<{ response: string; usage?: any }> {
    const res = await fetch(`http://${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate source code based on this Agent.md specification:\n\n${agentMdContent}` },
        ],
        temperature: 0.7,
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }

    const json: any = await res.json();
    const output: string =
      json?.choices?.[0]?.message?.content?.trim?.() ??
      json?.choices?.[0]?.text?.trim?.() ?? '';
    return { response: output, usage: json?.usage };
  }

  // Try up to 3 times to get a valid response
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await requestLLM();
      const output = data.response;
      const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
      const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
      const content = codeMatch?.[1]?.trim() ?? '';
      const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

      if (content) {
        return { content, reasoning };
      } else {
        console.warn('No <code> block found in LLM response. Retrying...');
      }
    } catch (err) {
      console.warn('Error during Agent.md processing:', (err as Error).message);
      if (attempt === 2) throw err; // Re-throw on last attempt
    }
    await new Promise(res => setTimeout(res, 1000));
  }

  throw new Error('Failed to generate code from Agent.md after multiple attempts');
}

// ---------------------------------------------------------------------------
// Initialise a fresh Bonsai with a root placeholder
// ---------------------------------------------------------------------------

function initFreshBonsai(): void {
  const initialNode: CodeNode = {
    id: ++currentId,
    prompt: 'Initial code',
    code: '# Paste or type your code here, then select this node and run an activity.',
    parentId: null,
    children: [],
    durationMs: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    isLeaf: true,
    activity: 'initial'
  };
  const defaultBranch: Branch = { id: 'main', name: 'Main', nodes: [initialNode] };
  branches = [defaultBranch];
  activeBranchId = 'main';
  bonsaiLog('Initialised fresh Bonsai with root node #', currentId);
}

// ---------------------------------------------------------------------------
// Message handler  (mirrors panel.webview.onDidReceiveMessage in extension.ts)
// ---------------------------------------------------------------------------

async function handleMessage(message: any): Promise<void> {
  if (message.command === 'trim') {
    const branch = branches.find(b => b.id === activeBranchId);
    if (!branch) { return; }
    const base = branch.nodes.find(n => n.id === message.id);
    if (!base) { return; }

    const toDelete = new Set<number>([base.id]);
    const collect = (node: CodeNode) => {
      for (const child of branch.nodes.filter(n => n.parentId === node.id)) {
        toDelete.add(child.id);
        collect(child);
      }
    };
    collect(base);

    branch.nodes = branch.nodes.filter(n => !toDelete.has(n.id));
    if (selectedNodeId != null && toDelete.has(selectedNodeId)) {
      selectedNodeId = null;
      broadcast({ command: 'leafSimilarities', node: null, similarities: [] });
    }
    recomputeLeafFlags(branch);
    broadcast({ command: 'renderGraph', graph: createGraphFromBranch(branch) });
    bonsaiLog(`Trimmed ${toDelete.size} nodes starting from #${base.id}`);
    return;
  }

  if (message.command === 'exportJSON') {
    // Handled by GET /export – nothing to do here
    return;
  }

  if (message.command === 'importJSON') {
    // The 'content' field carries the raw text of the uploaded JSON file
    try {
      const payload = JSON.parse(message.content as string);
      if (!payload || payload.schema !== 'bonsai.v1') {
        throw new Error('Invalid schema. Expected "bonsai.v1".');
      }
      if (!Array.isArray(payload.branches)) {
        throw new Error('Invalid file: "branches" must be an array.');
      }

      const importedBranches: Branch[] = payload.branches.map((b: any) => ({
        id: String(b.id ?? 'main'),
        name: String(b.name ?? 'Main'),
        nodes: Array.isArray(b.nodes) ? b.nodes.map((n: any) => ({
          id: Number(n.id),
          prompt: String(n.prompt ?? ''),
          code: String(n.code ?? ''),
          parentId: (n.parentId === null || n.parentId === undefined) ? null : Number(n.parentId),
          children: [],
          durationMs: typeof n.durationMs === 'number' ? n.durationMs : 0,
          tokens: n.tokens ?? { prompt: 0, completion: 0, total: 0 },
          reasoning: typeof n.reasoning === 'string' ? n.reasoning : undefined,
          lizard: n.lizard,
          isLeaf: Boolean(n.isLeaf),
          activity: String(n.activity ?? 'other')
        })) : []
      }));

      const importedActiveId: string | null =
        (typeof payload.activeBranchId === 'string' ? payload.activeBranchId : null)
        ?? (importedBranches[0]?.id ?? null);

      for (const br of importedBranches) { recomputeLeafFlags(br); }

      const allNodeIds = importedBranches.flatMap(b => b.nodes.map(n => n.id));
      currentId = allNodeIds.length ? Math.max(...allNodeIds) : 0;

      branches = importedBranches;
      activeBranchId = importedActiveId;
      selectedNodeId = null;

      const activeBranch = branches.find(b => b.id === activeBranchId) ?? branches[0];
      broadcast({ command: 'renderGraph', graph: createGraphFromBranch(activeBranch) });
      broadcast({ command: 'historyUpdate', history: activeBranch?.nodes ?? [] });
      broadcast({ command: 'urlmodelUpdate', baseUrl, LLMmodel });

      const firstCode = activeBranch?.nodes?.[0]?.code ?? '// Imported Bonsai';
      broadcast({ command: 'setInitialCode', code: firstCode });
      broadcast({ command: 'setActivityFlow', initialDone: true });
      bonsaiLog('Bonsai imported successfully');
    } catch (err: any) {
      broadcast({ command: 'loading', text: `Import failed: ${err?.message || err}` });
    }
    return;
  }

  if (message.command === 'unselectNode') {
    selectedNodeId = null;
    return;
  }

  if (message.command === 'selectNode') {
    selectedNodeId = message.id;
    bonsaiLog('Node selected:', selectedNodeId);

    const branch = branches.find(b => b.id === activeBranchId);
    if (!branch) { return; }
    const node = branch.nodes.find(n => n.id === selectedNodeId);
    if (!node) { return; }

    const isRoot = node.parentId === null;
    broadcast({ command: 'setActivityFlow', initialDone: !isRoot });

    if (node.isLeaf) {
      try {
        const sBranch: SimilarityBranch = {
          nodes: branch.nodes.map(n => ({ id: n.id, code: n.code, isLeaf: n.isLeaf } as SimilarityNode))
        };
        const sNode: SimilarityNode = { id: node.id, code: node.code, isLeaf: node.isLeaf };
        const similarities = computeLeafSimilaritiesForCode(sBranch, sNode);
        broadcast({ command: 'leafSimilarities', node, similarities });
      } catch (e: any) {
        console.error('Similarity computation failed:', e?.message || e);
      }
    } else {
      broadcast({ command: 'leafSimilarities', node, similarities: [] });
    }
    return;
  }

  if (message.command === 'generate') {
    const selectedNodeIdForPrompt = selectedNodeId;
    let code: string = message.code;
    baseUrl = message.baseUrl || baseUrl;
    LLMmodel = message.model || LLMmodel;

    if (selectedNodeIdForPrompt == null) {
      broadcast({ command: 'loading', text: 'Please SELECT A NODE before applying an activity' });
      return;
    }

    broadcast({ command: 'loading', text: 'Generating...' });

    try {
      const versionCount: number = message.versionCount ?? 1;
      const newNodes: CodeNode[] = [];

      bonsaiLog('Generating branches from #', selectedNodeIdForPrompt, 'num branches:', versionCount);

      for (let i = 0; i < versionCount; i++) {
        const currentCount = i + 1;
        bonsaiLog('Generating version', currentCount, 'of', versionCount);
        broadcast({ command: 'loading', text: `Generating branch ${currentCount} of ${versionCount}...` });

        const start = performance.now();
        const { content: result, reasoning, tokens } = await fetchFromLocalLMStudio(message.prompt, code);
        const duration = performance.now() - start;

        bonsaiLog(`Version ${i + 1} generated in ${duration.toFixed(2)} ms`);

        let lizardMetrics: LizardMetrics | undefined;
        try {
          lizardMetrics = await analyzeCodeWithLizardServer(result, `node-${currentId + 1}`, '.txt');
        } catch { /* ignore */ }

        newNodes.push({
          id: ++currentId,
          prompt: message.prompt,
          code: result,
          parentId: selectedNodeIdForPrompt,
          children: [],
          durationMs: Math.round(duration),
          tokens,
          reasoning,
          lizard: lizardMetrics,
          isLeaf: true,
          activity: message.activity || 'custom'
        });

        bonsaiLog(`Node #${currentId} created (parent #${selectedNodeIdForPrompt}), activity: ${message.activity}`);

        if (selectedNodeIdForPrompt != null) {
          const branch = branches.find(b => b.id === activeBranchId);
          const parent = branch?.nodes.find(n => n.id === selectedNodeIdForPrompt);
          if (parent) { parent.isLeaf = false; }
        }
      }

      const branch = branches.find(b => b.id === activeBranchId);
      if (branch) { branch.nodes.push(...newNodes); }

      broadcast({ command: 'historyUpdate', history: branch?.nodes ?? [] });
      broadcast({ command: 'renderGraph', graph: createGraphFromBranch(branch) });
    } catch (err: any) {
      broadcast({ command: 'loading', text: 'ERROR!: ' + err.message });
    }
    return;
  }

  if (message.command === 'updateConfig') {
    if (message.baseUrl) { baseUrl = message.baseUrl; }
    if (message.model) { LLMmodel = message.model; }
    bonsaiLog('Config updated – baseUrl:', baseUrl, 'model:', LLMmodel);
    return;
  }

  if (message.command === 'testConnection') {
    const testUrl = message.baseUrl || baseUrl;
    const testModel = message.model || LLMmodel;
    bonsaiLog('Testing connection to:', testUrl, 'with model:', testModel);
    broadcast({ command: 'loading', text: 'Testing connection...' });

    try {
      // Validate URL format (should be host:port/path pattern)
      if (!/^[\w.-]+(:\d+)?(\/[\w./]*)?$/.test(testUrl)) {
        throw new Error('Invalid URL format. Expected format: host:port/path (e.g., localhost:1234/v1)');
      }

      // First, test basic connectivity using the /models endpoint (lightweight, no model execution)
      const modelsRes = await fetch(`http://${testUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer lm-studio',
        },
      });

      if (!modelsRes.ok) {
        const text = await modelsRes.text().catch(() => '');
        throw new Error(`Server not reachable: HTTP ${modelsRes.status} ${modelsRes.statusText}${text ? ` - ${text}` : ''}`);
      }

      const modelsJson: any = await modelsRes.json();
      const availableModels = modelsJson?.data?.map((m: any) => m.id) ?? [];
      
      // Check if the specified model is available
      let modelStatus: string;
      if (availableModels.length === 0) {
        modelStatus = `Warning: No models reported by server. Make sure "${testModel}" is loaded.`;
      } else if (availableModels.includes(testModel)) {
        modelStatus = `Model "${testModel}" is available.`;
      } else {
        modelStatus = `Warning: Model "${testModel}" not found. Available: ${availableModels.join(', ')}`;
      }

      bonsaiLog('Connection test successful. Server reachable.', modelStatus);
      broadcast({ 
        command: 'connectionTestResult', 
        success: true, 
        message: `✓ Connected to LLM server! ${modelStatus}` 
      });
    } catch (err: any) {
      bonsaiLog('Connection test failed:', err?.message || err);
      broadcast({ command: 'connectionTestResult', success: false, message: `✗ Connection failed: ${err?.message || err}` });
    }
    return;
  }

  if (message.command === 'processAgentMd') {
    const agentMdContent = message.content || '';
    baseUrl = message.baseUrl || baseUrl;
    LLMmodel = message.model || LLMmodel;

    bonsaiLog('Processing Agent.md content, length:', agentMdContent.length);
    broadcast({ command: 'loading', text: 'Verifying LLM connection...' });

    try {
      // First, verify LLM connection before processing
      bonsaiLog('Verifying LLM connection before processing Agent.md');
      if (!/^[\w.-]+(:\d+)?(\/[\w./]*)?$/.test(baseUrl)) {
        throw new Error('Invalid URL format. Expected format: host:port/path (e.g., localhost:1234/v1)');
      }

      const modelsRes = await fetch(`http://${baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer lm-studio'
        },
        signal: AbortSignal.timeout(5000)
      });

      if (!modelsRes.ok) {
        throw new Error(`LLM server returned ${modelsRes.status}: ${modelsRes.statusText}`);
      }

      const modelsData: any = await modelsRes.json();
      const availableModels = modelsData?.data?.map((m: any) => m.id) ?? [];
      bonsaiLog('Connection verified. Available models:', availableModels.length);

      // Now process Agent.md
      broadcast({ command: 'loading', text: 'Processing Agent.md...' });
      const { content: generatedCode, reasoning } = await processAgentMdWithLLM(agentMdContent);
      bonsaiLog('Agent.md processed successfully. Generated code length:', generatedCode.length);
      broadcast({
        command: 'agentMdProcessResult',
        success: true,
        code: generatedCode,
        reasoning
      });
    } catch (err: any) {
      bonsaiLog('Agent.md processing failed:', err?.message || err);
      broadcast({
        command: 'agentMdProcessResult',
        success: false,
        message: err?.message || 'Processing failed'
      });
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// HTTP request router
// ---------------------------------------------------------------------------

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

/** Root of the standalone web frontend (client/ directory) */
const CLIENT_DIR = path.join(__dirname, '..', 'client');

/** Map common file extensions to MIME types */
function mimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.js':   return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json';
    case '.png':  return 'image/png';
    case '.svg':  return 'image/svg+xml';
    default:      return 'application/octet-stream';
  }
}

function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // CORS – allow any origin in development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // -----------------------------------------------------------------------
    // GET /  →  serve the standalone web frontend (client/index.html)
    // -----------------------------------------------------------------------
    if (method === 'GET' && url === '/') {
      serveFile(res, path.join(CLIENT_DIR, 'index.html'), 'text/html; charset=utf-8');
      return;
    }

    // -----------------------------------------------------------------------
    // GET /css/* and /js/*  →  static assets for the web frontend
    // -----------------------------------------------------------------------
    if (method === 'GET' && (url.startsWith('/css/') || url.startsWith('/js/'))) {
      // Prevent path traversal: resolve both paths and verify containment
      const filePath = path.resolve(CLIENT_DIR, url.slice(1));
      const resolvedClientDir = path.resolve(CLIENT_DIR);
      if (!filePath.startsWith(resolvedClientDir + path.sep) && filePath !== resolvedClientDir) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      serveFile(res, filePath, mimeType(filePath));
      return;
    }

    // -----------------------------------------------------------------------
    // GET /events  →  SSE stream (server → browser)
    // -----------------------------------------------------------------------
    if (method === 'GET' && url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(':ok\n\n');   // initial heartbeat
      sseClients.add(res);

      // Send the current Bonsai state to this new client immediately
      const activeBranch = branches.find(b => b.id === activeBranchId) ?? branches[0];
      if (activeBranch) {
        const send = (msg: object) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
        send({ command: 'renderGraph', graph: createGraphFromBranch(activeBranch) });
        send({ command: 'historyUpdate', history: activeBranch.nodes });
        send({ command: 'urlmodelUpdate', baseUrl, LLMmodel });
        const lastCode =
          activeBranch.nodes[activeBranch.nodes.length - 1]?.code ??
          activeBranch.nodes[0]?.code ?? '// Bonsai';
        send({ command: 'setInitialCode', code: lastCode });
        const hasBeyondRoot = activeBranch.nodes.some(n => n.parentId !== null);
        send({ command: 'setActivityFlow', initialDone: hasBeyondRoot });
      }

      req.on('close', () => { sseClients.delete(res); });
      return;
    }

    // -----------------------------------------------------------------------
    // POST /message  →  browser → server command
    // -----------------------------------------------------------------------
    if (method === 'POST' && url === '/message') {
      try {
        const message = await parseJsonBody(req);
        // Handle async without blocking the response
        handleMessage(message).catch(err => console.error('handleMessage error:', err));
        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      return;
    }

    // -----------------------------------------------------------------------
    // GET /export  →  download current Bonsai state as JSON
    // -----------------------------------------------------------------------
    if (method === 'GET' && url === '/export') {
      const activeBranch = branches.find(b => b.id === activeBranchId);
      if (!activeBranch || activeBranch.nodes.length <= 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cannot export: Bonsai only has the initial node.' }));
        return;
      }
      const payload = {
        schema: 'bonsai.v1',
        exportedAt: new Date().toISOString(),
        activeBranchId,
        branches,
        logs: getBonsaiLogs()
      };
      const json = JSON.stringify(payload, null, 2);
      const filename = `bonsai-${Date.now()}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      res.end(json);
      bonsaiLog('Bonsai exported via HTTP');
      return;
    }

    // -----------------------------------------------------------------------
    // POST /import  →  upload a bonsai JSON file (multipart or raw JSON body)
    // -----------------------------------------------------------------------
    if (method === 'POST' && url === '/import') {
      try {
        const body = await parseJsonBody(req);
        await handleMessage({ command: 'importJSON', content: JSON.stringify(body) });
        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      return;
    }

    // -----------------------------------------------------------------------
    // 404 fallback
    // -----------------------------------------------------------------------
    res.writeHead(404);
    res.end('Not found');
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

initFreshBonsai();

const PORT = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);
const server = createServer();
server.listen(PORT, () => {
  console.log(`BonsAIDE web server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser to start.`);
});
