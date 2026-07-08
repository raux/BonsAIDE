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
import { Branch, CodeNode, LizardMetrics, createGraphFromBranch, importBonsaiPayload, trimBranchAtNode } from './bonsai-state';
import { analyzeRepoForIssue, writeFixSpecFile, RepoIssueAnalysis } from './repo-analyzer';
import { discoverPiModels } from './pi-models';
import { buildLmStudioUrl, formatGitHubIssues, GitHubIssueForDisplay, mimeType, parseGitHubUrl } from './server-utils';

// ---------------------------------------------------------------------------
// Types  (mirrors extension.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// In-memory state  (equivalent to VS Code globalState + module-level vars)
// ---------------------------------------------------------------------------

let branches: Branch[] = [];
let activeBranchId: string | null = null;
let currentId = 0;
let selectedNodeId: number | null = null;
let baseUrl: string = process.env.BONSAI_LM_URL ?? 'localhost:1234/v1';
let LLMmodel: string = process.env.BONSAI_LM_MODEL ?? 'deepseek/deepseek-r1-0528-qwen3-8b';
let availableModels: string[] = [];
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
  const MODEL = LLMmodel || 'deepseek/deepseek-r1-0528-qwen3-8b';
  const API_KEY = 'lm-studio';

  async function requestLLM(): Promise<{ response: string; usage?: any }> {
    const res = await fetch(buildLmStudioUrl(BASE_URL, 'chat/completions'), {
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
  const MODEL = LLMmodel || 'deepseek/deepseek-r1-0528-qwen3-8b';
  const API_KEY = 'lm-studio';

  async function requestLLM(): Promise<{ response: string; usage?: any }> {
    const res = await fetch(buildLmStudioUrl(BASE_URL, 'chat/completions'), {
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
// GitHub helpers – fetch repository structure and key files
// ---------------------------------------------------------------------------

/** Fetch the repository tree and key file contents from GitHub API */
async function fetchGitHubRepoContent(owner: string, repo: string): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'BonsAIDE'
  };

  // 1. Fetch repo metadata
  const repoRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!repoRes.ok) {
    throw new Error(`GitHub API error: ${repoRes.status} ${repoRes.statusText}`);
  }
  const repoData: any = await repoRes.json();
  const defaultBranch = repoData.default_branch || 'main';
  const description = repoData.description || '';
  const language = repoData.language || '';

  // 2. Fetch directory tree (recursive)
  const treeRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, { headers, signal: AbortSignal.timeout(15000) });
  if (!treeRes.ok) {
    throw new Error(`GitHub tree API error: ${treeRes.status} ${treeRes.statusText}`);
  }
  const treeData: any = await treeRes.json();
  const allFiles: string[] = (treeData.tree || [])
    .filter((item: any) => item.type === 'blob')
    .map((item: any) => item.path);

  // 3. Identify key files to fetch content for
  const keyPatterns = [
    /^readme\.md$/i,
    /^package\.json$/i,
    /^pyproject\.toml$/i,
    /^cargo\.toml$/i,
    /^go\.mod$/i,
    /^pom\.xml$/i,
    /^build\.gradle$/i,
    /^makefile$/i,
    /^dockerfile$/i,
    /^requirements\.txt$/i,
    /^setup\.py$/i,
    /^tsconfig\.json$/i,
    /^agents\.md$/i,
  ];

  const entryPatterns = [
    /^(?:src\/)?(?:main|index|app|server|extension)\.[a-z]+$/i,
  ];

  const keyFiles = allFiles.filter(f => {
    const basename = f.split('/').pop() || '';
    return keyPatterns.some(p => p.test(basename)) || entryPatterns.some(p => p.test(f));
  });

  const filesToFetch = keyFiles.slice(0, 15);

  // 4. Fetch contents of key files (in parallel, with size limits)
  const fileContents: { path: string; content: string }[] = [];
  const MAX_FILE_SIZE = 8000;

  await Promise.all(filesToFetch.map(async (filePath) => {
    try {
      const fileRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(defaultBranch)}`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (!fileRes.ok) { return; }
      const fileData: any = await fileRes.json();
      if (fileData.encoding === 'base64' && fileData.content) {
        let decoded = Buffer.from(fileData.content, 'base64').toString('utf-8');
        if (decoded.length > MAX_FILE_SIZE) {
          decoded = decoded.substring(0, MAX_FILE_SIZE) + '\n... (truncated)';
        }
        fileContents.push({ path: filePath, content: decoded });
      }
    } catch { /* skip files that fail */ }
  }));

  // 5. Compose the summary for the LLM
  let summary = `# Repository: ${owner}/${repo}\n`;
  summary += `- Description: ${description}\n`;
  summary += `- Primary language: ${language}\n`;
  summary += `- Default branch: ${defaultBranch}\n`;
  summary += `- Total files: ${allFiles.length}\n\n`;

  summary += `## Directory structure\n\`\`\`\n`;
  const treeLines = allFiles.filter(f => {
    const depth = f.split('/').length;
    return depth <= 3;
  });
  summary += treeLines.slice(0, 150).join('\n');
  if (treeLines.length > 150) { summary += '\n... (truncated)'; }
  summary += '\n```\n\n';

  summary += `## Key file contents\n\n`;
  for (const fc of fileContents) {
    summary += `### ${fc.path}\n\`\`\`\n${fc.content}\n\`\`\`\n\n`;
  }

  return summary;
}

/** Fetch open GitHub issues and format them for display in the UI. */
async function generateAgenticFixAnalysis(analysis: RepoIssueAnalysis): Promise<string> {
  const snippetContext = analysis.snippets.map((snippet, index) => [
    `Snippet ${index + 1}: ${snippet.file}:${snippet.startLine}-${snippet.endLine}`,
    `Reason: ${snippet.reason}`,
    '```',
    snippet.code,
    '```'
  ].join('\n')).join('\n\n');

  const systemPrompt = `
You are a senior software-maintenance agent. Given a GitHub issue and statically gathered repository snippets, draft a practical fix specification.
Return concise Markdown with exactly these sections:
## Root-cause hypothesis
## Impacted code
## Fix specification
## Test plan
## Risks and checks
Do not claim you executed the repository. Do not invent files beyond the provided context unless clearly marked as unknown.
  `.trim();

  const userPrompt = `
Repository: ${analysis.owner}/${analysis.repo}
Issue: #${analysis.issue.number} ${analysis.issue.title}
URL: ${analysis.issue.html_url || '(none)'}

Issue description:
${analysis.issue.body || 'No description provided.'}

Extracted keywords:
${analysis.keywords.join(', ') || '(none)'}

Statically gathered snippets:
${snippetContext || '(No matching snippets found.)'}
  `.trim();

  const res = await fetch(buildLmStudioUrl(baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer lm-studio',
    },
    body: JSON.stringify({
      model: LLMmodel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Agentic LM Studio analysis failed: HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }

  const json: any = await res.json();
  const output: string =
    json?.choices?.[0]?.message?.content?.trim?.() ??
    json?.choices?.[0]?.text?.trim?.() ?? '';
  if (!output) {
    throw new Error('Agentic LM Studio analysis returned an empty response.');
  }
  return output;
}

async function fetchGitHubIssues(owner: string, repo: string): Promise<{ text: string; issues: GitHubIssueForDisplay[] }> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'BonsAIDE'
  };

  const issuesRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=50`,
    { headers, signal: AbortSignal.timeout(15000) }
  );

  if (!issuesRes.ok) {
    const text = await issuesRes.text().catch(() => '');
    throw new Error(`GitHub issues API error: ${issuesRes.status} ${issuesRes.statusText}${text ? ` - ${text}` : ''}`);
  }

  const issueData: any = await issuesRes.json();
  if (!Array.isArray(issueData)) {
    throw new Error('GitHub issues API returned an unexpected response.');
  }

  const issues: GitHubIssueForDisplay[] = issueData
    .filter((item: any) => !item.pull_request)
    .map((item: any) => ({
      number: Number(item.number),
      title: String(item.title ?? ''),
      html_url: String(item.html_url ?? ''),
      user: item.user && typeof item.user.login === 'string' ? { login: item.user.login } : undefined,
      labels: Array.isArray(item.labels)
        ? item.labels.map((label: any) => ({ name: typeof label.name === 'string' ? label.name : undefined }))
        : [],
      created_at: typeof item.created_at === 'string' ? item.created_at : undefined,
      updated_at: typeof item.updated_at === 'string' ? item.updated_at : undefined,
      comments: typeof item.comments === 'number' ? item.comments : undefined,
      body: typeof item.body === 'string' ? item.body : undefined,
    }));

  return { text: formatGitHubIssues(owner, repo, issues), issues };
}

// ---------------------------------------------------------------------------
// LLM – generateAgentMdFromRepo (generates AGENTS.MD from a GitHub repository)
// ---------------------------------------------------------------------------

async function generateAgentMdFromRepo(
  repoContent: string
): Promise<{ content: string; reasoning: string }> {
  const systemPrompt = `
You are an expert technical writer and software architect. You will be given information about a GitHub repository including its structure, metadata, and key file contents.

Your job is to generate a comprehensive AGENTS.MD file that summarizes the repository. The AGENTS.MD should help developers and AI agents quickly understand the codebase.

You MUST return output using ONLY the two XML tags below, with nothing before or after them. Absolutely NO backticks wrapping the entire output, NO prose outside the tags.

### REQUIRED SCHEMA (use exactly these tags and order):
<code>
[ONLY the final AGENTS.MD content here — valid Markdown format]
</code>
<reasoning>
[ONLY the explanation of how you analyzed the repository and what you included — plain text, no code fences]
</reasoning>

### AGENTS.MD CONTENT GUIDELINES:
The generated AGENTS.MD should include these sections (adapt based on what's relevant):
1) **Repository Overview** – Brief description of what the project does
2) **Environment Setup** – How to install dependencies and set up the development environment
3) **Build & Run** – Commands to build, run, and test the project
4) **Architecture** – High-level description of the codebase structure and key modules
5) **Key Files & Directories** – Table mapping paths to their purposes
6) **Code Conventions** – Naming patterns, style guidelines, important patterns used
7) **Testing** – How tests are organized and run
8) **Dependencies** – Key runtime and development dependencies
9) **Configuration** – Environment variables, config files, and their purpose
10) **Security Notes** – Any security-relevant information

### RULES (strict):
1) Output MUST start with "<code>" on the first line and end with "</reasoning>" on the last line.
2) No additional tags, headers, or text outside the two blocks.
3) The content inside <code> MUST be valid Markdown suitable for an AGENTS.MD file.
4) Put ALL explanation inside <reasoning>. Do NOT include code fences there.
5) Do NOT wrap anything in triple backticks outside the tags.
6) Be thorough but concise. Focus on actionable information that helps someone work with the codebase.

Validate your output against the RULES before responding.
  `.trim();

  const BASE_URL = baseUrl || 'localhost:1234/v1';
  const MODEL = LLMmodel || 'deepseek/deepseek-r1-0528-qwen3-8b';
  const API_KEY = 'lm-studio';

  async function requestLLM(): Promise<{ response: string; usage?: any }> {
    const res = await fetch(buildLmStudioUrl(BASE_URL, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this GitHub repository and generate a comprehensive AGENTS.MD file:\n\n${repoContent}` },
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
      console.warn('Error during AGENTS.MD generation:', (err as Error).message);
      if (attempt === 2) throw err;
    }
    await new Promise(res => setTimeout(res, 1000));
  }

  throw new Error('Failed to generate AGENTS.MD after multiple attempts');
}

// ---------------------------------------------------------------------------
// Initialise a fresh Bonsai with a root placeholder
// ---------------------------------------------------------------------------

function initFreshBonsai(): void {
  branches = [];
  activeBranchId = null;
  selectedNodeId = null;
  currentId = 0;
  bonsaiLogs = [];

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
    const toDelete = trimBranchAtNode(branch, Number(message.id));
    if (toDelete.size === 0) { return; }

    if (selectedNodeId != null && toDelete.has(selectedNodeId)) {
      selectedNodeId = null;
      broadcast({ command: 'leafSimilarities', node: null, similarities: [] });
    }
    broadcast({ command: 'renderGraph', graph: createGraphFromBranch(branch) });
    bonsaiLog(`Trimmed ${toDelete.size} nodes starting from #${Number(message.id)}`);
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
      const importedState = importBonsaiPayload(payload);

      branches = importedState.branches;
      activeBranchId = importedState.activeBranchId;
      currentId = importedState.currentId;
      selectedNodeId = null;

      const activeBranch = branches.find(b => b.id === activeBranchId) ?? branches[0];
      broadcast({ command: 'renderGraph', graph: createGraphFromBranch(activeBranch) });
      broadcast({ command: 'historyUpdate', history: activeBranch?.nodes ?? [] });
      broadcast({ command: 'urlmodelUpdate', baseUrl, LLMmodel, availableModels });

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

  if (message.command === 'loadPiModels') {
    bonsaiLog('Loading Pi model registry metadata');
    try {
      const result = await discoverPiModels();
      bonsaiLog('Pi model registry loaded. Compatible:', result.compatibleCount, 'Total:', result.totalCount);
      broadcast({
        command: 'piModelsUpdate',
        success: true,
        models: result.models,
        compatibleCount: result.compatibleCount,
        totalCount: result.totalCount,
        warning: result.warning ? 'Pi models.json had a load warning; check Pi config locally.' : undefined
      });
    } catch (err: any) {
      bonsaiLog('Pi model registry load failed:', err?.message || err);
      broadcast({ command: 'piModelsUpdate', success: false, message: err?.message || 'Unable to load Pi models' });
    }
    return;
  }

  if (message.command === 'testConnection') {
    const testUrl = message.baseUrl || baseUrl;
    const testModel = message.model || LLMmodel;
    bonsaiLog('Testing connection to:', testUrl, 'with model:', testModel);
    broadcast({ command: 'loading', text: 'Testing connection...' });

    try {
      // First, test basic connectivity using the /models endpoint (lightweight, no model execution)
      const modelsRes = await fetch(buildLmStudioUrl(testUrl, 'models'), {
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
      availableModels = modelsJson?.data?.map((m: any) => m.id) ?? [];
      
      // Check if the specified model is available
      let modelStatus: string;
      let selectedModel = testModel;
      if (availableModels.length === 0) {
        modelStatus = `Warning: No models reported by server. Make sure "${testModel}" is loaded.`;
      } else if (availableModels.includes(testModel)) {
        modelStatus = `Model "${testModel}" is available.`;
      } else {
        selectedModel = availableModels[0];
        LLMmodel = selectedModel;
        modelStatus = `Warning: Model "${testModel}" not found. Selected "${selectedModel}". Available: ${availableModels.join(', ')}`;
      }

      bonsaiLog('Connection test successful. Server reachable.', modelStatus);
      broadcast({ 
        command: 'connectionTestResult', 
        success: true, 
        message: `✓ Connected to LLM server! ${modelStatus}`,
        availableModels,
        selectedModel
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
      const modelsRes = await fetch(buildLmStudioUrl(baseUrl, 'models'), {
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
      availableModels = modelsData?.data?.map((m: any) => m.id) ?? [];
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

  if (message.command === 'collectGitHubIssues') {
    const repoUrl = message.repoUrl || '';

    bonsaiLog('Collecting GitHub issues for repo:', repoUrl);
    broadcast({ command: 'loading', text: 'Parsing GitHub repository URL...' });

    try {
      const parsed = parseGitHubUrl(repoUrl);
      if (!parsed) {
        throw new Error('Invalid GitHub URL. Expected format: https://github.com/owner/repo');
      }

      broadcast({ command: 'loading', text: 'Fetching open GitHub issues...' });
      const issueResult = await fetchGitHubIssues(parsed.owner, parsed.repo);
      bonsaiLog('GitHub issues collected. Count:', issueResult.issues.length, 'Length:', issueResult.text.length);

      broadcast({
        command: 'collectGitHubIssuesResult',
        success: true,
        content: issueResult.text,
        issues: issueResult.issues,
        issueCount: issueResult.issues.length,
        repository: `${parsed.owner}/${parsed.repo}`
      });
    } catch (err: any) {
      bonsaiLog('GitHub issue collection failed:', err?.message || err);
      broadcast({
        command: 'collectGitHubIssuesResult',
        success: false,
        message: err?.message || 'Issue collection failed'
      });
    }
    return;
  }

  if (message.command === 'analyzeRepoForFix') {
    const repoUrl = message.repoUrl || '';
    const issue = message.issue as GitHubIssueForDisplay | undefined;
    baseUrl = message.baseUrl || baseUrl;
    LLMmodel = message.model || LLMmodel;

    bonsaiLog('Agentically analyzing repo for fix:', repoUrl, issue?.number, 'model:', LLMmodel);
    broadcast({ command: 'repoIssueAnalysisResult', success: false, loading: true, message: 'Preparing repository analysis...' });

    try {
      const parsed = parseGitHubUrl(repoUrl);
      if (!parsed) {
        throw new Error('Invalid GitHub URL. Expected format: https://github.com/owner/repo');
      }
      if (!issue || typeof issue.title !== 'string' || typeof issue.number !== 'number') {
        throw new Error('Select an issue before analyzing the repository.');
      }

      broadcast({ command: 'repoIssueAnalysisResult', success: false, loading: true, message: 'Cloning or updating repository cache and gathering code context...' });
      const analysis = await analyzeRepoForIssue(parsed.owner, parsed.repo, issue);
      broadcast({ command: 'repoIssueAnalysisResult', success: false, loading: true, message: `Found ${analysis.snippets.length} likely impacted snippet(s). Asking local model for agentic fix specification...` });
      analysis.agenticAnalysis = await generateAgenticFixAnalysis(analysis);
      analysis.specPath = await writeFixSpecFile(analysis);
      analysis.content = `${analysis.content.replace(/\n\nFix specification file:\n[\s\S]*$/, '')}\n\nAgentic fix analysis:\n${analysis.agenticAnalysis}\n\nFix specification file:\n${analysis.specPath}`;
      broadcast({ command: 'repoIssueAnalysisResult', success: false, loading: true, message: `Agentic analysis complete. Creating Bonsai node...` });

      let branch = branches.find(b => b.id === activeBranchId);
      if (!branch) {
        initFreshBonsai();
        branch = branches[0];
      }

      const parentId = selectedNodeId ?? branch.nodes[0]?.id ?? null;
      const parent = parentId == null ? undefined : branch.nodes.find(n => n.id === parentId);
      if (parent) { parent.isLeaf = false; }

      const newNode: CodeNode = {
        id: ++currentId,
        prompt: `Agentic repo issue analysis for #${issue.number}: ${issue.title}`,
        code: analysis.content,
        parentId,
        children: [],
        durationMs: 0,
        tokens: { prompt: 0, completion: 0, total: 0 },
        reasoning: `Cloned/read ${parsed.owner}/${parsed.repo}, gathered static code context, used local LM Studio model ${LLMmodel} for agentic fix analysis, and wrote a fix specification file at ${analysis.specPath ?? 'unknown path'}. No repository code was executed.`,
        isLeaf: true,
        activity: 'repo_agentic_analysis'
      };

      branch.nodes.push(newNode);
      selectedNodeId = newNode.id;

      broadcast({ command: 'historyUpdate', history: branch.nodes });
      broadcast({ command: 'renderGraph', graph: createGraphFromBranch(branch) });
      broadcast({ command: 'setInitialCode', code: analysis.content });
      broadcast({
        command: 'repoIssueAnalysisResult',
        success: true,
        loading: false,
        message: `Created agentic analysis node #${newNode.id} with ${analysis.snippets.length} impacted snippet(s).`,
        node: newNode,
        snippets: analysis.snippets,
        keywords: analysis.keywords,
        repoPath: analysis.repoPath,
        specPath: analysis.specPath
      });
      bonsaiLog('Agentic repo issue analysis node created:', newNode.id, 'snippets:', analysis.snippets.length);
    } catch (err: any) {
      bonsaiLog('Repo issue analysis failed:', err?.message || err);
      broadcast({
        command: 'repoIssueAnalysisResult',
        success: false,
        loading: false,
        message: err?.message || 'Repository analysis failed'
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

export function createServer(): http.Server {
  initFreshBonsai();

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
        send({ command: 'urlmodelUpdate', baseUrl, LLMmodel, availableModels });
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

export function startServer(port = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10)): http.Server {
  const server = createServer();
  server.listen(port, () => {
    console.log(`BonsAIDE web server running at http://localhost:${port}`);
    console.log(`Open http://localhost:${port} in your browser to start.`);

    // Auto-test LLM connection on startup
    void (async () => {
      try {
        const testUrl = baseUrl || 'localhost:1234/v1';
        const testModel = LLMmodel || 'deepseek/deepseek-r1-0528-qwen3-8b';
        bonsaiLog('Auto-testing LLM connection on startup:', testUrl, 'model:', testModel);

        const modelsRes = await fetch(buildLmStudioUrl(testUrl, 'models'), {
          method: 'GET',
          headers: { 'Authorization': 'Bearer lm-studio' },
          signal: AbortSignal.timeout(5000)
        });

        if (!modelsRes.ok) {
          broadcast({ command: 'connectionTestResult', success: false, message: `✗ LLM server not reachable (HTTP ${modelsRes.status})` });
          return;
        }

        const modelsJson: any = await modelsRes.json();
        availableModels = modelsJson?.data?.map((m: any) => m.id) ?? [];

        let modelStatus: string;
        let selectedModel = testModel;
        if (availableModels.length === 0) {
          modelStatus = `Warning: No models reported by server. Make sure "${testModel}" is loaded.`;
        } else if (availableModels.includes(testModel)) {
          modelStatus = `Model "${testModel}" is available.`;
        } else {
          selectedModel = availableModels[0];
          LLMmodel = selectedModel;
          modelStatus = `Warning: Model "${testModel}" not found. Selected "${selectedModel}". Available: ${availableModels.join(', ')}`;
        }

        bonsaiLog('Startup connection test successful.', modelStatus);
        broadcast({ command: 'connectionTestResult', success: true, message: `✓ Connected to LLM server! ${modelStatus}`, availableModels, selectedModel });
      } catch (err: any) {
        bonsaiLog('Startup connection test failed:', err?.message || err);
        broadcast({ command: 'connectionTestResult', success: false, message: `✗ LLM server not reachable: ${err?.message || err}` });
      }
    })();
  });

  return server;
}

if (require.main === module) {
  startServer();
}
