import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeCheckout,
  discoverCandidateFiles,
  extractIssueKeywords,
  formatFixSpecification,
  safeRepoCacheName,
  writeFixSpecFile,
} from '../out-server/repo-analyzer.js';

test('safeRepoCacheName creates filesystem-safe cache names', () => {
  assert.equal(safeRepoCacheName('owner-name', 'repo.name'), 'owner-name__repo.name');
  assert.equal(safeRepoCacheName('bad/owner', 'repo name'), 'bad_owner__repo_name');
});

test('extractIssueKeywords uses title, body, labels, and filters common words', () => {
  const keywords = extractIssueKeywords({
    title: 'Add freehire-search aggregator skill',
    body: 'The search should support many countries and boards.',
    labels: [{ name: 'enhancement' }],
  });

  assert.ok(keywords.includes('freehire'));
  assert.ok(keywords.includes('search'));
  assert.ok(keywords.includes('aggregator'));
  assert.ok(keywords.includes('enhancement'));
  assert.equal(keywords.includes('the'), false);
});

test('discoverCandidateFiles ignores vendor/build folders and keeps useful text files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-repo-analyzer-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'src', 'search.ts'), 'export const search = true;');
    fs.writeFileSync(path.join(dir, 'README.md'), '# docs');
    fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'ignored');

    const files = discoverCandidateFiles(dir);

    assert.deepEqual(files.sort(), ['README.md', 'src/search.ts']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeCheckout ranks and formats likely impacted snippets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-repo-analyzer-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'freehire-search.ts'), [
      'export function freehireSearch() {',
      '  const boards = ["remote", "global"];',
      '  return boards.map(board => `search ${board}`);',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'src', 'unrelated.ts'), 'export const payment = true;');

    const analysis = analyzeCheckout(dir, 'owner', 'repo', {
      number: 62,
      title: 'Add a freehire-search skill',
      html_url: 'https://github.com/owner/repo/issues/62',
      labels: [{ name: 'enhancement' }],
      body: 'Build an aggregator search for remote job boards.',
    });

    assert.ok(analysis.keywords.includes('freehire'));
    assert.equal(analysis.snippets[0].file, 'src/freehire-search.ts');
    assert.match(analysis.content, /Repository: owner\/repo/);
    assert.match(analysis.content, /src\/freehire-search.ts/);
    assert.match(analysis.content, /freehireSearch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatFixSpecification and writeFixSpecFile create agentic fix spec files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-repo-analyzer-'));
  const specRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-repo-specs-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'freehire-search.ts'), 'export function freehireSearch() { return true; }');

    const analysis = analyzeCheckout(dir, 'owner', 'repo', {
      number: 62,
      title: 'Add a freehire-search skill',
      html_url: 'https://github.com/owner/repo/issues/62',
      labels: [{ name: 'enhancement' }],
      body: 'Build an aggregator search for remote job boards.',
    });

    analysis.agenticAnalysis = '## Root-cause hypothesis\nThe search skill is missing.\n\n## Test plan\nAdd a focused unit test.';
    const spec = formatFixSpecification(analysis);
    assert.match(spec, /# Fix Specification: owner\/repo issue #62/);
    assert.match(spec, /## Agentic analysis method/);
    assert.match(spec, /No repository code was executed/);
    assert.match(spec, /The search skill is missing/);
    assert.match(spec, /src\/freehire-search.ts/);

    const specPath = await writeFixSpecFile(analysis, specRoot);
    const written = fs.readFileSync(specPath, 'utf8');
    assert.match(specPath, /issue-62-add-a-freehire-search-skill\.md$/);
    assert.equal(written, spec);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(specRoot, { recursive: true, force: true });
  }
});
