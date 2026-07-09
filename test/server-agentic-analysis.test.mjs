import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgenticFixAnalysisPrompt,
  buildIssueLocationHypothesisPrompt,
  buildRepoIssueSnippetNodes,
  parseIssueLocationHypothesis,
} from '../out-server/server.js';

function makeIssue() {
  return {
    number: 840,
    title: 'Parakeet can report No model loaded after auto-unload restore timeout',
    html_url: 'https://github.com/TypeWhisper/typewhisper-mac/issues/840',
    labels: [{ name: 'bug' }],
    body: 'Auto-unload restore can fail with No model loaded.',
    user: { login: 'SeoFood' },
  };
}

function makeSnippet(index) {
  return {
    file: `TypeWhisper/Services/File${index}.swift`,
    startLine: index * 10,
    endLine: index * 10 + 4,
    code: [`func restore${index}() {`, '  restoreModel()', '}'].join('\n'),
    score: 100 - index,
    reason: `Matched restore keyword ${index}`,
  };
}

test('issue location hypothesis prompt asks for strict JSON search signals', () => {
  const prompt = buildIssueLocationHypothesisPrompt(makeIssue());

  assert.match(prompt, /Return ONLY valid JSON/);
  assert.match(prompt, /"rephrasedIssue"/);
  assert.match(prompt, /"likelyFiles"/);
  assert.match(prompt, /"searchSignals"/);
  assert.match(prompt, /No model loaded/);
});

test('parseIssueLocationHypothesis parses fenced model JSON defensively', () => {
  const parsed = parseIssueLocationHypothesis('```json\n{"rephrasedIssue":"Restore times out","suspectedBehavior":["model restore fails"],"likelyComponents":["model lifecycle"],"likelyFiles":["Services/ModelLoader.swift"],"likelyFunctions":["restoreModel"],"searchSignals":["No model loaded"],"negativeSignals":["billing"]}\n```');

  assert.equal(parsed.rephrasedIssue, 'Restore times out');
  assert.deepEqual(parsed.likelyFiles, ['Services/ModelLoader.swift']);
  assert.deepEqual(parsed.searchSignals, ['No model loaded']);
});

test('agentic fix analysis prompt includes issue interpretation when available', () => {
  const prompt = buildAgenticFixAnalysisPrompt({
    owner: 'TypeWhisper',
    repo: 'typewhisper-mac',
    repoPath: '/tmp/typewhisper-mac',
    issue: makeIssue(),
    keywords: ['parakeet', 'restore'],
    snippets: [makeSnippet(1)],
    content: 'Static context gathered for agentic fix analysis',
    locationHypothesis: {
      rephrasedIssue: 'Auto-unload restore can leave Parakeet without a loaded model.',
      suspectedBehavior: ['restore timeout leaves model unloaded'],
      likelyComponents: ['model lifecycle'],
      likelyFiles: ['TypeWhisper/Services/File1.swift'],
      likelyFunctions: ['restoreModel'],
      searchSignals: ['No model loaded'],
      negativeSignals: ['billing'],
    },
  });

  assert.match(prompt, /Issue interpretation:/);
  assert.match(prompt, /Auto-unload restore can leave Parakeet/);
  assert.match(prompt, /Likely files: TypeWhisper\/Services\/File1\.swift/);
});

test('agentic fix analysis prompt asks for concrete fix steps', () => {
  const prompt = buildAgenticFixAnalysisPrompt({
    owner: 'TypeWhisper',
    repo: 'typewhisper-mac',
    repoPath: '/tmp/typewhisper-mac',
    issue: makeIssue(),
    keywords: ['parakeet', 'restore'],
    snippets: [makeSnippet(1)],
    content: 'Static context gathered for agentic fix analysis',
  });

  assert.match(prompt, /draft practical fix steps/);
  assert.match(prompt, /## Fix steps/);
  assert.match(prompt, /Prefer numbered, concrete steps/);
  assert.match(prompt, /TypeWhisper\/Services\/File1\.swift:10-14/);
  assert.match(prompt, /Do not claim you executed the repository/);
});

test('agentic repo analysis creates one Bonsai node per impacted snippet', () => {
  const snippets = Array.from({ length: 8 }, (_, index) => makeSnippet(index + 1));
  const result = buildRepoIssueSnippetNodes(
    {
      snippets,
      keywords: ['parakeet', 'auto', 'unload', 'restore', 'timeout'],
      specPath: 'artifacts/repo-analysis-specs/TypeWhisper__typewhisper-mac/issue-840.md',
    },
    makeIssue(),
    { owner: 'TypeWhisper', repo: 'typewhisper-mac' },
    7,
    10
  );

  assert.equal(result.nodes.length, 8);
  assert.equal(result.lastNodeId, 18);
  assert.deepEqual(result.nodes.map(node => node.id), [11, 12, 13, 14, 15, 16, 17, 18]);
  assert.ok(result.nodes.every(node => node.parentId === 7));
  assert.ok(result.nodes.every(node => node.activity === 'repo_issue_analysis'));
  assert.ok(result.nodes.every(node => node.isLeaf === true));
  assert.equal(result.nodes[0].code, snippets[0].code);
  assert.equal(result.nodes[7].code, snippets[7].code);
  assert.match(result.nodes[0].prompt, /snippet 1\/8/);
  assert.match(result.nodes[7].prompt, /snippet 8\/8/);
});

test('agentic repo analysis snippet nodes preserve file metadata and combined snippet content', () => {
  const snippet = makeSnippet(3);
  const result = buildRepoIssueSnippetNodes(
    {
      snippets: [snippet],
      keywords: ['restore'],
      specPath: 'artifacts/repo-analysis-specs/TypeWhisper__typewhisper-mac/issue-840.md',
    },
    makeIssue(),
    { owner: 'TypeWhisper', repo: 'typewhisper-mac' },
    null,
    0
  );

  assert.equal(result.nodes.length, 1);
  const [node] = result.nodes;
  assert.equal(node.id, 1);
  assert.equal(node.parentId, null);
  assert.match(node.reasoning, /Repository: TypeWhisper\/typewhisper-mac/);
  assert.match(node.reasoning, /Issue: #840/);
  assert.match(node.reasoning, /Snippet: TypeWhisper\/Services\/File3\.swift:30-34/);
  assert.match(node.reasoning, /Score: 97/);
  assert.match(node.reasoning, /Reason: Matched restore keyword 3/);
  assert.match(node.reasoning, /Search signals: restore/);
  assert.match(node.reasoning, /No repository code was executed/);
  assert.match(result.combinedSnippetContent, /Snippet 1: TypeWhisper\/Services\/File3\.swift:30-34/);
  assert.match(result.combinedSnippetContent, /```\nfunc restore3\(\)/);
});

test('agentic repo analysis snippet node builder returns no aggregate node when no snippets exist', () => {
  const result = buildRepoIssueSnippetNodes(
    { snippets: [], keywords: [], specPath: undefined },
    makeIssue(),
    { owner: 'TypeWhisper', repo: 'typewhisper-mac' },
    1,
    20
  );

  assert.deepEqual(result.nodes, []);
  assert.equal(result.lastNodeId, 20);
  assert.equal(result.combinedSnippetContent, '');
});
