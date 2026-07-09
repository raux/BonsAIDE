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
import { analyzeRepoForIssue, writeFixSpecFile, IssueLocationHypothesis, RepoIssueAnalysis } from './repo-analyzer';
import { discoverPiModels } from './pi-models';
import { generateViaSubscription, promptViaPiModel } from './pi-subscription-rpc';
import { formatGitHubIssues, GitHubIssueForDisplay, mimeType, parseGitHubUrl } from './server-utils';

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
let LLMmodel: string = process.env.BONSAI_PI_MODEL ?? '';
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

interface SelectedPiModel {
  provider: string;
  modelId: string;
}

function parseSelectedPiModel(value: string): SelectedPiModel | null {
  const match = typeof value === 'string' ? value.match(/^pi:([^:]+):(.+)$/) : null;
  return match ? { provider: match[1], modelId: match[2] } : null;
}

function requireSelectedPiModel(value = LLMmodel): SelectedPiModel {
  const selected = parseSelectedPiModel(value);
  if (!selected) {
    throw new Error('Select a Pi model first. Click "Load Pi Models" and choose a configured Pi model.');
  }
  return selected;
}

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
// LLM execution is Pi-only. BonsAIDE never calls local model endpoints directly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LLM – processAgentMdWithLLM (processes Agent.md content to generate code)
// ---------------------------------------------------------------------------

async function processAgentMdWithLLM(
  agentMdContent: string
): Promise<{ content: string; reasoning: string }> {
  const selected = requireSelectedPiModel();
  const prompt = `
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

Agent.md specification:
${agentMdContent}
  `.trim();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await promptViaPiModel({
        provider: selected.provider,
        modelId: selected.modelId,
        prompt,
        timeoutMs: 300000
      });
      const output = result.text;
      const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
      const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
      const content = codeMatch?.[1]?.trim() ?? '';
      const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

      if (content) { return { content, reasoning }; }
      console.warn('No <code> block found in Pi model response. Retrying...');
    } catch (err) {
      console.warn('Error during Agent.md processing via Pi:', (err as Error).message);
      if (attempt === 2) { throw err; }
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

export function buildIssueLocationHypothesisPrompt(issue: GitHubIssueForDisplay): string {
  return `
You are a senior software-maintenance agent. Rephrase this GitHub issue into repository-search signals that can help locate the likely bug area before any code is executed.

Return ONLY valid JSON with this exact shape:
{
  "rephrasedIssue": "one concise maintenance-focused restatement",
  "suspectedBehavior": ["observable broken behavior or invariant"],
  "likelyComponents": ["component, subsystem, feature, CLI command, UI area, or integration"],
  "likelyFiles": ["possible file/path names or path fragments; use cautious guesses"],
  "likelyFunctions": ["possible function/class/method/identifier names"],
  "searchSignals": ["concrete search terms, error strings, config keys, command names, or domain words"],
  "negativeSignals": ["terms that likely indicate unrelated areas"]
}

Rules:
- Keep arrays short: 3 to 8 items each.
- Prefer terms likely to appear in code: identifiers, file stems, commands, error messages, configuration names.
- Do not claim certainty. Use cautious location hypotheses.
- Do not include Markdown or code fences.

Issue: #${issue.number} ${issue.title}
URL: ${issue.html_url || '(none)'}
Labels: ${(issue.labels || []).map(label => label.name).filter(Boolean).join(', ') || '(none)'}

Issue description:
${issue.body || 'No description provided.'}
  `.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function parseIssueLocationHypothesis(raw: string): IssueLocationHypothesis {
  const trimmed = (raw || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  return {
    rephrasedIssue: typeof parsed.rephrasedIssue === 'string' ? parsed.rephrasedIssue.trim() : '',
    suspectedBehavior: stringArray(parsed.suspectedBehavior),
    likelyComponents: stringArray(parsed.likelyComponents),
    likelyFiles: stringArray(parsed.likelyFiles),
    likelyFunctions: stringArray(parsed.likelyFunctions),
    searchSignals: stringArray(parsed.searchSignals),
    negativeSignals: stringArray(parsed.negativeSignals),
  };
}

async function generateIssueLocationHypothesis(issue: GitHubIssueForDisplay): Promise<IssueLocationHypothesis> {
  const selected = requireSelectedPiModel();
  const result = await promptViaPiModel({
    provider: selected.provider,
    modelId: selected.modelId,
    prompt: buildIssueLocationHypothesisPrompt(issue),
    timeoutMs: 180000
  });
  return parseIssueLocationHypothesis(result.text);
}

export interface FixTodo {
  bugLocation: string;
  fixIdea: string;
  potentialMethod: string;
  sourceCodeSketch: string;
  tests: string[];
}

export interface FixAlternative {
  title: string;
  summary: string;
  todos: FixTodo[];
}

function snippetContextForPrompt(analysis: RepoIssueAnalysis): string {
  return analysis.snippets.map((snippet, index) => [
    `Snippet ${index + 1}: ${snippet.file}:${snippet.startLine}-${snippet.endLine}`,
    `Reason: ${snippet.reason}`,
    '```',
    snippet.code,
    '```'
  ].join('\n')).join('\n\n');
}

function issueInterpretationForPrompt(analysis: RepoIssueAnalysis): string {
  const hypothesis = analysis.locationHypothesis;
  return hypothesis ? [
    `Rephrased issue: ${hypothesis.rephrasedIssue || '(not provided)'}`,
    `Suspected behavior: ${hypothesis.suspectedBehavior.join(', ') || '(none)'}`,
    `Likely components: ${hypothesis.likelyComponents.join(', ') || '(none)'}`,
    `Likely files: ${hypothesis.likelyFiles.join(', ') || '(none)'}`,
    `Likely functions: ${hypothesis.likelyFunctions.join(', ') || '(none)'}`,
    `Search signals: ${hypothesis.searchSignals.join(', ') || '(none)'}`,
    `Negative signals: ${hypothesis.negativeSignals.join(', ') || '(none)'}`,
  ].join('\n') : '(Issue rephrasing was unavailable; fallback search signals were used.)';
}

export function buildFixAlternativesPrompt(analysis: RepoIssueAnalysis): string {
  return `
You are a senior software-maintenance agent. Given a GitHub issue, issue interpretation, and statically gathered repository snippets, propose exactly 3 alternative fix plans.

Return ONLY valid JSON with this exact shape:
{
  "alternatives": [
    {
      "title": "short title such as Minimal localized guard",
      "summary": "one-sentence tradeoff summary",
      "todos": [
        {
          "bugLocation": "file/path:line-range and why this is likely relevant",
          "fixIdea": "concrete change to make",
          "potentialMethod": "function/class/method/identifier to edit or add",
          "sourceCodeSketch": "small illustrative code sketch, patch fragment, or pseudocode",
          "tests": ["specific regression/unit/manual check"]
        }
      ]
    }
  ]
}

Requirements:
- Provide exactly 3 alternatives.
- Each alternative must be a todo/checklist-style plan with 2 to 5 todos.
- Each todo must include bugLocation, fixIdea, potentialMethod, sourceCodeSketch, and tests.
- Prefer concrete bug locations from the provided snippets.
- Make the alternatives meaningfully different, e.g. minimal guard, refactor/state-machine fix, defensive validation/observability fix.
- Do not claim you executed the repository.
- Do not invent files beyond the provided context unless clearly marked as unknown.
- Do not include Markdown or code fences outside JSON string values.

Repository: ${analysis.owner}/${analysis.repo}
Issue: #${analysis.issue.number} ${analysis.issue.title}
URL: ${analysis.issue.html_url || '(none)'}

Issue description:
${analysis.issue.body || 'No description provided.'}

Issue interpretation:
${issueInterpretationForPrompt(analysis)}

Context search signals:
${analysis.keywords.join(', ') || '(none)'}

Potential bug-location snippets:
${snippetContextForPrompt(analysis) || '(No matching snippets found.)'}
  `.trim();
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coerceFixAlternative(value: unknown, index = 0): FixAlternative {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const rawTodos = Array.isArray(raw.todos) ? raw.todos : [];
  return {
    title: stringValue(raw.title) || `Alternative ${index + 1}`,
    summary: stringValue(raw.summary),
    todos: rawTodos.slice(0, 8).map((todoValue): FixTodo => {
      const todo = (todoValue && typeof todoValue === 'object' ? todoValue : {}) as Record<string, unknown>;
      return {
        bugLocation: stringValue(todo.bugLocation),
        fixIdea: stringValue(todo.fixIdea),
        potentialMethod: stringValue(todo.potentialMethod),
        sourceCodeSketch: stringValue(todo.sourceCodeSketch),
        tests: stringArray(todo.tests),
      };
    }).filter(todo => todo.bugLocation || todo.fixIdea || todo.potentialMethod || todo.sourceCodeSketch || todo.tests.length > 0),
  };
}

export function parseFixAlternatives(raw: string): FixAlternative[] {
  const trimmed = (raw || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  const alternatives = Array.isArray(parsed.alternatives) ? parsed.alternatives : [];
  return alternatives.slice(0, 3).map((alternative, index) => coerceFixAlternative(alternative, index));
}

export function formatFixAlternativeAsMarkdown(alternative: FixAlternative, index = 0): string {
  const lines: string[] = [];
  lines.push(`## Alternative ${index + 1}: ${alternative.title}`);
  if (alternative.summary) { lines.push('', alternative.summary); }
  lines.push('');
  alternative.todos.forEach((todo, todoIndex) => {
    lines.push(`### Todo ${todoIndex + 1}`);
    lines.push(`- [ ] Bug location: ${todo.bugLocation || '(unknown)'}`);
    lines.push(`- [ ] Fix idea: ${todo.fixIdea || '(not specified)'}`);
    lines.push(`- [ ] Potential method: ${todo.potentialMethod || '(not specified)'}`);
    lines.push('- [ ] Potential source code:');
    lines.push('```');
    lines.push(todo.sourceCodeSketch || '// Source-code sketch not provided');
    lines.push('```');
    if (todo.tests.length > 0) {
      lines.push('- [ ] Tests/checks:');
      todo.tests.forEach(test => lines.push(`  - ${test}`));
    }
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function formatFixAlternativesAsMarkdown(alternatives: FixAlternative[]): string {
  return alternatives.map((alternative, index) => formatFixAlternativeAsMarkdown(alternative, index)).join('\n\n');
}

async function generateFixAlternatives(analysis: RepoIssueAnalysis): Promise<FixAlternative[]> {
  const selected = requireSelectedPiModel();
  const result = await promptViaPiModel({
    provider: selected.provider,
    modelId: selected.modelId,
    prompt: buildFixAlternativesPrompt(analysis),
    timeoutMs: 300000
  });
  return parseFixAlternatives(result.text);
}

export function buildRepoIssueSnippetNodes(
  analysis: Pick<RepoIssueAnalysis, 'snippets' | 'keywords' | 'specPath'>,
  issue: GitHubIssueForDisplay,
  repoRef: { owner: string; repo: string },
  parentId: number | null,
  firstNodeId: number
): { nodes: CodeNode[]; lastNodeId: number; combinedSnippetContent: string } {
  let nextId = firstNodeId;
  const nodes: CodeNode[] = analysis.snippets.map((snippet, index) => ({
    id: ++nextId,
    prompt: `Repo issue #${issue.number} snippet ${index + 1}/${analysis.snippets.length}: ${snippet.file}:${snippet.startLine}-${snippet.endLine}`,
    code: snippet.code,
    parentId,
    children: [],
    durationMs: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    reasoning: [
      `Repository: ${repoRef.owner}/${repoRef.repo}`,
      `Issue: #${issue.number} ${issue.title}`,
      `Snippet: ${snippet.file}:${snippet.startLine}-${snippet.endLine}`,
      `Score: ${snippet.score}`,
      `Reason: ${snippet.reason}`,
      `Search signals: ${analysis.keywords.join(', ') || '(none)'}`,
      `Fix specification file: ${analysis.specPath ?? 'not written'}`,
      'This node contains one statically gathered impacted snippet. No repository code was executed.'
    ].join('\n'),
    lizard: undefined,
    isLeaf: true,
    activity: 'repo_issue_analysis'
  }));

  const combinedSnippetContent = analysis.snippets.map((snippet, index) => [
    `Snippet ${index + 1}: ${snippet.file}:${snippet.startLine}-${snippet.endLine}`,
    `Reason: ${snippet.reason}`,
    '```',
    snippet.code,
    '```'
  ].join('\n')).join('\n\n');

  return { nodes, lastNodeId: nextId, combinedSnippetContent };
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
  const selected = requireSelectedPiModel();
  const prompt = `
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
1) Repository Overview
2) Environment Setup
3) Build & Run
4) Architecture
5) Key Files & Directories
6) Code Conventions
7) Testing
8) Dependencies
9) Configuration
10) Security Notes

### RULES (strict):
1) Output MUST start with "<code>" on the first line and end with "</reasoning>" on the last line.
2) No additional tags, headers, or text outside the two blocks.
3) The content inside <code> MUST be valid Markdown suitable for an AGENTS.MD file.
4) Put ALL explanation inside <reasoning>. Do NOT include code fences there.
5) Do NOT wrap anything in triple backticks outside the tags.
6) Be thorough but concise. Focus on actionable information that helps someone work with the codebase.

Repository information:
${repoContent}
  `.trim();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await promptViaPiModel({
        provider: selected.provider,
        modelId: selected.modelId,
        prompt,
        timeoutMs: 300000
      });
      const output = result.text;
      const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
      const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
      const content = codeMatch?.[1]?.trim() ?? '';
      const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

      if (content) { return { content, reasoning }; }
      console.warn('No <code> block found in Pi model response. Retrying...');
    } catch (err) {
      console.warn('Error during AGENTS.MD generation via Pi:', (err as Error).message);
      if (attempt === 2) { throw err; }
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
      broadcast({ command: 'urlmodelUpdate', LLMmodel, availableModels });

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

      const selectedPiModel = requireSelectedPiModel();

      for (let i = 0; i < versionCount; i++) {
        const currentCount = i + 1;
        bonsaiLog('Generating version', currentCount, 'of', versionCount);
        broadcast({ command: 'loading', text: `Generating branch ${currentCount} of ${versionCount}...` });

        const start = performance.now();
        let result: string;
        let reasoning: string;
        let tokens: { prompt: number; completion: number; total: number };

        bonsaiLog(`Generating via Pi model: ${selectedPiModel.provider}/${selectedPiModel.modelId}`);
        const subscriptionResult = await generateViaSubscription({
          provider: selectedPiModel.provider,
          modelId: selectedPiModel.modelId,
          prompt: message.prompt,
          code
        });
        result = subscriptionResult.content;
        reasoning = subscriptionResult.reasoning;
        tokens = subscriptionResult.tokens;

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
    if (message.model) { LLMmodel = message.model; }
    bonsaiLog('Config updated – Pi model:', LLMmodel || '(none selected)');
    return;
  }

  if (message.command === 'loadPiModels') {
    bonsaiLog('Loading Pi model registry metadata');
    try {
      const result = await discoverPiModels();
      availableModels = result.models
        .filter(model => model.compatible)
        .map(model => `pi:${model.provider}:${model.id}`);
      if ((!LLMmodel || !availableModels.includes(LLMmodel)) && availableModels.length > 0) {
        LLMmodel = availableModels[0];
      }
      bonsaiLog('Pi model registry loaded. Compatible:', result.compatibleCount, 'Total:', result.totalCount, 'selected:', LLMmodel || '(none)');
      broadcast({
        command: 'piModelsUpdate',
        success: true,
        models: result.models,
        compatibleCount: result.compatibleCount,
        totalCount: result.totalCount,
        selectedModel: LLMmodel,
        warning: result.warning ? 'Pi models.json had a load warning; check Pi config locally.' : undefined
      });
    } catch (err: any) {
      bonsaiLog('Pi model registry load failed:', err?.message || err);
      broadcast({ command: 'piModelsUpdate', success: false, message: err?.message || 'Unable to load Pi models' });
    }
    return;
  }

  if (message.command === 'testConnection') {
    LLMmodel = message.model || LLMmodel;
    bonsaiLog('Testing Pi model selection:', LLMmodel || '(none)');
    broadcast({ command: 'loading', text: 'Testing Pi model configuration...' });

    try {
      const selected = requireSelectedPiModel();
      const result = await discoverPiModels();
      availableModels = result.models
        .filter(model => model.compatible)
        .map(model => `pi:${model.provider}:${model.id}`);
      const selectedValue = `pi:${selected.provider}:${selected.modelId}`;
      const selectedModel = result.models.find(model => model.provider === selected.provider && model.id === selected.modelId);
      if (!selectedModel) {
        throw new Error(`Selected Pi model is not available: ${selected.provider}/${selected.modelId}`);
      }
      if (!selectedModel.compatible) {
        throw new Error(selectedModel.reason);
      }
      LLMmodel = selectedValue;
      bonsaiLog('Pi model test successful:', selectedValue);
      broadcast({
        command: 'connectionTestResult',
        success: true,
        message: `✓ Pi model ready: ${selected.provider}/${selected.modelId}`,
        availableModels,
        selectedModel: selectedValue
      });
    } catch (err: any) {
      bonsaiLog('Pi model test failed:', err?.message || err);
      broadcast({ command: 'connectionTestResult', success: false, message: `✗ Pi model unavailable: ${err?.message || err}` });
    }
    return;
  }

  if (message.command === 'processAgentMd') {
    const agentMdContent = message.content || '';
    LLMmodel = message.model || LLMmodel;

    bonsaiLog('Processing Agent.md content via Pi, length:', agentMdContent.length, 'model:', LLMmodel || '(none)');
    broadcast({ command: 'loading', text: 'Processing Agent.md with Pi...' });

    try {
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

  if (message.command === 'createFixAlternativeNode') {
    const alternative = coerceFixAlternative(message.alternative, 0);
    const issue = message.issue as GitHubIssueForDisplay | undefined;
    const repoUrl = message.repoUrl || '';

    try {
      let branch = branches.find(b => b.id === activeBranchId);
      if (!branch) {
        initFreshBonsai();
        branch = branches[0];
      }
      const parsed = repoUrl ? parseGitHubUrl(repoUrl) : null;
      const parentId = selectedNodeId ?? branch.nodes[0]?.id ?? null;
      const parent = parentId == null ? undefined : branch.nodes.find(n => n.id === parentId);
      if (parent) { parent.isLeaf = false; }

      const markdown = formatFixAlternativeAsMarkdown(alternative, 0);
      const node: CodeNode = {
        id: ++currentId,
        prompt: `Fix alternative: ${alternative.title}`,
        code: markdown,
        parentId,
        children: [],
        durationMs: 0,
        tokens: { prompt: 0, completion: 0, total: 0 },
        reasoning: [
          parsed ? `Repository: ${parsed.owner}/${parsed.repo}` : 'Repository: unknown',
          issue ? `Issue: #${issue.number} ${issue.title}` : 'Issue: unknown',
          `Alternative: ${alternative.title}`,
          'This node was created from a displayed fix-plan todo card. No repository code was executed.'
        ].join('\n'),
        lizard: undefined,
        isLeaf: true,
        activity: 'repo_issue_analysis'
      };

      branch.nodes.push(node);
      selectedNodeId = node.id;
      broadcast({ command: 'historyUpdate', history: branch.nodes });
      broadcast({ command: 'renderGraph', graph: createGraphFromBranch(branch) });
      broadcast({ command: 'setInitialCode', code: markdown });
      broadcast({ command: 'createFixAlternativeNodeResult', success: true, message: `Created Bonsai node #${node.id} from ${alternative.title}.`, node });
    } catch (err: any) {
      bonsaiLog('Fix alternative node creation failed:', err?.message || err);
      broadcast({ command: 'createFixAlternativeNodeResult', success: false, message: err?.message || 'Node creation failed' });
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
    LLMmodel = message.model || LLMmodel;

    bonsaiLog('Analyzing repo for fix:', repoUrl, issue?.number, 'Pi model:', LLMmodel || '(none)');
    broadcast({ command: 'repoIssueAnalysisResult', success: false, loading: true, message: 'Preparing repository analysis...' });

    try {
      // Step 1: Validate URL
      broadcast({ command: 'analysisLogStep', stepIndex: 0, action: 'add', stepName: 'Validating URL', status: 'running' });
      const parsed = parseGitHubUrl(repoUrl);
      if (!parsed) {
        throw new Error('Invalid GitHub URL. Expected format: https://github.com/owner/repo');
      }
      if (!issue || typeof issue.title !== 'string' || typeof issue.number !== 'number') {
        throw new Error('Select an issue before analyzing the repository.');
      }
      broadcast({ command: 'analysisLogStep', stepIndex: 0, action: 'update', status: 'completed', detail: `${parsed.owner}/${parsed.repo}` });

      // Step 2: Rephrase the issue into location hypotheses before scanning the checkout
      let stepIndex = 1;
      let locationHypothesis: IssueLocationHypothesis | undefined;
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'add', stepName: 'Rephrasing issue into search signals', status: 'running' });
      try {
        locationHypothesis = await generateIssueLocationHypothesis(issue);
        broadcast({
          command: 'analysisLogStep',
          stepIndex,
          action: 'update',
          status: 'completed',
          detail: locationHypothesis.rephrasedIssue || `${locationHypothesis.searchSignals.length} search signal(s)`
        });
      } catch (err: any) {
        bonsaiLog('Issue rephrasing failed; falling back to static issue terms:', err?.message || err);
        broadcast({
          command: 'analysisLogStep',
          stepIndex,
          action: 'update',
          status: 'completed',
          detail: 'Rephrasing failed; falling back to static issue terms.'
        });
      }

      // Step 3: Clone/checkout repository and scan with interpreted signals
      stepIndex++;
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'add', stepName: 'Cloning/updating repository', status: 'running' });
      const analysis = await analyzeRepoForIssue(parsed.owner, parsed.repo, issue, { locationHypothesis });
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'update', status: 'completed', detail: `${analysis.repoPath}` });

      // Step 4: Identify potential bug locations from the interpreted scan
      stepIndex++;
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'add', stepName: 'Identifying potential bug locations', status: 'running' });
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'update', status: 'completed', detail: `${analysis.snippets.length} snippet(s), ${analysis.keywords.length} search signal(s)` });
      if (analysis.snippets.length === 0) {
        throw new Error('No impacted snippets found for the selected issue.');
      }

      // Step 5: Drafting 3 model-assisted fix-plan alternatives and updating the spec file
      stepIndex++;
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'add', stepName: 'Drafting 3 fix-plan alternatives', status: 'running' });
      const fixAlternatives = await generateFixAlternatives(analysis);
      if (fixAlternatives.length === 0) {
        throw new Error('The selected Pi model did not return any fix alternatives.');
      }
      analysis.agenticAnalysis = formatFixAlternativesAsMarkdown(fixAlternatives);
      analysis.specPath = await writeFixSpecFile(analysis);
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'update', status: 'completed', detail: `${fixAlternatives.length} alternative(s). Spec: ${analysis.specPath}` });

      // Step 6: Displaying fix-plan todo cards instead of creating snippet nodes
      stepIndex++;
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'add', stepName: 'Displaying fix-plan todo cards', status: 'running' });
      broadcast({ command: 'analysisLogStep', stepIndex, action: 'update', status: 'completed', detail: `${fixAlternatives.length} card(s) ready` });

      broadcast({ command: 'setInitialCode', code: analysis.agenticAnalysis });
      broadcast({
        command: 'repoIssueAnalysisResult',
        success: true,
        loading: false,
        message: `Prepared ${fixAlternatives.length} fix alternative todo list(s) for issue #${issue.number}.`,
        fixAlternatives,
        snippets: analysis.snippets,
        keywords: analysis.keywords,
        locationHypothesis: analysis.locationHypothesis,
        repoPath: analysis.repoPath,
        specPath: analysis.specPath,
        repository: `${parsed.owner}/${parsed.repo}`
      });
      bonsaiLog('Repo issue fix alternatives created:', fixAlternatives.length, 'snippets:', analysis.snippets.length);
    } catch (err: any) {
      bonsaiLog('Repo issue analysis failed:', err?.message || err);
      broadcast({ command: 'analysisLogStep', action: 'error', detail: err?.message || 'Unknown error' });
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
        send({ command: 'urlmodelUpdate', LLMmodel, availableModels });
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

    // Load Pi model metadata on startup. No local LLM endpoint is contacted.
    void (async () => {
      try {
        bonsaiLog('Loading Pi model registry on startup');
        const result = await discoverPiModels();
        availableModels = result.models
          .filter(model => model.compatible)
          .map(model => `pi:${model.provider}:${model.id}`);
        if ((!LLMmodel || !availableModels.includes(LLMmodel)) && availableModels.length > 0) {
          LLMmodel = availableModels[0];
        }
        const message = availableModels.length
          ? `✓ Pi models loaded. Selected ${LLMmodel}.`
          : 'No configured Pi models found. Run pi /login <provider> and click Load Pi Models.';
        bonsaiLog('Pi model registry loaded on startup. Compatible:', availableModels.length, 'selected:', LLMmodel || '(none)');
        broadcast({ command: 'connectionTestResult', success: availableModels.length > 0, message, availableModels, selectedModel: LLMmodel });
      } catch (err: any) {
        bonsaiLog('Startup Pi model registry load failed:', err?.message || err);
        broadcast({ command: 'connectionTestResult', success: false, message: `✗ Pi model registry unavailable: ${err?.message || err}` });
      }
    })();
  });

  return server;
}

if (require.main === module) {
  startServer();
}
