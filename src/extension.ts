import * as vscode from 'vscode';
import { analyzeWithLizard } from './lizard';
import { computeLeafSimilaritiesForCode, SimilarityBranch, SimilarityNode } from './similarity';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { text } from 'stream/consumers';


type LizardMetrics = any; // Raw JSON from lizard -j

let bonsaiLogs: string[] = []; // In-memory log storage

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

let branches: Branch[] = [];
let activeBranchId: string | null = null;
let currentId = 0;
let selectedNodeId: number | null = null;
let baseUrl: string = 'localhost:1234/v1'; // default LM Studio URL
let LLMmodel: string = 'deepseek/deepseek-r1-0528-qwen3-8b'; // default model

// --- Persistence helpers ---
const STORAGE_KEY = 'bonsai.state.v1';
const SESSION_ID = vscode.env.sessionId; // unique per VS Code window/session


/** Load last saved Bonsai state if it belongs to THIS VS Code session */
function getPersistedState(context: vscode.ExtensionContext): {
  branches: Branch[];
  activeBranchId: string | null;
  currentId: number;
  baseUrl: string;
  LLMmodel: string;
} | null {
  const raw = context.globalState.get(STORAGE_KEY) as any;
  if (!raw) return null;
  try {
    if (raw.sessionId !== SESSION_ID) {
      // Saved state is from a previous VS Code session: ignore it (and optionally wipe it)
      void context.globalState.update(STORAGE_KEY, undefined); // fire-and-forget
      return null;
    }
    if (!Array.isArray(raw.branches)) return null;
    return {
      branches: raw.branches as Branch[],
      activeBranchId: typeof raw.activeBranchId === 'string' ? raw.activeBranchId : null,
      currentId: typeof raw.currentId === 'number' ? raw.currentId : 0,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : 'localhost:1234/v1',
      LLMmodel: typeof raw.LLMmodel === 'string' ? raw.LLMmodel : 'deepseek/deepseek-r1-0528-qwen3-8b',
    };
  } catch {
    return null;
  }
}

/** Append a log message with timestamp */
function bonsaiLog(...args: any[]) {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}`;
  bonsaiLogs.push(line);
  console.log(line);
}

/** Clear logs (e.g., when starting a new Bonsai session) */
function clearBonsaiLogs() {
  bonsaiLogs = [];
}

/** Get all logs */
function getBonsaiLogs(): string[] {
  return bonsaiLogs;
}


/** Save current Bonsai state as belonging to THIS VS Code session only */
async function persistState(context: vscode.ExtensionContext) {
  await context.globalState.update(STORAGE_KEY, {
    sessionId: SESSION_ID,     // tag the state with this session
    branches,
    activeBranchId,
    currentId,
    baseUrl,
    LLMmodel
  });
}

function createGraphFromBranch(branch?: Branch) {
  if (!branch) {
    return { nodes: [], edges: [] };
  }

  // Exclude root nodes (parentId === null) from metrics (tokens/duration)
  const metricNodes = branch.nodes.filter(n => n.parentId !== null);

  // Size depending on completion tokens (only among metricNodes)
  const completionVals = metricNodes.map(n => n.tokens?.completion ?? 0);
  const minTokens = completionVals.length ? Math.min(...completionVals) : 0;
  const maxTokens = completionVals.length ? Math.max(...completionVals) : 0;

  // Time-based color (only among metricNodes)
  const durationVals = metricNodes.map(n => n.durationMs ?? 0);
  const minDuration = durationVals.length ? Math.min(...durationVals) : 0;
  const maxDuration = durationVals.length ? Math.max(...durationVals) : 0;

  return {
    nodes: branch.nodes.map(s => {
      // Size based on completion tokens normalized against metricNodes' range
      const tokens = s.tokens?.completion ?? 0;
      const size = (minTokens === maxTokens)
        ? 80
        : 40 + ((tokens - minTokens) / (maxTokens - minTokens)) * (120 - 40);

      // Keep time color; normalize against metricNodes' range (blue → red)
      const duration = s.durationMs ?? 0;
      const t = (maxDuration === minDuration)
        ? 0
        : (duration - minDuration) / (maxDuration - minDuration);
      const r = Math.round(255 * t);
      const g = 0;
      const b = Math.round(255 * (1 - t));
      const timeColor = `rgb(${r},${g},${b})`;

      // Activity color (categorical) for node fill
      const activityColor = getActivityColor(s.activity);

      return {
        data: {
          id: 'n' + s.id,
          label: '#' + s.id,
          code: s.code,
          prompt: s.prompt,
          activity: s.activity,
          reasoning: s.reasoning,

          size: Math.round(size),

          // colors
          activityColor, // used for background fill
          timeColor,     // preserved separately (e.g., use for border/tooltip)

          // also pass raw duration & normalized, if useful in UI
          duration,
          durationNorm: t
        }
      };
    }),

    edges: branch.nodes
      .filter(n => n.parentId !== null)
      .map(n => ({
        data: {
          source: 'n' + n.parentId,
          target: 'n' + n.id
        }
      }))
  };
}

// Helper: categorical colors by activity
function getActivityColor(activity?: string): string {
  switch (activity) {
    case 'fix_with_context': return '#834632';
    case 'fix_without_context': return '#83675e';
    case 'gen_tests': return '#970071';
    case 'refactor': return '#006d18';
    case 'exceptions': return '#00b0b6';
    default: return '#777777';                   // neutral dark gray (other/unknown)
  }
}

function getWebviewContent(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): string {
  // Path to media/webview.html
  const webviewHtmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'webview.html');
  let html = fs.readFileSync(webviewHtmlPath.fsPath, 'utf8');

  // Re-map script and style URIs for the webview (security: only allow via asWebviewUri)
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')
  );
  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'styles.css')
  );

  // Replace placeholders in HTML
  html = html.replace('${scriptUri}', scriptUri.toString());
  html = html.replace('${styleUri}', styleUri.toString());

  return html;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('bonsaiIDE.start', async () => {
      const panel = vscode.window.createWebviewPanel(
        'bonsaiIDE',
        'Bonsai IDE',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      // --- Always set the webview HTML first, then post messages to it ---
      panel.webview.html = getWebviewContent(panel, context.extensionUri);

      // --- Try to restore the last saved Bonsai from extension storage ---
      const persisted = getPersistedState(context);

      // Keep last known extension for Lizard (fallback .txt)
      let lastKnownExt = '.txt';

      if (persisted && Array.isArray(persisted.branches) && persisted.branches.length > 0) {
        // Restore global state
        branches = persisted.branches;
        activeBranchId = persisted.activeBranchId ?? persisted.branches[0].id ?? 'main';
        currentId = typeof persisted.currentId === 'number' ? persisted.currentId : 0;
        baseUrl = typeof persisted.baseUrl === 'string' ? persisted.baseUrl : 'localhost:1234/v1';
        LLMmodel = typeof persisted.LLMmodel === 'string' ? persisted.LLMmodel : 'qwen/qwen2.5-coder-3b-instruct';

        // Safety: recompute leaf flags in case the saved file is older or was edited
        const active = branches.find(b => b.id === activeBranchId) ?? branches[0];
        recomputeLeafFlags(active);

        // Initial render
        panel.webview.postMessage({ command: 'renderGraph', graph: createGraphFromBranch(active) });
        panel.webview.postMessage({ command: 'historyUpdate', history: active.nodes });
        panel.webview.postMessage({ command: 'urlmodelUpdate', baseUrl, LLMmodel });

        // Put last/first code into the textarea so the user sees something immediately
        const lastCode = active.nodes[active.nodes.length - 1]?.code
          ?? active.nodes[0]?.code
          ?? '// Bonsai';
        panel.webview.postMessage({ command: 'setInitialCode', code: lastCode });

        // When importing/restoring a Bonsai that is already beyond the root,
        // we want the activity flow as "initial already done": disable Fix, enable Then
        panel.webview.postMessage({ command: 'setActivityFlow', initialDone: true });

      } else {
        // --- No previous state: bootstrap a fresh Bonsai with a single root node ---

        // Get code and language hint from the active editor (if any)
        const editor = vscode.window.activeTextEditor;
        const ext = pickTempExtensionFromEditor(editor); // kept for future use
        lastKnownExt = ext;
        const initialCode = editor?.document.getText() ?? '// No code found';

        // Create the initial root node (no parent)
        const initialNode: CodeNode = {
          id: ++currentId,
          prompt: 'Initial code',
          code: initialCode,
          parentId: null,
          children: [],
          durationMs: 0,
          tokens: { prompt: 0, completion: 0, total: 0 },
          lizard: undefined,
          isLeaf: true,
          activity: 'initial'
        };

        // Create the default branch and set it active
        const defaultBranch: Branch = {
          id: 'main',
          name: 'Main',
          nodes: [initialNode]
        };
        branches = [defaultBranch];
        activeBranchId = 'main';

        // First render
        panel.webview.postMessage({ command: 'renderGraph', graph: createGraphFromBranch(defaultBranch) });
        panel.webview.postMessage({ command: 'historyUpdate', history: defaultBranch.nodes });
        panel.webview.postMessage({ command: 'setInitialCode', code: initialCode });

        // Persist the freshly created state so it survives tab switches
        await persistState(context);
      }

      // Keep bonsai when the user switches tabs
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          // When the Bonsai IDE tab becomes visible again, re-render the last state
          const activeBranch = branches.find(b => b.id === activeBranchId) ?? branches[0];
          if (!activeBranch) return;

          panel.webview.postMessage({ command: 'renderGraph', graph: createGraphFromBranch(activeBranch) });
          panel.webview.postMessage({ command: 'historyUpdate', history: activeBranch.nodes });
          panel.webview.postMessage({ command: 'urlmodelUpdate', baseUrl, LLMmodel });


          const lastCode = activeBranch.nodes[activeBranch.nodes.length - 1]?.code
            ?? activeBranch.nodes[0]?.code
            ?? '// Bonsai';
          panel.webview.postMessage({ command: 'setInitialCode', code: lastCode });

          // If the bonsai already has more than just the root, mark the flow as started
          const hasBeyondRoot = activeBranch.nodes.some(n => n.parentId !== null);
          panel.webview.postMessage({ command: 'setActivityFlow', initialDone: hasBeyondRoot });
        }
      });

      // Persist on panel close as a safety net
      panel.onDidDispose(() => {
        void persistState(context);
      });

      panel.webview.onDidReceiveMessage(async message => {
        if (message.command === 'trim') {
          const branch = branches.find(b => b.id === activeBranchId);
          if (!branch) return;

          const base = branch.nodes.find(n => n.id === message.id);
          if (!base) return;

          // Collect ids to delete: base + all descendants
          const toDelete = new Set<number>([base.id]);
          const collect = (node: CodeNode) => {
            for (const child of branch.nodes.filter(n => n.parentId === node.id)) {
              toDelete.add(child.id);
              collect(child);
            }
          };
          collect(base);

          // Drop deleted nodes
          branch.nodes = branch.nodes.filter(n => !toDelete.has(n.id));

          // If current selection was deleted, clear it
          if (selectedNodeId != null && toDelete.has(selectedNodeId)) {
            selectedNodeId = null;
            // Notify webview to clear selected node
            panel.webview.postMessage({ command: 'leafSimilarities', node: null, similarities: [] });
          }

          // Recompute leaf flags after deletions
          recomputeLeafFlags(branch);

          // Re-render graph
          const graph = createGraphFromBranch(branch);
          panel.webview.postMessage({ command: 'renderGraph', graph });

          bonsaiLog(`Trimmed ${toDelete.size} nodes starting from #${base.id}`);

          await persistState(context);
        }

        if (message.command === 'exportJSON') {
          try {
            const activeBranch = branches.find(b => b.id === activeBranchId);
            if (!activeBranch) return;

            // No export if only root node
            if (activeBranch.nodes.length <= 1) {
              vscode.window.showWarningMessage('Cannot export: Bonsai only has the initial node.');
              return;
            }

            // 1) Get object to export
            const exportPayload = {
              schema: 'bonsai.v1',
              exportedAt: new Date().toISOString(),
              activeBranchId,
              branches, // Include all branches and nodes
              logs: getBonsaiLogs() // Include logs for context/debugging
            };

            // 2) Where to save
            const uri = await vscode.window.showSaveDialog({
              title: 'Export Bonsai as JSON',
              saveLabel: 'Export',
              filters: { JSON: ['json'] },
              defaultUri: vscode.Uri.file(`bonsai-${Date.now()}.json`),
            });
            if (!uri) return; // User cancelled

            // 3) Write file
            const bytes = Buffer.from(JSON.stringify(exportPayload, null, 2), 'utf8');
            await vscode.workspace.fs.writeFile(uri, bytes);
            bonsaiLog('Bonsai exported to', uri.fsPath);
            vscode.window.showInformationMessage(`Bonsai exported to ${uri.fsPath}`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Export failed: ${err?.message || err}`);
          }
          return;
        }

        if (message.command === 'importJSON') {
          try {
            const picked = await vscode.window.showOpenDialog({
              title: 'Import Bonsai JSON',
              filters: { JSON: ['json'] },
              canSelectMany: false
            });
            if (!picked || picked.length === 0) return;

            // Read & parse file
            const bytes = await vscode.workspace.fs.readFile(picked[0]);
            const text = Buffer.from(bytes).toString('utf8');
            const payload = JSON.parse(text);

            // Basic validation
            if (!payload || payload.schema !== 'bonsai.v1') {
              throw new Error('Invalid schema. Expected "bonsai.v1".');
            }
            if (!Array.isArray(payload.branches)) {
              throw new Error('Invalid file: "branches" must be an array.');
            }

            // Rehydrate branches (trusting shape; add light defaults)
            const importedBranches: Branch[] = payload.branches.map((b: any) => ({
              id: String(b.id ?? 'main'),
              name: String(b.name ?? 'Main'),
              nodes: Array.isArray(b.nodes) ? b.nodes.map((n: any) => ({
                id: Number(n.id),
                prompt: String(n.prompt ?? ''),
                code: String(n.code ?? ''),
                parentId: (n.parentId === null || n.parentId === undefined) ? null : Number(n.parentId),
                children: Array.isArray(n.children) ? n.children as CodeNode[] : [], // not used directly; kept for compatibility
                durationMs: (typeof n.durationMs === 'number') ? n.durationMs : 0,
                tokens: n.tokens ?? { prompt: 0, completion: 0, total: 0 },
                reasoning: typeof n.reasoning === 'string' ? n.reasoning : undefined,
                lizard: n.lizard, // raw metrics as saved
                isLeaf: Boolean(n.isLeaf), // will be recomputed anyway
                activity: String(n.activity ?? 'other')
              })) : []
            }));

            // Choose active branch (payload or first)
            const importedActiveId: string | null =
              (typeof payload.activeBranchId === 'string' ? payload.activeBranchId : null)
              ?? (importedBranches[0]?.id ?? null);

            // Recompute leaf flags for safety (structure could have changed)
            for (const br of importedBranches) {
              recomputeLeafFlags(br);
            }

            // Recompute currentId as max node id across all branches
            const allNodeIds = importedBranches.flatMap(b => b.nodes.map(n => n.id));
            currentId = allNodeIds.length ? Math.max(...allNodeIds) : 0;

            // Swap global state
            branches = importedBranches;
            activeBranchId = importedActiveId;
            selectedNodeId = null;

            // Render UI (graph + history of active)
            const activeBranch = branches.find(b => b.id === activeBranchId) ?? branches[0] ?? undefined;
            const graph = createGraphFromBranch(activeBranch);
            panel.webview.postMessage({ command: 'renderGraph', graph });
            panel.webview.postMessage({ command: 'historyUpdate', history: activeBranch?.nodes ?? [] });
            panel.webview.postMessage({ command: 'urlmodelUpdate', baseUrl, LLMmodel });

            // Optionally set code textarea to root/last node
            const firstCode = activeBranch?.nodes?.[0]?.code ?? '// Imported Bonsai';
            panel.webview.postMessage({ command: 'setInitialCode', code: firstCode });

            await persistState(context);

            // Tell webview to disable Fix buttons and enable follow-up buttons after import
            panel.webview.postMessage({
              command: 'setActivityFlow',
              initialDone: true
            });

            vscode.window.showInformationMessage('Bonsai imported successfully.');
          } catch (err: any) {
            vscode.window.showErrorMessage(`Import failed: ${err?.message || err}`);
          }
          return;
        }

        if (message.command === 'unselectNode') {
          selectedNodeId = null
        }

        if (message.command === 'selectNode') {
          selectedNodeId = message.id;

          bonsaiLog('Node selected:', selectedNodeId);

          // Calculate leaf similarities for the selected node, first check if it is a leaf
          const branch = branches.find(b => b.id === activeBranchId);
          if (!branch) return;

          const node = branch.nodes.find(n => n.id === selectedNodeId);
          if (!node) return;

          // Toggle activity flow depending on whether the selected node is the root
          // Root node => initial not done (enable Fix, disable Then)
          // Non-root  => initial done (disable Fix, enable Then)
          const isRoot = (node.parentId === null);
          panel.webview.postMessage({
            command: 'setActivityFlow',
            initialDone: !isRoot
          });

          if (node.isLeaf) {
            try {
              // Adapt current branch/nodes to the minimal shapes the similarity module expects
              const sBranch: SimilarityBranch = {
                nodes: branch.nodes.map(n => ({
                  id: n.id,
                  code: n.code,
                  isLeaf: n.isLeaf
                } as SimilarityNode))
              };

              const sNode: SimilarityNode = { id: node.id, code: node.code, isLeaf: node.isLeaf };

              const similarities = computeLeafSimilaritiesForCode(sBranch, sNode);
              // console.log('Leaf similarities computed:', similarities);
              // Send to webview (we'll design the UI later)
              panel.webview.postMessage({
                command: 'leafSimilarities',
                node,
                similarities // array of { id, similarity } sorted desc
              });
            } catch (e: any) {
              vscode.window.showErrorMessage(`Similarity computation failed: ${e?.message || e}`);
            }
          } else {
            // Not a leaf: send empty list (or skip message)
            panel.webview.postMessage({
              command: 'leafSimilarities',
              node,
              similarities: []
            });
          }
          return;
        }

        if (message.command === 'testConnection') {
          const testUrl = message.baseUrl || baseUrl;
          const testModel = message.model || LLMmodel;
          bonsaiLog('Testing connection to:', testUrl, 'with model:', testModel);
          panel.webview.postMessage({ command: 'loading', text: 'Testing connection...' });

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
            panel.webview.postMessage({ 
              command: 'connectionTestResult', 
              success: true, 
              message: `✓ Connected to LLM server! ${modelStatus}` 
            });
          } catch (err: any) {
            bonsaiLog('Connection test failed:', err?.message || err);
            panel.webview.postMessage({ command: 'connectionTestResult', success: false, message: `✗ Connection failed: ${err?.message || err}` });
          }
          return;
        }

        if (message.command === 'generate') {
          const selectedNodeIdForPrompt = selectedNodeId;
          let code = message.code;
          baseUrl = message.baseUrl || baseUrl; // update global baseUrl if provided
          LLMmodel = message.model || LLMmodel; // update global model if provided

          /* Avoid generating from an empty code state */
          if (selectedNodeIdForPrompt == null) {
            panel.webview.postMessage({ command: 'loading', text: 'Please SELECT A NODE before applying an activity' });
            return
          }

          panel.webview.postMessage({ command: 'loading', text: 'Generating...' });

          try {
            const versionCount = message.versionCount ?? 1;
            const newNodes: CodeNode[] = [];

            bonsaiLog('Generating branches from #', selectedNodeIdForPrompt, 'num branches:', versionCount);

            for (let i = 0; i < versionCount; i++) {
              let currentCount = i + 1;
              bonsaiLog('Generating version', currentCount, 'of', versionCount);
              panel.webview.postMessage({ command: 'loading', text: 'Generating branch ' + currentCount + ' of ' + versionCount + "..." });

              const start = performance.now();
              const { content: result, reasoning, tokens } = await fetchFromLocalLMStudio(message.prompt, code);
              const duration = performance.now() - start;

              bonsaiLog(`Version ${i + 1} generated in ${duration.toFixed(2)} ms`);

              // Analyze generated code with Lizard and capture all JSON metrics
              let lizardMetrics: LizardMetrics | undefined = undefined;
              try {
                lizardMetrics = await analyzeCodeWithLizard(result, `node-${currentId + 1}`, lastKnownExt);
              } catch {
                // ignore; analyzeWithLizard already shows a VSCode error
              }
              // console.log('Lizard analysis complete', lizardMetrics);


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

              bonsaiLog(`Node #${currentId} created (parent #${selectedNodeIdForPrompt}), activity: ${message.activity}, tokens:`, tokens);

              // If the node is selected and generated children for it, it is no longer a leaf
              if (selectedNodeIdForPrompt != null) {
                const branch = branches.find(b => b.id === activeBranchId);
                const parent = branch?.nodes.find(n => n.id === selectedNodeIdForPrompt);
                if (parent) parent.isLeaf = false;
              }
            }

            let branch = branches.find(b => b.id === activeBranchId);
            if (branch) {
              branch.nodes.push(...newNodes);
            }



            panel.webview.postMessage({ command: 'historyUpdate', history: branch?.nodes ?? [] });
            const graph = createGraphFromBranch(branch);
            panel.webview.postMessage({ command: 'renderGraph', graph });
            await persistState(context);
          } catch (err: any) {
            panel.webview.postMessage({ command: 'loading', text: 'ERROR!: ' + err.message });
            panel.webview.postMessage({ command: 'result', content: 'Error: ' + err.message });
          }
        }
      });
    })
  );
}

async function fetchFromOpenRouter(
  prompt: string,
  code: string
): Promise<{
  content: string;
  reasoning: string;
  tokens: { prompt: number; completion: number; total: number };
}> {
  const systemPrompt = `
Your response MUST always follow this exact structure:

<code>
[ONLY valid code goes here. Absolutely no comments, no annotations, no explanations.]
</code>

<reasoning>
[Concise reasoning and explanation goes here. Never include code inside this section.]
</reasoning>.
`;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY environment variable');
    throw new Error('Missing OPENROUTER_API_KEY environment variable');
  }

  const fullPrompt = `${prompt}\n${code}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-r1-distill-llama-70b:free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: fullPrompt }
      ],
      temperature: 0.2,
      max_tokens: 2048,
    })
  });

  const data = await response.json() as any;

  if (data?.error) {
    const msg = typeof data.error === 'string' ? data.error : data.error.message;
    console.error('OpenRouter API Error:', msg);
    throw new Error(`OpenRouter API Error: ${msg}`);
  }

  const output: string =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.message ??
    '';

  const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/);
  const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/);

  const content = codeMatch?.[1]?.trim() ?? '// Failed to extract <code> block';
  const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

  const promptTokens = data?.usage?.prompt_tokens ?? 0;
  const completionTokens = data?.usage?.completion_tokens ?? 0;
  const totalTokens = data?.usage?.total_tokens ?? (promptTokens + completionTokens);

  return {
    content,
    reasoning,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens
    }
  };
}

export async function fetchFromLocalLLM(
  prompt: string,
  code: string
): Promise<{
  content: string;
  reasoning: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
}> {
  const systemPrompt = `
    Your response MUST and ONLY follow this exact structure, any deviation will be considered an error:

    <code>
    [some code here]
    </code>

    <reasoning>
    [an explanation here]
    </reasoning>

    Example:

    <code>
    print('Hello world')
    </code>

    <reasoning>
    This prints Hello World in Python.
    </reasoning>
    `;

  const fullPrompt = `${prompt}\n${code}`;

  async function requestLLM(): Promise<{ response: string } | { error: string }> {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'phi3:mini',
        prompt: `User prompt: ${fullPrompt}\n\n${systemPrompt}`,
        stream: false
      })
    });

    if (response.status === 500) {
      throw new Error('Server error 500');
    }

    return response.json() as any;
  }

  while (true) {
    try {
      const data = await requestLLM();

      if (typeof data === 'object' && data !== null && 'error' in data) {
        console.error('Local LLM Error:', (data as any).error);
        // Puedes romper aquí si quieres o seguir intentando
        throw new Error(`Local LLM Error: ${(data as any).error}`);
      }

      const output = (data as { response: string }).response?.trim() ?? '';
      const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/);
      const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/);

      const content = codeMatch?.[1]?.trim() ?? '';
      const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

      if (content) {
        const completionTokens = output.split(/\s+/).length;
        return {
          content,
          reasoning,
          tokens: {
            prompt: 0,
            completion: completionTokens,
            total: completionTokens
          }
        };
      } else {
        console.warn('No <code> block found in LLM response. Retrying...');
      }
    } catch (error) {
      console.warn('Error during fetch or parsing:', (error as Error).message, 'Retrying...');
    }
    await new Promise(res => setTimeout(res, 1000));
  }
}

export async function fetchFromLocalLMStudio(
  prompt: string,
  code: string,
): Promise<{
  content: string;
  reasoning: string;
  tokens: { prompt: number; completion: number; total: number };
}> {
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
  const BASE_URL = baseUrl || "http://10.184.201.141:1234/v1";
  const MODEL = LLMmodel || "qwen/qwen2.5-coder-3b-instruct"; //"qwen/qwen2.5-coder-3b-instruct"; //qwen/qwen2.5-coder-14b"; //qwen2.5-0.5b-instruct-mlx"; //"gpt-oss-20b";
  const API_KEY = "lm-studio";

  async function requestLLM(): Promise<{ response: string; usage?: any } | { error: string }> {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `User prompt:\n${fullPrompt}` },
        ],
        temperature: 0.8, // 0 for deterministic output
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`);
    }

    const json: any = await res.json();
    const output =
      json?.choices?.[0]?.message?.content?.trim?.() ??
      json?.choices?.[0]?.text?.trim?.() ??
      "";

    return { response: output, usage: json?.usage };
  }

  while (true) {
    try {
      const data = await requestLLM();

      if (typeof data !== "object" || !("response" in data)) {
        throw new Error("Unexpected response from local LLM");
      }

      const output = (data as any).response as string;

      const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
      const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);

      const content = codeMatch?.[1]?.trim() ?? "";
      const reasoning = reasoningMatch?.[1]?.trim() ?? "(no reasoning provided)";

      if (content || reasoning) {
        const usage = (data as any).usage;
        const promptTokens = usage?.prompt_tokens ?? 0;
        const completionTokens =
          usage?.completion_tokens ?? output.split(/\s+/).filter(Boolean).length;
        const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;

        return {
          content,
          reasoning,
          tokens: {
            prompt: promptTokens,
            completion: completionTokens,
            total: totalTokens,
          },
        };
      } else {
        console.warn("No <code>/<reasoning> tags found in LLM response. Retrying...");
      }
    } catch (err) {
      console.warn("Error during fetch or parsing:", (err as Error).message, "Retrying...");
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}



/** Map VSCode languageId to a file extension understood by Lizard */
function extFromLanguageId(lang: string): string {
  switch (lang) {
    case 'typescript': return '.ts';
    case 'javascript': return '.js';
    case 'python': return '.py';
    case 'cpp': return '.cpp';
    case 'c': return '.c';
    case 'csharp': return '.cs';
    case 'java': return '.java';
    case 'go': return '.go';
    case 'ruby': return '.rb';
    case 'php': return '.php';
    default: return '';
  }
}

/** Decide the best extension using the active editor (languageId first, then fileName) */
function pickTempExtensionFromEditor(ed: any): string {
  if (!ed) return '.txt';

  // Prefer languageId → stable across unsaved buffers
  const byLang = extFromLanguageId(ed.document.languageId);
  if (byLang) return byLang;

  // Fallback to actual file extension if present
  const byName = path.extname(ed.document.fileName);
  return byName || '.txt';
}

/** Write code to a temp file with the right extension and analyze it with Lizard */
async function analyzeCodeWithLizard(code: string, nameHint = 'snippet', ext: string): Promise<any | undefined> {

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-'));
  const tempFile = path.join(tempDir, `${nameHint}${ext}`);

  try {
    await fs.promises.writeFile(tempFile, code, 'utf8');
    // Use the TS wrapper you already have
    const metrics = await analyzeWithLizard(tempFile);
    return metrics;
  } catch {
    // analyzeWithLizard already surfaces a VSCode error on failure
    return undefined;
  } finally {
    // Best-effort cleanup
    try { await fs.promises.unlink(tempFile); } catch { }
    try { await fs.promises.rmdir(tempDir); } catch { }
  }
}

function recomputeLeafFlags(branch: Branch) {
  // Count children for each node and set isLeaf flag
  const childCount = new Map<number, number>();
  for (const n of branch.nodes) childCount.set(n.id, 0);
  for (const n of branch.nodes) {
    if (n.parentId != null && childCount.has(n.parentId)) {
      childCount.set(n.parentId, (childCount.get(n.parentId) || 0) + 1);
    }
  }
  for (const n of branch.nodes) {
    n.isLeaf = (childCount.get(n.id) || 0) === 0;
  }
}


export function deactivate() { }
