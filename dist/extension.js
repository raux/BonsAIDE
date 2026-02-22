/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
exports.fetchFromLocalLLM = fetchFromLocalLLM;
exports.fetchFromLocalLMStudio = fetchFromLocalLMStudio;
exports.deactivate = deactivate;
const vscode = __importStar(__webpack_require__(1));
const lizard_1 = __webpack_require__(2);
const similarity_1 = __webpack_require__(7);
const fs = __importStar(__webpack_require__(4));
const os = __importStar(__webpack_require__(5));
const path = __importStar(__webpack_require__(6));
let bonsaiLogs = []; // In-memory log storage
let branches = [];
let activeBranchId = null;
let currentId = 0;
let selectedNodeId = null;
let baseUrl = 'localhost:1234/v1'; // default LM Studio URL
let LLMmodel = 'qwen/qwen2.5-coder-3b-instruct'; // default model
// --- Persistence helpers ---
const STORAGE_KEY = 'bonsai.state.v1';
const SESSION_ID = vscode.env.sessionId; // unique per VS Code window/session
/** Load last saved Bonsai state if it belongs to THIS VS Code session */
function getPersistedState(context) {
    const raw = context.globalState.get(STORAGE_KEY);
    if (!raw)
        return null;
    try {
        if (raw.sessionId !== SESSION_ID) {
            // Saved state is from a previous VS Code session: ignore it (and optionally wipe it)
            void context.globalState.update(STORAGE_KEY, undefined); // fire-and-forget
            return null;
        }
        if (!Array.isArray(raw.branches))
            return null;
        return {
            branches: raw.branches,
            activeBranchId: typeof raw.activeBranchId === 'string' ? raw.activeBranchId : null,
            currentId: typeof raw.currentId === 'number' ? raw.currentId : 0,
            baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : 'localhost:1234/v1',
            LLMmodel: typeof raw.LLMmodel === 'string' ? raw.LLMmodel : 'qwen/qwen2.5-coder-3b-instruct',
        };
    }
    catch {
        return null;
    }
}
/** Append a log message with timestamp */
function bonsaiLog(...args) {
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
function getBonsaiLogs() {
    return bonsaiLogs;
}
/** Save current Bonsai state as belonging to THIS VS Code session only */
async function persistState(context) {
    await context.globalState.update(STORAGE_KEY, {
        sessionId: SESSION_ID, // tag the state with this session
        branches,
        activeBranchId,
        currentId,
        baseUrl,
        LLMmodel
    });
}
function createGraphFromBranch(branch) {
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
                    timeColor, // preserved separately (e.g., use for border/tooltip)
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
function getActivityColor(activity) {
    switch (activity) {
        case 'fix_with_context': return '#834632';
        case 'fix_without_context': return '#83675e';
        case 'gen_tests': return '#970071';
        case 'refactor': return '#006d18';
        case 'exceptions': return '#00b0b6';
        default: return '#777777'; // neutral dark gray (other/unknown)
    }
}
function getWebviewContent(panel, extensionUri) {
    // Path to media/webview.html
    const webviewHtmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'webview.html');
    let html = fs.readFileSync(webviewHtmlPath.fsPath, 'utf8');
    // Re-map script and style URIs for the webview (security: only allow via asWebviewUri)
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));
    // Replace placeholders in HTML
    html = html.replace('${scriptUri}', scriptUri.toString());
    html = html.replace('${styleUri}', styleUri.toString());
    return html;
}
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('bonsaiIDE.start', async () => {
        const panel = vscode.window.createWebviewPanel('bonsaiIDE', 'Bonsai IDE', vscode.ViewColumn.Beside, { enableScripts: true });
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
        }
        else {
            // --- No previous state: bootstrap a fresh Bonsai with a single root node ---
            // Get code and language hint from the active editor (if any)
            const editor = vscode.window.activeTextEditor;
            const ext = pickTempExtensionFromEditor(editor); // kept for future use
            lastKnownExt = ext;
            const initialCode = editor?.document.getText() ?? '// No code found';
            // Create the initial root node (no parent)
            const initialNode = {
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
            const defaultBranch = {
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
                if (!activeBranch)
                    return;
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
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'trim') {
                const branch = branches.find(b => b.id === activeBranchId);
                if (!branch)
                    return;
                const base = branch.nodes.find(n => n.id === message.id);
                if (!base)
                    return;
                // Collect ids to delete: base + all descendants
                const toDelete = new Set([base.id]);
                const collect = (node) => {
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
                    if (!activeBranch)
                        return;
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
                    if (!uri)
                        return; // User cancelled
                    // 3) Write file
                    const bytes = Buffer.from(JSON.stringify(exportPayload, null, 2), 'utf8');
                    await vscode.workspace.fs.writeFile(uri, bytes);
                    bonsaiLog('Bonsai exported to', uri.fsPath);
                    vscode.window.showInformationMessage(`Bonsai exported to ${uri.fsPath}`);
                }
                catch (err) {
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
                    if (!picked || picked.length === 0)
                        return;
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
                    const importedBranches = payload.branches.map((b) => ({
                        id: String(b.id ?? 'main'),
                        name: String(b.name ?? 'Main'),
                        nodes: Array.isArray(b.nodes) ? b.nodes.map((n) => ({
                            id: Number(n.id),
                            prompt: String(n.prompt ?? ''),
                            code: String(n.code ?? ''),
                            parentId: (n.parentId === null || n.parentId === undefined) ? null : Number(n.parentId),
                            children: Array.isArray(n.children) ? n.children : [], // not used directly; kept for compatibility
                            durationMs: (typeof n.durationMs === 'number') ? n.durationMs : 0,
                            tokens: n.tokens ?? { prompt: 0, completion: 0, total: 0 },
                            reasoning: typeof n.reasoning === 'string' ? n.reasoning : undefined,
                            lizard: n.lizard, // raw metrics as saved
                            isLeaf: Boolean(n.isLeaf), // will be recomputed anyway
                            activity: String(n.activity ?? 'other')
                        })) : []
                    }));
                    // Choose active branch (payload or first)
                    const importedActiveId = (typeof payload.activeBranchId === 'string' ? payload.activeBranchId : null)
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
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Import failed: ${err?.message || err}`);
                }
                return;
            }
            if (message.command === 'unselectNode') {
                selectedNodeId = null;
            }
            if (message.command === 'selectNode') {
                selectedNodeId = message.id;
                bonsaiLog('Node selected:', selectedNodeId);
                // Calculate leaf similarities for the selected node, first check if it is a leaf
                const branch = branches.find(b => b.id === activeBranchId);
                if (!branch)
                    return;
                const node = branch.nodes.find(n => n.id === selectedNodeId);
                if (!node)
                    return;
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
                        const sBranch = {
                            nodes: branch.nodes.map(n => ({
                                id: n.id,
                                code: n.code,
                                isLeaf: n.isLeaf
                            }))
                        };
                        const sNode = { id: node.id, code: node.code, isLeaf: node.isLeaf };
                        const similarities = (0, similarity_1.computeLeafSimilaritiesForCode)(sBranch, sNode);
                        // console.log('Leaf similarities computed:', similarities);
                        // Send to webview (we'll design the UI later)
                        panel.webview.postMessage({
                            command: 'leafSimilarities',
                            node,
                            similarities // array of { id, similarity } sorted desc
                        });
                    }
                    catch (e) {
                        vscode.window.showErrorMessage(`Similarity computation failed: ${e?.message || e}`);
                    }
                }
                else {
                    // Not a leaf: send empty list (or skip message)
                    panel.webview.postMessage({
                        command: 'leafSimilarities',
                        node,
                        similarities: []
                    });
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
                    return;
                }
                panel.webview.postMessage({ command: 'loading', text: 'Generating...' });
                try {
                    const versionCount = message.versionCount ?? 1;
                    const newNodes = [];
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
                        let lizardMetrics = undefined;
                        try {
                            lizardMetrics = await analyzeCodeWithLizard(result, `node-${currentId + 1}`, lastKnownExt);
                        }
                        catch {
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
                            if (parent)
                                parent.isLeaf = false;
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
                }
                catch (err) {
                    panel.webview.postMessage({ command: 'loading', text: 'ERROR!: ' + err.message });
                    panel.webview.postMessage({ command: 'result', content: 'Error: ' + err.message });
                }
            }
        });
    }));
}
async function fetchFromOpenRouter(prompt, code) {
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
    const data = await response.json();
    if (data?.error) {
        const msg = typeof data.error === 'string' ? data.error : data.error.message;
        console.error('OpenRouter API Error:', msg);
        throw new Error(`OpenRouter API Error: ${msg}`);
    }
    const output = data?.choices?.[0]?.message?.content ??
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
async function fetchFromLocalLLM(prompt, code) {
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
    async function requestLLM() {
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
        return response.json();
    }
    while (true) {
        try {
            const data = await requestLLM();
            if (typeof data === 'object' && data !== null && 'error' in data) {
                console.error('Local LLM Error:', data.error);
                // Puedes romper aquí si quieres o seguir intentando
                throw new Error(`Local LLM Error: ${data.error}`);
            }
            const output = data.response?.trim() ?? '';
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
            }
            else {
                console.warn('No <code> block found in LLM response. Retrying...');
            }
        }
        catch (error) {
            console.warn('Error during fetch or parsing:', error.message, 'Retrying...');
        }
        await new Promise(res => setTimeout(res, 1000));
    }
}
async function fetchFromLocalLMStudio(prompt, code) {
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
    async function requestLLM() {
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
        const json = await res.json();
        const output = json?.choices?.[0]?.message?.content?.trim?.() ??
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
            const output = data.response;
            const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
            const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
            const content = codeMatch?.[1]?.trim() ?? "";
            const reasoning = reasoningMatch?.[1]?.trim() ?? "(no reasoning provided)";
            if (content || reasoning) {
                const usage = data.usage;
                const promptTokens = usage?.prompt_tokens ?? 0;
                const completionTokens = usage?.completion_tokens ?? output.split(/\s+/).filter(Boolean).length;
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
            }
            else {
                console.warn("No <code>/<reasoning> tags found in LLM response. Retrying...");
            }
        }
        catch (err) {
            console.warn("Error during fetch or parsing:", err.message, "Retrying...");
        }
        await new Promise((res) => setTimeout(res, 1000));
    }
}
/** Map VSCode languageId to a file extension understood by Lizard */
function extFromLanguageId(lang) {
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
function pickTempExtensionFromEditor(ed) {
    if (!ed)
        return '.txt';
    // Prefer languageId → stable across unsaved buffers
    const byLang = extFromLanguageId(ed.document.languageId);
    if (byLang)
        return byLang;
    // Fallback to actual file extension if present
    const byName = path.extname(ed.document.fileName);
    return byName || '.txt';
}
/** Write code to a temp file with the right extension and analyze it with Lizard */
async function analyzeCodeWithLizard(code, nameHint = 'snippet', ext) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-'));
    const tempFile = path.join(tempDir, `${nameHint}${ext}`);
    try {
        await fs.promises.writeFile(tempFile, code, 'utf8');
        // Use the TS wrapper you already have
        const metrics = await (0, lizard_1.analyzeWithLizard)(tempFile);
        return metrics;
    }
    catch {
        // analyzeWithLizard already surfaces a VSCode error on failure
        return undefined;
    }
    finally {
        // Best-effort cleanup
        try {
            await fs.promises.unlink(tempFile);
        }
        catch { }
        try {
            await fs.promises.rmdir(tempDir);
        }
        catch { }
    }
}
function recomputeLeafFlags(branch) {
    // Count children for each node and set isLeaf flag
    const childCount = new Map();
    for (const n of branch.nodes)
        childCount.set(n.id, 0);
    for (const n of branch.nodes) {
        if (n.parentId != null && childCount.has(n.parentId)) {
            childCount.set(n.parentId, (childCount.get(n.parentId) || 0) + 1);
        }
    }
    for (const n of branch.nodes) {
        n.isLeaf = (childCount.get(n.id) || 0) === 0;
    }
}
function deactivate() { }


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.analyzeWithLizard = analyzeWithLizard;
// src/lizard.ts
const vscode = __importStar(__webpack_require__(1));
const child_process_1 = __webpack_require__(3);
const fs = __importStar(__webpack_require__(4));
const os = __importStar(__webpack_require__(5));
const path = __importStar(__webpack_require__(6));
function execPromise(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.exec)(cmd, { maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
            if (error)
                return reject({ error, stdout, stderr });
            resolve({ stdout, stderr });
        });
    });
}
function execFilePromise(bin, args, opts = {}) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)(bin, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
            if (error)
                return reject({ error, stdout, stderr });
            resolve({ stdout, stderr });
        });
    });
}
/** Try to find a usable Python command on the current platform */
async function findPython() {
    const candidates = process.platform === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3', 'python'];
    for (const cmd of candidates) {
        try {
            const { stdout, stderr } = await execFilePromise(cmd, ['--version']);
            if (/Python\s+\d+\.\d+\.\d+/.test(stdout) || /Python\s+\d+\.\d+\.\d+/.test(stderr)) {
                return cmd;
            }
        }
        catch { /* try next */ }
    }
    return null;
}
/** Ensure Python is installed; if not, guide the user and throw */
async function ensurePythonInstalled() {
    const py = await findPython();
    if (py)
        return py;
    const platform = process.platform;
    const action = await vscode.window.showErrorMessage('Python was not found on your system. It is required to install/run Lizard.', 'Open installation guide');
    console.error('Python is not installed or not available on PATH.');
    if (action === 'Open installation guide') {
        const url = platform === 'win32'
            ? 'https://www.python.org/downloads/windows/'
            : platform === 'darwin'
                ? 'https://www.python.org/downloads/macos/'
                : 'https://www.python.org/downloads/';
        void vscode.env.openExternal(vscode.Uri.parse(url));
    }
    throw new Error('Python is not installed or not available on PATH.');
}
/** Install Lizard using the provided Python interpreter (user site-packages) */
async function installLizardWith(pyCmd) {
    vscode.window.showInformationMessage('Installing Lizard (Python package)...');
    // Ensure pip is available for that interpreter
    try {
        await execFilePromise(pyCmd, ['-m', 'pip', '--version']);
    }
    catch {
        try {
            await execFilePromise(pyCmd, ['-m', 'ensurepip', '--upgrade']);
        }
        catch {
            throw new Error('Failed to initialize pip for this Python interpreter.');
        }
    }
    try {
        await execFilePromise(pyCmd, ['-m', 'pip', 'install', '--user', 'lizard']);
    }
    catch (e) {
        const stderr = e?.stderr ?? '';
        throw new Error(`Lizard installation failed: ${stderr || e}`);
    }
}
/** Check whether Lizard (Python module) is available */
async function isLizardAvailable(pyCmd) {
    try {
        await execFilePromise(pyCmd, ['-c', 'import lizard']);
        return true;
    }
    catch (error) {
        console.log('Lizard is not available:', error);
        return false;
    }
}
/** Ensure wrapper exists: prefer repo version; otherwise, write a temp copy and reuse it */
let cachedWrapperPath = null;
async function ensureWrapperPath() {
    if (cachedWrapperPath && fs.existsSync(cachedWrapperPath))
        return cachedWrapperPath;
    // 1) Look for a checked-in script at "<workspace>/scripts/lizard_wrapper.py"
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        for (const f of folders) {
            const p = path.join(f.uri.fsPath, 'scripts', 'lizard_wrapper.py');
            if (fs.existsSync(p)) {
                cachedWrapperPath = p;
                return p;
            }
        }
    }
    // 2) If not found, create a temp file with the wrapper content
    const content = `
import sys, json, lizard

def analyze(path: str):
    result = lizard.analyze_file(path)
    return {
        "filename": result.filename,
        "nloc": result.nloc,
        "token_count": result.token_count,
        "function_count": len(result.function_list),
        "average_ccn": result.average_cyclomatic_complexity,
        "avg_nloc": result.average_nloc,
        "avg_token_count": result.average_token_count,
        "functions": [
            {
                "name": f.name,
                "long_name": getattr(f, "long_name", f.name),
                "nloc": f.nloc,
                "ccn": f.cyclomatic_complexity,
                "token_count": f.token_count,
                "parameters": f.parameter_count,
                "start_line": f.start_line,
                "end_line": f.end_line,
                "filename": f.filename,
            }
            for f in result.function_list
        ]
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python lizard_wrapper.py <file>")
        sys.exit(1)
    path = sys.argv[1]
    metrics = analyze(path)
    print(json.dumps(metrics))
`.trimStart();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-lizard-'));
    const tempFile = path.join(tempDir, 'lizard_wrapper.py');
    await fs.promises.writeFile(tempFile, content, 'utf8');
    cachedWrapperPath = tempFile;
    return tempFile;
}
/**
 * Analyze a file with Lizard (via a Python wrapper) and return JSON metrics.
 * @param fileOrDirPath Absolute path to a file (recommended). (Directory is not supported by the wrapper as-is.)
 */
async function analyzeWithLizard(fileOrDirPath) {
    const py = await ensurePythonInstalled();
    if (!(await isLizardAvailable(py))) {
        await installLizardWith(py);
    }
    const wrapper = await ensureWrapperPath();
    try {
        const { stdout } = await execFilePromise(py, [wrapper, fileOrDirPath]);
        return JSON.parse(stdout);
    }
    catch (e) {
        const msg = e?.stderr || e?.stdout || String(e);
        vscode.window.showErrorMessage(`Lizard analysis failed: ${msg}`);
        console.error('Lizard analysis error:', e);
        throw e;
    }
}


/***/ }),
/* 3 */
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),
/* 4 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("os");

/***/ }),
/* 6 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 7 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.computeLeafSimilaritiesForCode = computeLeafSimilaritiesForCode;
/** --- Cosine similarity helpers (no external deps) --- **/
/** Very simple tokenizer for code: split on non-word, keep letters/digits/_ , lowercase */
function tokenizeCode(text) {
    return (text || '')
        .toLowerCase()
        .split(/[^a-zA-Z0-9_]+/g)
        .filter(Boolean);
}
/** Build TF-IDF vectors for documents (code strings). Returns normalized sparse vectors. */
function buildTfIdf(docs) {
    const tokensPerDoc = docs.map(tokenizeCode);
    // Document frequency (DF)
    const df = new Map();
    tokensPerDoc.forEach(tokens => {
        const seen = new Set();
        for (const t of tokens) {
            if (!seen.has(t)) {
                df.set(t, (df.get(t) || 0) + 1);
                seen.add(t);
            }
        }
    });
    const N = docs.length;
    // Inverse Document Frequency (IDF) with smoothing
    const idf = new Map();
    for (const [t, dfi] of df.entries()) {
        idf.set(t, Math.log((N + 1) / (dfi + 1)) + 1);
    }
    // TF-IDF vectors as sparse maps(term -> weight), L2-normalized
    return tokensPerDoc.map(tokens => {
        const tf = new Map();
        for (const t of tokens)
            tf.set(t, (tf.get(t) || 0) + 1);
        const vec = new Map();
        let sumsq = 0;
        for (const [t, freq] of tf.entries()) {
            const w = freq * (idf.get(t) || 0);
            if (w !== 0) {
                vec.set(t, w);
                sumsq += w * w;
            }
        }
        const norm = Math.sqrt(sumsq) || 1;
        for (const [t, w] of vec.entries())
            vec.set(t, w / norm);
        return vec;
    });
}
/** Cosine between two normalized sparse vectors (term->weight) */
function cosineSparse(a, b) {
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [t, wa] of small.entries()) {
        const wb = large.get(t);
        if (wb)
            dot += wa * wb;
    }
    return dot; // already normalized
}
/**
 * Compute cosine similarity on code ONLY, comparing a target leaf against other leaf nodes.
 * Returns an array sorted by similarity (desc), excluding the target itself.
 *
 * @param branch  A branch-like object with nodes { id, code, isLeaf }
 * @param target  The selected node (must exist in branch)
 */
function computeLeafSimilaritiesForCode(branch, target) {
    // Collect leaf nodes that have code (string)
    const leafs = branch.nodes.filter(n => n.isLeaf && typeof n.code === 'string');
    // Target first, then other leafs (excluding target)
    const ordered = [target, ...leafs.filter(n => n.id !== target.id)];
    const docs = ordered.map(n => n.code || '');
    // Build vectors and compute cosine vs target
    const vectors = buildTfIdf(docs);
    const vTarget = vectors[0];
    const results = [];
    for (let i = 1; i < ordered.length; i++) {
        const sim = cosineSparse(vTarget, vectors[i]);
        results.push({ id: ordered[i].id, similarity: sim });
    }
    // Sort descending by similarity
    results.sort((a, b) => b.similarity - a.similarity);
    return results;
}


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map