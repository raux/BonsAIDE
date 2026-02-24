/**
 * app.js – BonsAIDE standalone web frontend
 *
 * Communicates with the BonsAIDE HTTP server (src/server.ts) using:
 *   GET /events   – Server-Sent Events for server → browser messages
 *   POST /message – browser → server commands (same protocol as VS Code webview)
 *   GET /export   – download current Bonsai state as JSON
 *   POST /import  – (handled via file picker, then POST /message with importJSON)
 */

'use strict';

/* =============================================================
   1.  Transport layer: SSE + fetch (replaces acquireVsCodeApi)
   ============================================================= */

const connectionStatus = document.getElementById('connectionStatus');

function setConnectionStatus(connected) {
    if (!connectionStatus) { return; }
    if (connected) {
        connectionStatus.textContent = '● Connected';
        connectionStatus.className = 'connected';
    } else {
        connectionStatus.textContent = '○ Disconnected';
        connectionStatus.className = 'disconnected';
    }
}

// Server-Sent Events: receive messages from the backend
const evtSource = new EventSource('/events');

evtSource.onopen = function () { setConnectionStatus(true); };

evtSource.onmessage = function (e) {
    try {
        const msg = JSON.parse(e.data);
        // Dispatch as a synthetic window message so existing handlers work unchanged
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
    } catch (err) {
        console.error('SSE parse error', err);
    }
};

evtSource.onerror = function () {
    setConnectionStatus(false);
    console.warn('SSE connection lost – will retry automatically.');
};

// Hidden file input for JSON import
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.json';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

fileInput.addEventListener('change', function () {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { return; }
    const reader = new FileReader();
    reader.onload = function (ev) {
        sendToServer({ command: 'importJSON', content: ev.target.result });
    };
    reader.readAsText(file);
    fileInput.value = ''; // reset so same file can be re-imported
});

// Hidden file input for Agent.md upload
const agentMdInput = document.createElement('input');
agentMdInput.type = 'file';
agentMdInput.accept = '.md,.markdown';
agentMdInput.style.display = 'none';
document.body.appendChild(agentMdInput);

agentMdInput.addEventListener('change', function () {
    const file = agentMdInput.files && agentMdInput.files[0];
    if (!file) { return; }
    const reader = new FileReader();
    reader.onload = function (ev) {
        const agentMdEl = document.getElementById('agentMdContent');
        if (agentMdEl) { agentMdEl.value = ev.target.result; }
        const nameEl = document.getElementById('agentMdFilename');
        if (nameEl) { nameEl.textContent = file.name; }
    };
    reader.readAsText(file);
    agentMdInput.value = ''; // reset so same file can be re-loaded
});

document.getElementById('btnLoadAgentMd').addEventListener('click', function () {
    agentMdInput.click();
});

// Process Agent.md button handler
document.getElementById('btnProcessAgentMd').addEventListener('click', function () {
    var agentMdContent = document.getElementById('agentMdContent').value || '';
    var statusEl = document.getElementById('agentMdProcessStatus');
    if (!agentMdContent.trim()) {
        if (statusEl) {
            statusEl.textContent = 'Please enter or load Agent.md content first.';
            statusEl.className = 'error';
        }
        return;
    }
    if (statusEl) {
        statusEl.textContent = 'Processing...';
        statusEl.className = 'processing';
    }
    var baseUrl = document.getElementById('baseUrlInput').value || '';
    var model = document.getElementById('modelInput').value || '';
    vscode.postMessage({ 
        command: 'processAgentMd', 
        content: agentMdContent,
        baseUrl: baseUrl,
        model: model
    });
});

/** Send a command object to the backend */
function sendToServer(msg) {
    fetch('/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg)
    }).catch(function (err) { console.error('Message POST error', err); });
}

/**
 * vscode shim – the rest of the code calls vscode.postMessage() exactly as
 * it does in the VS Code webview.  Here we translate those calls to HTTP.
 */
const vscode = {
    postMessage: function (msg) {
        if (msg.command === 'exportJSON') {
            // Trigger a browser file download
            window.location.href = '/export';
            return;
        }
        if (msg.command === 'importJSON') {
            // Open a native file picker
            fileInput.click();
            return;
        }
        sendToServer(msg);
    }
};

/* =============================================================
   2.  Export / Import button handlers
   ============================================================= */

document.getElementById('btnExportJson').addEventListener('click', function () {
    vscode.postMessage({ command: 'exportJSON' });
});

document.getElementById('btnImportJson').addEventListener('click', function () {
    vscode.postMessage({ command: 'importJSON' });
});

document.getElementById('btnTestConnection').addEventListener('click', function () {
    const baseUrl = document.getElementById('baseUrlInput').value || '';
    const model = document.getElementById('modelInput').value || '';
    const statusEl = document.getElementById('connectionTestStatus');
    if (statusEl) {
        statusEl.textContent = 'Testing...';
        statusEl.className = 'connection-testing';
    }
    vscode.postMessage({ command: 'testConnection', baseUrl: baseUrl, model: model });
});

/* =============================================================
   3.  General helpers
   ============================================================= */

function escapeHtml(s) {
    return String(s).replace(/[<>&]/g, function (c) {
        return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
    });
}

/* =============================================================
   4.  Similarity + metrics rendering
   ============================================================= */

function renderSimilarities(baseNode, similarities) {
    const box = document.getElementById('similarities');
    if (!box) { return; }

    if (!baseNode || !baseNode.isLeaf) {
        box.innerHTML = '<em>No leaf node selected.</em>';
        return;
    }

    if (!similarities || similarities.length === 0) {
        box.innerHTML = '<div><strong>Node #' + baseNode.id + '</strong> is a leaf. No other leaves to compare.</div>';
        return;
    }

    const rows = similarities.map(function (s) {
        return '<tr><td>#' + s.id + '</td><td style="text-align:right">' +
            (s.similarity || 0).toFixed(4) + '</td></tr>';
    }).join('');

    box.innerHTML =
        '<div style="margin-top:8px">' +
        '<div><strong>Base leaf:</strong> #' + baseNode.id + '</div>' +
        '<table style="width:100%; border-collapse:collapse; margin-top:6px">' +
        '<thead><tr>' +
        '<th style="text-align:left; border-bottom:1px solid #ddd">Leaf Node</th>' +
        '<th style="text-align:right; border-bottom:1px solid #ddd">Cosine</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table></div>';
}

function renderLizardMetrics(node) {
    const box = document.getElementById('metrics');
    if (!box) { return; }

    if (!node) { box.innerHTML = ''; return; }

    const m = node.lizard;
    if (!m) {
        box.innerHTML = '<div style="margin-top:10px"><strong>Lizard metrics:</strong> <em>Not available for node #' + node.id + '</em></div>';
        return;
    }

    const fnCount = m.function_count != null ? m.function_count : (m.functions ? m.functions.length : undefined);
    const summary =
        '<div><strong>File:</strong> ' + escapeHtml(m.filename || '') + '</div>' +
        '<div><strong>NLOC:</strong> ' + (m.nloc != null ? m.nloc : '-') + '</div>' +
        '<div><strong>Token count:</strong> ' + (m.token_count != null ? m.token_count : '-') + '</div>' +
        '<div><strong>Functions:</strong> ' + (fnCount != null ? fnCount : '-') + '</div>' +
        '<div><strong>Average CCN:</strong> ' + (m.average_ccn != null ? m.average_ccn : '-') + '</div>';

    const pretty = escapeHtml(JSON.stringify(m, null, 2));
    box.innerHTML =
        '<div style="margin-top:10px">' +
        '<strong>Lizard metrics for node #' + node.id + ':</strong>' +
        '<div style="margin-top:6px">' + summary + '</div>' +
        '<details style="margin-top:8px"><summary>Full JSON</summary>' +
        '<pre class="code-block" style="max-height:260px; overflow:auto">' + pretty + '</pre>' +
        '</details></div>';
}

/* =============================================================
   5.  Similarity border heatmap helpers
   ============================================================= */

function resetAllBordersToBaseline() {
    if (!window.bonsaiCyRef) { return; }
    window.bonsaiCyRef.nodes().forEach(function (n) {
        n.removeStyle('border-color');
        n.removeStyle('border-width');
    });
}

function simToHeatColor(sim, minSim, maxSim) {
    let t = (maxSim === minSim) ? 0.5 : (sim - minSim) / (maxSim - minSim);
    t = Math.max(0, Math.min(1, t));
    return 'rgb(' + Math.round(255 * t) + ',' + Math.round(255 * t) + ',' + Math.round(255 * (1 - t)) + ')';
}

function applySimilarityBorders(baseNodeId, similarities) {
    if (!window.bonsaiCyRef || !similarities || similarities.length === 0) { return; }
    resetAllBordersToBaseline();
    similarities.forEach(function (item) {
        if (item.id === baseNodeId) { return; }
        const node = window.bonsaiCyRef.getElementById('n' + item.id);
        if (node && node.nonempty()) {
            node.style('border-color', simToHeatColor(item.similarity, 0, 1));
            node.style('border-width', 20);
        }
    });
}

/* =============================================================
   6.  Trim helper
   ============================================================= */

function trimTo(id) {
    vscode.postMessage({ command: 'trim', id: id });
}

/* =============================================================
   7.  Window message listener (server → browser, via SSE dispatch)
   ============================================================= */

window.addEventListener('message', function (event) {
    const message = event.data;

    if (message.command === 'setInitialCode') {
        const el = document.getElementById('code');
        if (el) { el.value = message.code; }
    }

    if (message.command === 'loading') {
        const el = document.getElementById('log');
        if (el) { el.innerHTML = '<p class="loading">' + message.text + '</p>'; }
    }

    if (message.command === 'historyUpdate') {
        const log = document.getElementById('log');
        if (log) { log.innerHTML = ''; }
        const container = document.getElementById('output');
        if (!container) { return; }
        container.innerHTML = '';
        message.history.forEach(function (state) {
            const block = document.createElement('div');
            block.className = 'code-block';
            const escapedCode = state.code.replace(/[<>&]/g, function (c) {
                return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
            });
            block.innerHTML =
                '<div class="version-label">#' + state.id + ' - Prompt: ' + state.prompt + '</div>' +
                '<pre>' + escapedCode + '</pre>' +
                '<button onclick="trimTo(' + state.id + ')">✂ Trim to this</button>';
            container.appendChild(block);
        });
    }

    if (message.command === 'urlmodelUpdate') {
        const baseUrlInput = document.getElementById('baseUrlInput');
        const modelInput = document.getElementById('modelInput');
        if (baseUrlInput && message.baseUrl) { baseUrlInput.value = message.baseUrl; }
        if (modelInput && message.LLMmodel) { modelInput.value = message.LLMmodel; }
    }

    if (message.command === 'connectionTestResult') {
        const statusEl = document.getElementById('connectionTestStatus');
        if (statusEl) {
            statusEl.textContent = message.message;
            statusEl.className = message.success ? 'connection-success' : 'connection-error';
        }
    }

    if (message.command === 'agentMdProcessResult') {
        var statusEl = document.getElementById('agentMdProcessStatus');
        if (message.success) {
            // Put the generated code into the code textarea
            var codeEl = document.getElementById('code');
            if (codeEl && message.code) { codeEl.value = message.code; }
            if (statusEl) {
                statusEl.textContent = '✓ Code generated successfully!';
                statusEl.className = 'success';
            }
        } else {
            if (statusEl) {
                statusEl.textContent = '✗ ' + (message.message || 'Processing failed');
                statusEl.className = 'error';
            }
        }
    }

    if (message.command === 'leafSimilarities') {
        renderSimilarities(message.node, message.similarities);
        renderLizardMetrics(message.node);
        if (message.node && Array.isArray(message.similarities) && message.similarities.length) {
            applySimilarityBorders(message.node.id, message.similarities);
        } else {
            resetAllBordersToBaseline();
        }
    }
});

/* =============================================================
   8.  Graph rendering (Cytoscape.js)
      Cytoscape is loaded via CDN in index.html before this script.
   ============================================================= */

window.addEventListener('message', function (event) {
    const message = event.data;
    if (message.command !== 'renderGraph') { return; }

    vscode.postMessage({ command: 'unselectNode' });
    console.log('Rendering graph:', message.graph);
    cleanupAllTooltips();

    const cy = cytoscape({
        container: document.getElementById('graph'),
        elements: [...message.graph.nodes, ...message.graph.edges],
        style: [
            {
                selector: 'node',
                style: {
                    'label': 'data(label)',
                    'background-color': 'data(activityColor)',
                    'border-color': 'data(activityColor)',
                    'color': '#fff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'border-width': 20,
                    'width': 'data(size)',
                    'height': 'data(size)'
                }
            },
            {
                selector: '.selected',
                style: {
                    'border-width': 20,
                    'border-color': 'yellow',
                    'overlay-color': 'yellow',
                    'overlay-opacity': 0.2,
                    'overlay-padding': 20
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 2,
                    'line-color': '#ccc',
                    'target-arrow-color': '#ccc',
                    'target-arrow-shape': 'triangle'
                }
            }
        ],
        layout: {
            name: 'breadthfirst',
            directed: true,
            padding: 10,
            spacingFactor: 1.5,
            animate: false,
            transform: function (node, position) { return { x: position.x, y: -position.y }; }
        }
    });

    window.bonsaiCyRef = cy;

    cy.on('cxttap', 'node', function (evt) {
        const id = parseInt(evt.target.id().slice(1));
        vscode.postMessage({ command: 'unselectNode' });
        vscode.postMessage({ command: 'trim', id: id });
    });

    cy.on('tap', 'node', function (evt) {
        resetAllBordersToBaseline();
        const id = parseInt(evt.target.id().slice(1));
        vscode.postMessage({ command: 'selectNode', id: id });
        cy.nodes().forEach(function (n) { n.removeClass('selected'); });
        evt.target.addClass('selected');

        const codeInput = document.getElementById('code');
        const promptInput = document.getElementById('prompt');
        if (codeInput) { codeInput.value = evt.target.data('code'); }
        if (promptInput) { promptInput.value = evt.target.data('prompt'); }

        const reasoningPanel = document.getElementById('reasoningPanel');
        const reasoningContent = document.getElementById('reasoningContent');
        const reasoning = (evt.target.data('reasoning') || '').toString();
        if (reasoning && reasoning.trim().length > 0) {
            reasoningContent.innerHTML = escapeHtml(reasoning);
            reasoningPanel.style.display = '';
        } else {
            reasoningContent.textContent = '';
            reasoningPanel.removeAttribute('open');
            reasoningPanel.style.display = 'none';
        }
    });

    const graphContainer = document.getElementById('graph');
    graphContainer.addEventListener('mouseleave', hideAllTooltips);
    cy.on('pan zoom', hideAllTooltips);

    cy.nodes().forEach(function (n) {
        const code = n.data('code') || '';
        const label = n.data('label') || '';
        const activity = n.data('activity') || '';
        const html =
            '<div style="white-space:pre-wrap; max-width:360px;">' +
            '<strong>' + label + ': ' + activity + '</strong><br>' +
            '<pre style="margin:0;">' + code.replace(/[<>&]/g, function (c) {
                return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
            }) + '</pre></div>';

        const tip = createTooltipEl(html);
        tooltipsById.set(n.id(), tip);

        n.on('mouseover', function (e) {
            const pos = e.target.renderedPosition();
            const rect = graphContainer.getBoundingClientRect();
            tip.style.left = (rect.left + pos.x + 10) + 'px';
            tip.style.top  = (rect.top  + pos.y + 10) + 'px';
            tip.style.display = 'block';
        });
        n.on('mouseout',  function () { tip.style.display = 'none'; });
        n.on('remove',    function () {
            if (tip && tip.parentNode) { tip.parentNode.removeChild(tip); }
            tooltipsById.delete(n.id());
        });
    });
});

// ---- Tooltip utilities ----
const tooltipsById = new Map();

function createTooltipEl(html) {
    const el = document.createElement('div');
    el.className = 'bonsai-qtip';
    el.style.position   = 'fixed';
    el.style.background = '#333';
    el.style.color      = '#fff';
    el.style.padding    = '6px';
    el.style.borderRadius = '4px';
    el.style.fontSize   = '12px';
    el.style.display    = 'none';
    el.style.zIndex     = '1000';
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
}

function hideAllTooltips() {
    tooltipsById.forEach(function (el) { el.style.display = 'none'; });
}

function cleanupAllTooltips() {
    tooltipsById.forEach(function (el) {
        if (el && el.parentNode) { el.parentNode.removeChild(el); }
    });
    tooltipsById.clear();
}

/* =============================================================
   9.  Activity templates + button flow
   ============================================================= */

const ACTIVITY_TEMPLATES = {
    fix_with_context: function (problem) {
        return (
            'You are an expert software engineer. You will be given CODE (from the user) and a PROBLEM DESCRIPTION (below).\n' +
            'Your task is to FIX the code to solve ONLY the described problem, keeping behavior otherwise unchanged.\n' +
            '- Keep the public API stable unless strictly needed.\n' +
            '- Prefer minimal, targeted changes with clear rationale.\n' +
            '- If tests exist, preserve them; if not, keep code testable.\n\n' +
            'PROBLEM DESCRIPTION:\n' + problem
        ).trim();
    },
    fix_without_context: function () {
        return (
            'You are an expert software engineer. You will be given CODE (from the user).\n' +
            'First, infer the most likely primary defect or weakness, then FIX it with minimal, targeted changes.\n' +
            '- Keep behavior otherwise unchanged.\n' +
            '- Keep the public API stable unless strictly needed.\n' +
            '- Make the code testable and maintainable.'
        ).trim();
    },
    gen_tests: function () {
        return (
            'You are a senior engineer. Your task is to APPEND unit tests to the provided source code, WITHOUT modifying the source. STRICTLY follow these rules:\n' +
            '- INCLUDE in the answer the original source code in the prompt. Do NOT change, reorder, format, or delete any line of the original source.\n' +
            '- Cover the fixed behavior and edge cases. Prefer small, isolated tests.\n' +
            '- Include any necessary test doubles.'
        ).trim();
    },
    refactor: function () {
        return (
            'Refactor the given CODE to improve readability, maintainability, and structure WITHOUT changing behavior.\n' +
            '- Apply small, safe refactorings (naming, decomposition, DRY, cohesion, comments where useful).\n' +
            '- Do not change external behavior or public API.'
        ).trim();
    },
    exceptions: function () {
        return (
            'Harden the given CODE with robust error/exception handling.\n' +
            '- Add meaningful exceptions and messages.\n' +
            '- Avoid blanket catches; keep failures observable.\n' +
            '- Do not change external behavior except to handle errors gracefully.'
        ).trim();
    }
};

let initialActivityDone = false;

function setFollowupEnabled(enabled) {
    document.getElementById('btnGenTests').disabled   = !enabled;
    document.getElementById('btnRefactor').disabled   = !enabled;
    document.getElementById('btnExceptions').disabled = !enabled;
}

function setInitialFixEnabled(enabled) {
    document.getElementById('btnFixWith').disabled    = !enabled;
    document.getElementById('btnFixNoCtx').disabled   = !enabled;
    const div = document.getElementById('problemDescDiv');
    if (div) { div.style.display = enabled ? 'block' : 'none'; }
}

function resetFlow() {
    initialActivityDone = false;
    setInitialFixEnabled(true);
    setFollowupEnabled(false);
}

window.addEventListener('message', function (event) {
    const message = event.data;
    if (message.command === 'setActivityFlow') {
        initialActivityDone = message.initialDone;
        setInitialFixEnabled(!initialActivityDone);
        setFollowupEnabled(initialActivityDone);
    }
});

function getBaseCode() {
    return document.getElementById('code').value;
}

function getVersionCount() {
    const v = parseInt(document.getElementById('versionCount').value, 10);
    return Number.isFinite(v) && v > 0 ? v : 1;
}

function runActivity(activityKey) {
    let prompt = '';
    if (activityKey === 'fix_with_context') {
        const problem = (document.getElementById('problemDesc').value || '').trim();
        if (!problem) { console.log('Please provide a problem description.'); return; }
        prompt = ACTIVITY_TEMPLATES.fix_with_context(problem);
    } else if (activityKey === 'fix_without_context') {
        prompt = ACTIVITY_TEMPLATES.fix_without_context();
    } else if (activityKey === 'gen_tests') {
        if (!initialActivityDone) { console.log('Run one initial activity first.'); return; }
        prompt = ACTIVITY_TEMPLATES.gen_tests();
    } else if (activityKey === 'refactor') {
        if (!initialActivityDone) { console.log('Run one initial activity first.'); return; }
        prompt = ACTIVITY_TEMPLATES.refactor();
    } else if (activityKey === 'exceptions') {
        if (!initialActivityDone) { console.log('Run one initial activity first.'); return; }
        prompt = ACTIVITY_TEMPLATES.exceptions();
    } else {
        console.warn('Unknown activity:', activityKey);
        return;
    }

    setInitialFixEnabled(false);
    setFollowupEnabled(false);

    const baseUrl = document.getElementById('baseUrlInput').value || '';
    const model   = document.getElementById('modelInput').value   || '';

    vscode.postMessage({
        command:      'generate',
        prompt:       prompt,
        code:         getBaseCode(),
        versionCount: getVersionCount(),
        activity:     activityKey,
        baseUrl:      baseUrl,
        model:        model
    });

    document.getElementById('log').innerHTML = '<p class="loading">Generating...</p>';
}

// Wire activity buttons
document.getElementById('btnFixWith').addEventListener('click',     function () { runActivity('fix_with_context'); });
document.getElementById('btnFixNoCtx').addEventListener('click',    function () { runActivity('fix_without_context'); });
document.getElementById('btnGenTests').addEventListener('click',    function () { runActivity('gen_tests'); });
document.getElementById('btnRefactor').addEventListener('click',    function () { runActivity('refactor'); });
document.getElementById('btnExceptions').addEventListener('click',  function () { runActivity('exceptions'); });

// Initialise flow state
resetFlow();
