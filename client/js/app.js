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
    const model = getSelectedModelId();
    const statusEl = document.getElementById('connectionTestStatus');
    if (statusEl) {
        statusEl.textContent = 'Testing Pi model...';
        statusEl.className = 'connection-testing';
    }
    vscode.postMessage({ command: 'testConnection', model: model });
});

document.getElementById('btnLoadPiModels').addEventListener('click', function () {
    const statusEl = document.getElementById('piModelsStatus');
    if (statusEl) {
        statusEl.textContent = 'Loading Pi models...';
        statusEl.className = 'connection-testing';
    }
    vscode.postMessage({ command: 'loadPiModels' });
});

document.getElementById('modelInput').addEventListener('change', function () {
    applySelectedModelConfiguration();
});

// Analysis log toggle and clear button handlers
var btnToggleLog = document.getElementById('btnToggleAnalysisLog');
var logContent = document.getElementById('analysisLogContent');
var btnClearLog = document.getElementById('btnClearAnalysisLog');

if (btnToggleLog && logContent) {
    btnToggleLog.addEventListener('click', function () {
        var isHidden = logContent.style.display === 'none';
        logContent.style.display = isHidden ? 'block' : 'none';
        btnToggleLog.textContent = (isHidden ? '▼' : '▶') + ' Analysis Log';
        if (btnClearLog) {
            btnClearLog.style.display = isHidden ? 'inline-block' : 'none';
        }
    });
}

if (btnClearLog) {
    btnClearLog.addEventListener('click', function () {
        analysisLogClear();
    });
}

// Collect GitHub issues button handler
document.getElementById('btnCollectIssues').addEventListener('click', function () {
    var repoUrl = document.getElementById('githubRepoUrl').value || '';
    var statusEl = document.getElementById('collectIssuesStatus');
    if (!repoUrl.trim()) {
        if (statusEl) {
            statusEl.textContent = 'Please enter a GitHub repository URL.';
            statusEl.className = 'error';
        }
        return;
    }
    if (statusEl) {
        statusEl.textContent = 'Collecting issues...';
        statusEl.className = 'processing';
    }
    vscode.postMessage({
        command: 'collectGitHubIssues',
        repoUrl: repoUrl
    });
});

document.getElementById('btnAnalyzeRepoForFix').addEventListener('click', function () {
    var repoUrl = document.getElementById('githubRepoUrl').value || '';
    var issue = currentSelectedIssue();
    var statusEl = document.getElementById('repoAnalysisStatus');
    var instructionsEl = document.getElementById('codeGenerationInstructions');
    var generationInstructions = instructionsEl ? instructionsEl.value : '';

    if (!repoUrl.trim() || !issue) {
        if (statusEl) {
            statusEl.textContent = 'Select a repository and issue first.';
            statusEl.className = 'issue-analysis-status error';
        }
        return;
    }

    if (statusEl) {
        statusEl.textContent = 'Running repository analysis with the selected Pi model...';
        statusEl.className = 'issue-analysis-status processing';
    }

    analysisLogClear();
    fixAlternativesClear();
    analysisChecklistStart();
    var modelId = getSelectedModelId();
    analysisLogSetModel(modelId);

    applySelectedModelConfiguration();
    vscode.postMessage({
        command: 'analyzeRepoForFix',
        repoUrl: repoUrl,
        issue: issue,
        model: modelId,
        generationInstructions: generationInstructions
    });
});

/* =============================================================
   Analysis Log Pane Management
   ============================================================= */

var analysisLogState = { model: '', steps: [] };
var analysisLogStartTime = 0;

var DEFAULT_ANALYSIS_CHECKLIST = [
    'Validate GitHub URL',
    'Rephrase issue into search signals',
    'Clone/update source repository',
    'Identify potential bug locations',
    'Draft 4 fix-plan alternatives',
    'Create 4 isolated repository clones',
    'Generate and apply 4 fixes',
    'Run build and tests in each clone',
    'Display 4 validated fix candidates'
];
var analysisChecklistState = [];
var latestFixAlternatives = [];
var latestFixAlternativeContext = { repoUrl: '', issue: null };

function analysisLogClear() {
    analysisLogState = { model: '', steps: [] };
    analysisLogStartTime = Date.now();
    var stepsDiv = document.getElementById('analysisLogSteps');
    if (stepsDiv) { stepsDiv.innerHTML = ''; }
    analysisChecklistClear();
}

function analysisLogSetModel(modelId) {
    analysisLogState.model = modelId || 'Unknown';
    var modelDiv = document.getElementById('analysisLogModel');
    if (modelDiv) {
        modelDiv.textContent = 'Model: ' + escapeHtml(analysisLogState.model);
    }
}

function analysisLogAddStep(stepName, detail, status) {
    var elapsed = Math.round((Date.now() - analysisLogStartTime) / 100) / 10 + 's';
    var step = {
        name: stepName,
        detail: detail || '',
        status: status || 'pending',
        elapsed: elapsed
    };
    analysisLogState.steps.push(step);
    analysisLogRender();
}

function analysisLogUpdateStep(stepIndex, status, detail) {
    if (stepIndex >= 0 && stepIndex < analysisLogState.steps.length) {
        analysisLogState.steps[stepIndex].status = status;
        if (detail !== undefined) {
            analysisLogState.steps[stepIndex].detail = detail;
        }
        analysisLogState.steps[stepIndex].elapsed = Math.round((Date.now() - analysisLogStartTime) / 100) / 10 + 's';
        analysisLogRender();
    }
}

function analysisLogRender() {
    var stepsDiv = document.getElementById('analysisLogSteps');
    if (!stepsDiv) { return; }
    stepsDiv.innerHTML = '';
    analysisLogState.steps.forEach(function (step) {
        var stepEl = document.createElement('div');
        stepEl.className = 'log-step ' + step.status;
        var titleEl = document.createElement('span');
        titleEl.className = 'log-step-title';
        titleEl.textContent = step.name + ' [' + step.elapsed + ']';
        stepEl.appendChild(titleEl);
        if (step.detail) {
            var detailEl = document.createElement('span');
            detailEl.className = 'log-step-detail';
            detailEl.textContent = step.detail;
            stepEl.appendChild(detailEl);
        }
        stepsDiv.appendChild(stepEl);
    });
}

function analysisChecklistClear() {
    analysisChecklistState = [];
    analysisChecklistRender();
}

function analysisChecklistStart() {
    analysisChecklistState = DEFAULT_ANALYSIS_CHECKLIST.map(function (title) {
        return { title: title, detail: '', status: 'pending' };
    });
    analysisChecklistRender();
}

function analysisChecklistEnsureStep(stepIndex, stepName) {
    if (!analysisChecklistState.length) {
        analysisChecklistStart();
    }
    while (stepIndex >= analysisChecklistState.length) {
        analysisChecklistState.push({ title: 'Step ' + (analysisChecklistState.length + 1), detail: '', status: 'pending' });
    }
    if (stepName && !DEFAULT_ANALYSIS_CHECKLIST[stepIndex]) {
        analysisChecklistState[stepIndex].title = stepName;
    }
}

function analysisChecklistUpdateStep(stepIndex, stepName, status, detail) {
    if (typeof stepIndex !== 'number' || stepIndex < 0) { return; }
    analysisChecklistEnsureStep(stepIndex, stepName);
    if (status) {
        analysisChecklistState[stepIndex].status = status;
    }
    if (detail !== undefined) {
        analysisChecklistState[stepIndex].detail = detail || '';
    } else if (stepName && stepName !== analysisChecklistState[stepIndex].title) {
        analysisChecklistState[stepIndex].detail = stepName;
    }
    analysisChecklistRender();
}

function analysisChecklistMarkError(detail) {
    if (!analysisChecklistState.length) {
        analysisChecklistStart();
    }
    var runningIndex = analysisChecklistState.findIndex(function (step) { return step.status === 'running'; });
    var targetIndex = runningIndex >= 0 ? runningIndex : analysisChecklistState.findIndex(function (step) { return step.status === 'pending'; });
    if (targetIndex < 0) { targetIndex = analysisChecklistState.length - 1; }
    analysisChecklistState[targetIndex].status = 'error';
    analysisChecklistState[targetIndex].detail = detail || analysisChecklistState[targetIndex].detail || 'Analysis failed.';
    analysisChecklistRender();
}

function analysisChecklistRender() {
    var listEl = document.getElementById('analysisChecklist');
    var progressEl = document.getElementById('analysisChecklistProgress');
    if (!listEl) { return; }

    listEl.innerHTML = '';
    if (!analysisChecklistState.length) {
        var emptyEl = document.createElement('li');
        emptyEl.className = 'checklist-empty';
        emptyEl.textContent = 'Run “Analyze Repo for Fix” to see the steps.';
        listEl.appendChild(emptyEl);
        if (progressEl) { progressEl.textContent = '0/0 done'; }
        return;
    }

    var completed = analysisChecklistState.filter(function (step) { return step.status === 'completed'; }).length;
    if (progressEl) { progressEl.textContent = completed + '/' + analysisChecklistState.length + ' done'; }

    analysisChecklistState.forEach(function (step, index) {
        var itemEl = document.createElement('li');
        itemEl.className = 'checklist-item ' + step.status;

        var markerEl = document.createElement('span');
        markerEl.className = 'checklist-marker';
        markerEl.textContent = step.status === 'completed' ? '✓' : step.status === 'error' ? '!' : String(index + 1);
        itemEl.appendChild(markerEl);

        var bodyEl = document.createElement('div');
        var titleEl = document.createElement('span');
        titleEl.className = 'checklist-title';
        titleEl.textContent = step.title;
        bodyEl.appendChild(titleEl);

        if (step.detail) {
            var detailEl = document.createElement('span');
            detailEl.className = 'checklist-detail';
            detailEl.textContent = step.detail;
            bodyEl.appendChild(detailEl);
        }

        itemEl.appendChild(bodyEl);
        listEl.appendChild(itemEl);
    });
}

function fixAlternativesClear() {
    latestFixAlternatives = [];
    latestFixAlternativeContext = { repoUrl: '', issue: null };
    var panel = document.getElementById('fixAlternativesPanel');
    var cards = document.getElementById('fixAlternativesCards');
    var summary = document.getElementById('fixAlternativesSummary');
    if (panel) { panel.style.display = 'none'; }
    if (cards) { cards.innerHTML = ''; }
    if (summary) { summary.textContent = ''; }
}

function appendTextRow(container, label, value) {
    if (!value) { return; }
    var labelEl = document.createElement('label');
    labelEl.textContent = label;
    container.appendChild(labelEl);
    var valueEl = document.createElement('div');
    valueEl.textContent = value;
    container.appendChild(valueEl);
}

function renderFixAlternatives(alternatives, context) {
    latestFixAlternatives = Array.isArray(alternatives) ? alternatives : [];
    latestFixAlternativeContext = context || { repoUrl: '', issue: null };

    var panel = document.getElementById('fixAlternativesPanel');
    var cards = document.getElementById('fixAlternativesCards');
    var summary = document.getElementById('fixAlternativesSummary');
    if (!panel || !cards) { return; }

    cards.innerHTML = '';
    if (!latestFixAlternatives.length) {
        panel.style.display = 'none';
        if (summary) { summary.textContent = ''; }
        return;
    }

    panel.style.display = 'block';
    if (summary) { summary.textContent = latestFixAlternatives.length + ' alternatives'; }

    latestFixAlternatives.forEach(function (alternative, index) {
        var card = document.createElement('section');
        card.className = 'fix-alternative-card';

        var title = document.createElement('h4');
        title.textContent = 'Alternative ' + (index + 1) + ': ' + (alternative.title || 'Untitled fix plan');
        card.appendChild(title);

        if (alternative.summary) {
            var summaryP = document.createElement('p');
            summaryP.className = 'fix-alternative-summary';
            summaryP.textContent = alternative.summary;
            card.appendChild(summaryP);
        }

        if (alternative.execution) {
            var execution = alternative.execution;
            var executionBox = document.createElement('div');
            executionBox.className = 'fix-execution-summary status-' + String(execution.status || 'unknown').toLowerCase();
            appendTextRow(executionBox, 'Candidate status', execution.status);
            appendTextRow(executionBox, 'Isolated clone', execution.workspacePath);
            appendTextRow(executionBox, 'Changed files', Array.isArray(execution.changedFiles) ? execution.changedFiles.join('\n') : '');
            appendTextRow(executionBox, 'Build', execution.build ? execution.build.status + ' — ' + execution.build.displayCommand : 'unavailable');
            appendTextRow(executionBox, 'Tests', execution.test ? execution.test.status + ' — ' + execution.test.displayCommand : 'unavailable');
            appendTextRow(executionBox, 'Diff', execution.diffPath);
            appendTextRow(executionBox, 'Report', execution.reportPath);
            appendTextRow(executionBox, 'Error', execution.error);
            card.appendChild(executionBox);
        }

        var implementations = Array.isArray(alternative.implementations) && alternative.implementations.length
            ? alternative.implementations
            : [{ title: 'Implementation 1', summary: '', todos: alternative.todos || [] }];
        implementations.forEach(function (implementation, implementationIndex) {
            var implementationSection = document.createElement('div');
            implementationSection.className = 'fix-implementation';

            var implementationTitle = document.createElement('h5');
            implementationTitle.textContent = 'Implementation ' + (implementationIndex + 1) + ': ' + (implementation.title || 'Untitled implementation');
            implementationSection.appendChild(implementationTitle);

            if (implementation.summary) {
                var implementationSummary = document.createElement('p');
                implementationSummary.className = 'fix-implementation-summary';
                implementationSummary.textContent = implementation.summary;
                implementationSection.appendChild(implementationSummary);
            }

            var todoList = document.createElement('ul');
            todoList.className = 'fix-todo-list';
            (implementation.todos || []).forEach(function (todo) {
                var item = document.createElement('li');
                item.className = 'fix-todo-item';
                appendTextRow(item, 'Bug location', todo.bugLocation);
                appendTextRow(item, 'Fix idea', todo.fixIdea);
                appendTextRow(item, 'Potential method', todo.potentialMethod);
                if (todo.sourceCodeSketch) {
                    var codeLabel = document.createElement('label');
                    codeLabel.textContent = 'Potential source code';
                    item.appendChild(codeLabel);
                    var code = document.createElement('pre');
                    code.className = 'fix-code-sketch';
                    code.textContent = todo.sourceCodeSketch;
                    item.appendChild(code);
                }
                if (Array.isArray(todo.tests) && todo.tests.length) {
                    appendTextRow(item, 'Tests/checks', todo.tests.join('\n'));
                }
                todoList.appendChild(item);
            });
            implementationSection.appendChild(todoList);
            card.appendChild(implementationSection);
        });

        var button = document.createElement('button');
        button.className = 'btn-create-fix-node';
        button.type = 'button';
        button.textContent = 'Create Bonsai node from this plan';
        button.addEventListener('click', function () {
            vscode.postMessage({
                command: 'createFixAlternativeNode',
                repoUrl: latestFixAlternativeContext.repoUrl,
                issue: latestFixAlternativeContext.issue,
                alternative: alternative
            });
        });
        card.appendChild(button);
        cards.appendChild(card);
    });
}

/* =============================================================
   3.  General helpers
   ============================================================= */

function escapeHtml(s) {
    return String(s).replace(/[<>&"']/g, function (c) {
        return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function ensureModelOption(selectEl, modelId) {
    if (!selectEl || !modelId) { return; }
    var exists = Array.prototype.some.call(selectEl.options, function (option) {
        return option.value === modelId;
    });
    if (!exists) {
        var option = document.createElement('option');
        option.value = modelId;
        option.textContent = modelId;
        selectEl.appendChild(option);
    }
}

function updateModelDropdown(availableModels, selectedModel) {
    var modelInput = document.getElementById('modelInput');
    if (!modelInput) { return; }

    if (Array.isArray(availableModels) && availableModels.length > 0) {
        modelInput.disabled = false;
        modelInput.innerHTML = '';
        availableModels.forEach(function (modelId) {
            if (!modelId) { return; }
            var option = document.createElement('option');
            option.value = modelId;
            option.textContent = modelId;
            option.setAttribute('data-model-id', modelId);
            modelInput.appendChild(option);
        });

        var nextValue = availableModels.indexOf(selectedModel) >= 0 ? selectedModel : availableModels[0];
        modelInput.value = nextValue;
        return;
    }

    modelInput.innerHTML = '';
    var option = document.createElement('option');
    option.value = '';
    option.textContent = 'No models available';
    modelInput.appendChild(option);
    modelInput.disabled = true;
}

function selectedModelOption() {
    var modelInput = document.getElementById('modelInput');
    if (!modelInput || modelInput.selectedIndex < 0) { return null; }
    return modelInput.options[modelInput.selectedIndex] || null;
}

function getSelectedModelId() {
    var option = selectedModelOption();
    if (option) {
        return option.value || '';
    }
    var modelInput = document.getElementById('modelInput');
    return modelInput ? (modelInput.value || '') : '';
}

function applySelectedModelConfiguration() {
    // Pi-only mode: all model execution is delegated through Pi by model value.
}

function appendPiModelsToDropdown(models) {
    var modelInput = document.getElementById('modelInput');
    if (!modelInput || !Array.isArray(models)) { return 0; }

    var firstCompatibleValue = '';
    var added = 0;
    models.forEach(function (model) {
        if (!model || !model.id || !model.provider) { return; }

        var optionValue = 'pi:' + model.provider + ':' + model.id;
        var existingOption = null;
        Array.prototype.some.call(modelInput.options, function (option) {
            if (option.value === optionValue) {
                existingOption = option;
                return true;
            }
            return false;
        });

        var label = '[Pi] ' + model.providerName + ' / ' + model.id;
        var option = existingOption || document.createElement('option');
        option.value = optionValue;
        option.textContent = label + (model.compatible ? '' : ' (auth required)');
        option.title = model.reason || '';
        option.disabled = !model.compatible;
        option.setAttribute('data-source', 'pi');
        option.setAttribute('data-model-id', model.id);
        option.setAttribute('data-provider', model.provider);
        option.setAttribute('data-subscription', 'true');
        if (!existingOption) {
            modelInput.appendChild(option);
            added += 1;
        }

        if (model.compatible && !firstCompatibleValue) {
            firstCompatibleValue = optionValue;
        }
    });

    if (firstCompatibleValue) {
        modelInput.disabled = false;
        modelInput.value = firstCompatibleValue;
        applySelectedModelConfiguration();
    }
    return added;
}

/* =============================================================
   4.  GitHub issue rendering
   ============================================================= */

let collectedIssuesState = [];
let selectedIssueIndex = -1;

function currentSelectedIssue() {
    return selectedIssueIndex >= 0 ? collectedIssuesState[selectedIssueIndex] : null;
}

function issueDescription(issue) {
    var body = (issue && issue.body ? String(issue.body).trim() : '');
    return body || 'No description provided.';
}

function issueLabels(issue) {
    return (issue.labels || [])
        .map(function (label) { return label && label.name; })
        .filter(Boolean)
        .join(', ');
}

function parseIssuesFromMarkdown(content) {
    var text = String(content || '');
    if (!text.trim() || /No open issues found\./i.test(text)) { return []; }

    var issues = [];
    var blocks = text.split(/\n(?=## #\d+: )/g);
    blocks.forEach(function (block) {
        var heading = block.match(/^## #(\d+):\s*(.+)$/m);
        if (!heading) { return; }

        var issue = {
            number: Number(heading[1]),
            title: heading[2].trim(),
            html_url: '',
            user: undefined,
            labels: [],
            comments: undefined,
            created_at: undefined,
            updated_at: undefined,
            body: ''
        };

        block.split(/\r?\n/).forEach(function (line) {
            var value;
            if (line.indexOf('- URL: ') === 0) {
                issue.html_url = line.slice('- URL: '.length).trim();
            } else if (line.indexOf('- Author: @') === 0) {
                issue.user = { login: line.slice('- Author: @'.length).trim() };
            } else if (line.indexOf('- Labels: ') === 0) {
                value = line.slice('- Labels: '.length).trim();
                issue.labels = value ? value.split(/,\s*/).map(function (name) { return { name: name }; }) : [];
            } else if (line.indexOf('- Comments: ') === 0) {
                value = Number(line.slice('- Comments: '.length).trim());
                if (Number.isFinite(value)) { issue.comments = value; }
            } else if (line.indexOf('- Created: ') === 0) {
                issue.created_at = line.slice('- Created: '.length).trim();
            } else if (line.indexOf('- Updated: ') === 0) {
                issue.updated_at = line.slice('- Updated: '.length).trim();
            } else if (line.indexOf('- Summary: ') === 0) {
                issue.body = line.slice('- Summary: '.length).trim();
            }
        });

        issues.push(issue);
    });

    return issues;
}

function selectIssue(index) {
    var issue = collectedIssuesState[index];
    if (!issue) { return; }
    selectedIssueIndex = index;

    var analyzeButton = document.getElementById('btnAnalyzeRepoForFix');
    if (analyzeButton) { analyzeButton.disabled = false; }

    var listEl = document.getElementById('issuesList');
    if (listEl) {
        Array.prototype.forEach.call(listEl.querySelectorAll('.issue-list-item'), function (button) {
            button.classList.toggle('selected', Number(button.getAttribute('data-index')) === index);
        });
    }

    var titleEl = document.getElementById('selectedIssueTitle');
    var metaEl = document.getElementById('selectedIssueMeta');
    var bodyEl = document.getElementById('selectedIssueBody');
    var labels = issueLabels(issue);

    if (titleEl) { titleEl.textContent = '#' + issue.number + ': ' + issue.title; }
    if (metaEl) {
        metaEl.innerHTML = '';
        var metaParts = [];
        if (issue.html_url) { metaParts.push('<a href="' + escapeHtml(issue.html_url) + '" target="_blank" rel="noreferrer">Open on GitHub</a>'); }
        if (issue.user && issue.user.login) { metaParts.push('Author: @' + escapeHtml(issue.user.login)); }
        if (labels) { metaParts.push('Labels: ' + escapeHtml(labels)); }
        if (typeof issue.comments === 'number') { metaParts.push('Comments: ' + issue.comments); }
        if (issue.updated_at) { metaParts.push('Updated: ' + escapeHtml(issue.updated_at)); }
        metaEl.innerHTML = metaParts.join(' · ');
    }
    if (bodyEl) { bodyEl.textContent = issueDescription(issue); }
}

function renderIssuesExplorer(issues) {
    var explorerEl = document.getElementById('issuesExplorer');
    var listEl = document.getElementById('issuesList');
    var titleEl = document.getElementById('selectedIssueTitle');
    var metaEl = document.getElementById('selectedIssueMeta');
    var bodyEl = document.getElementById('selectedIssueBody');
    if (!explorerEl || !listEl) { return; }

    collectedIssuesState = Array.isArray(issues) ? issues : [];
    selectedIssueIndex = -1;
    var analyzeButton = document.getElementById('btnAnalyzeRepoForFix');
    if (analyzeButton) { analyzeButton.disabled = true; }
    explorerEl.style.display = 'grid';
    listEl.innerHTML = '';

    if (collectedIssuesState.length === 0) {
        listEl.innerHTML = '<div class="empty-issues">No open issues found.</div>';
        if (titleEl) { titleEl.textContent = 'No issues found'; }
        if (metaEl) { metaEl.textContent = ''; }
        if (bodyEl) { bodyEl.textContent = 'This repository has no open issues in the public GitHub issue list.'; }
        return;
    }

    collectedIssuesState.forEach(function (issue, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'issue-list-item';
        button.setAttribute('data-index', String(index));

        var title = document.createElement('span');
        title.className = 'issue-list-title';
        title.textContent = '#' + issue.number + ' ' + issue.title;

        var preview = document.createElement('span');
        preview.className = 'issue-list-preview';
        preview.textContent = issueDescription(issue).slice(0, 140);

        button.appendChild(title);
        button.appendChild(preview);
        button.addEventListener('click', function () { selectIssue(index); });
        listEl.appendChild(button);
    });

    selectIssue(0);
}

/* =============================================================
   5.  Similarity + metrics rendering
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
        updateModelDropdown(message.availableModels, message.LLMmodel);
    }

    if (message.command === 'connectionTestResult') {
        const statusEl = document.getElementById('connectionTestStatus');
        if (statusEl) {
            statusEl.textContent = message.message;
            statusEl.className = message.success ? 'connection-success' : 'connection-error';
        }
        if (message.success) {
            updateModelDropdown(message.availableModels, message.selectedModel);
        }
    }

    if (message.command === 'piModelsUpdate') {
        var piStatusEl = document.getElementById('piModelsStatus');
        if (message.success) {
            var added = appendPiModelsToDropdown(message.models || []);
            if (piStatusEl) {
                var piModels = (message.models || []).filter(function(m) { return m.compatible; }).length;
                var warning = message.warning ? ' Config warning: ' + message.warning : '';
                piStatusEl.textContent = '✓ Loaded ' + piModels + ' configured Pi model' + (piModels === 1 ? '' : 's') + '. Credentials are managed by Pi.' + (added ? '' : ' Already loaded.') + warning;
                piStatusEl.className = 'connection-success';
            }
        } else if (piStatusEl) {
            piStatusEl.textContent = '✗ ' + (message.message || 'Unable to load Pi models');
            piStatusEl.className = 'connection-error';
        }
    }

    if (message.command === 'collectGitHubIssuesResult') {
        var issuesStatusEl = document.getElementById('collectIssuesStatus');
        var issuesTextarea = document.getElementById('collectedIssues');
        if (message.success) {
            var issues = Array.isArray(message.issues) ? message.issues : parseIssuesFromMarkdown(message.content);
            renderIssuesExplorer(issues);
            if (issuesTextarea && message.content) {
                issuesTextarea.value = message.content;
            }
            if (issuesStatusEl) {
                var count = typeof message.issueCount === 'number' ? message.issueCount : issues.length;
                issuesStatusEl.textContent = '✓ Collected ' + count + ' issue' + (count === 1 ? '' : 's') + '!';
                issuesStatusEl.className = 'success';
            }
        } else {
            if (issuesStatusEl) {
                issuesStatusEl.textContent = '✗ ' + (message.message || 'Issue collection failed');
                issuesStatusEl.className = 'error';
            }
        }
    }

    if (message.command === 'repoIssueAnalysisResult') {
        var repoAnalysisStatus = document.getElementById('repoAnalysisStatus');
        if (repoAnalysisStatus) {
            repoAnalysisStatus.textContent = message.message || '';
            if (message.loading) {
                repoAnalysisStatus.className = 'issue-analysis-status processing';
            } else {
                repoAnalysisStatus.className = message.success ? 'issue-analysis-status success' : 'issue-analysis-status error';
            }
        }
        if (message.success && message.specPath && repoAnalysisStatus) {
            repoAnalysisStatus.textContent = (message.message || 'Analysis complete.') + ' Spec: ' + message.specPath;
        }
        if (message.success && Array.isArray(message.fixAlternatives)) {
            renderFixAlternatives(message.fixAlternatives, {
                repoUrl: document.getElementById('githubRepoUrl') ? document.getElementById('githubRepoUrl').value || '' : '',
                issue: currentSelectedIssue()
            });
        }
        if (message.success && message.node && message.node.code) {
            var codeEl = document.getElementById('code');
            if (codeEl) { codeEl.value = message.node.code; }
        }
    }

    if (message.command === 'createFixAlternativeNodeResult') {
        var createStatus = document.getElementById('repoAnalysisStatus');
        if (createStatus) {
            createStatus.textContent = message.message || '';
            createStatus.className = message.success ? 'issue-analysis-status success' : 'issue-analysis-status error';
        }
    }

    if (message.command === 'analysisLogStep') {
        if (message.action === 'add') {
            analysisLogAddStep(message.stepName, message.detail, message.status);
            analysisChecklistUpdateStep(message.stepIndex, message.stepName, message.status || 'pending', message.detail);
        } else if (message.action === 'update') {
            analysisLogUpdateStep(message.stepIndex, message.status, message.detail);
            analysisChecklistUpdateStep(message.stepIndex, message.stepName, message.status, message.detail);
        } else if (message.action === 'error') {
            analysisLogAddStep('Error', message.detail, 'error');
            analysisChecklistMarkError(message.detail);
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
    // No-op: all activities are always enabled now
}

function setInitialFixEnabled(enabled) {
    // No-op: fix buttons removed
}

function resetFlow() {
    // No-op: all activities are always enabled now
}

window.addEventListener('message', function (event) {
    const message = event.data;
    if (message.command === 'setActivityFlow') {
        // No-op: flow management removed
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
    if (activityKey === 'gen_tests') {
        prompt = ACTIVITY_TEMPLATES.gen_tests();
    } else if (activityKey === 'refactor') {
        prompt = ACTIVITY_TEMPLATES.refactor();
    } else if (activityKey === 'exceptions') {
        prompt = ACTIVITY_TEMPLATES.exceptions();
    } else {
        console.warn('Unknown activity:', activityKey);
        return;
    }

    applySelectedModelConfiguration();
    const model   = getSelectedModelId();

    vscode.postMessage({
        command:      'generate',
        prompt:       prompt,
        code:         getBaseCode(),
        versionCount: getVersionCount(),
        activity:     activityKey,
        model:        model
    });

    document.getElementById('log').innerHTML = '<p class="loading">Generating...</p>';
}

// Wire activity buttons
document.getElementById('btnGenTests').addEventListener('click',    function () { runActivity('gen_tests'); });
document.getElementById('btnRefactor').addEventListener('click',    function () { runActivity('refactor'); });
document.getElementById('btnExceptions').addEventListener('click',  function () { runActivity('exceptions'); });

// Initialise flow state (no-op now)
resetFlow();
