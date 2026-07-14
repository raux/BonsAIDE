import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLmStudioUrl,
  formatGitHubIssues,
  getActivityColor,
  mimeType,
  normalizeLmStudioBaseUrl,
  parseGitHubUrl,
} from '../out-server/server-utils.js';

test('parseGitHubUrl accepts common GitHub URL forms', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGitHubUrl('github.com/owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGitHubUrl('owner/repo'), { owner: 'owner', repo: 'repo' });
});

test('parseGitHubUrl strips .git and ignores trailing URL decorations', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo/?tab=readme#top'), { owner: 'owner', repo: 'repo' });
});

test('parseGitHubUrl rejects malformed repository references', () => {
  assert.equal(parseGitHubUrl(''), null);
  assert.equal(parseGitHubUrl('https://example.com/owner/repo'), null);
  assert.equal(parseGitHubUrl('owner'), null);
  assert.equal(parseGitHubUrl('owner/repo/extra'), null);
});

test('normalizeLmStudioBaseUrl accepts host paths and absolute URLs', () => {
  assert.equal(normalizeLmStudioBaseUrl('localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.equal(normalizeLmStudioBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.equal(normalizeLmStudioBaseUrl('https://llm.example.test/v1/'), 'https://llm.example.test/v1');
});

test('normalizeLmStudioBaseUrl rejects invalid URLs and unsupported protocols', () => {
  assert.throws(() => normalizeLmStudioBaseUrl('   '), /Invalid URL format/);
  assert.throws(() => normalizeLmStudioBaseUrl('ftp://localhost:1234/v1'), /Invalid URL format|Invalid URL protocol/);
});

test('buildLmStudioUrl appends endpoint paths safely', () => {
  assert.equal(
    buildLmStudioUrl('localhost:1234/v1/', '/chat/completions'),
    'http://localhost:1234/v1/chat/completions'
  );
  assert.equal(buildLmStudioUrl('http://localhost:1234/v1', 'models'), 'http://localhost:1234/v1/models');
});

test('mimeType maps known extensions and falls back for unknown files', () => {
  assert.equal(mimeType('index.html'), 'text/html; charset=utf-8');
  assert.equal(mimeType('styles.css'), 'text/css; charset=utf-8');
  assert.equal(mimeType('app.js'), 'application/javascript; charset=utf-8');
  assert.equal(mimeType('data.json'), 'application/json');
  assert.equal(mimeType('image.png'), 'image/png');
  assert.equal(mimeType('diagram.svg'), 'image/svg+xml');
  assert.equal(mimeType('README.md'), 'application/octet-stream');
});

test('getActivityColor returns configured colors and fallback color', () => {
  assert.equal(getActivityColor('gen_tests'), '#970071');
  assert.equal(getActivityColor('refactor'), '#006d18');
  assert.equal(getActivityColor('exceptions'), '#00b0b6');
  assert.equal(getActivityColor('agent_md_alternative'), '#4c51bf');
  assert.equal(getActivityColor('repo_agentic_analysis'), '#7c3aed');
  assert.equal(getActivityColor('repo_clone'), '#2563eb');
  assert.equal(getActivityColor('repo_code_snippet'), '#7c3aed');
  assert.equal(getActivityColor('repo_test_pass'), '#15803d');
  assert.equal(getActivityColor('repo_test_partial'), '#ca8a04');
  assert.equal(getActivityColor('repo_test_fail'), '#b91c1c');
  assert.equal(getActivityColor('unknown'), '#777777');
});

test('formatGitHubIssues renders open issues for display', () => {
  const output = formatGitHubIssues('owner', 'repo', [
    {
      number: 42,
      title: 'Bug in parser',
      html_url: 'https://github.com/owner/repo/issues/42',
      user: { login: 'alice' },
      labels: [{ name: 'bug' }, { name: 'help wanted' }],
      comments: 3,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      body: 'Parser fails on nested input.\n\nMore details here.',
    },
  ]);

  assert.match(output, /# Open Issues for owner\/repo/);
  assert.match(output, /Found 1 open issue\./);
  assert.match(output, /## #42: Bug in parser/);
  assert.match(output, /Author: @alice/);
  assert.match(output, /Labels: bug, help wanted/);
  assert.match(output, /Summary: Parser fails on nested input\./);
});

test('formatGitHubIssues handles repositories with no open issues', () => {
  assert.equal(formatGitHubIssues('owner', 'repo', []), '# Open Issues for owner/repo\n\nNo open issues found.');
});
