import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FIX_CANDIDATE_COUNT,
  applyGeneratedFix,
  buildFixGenerationPrompt,
  detectValidationCommands,
  finalizeCandidateReport,
  parseGeneratedFix,
  prepareFourFixClones,
  validateFixWorkspace,
} from '../out-server/fix-workspaces.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Bonsai Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
}

test('parseGeneratedFix accepts complete files and rejects unsafe paths', () => {
  const parsed = parseGeneratedFix(JSON.stringify({
    summary: 'Add a guard.',
    files: [{ path: 'src/fix.ts', content: 'export const fixed = true;\n' }],
  }));
  assert.equal(parsed.summary, 'Add a guard.');
  assert.deepEqual(parsed.files, [{ path: 'src/fix.ts', content: 'export const fixed = true;\n' }]);

  assert.throws(() => parseGeneratedFix(JSON.stringify({
    files: [{ path: '../escape.ts', content: 'bad' }],
  })), /unsafe segment/);
  assert.throws(() => parseGeneratedFix(JSON.stringify({
    files: [{ path: '.git/config', content: 'bad' }],
  })), /protected directory/);
});

test('applyGeneratedFix rejects symbolic-link traversal outside a workspace', async () => {
  const workspace = tempDir('bonsai-symlink-workspace-');
  const outside = tempDir('bonsai-symlink-outside-');
  try {
    fs.symlinkSync(outside, path.join(workspace, 'tests'), 'dir');
    const generated = parseGeneratedFix(JSON.stringify({
      summary: 'Unsafe linked test.',
      files: [{ path: 'tests/reproduction.test.js', content: 'bad\n' }],
    }));
    await assert.rejects(() => applyGeneratedFix(workspace, generated), /symbolic link/);
    assert.equal(fs.existsSync(path.join(outside, 'reproduction.test.js')), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('buildFixGenerationPrompt requires complete file JSON and post-fix validation', () => {
  const prompt = buildFixGenerationPrompt({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    issueTitle: 'Broken guard',
    issueBody: 'The guard is missing.',
    candidate: 2,
    plan: {
      title: 'Defensive guard',
      summary: 'Validate input before use.',
      implementations: [{
        title: 'Boundary validation',
        summary: 'Keep validation at the boundary.',
        todos: [{
          bugLocation: 'src/fix.ts:1',
          fixIdea: 'Add validation.',
          potentialMethod: 'validate',
          sourceCodeSketch: 'validate(input)',
          tests: ['reject invalid input'],
        }],
      }],
    },
    fileContext: 'FILE: src/fix.ts\n--- BEGIN FILE ---\nold\n--- END FILE ---',
    generationInstructions: 'Do not add dependencies; preserve Node 18 compatibility.',
  });
  assert.match(prompt, /candidate 2 of exactly four isolated fixes/);
  assert.match(prompt, /complete final contents/);
  assert.match(prompt, /BonsAIDE will run them after applying/);
  assert.match(prompt, /Defensive guard/);
  assert.match(prompt, /Do not add dependencies; preserve Node 18 compatibility/);
});

test('detectValidationCommands recognizes root-level Python test modules', () => {
  const workspace = tempDir('bonsai-python-tests-');
  try {
    fs.writeFileSync(path.join(workspace, 'setup.py'), 'from setuptools import setup\n');
    fs.writeFileSync(path.join(workspace, 'test_parser.py'), 'def test_parser():\n    assert True\n');
    const commands = detectValidationCommands(workspace);
    assert.deepEqual(commands.build, { label: 'build', command: 'python3', args: ['-m', 'compileall', '-q', '.'] });
    assert.deepEqual(commands.test, { label: 'test', command: 'python3', args: ['-m', 'pytest', '-q'] });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('prepareFourFixClones creates four isolated Git branches', async () => {
  const source = tempDir('bonsai-source-');
  const root = tempDir('bonsai-workspaces-');
  try {
    initGitRepo(source);
    const clones = await prepareFourFixClones(source, 'owner', 'repo', 42, root);
    assert.equal(clones.length, FIX_CANDIDATE_COUNT);
    assert.equal(new Set(clones).size, FIX_CANDIDATE_COUNT);
    clones.forEach((clone, index) => {
      assert.ok(fs.existsSync(path.join(clone, '.git')));
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd: clone, encoding: 'utf8' }).trim();
      assert.equal(branch, `bonsai-issue-42-candidate-${index + 1}`);
    });
    fs.writeFileSync(path.join(clones[0], 'only-clone-1.txt'), 'isolated');
    assert.equal(fs.existsSync(path.join(clones[1], 'only-clone-1.txt')), false);
    assert.equal(fs.existsSync(path.join(source, 'only-clone-1.txt')), false);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applied fix is built and tested, then persisted in a candidate report', async () => {
  const workspace = tempDir('bonsai-candidate-');
  try {
    initGitRepo(workspace);
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'value.js'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'candidate-test',
      version: '1.0.0',
      scripts: {
        build: 'node -e "require(\\\"fs\\\").accessSync(\\\"src/value.js\\\")"',
        test: 'node -e "const fs=require(\\\"fs\\\");if(!fs.readFileSync(\\\"src/value.js\\\",\\\"utf8\\\").includes(\\\"value = 2\\\"))process.exit(1)"',
      },
    }, null, 2));
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: workspace });

    const generated = parseGeneratedFix(JSON.stringify({
      summary: 'Change value and verify it.',
      files: [{ path: 'src/value.js', content: 'export const value = 2;\n' }],
    }));
    const changedFiles = await applyGeneratedFix(workspace, generated);
    assert.deepEqual(changedFiles, ['src/value.js']);

    const commands = detectValidationCommands(workspace);
    assert.deepEqual(commands.build, { label: 'build', command: 'npm', args: ['run', 'build'] });
    assert.deepEqual(commands.test, { label: 'test', command: 'npm', args: ['run', 'test'] });

    const validation = await validateFixWorkspace(workspace);
    assert.equal(validation.build.status, 'passed');
    assert.equal(validation.test.status, 'passed');

    const report = await finalizeCandidateReport({
      candidate: 1,
      title: 'Minimal fix',
      workspacePath: workspace,
      changedFiles,
      generationSummary: generated.summary,
      validation,
    });
    assert.equal(report.status, 'PASS');
    assert.ok(fs.existsSync(report.reportPath));
    assert.ok(fs.existsSync(report.diffPath));
    assert.match(fs.readFileSync(report.reportPath, 'utf8'), /Build|build: \*\*PASSED\*\*/i);
    assert.match(report.gitStatus, /src\/value\.js/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
