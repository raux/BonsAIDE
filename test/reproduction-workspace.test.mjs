import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  applyGeneratedFix,
  buildReproductionTestPrompt,
  classifyReproduction,
  discoverTestContextFiles,
  finalizeReproductionReport,
  isLikelyTestPath,
  parseGeneratedReproductionTest,
  prepareReproductionClone,
  runBaselineValidation,
  runReproductionValidation,
} from '../out-server/reproduction-workspace.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Bonsai Test'], { cwd: dir });
}

function validation(label, status) {
  return {
    label,
    displayCommand: status === 'unavailable' ? '(not detected)' : `run-${label}`,
    status,
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    durationMs: 1,
    stdout: '',
    stderr: '',
  };
}

test('reproduction parser accepts conventional test paths and rejects production files', () => {
  assert.equal(isLikelyTestPath('test/parser.test.js'), true);
  assert.equal(isLikelyTestPath('src/parser.spec.ts'), true);
  assert.equal(isLikelyTestPath('tests/test_parser.py'), true);
  assert.equal(isLikelyTestPath('src/parser.ts'), false);

  const generated = parseGeneratedReproductionTest(JSON.stringify({
    summary: 'Expose parser failure.',
    files: [{ path: 'test/parser.test.js', content: 'test("parser", () => {});\n' }],
  }));
  assert.equal(generated.files[0].path, 'test/parser.test.js');

  assert.throws(() => parseGeneratedReproductionTest(JSON.stringify({
    files: [{ path: 'src/parser.js', content: 'export const changed = true;\n' }],
  })), /test files/);
});

test('reproduction prompt requires a deterministic issue-specific test-only response', () => {
  const prompt = buildReproductionTestPrompt({
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    issueTitle: 'Parser accepts malformed input',
    issueBody: 'Malformed input should be rejected.',
    issueInterpretation: 'The parser misses a boundary check.',
    snippetContext: 'Snippet 1: src/parser.js',
    fileContext: 'FILE: test/parser.test.js',
    generationInstructions: 'Use node:test.',
  });

  assert.match(prompt, /creating a focused regression test/);
  assert.match(prompt, /Write test files only/);
  assert.match(prompt, /should fail on the current buggy revision/);
  assert.match(prompt, /Do not weaken assertions/);
  assert.match(prompt, /Use node:test/);
});

test('classification requires a passing baseline and issue-specific post-test failure', () => {
  const passingBaseline = {
    setup: validation('setup', 'unavailable'),
    build: validation('build', 'passed'),
    test: validation('test', 'passed'),
  };
  assert.equal(classifyReproduction(passingBaseline, {
    build: validation('build', 'passed'),
    test: validation('test', 'failed'),
  }).status, 'REPRODUCED');
  assert.equal(classifyReproduction(passingBaseline, {
    build: validation('build', 'passed'),
    test: validation('test', 'passed'),
  }).status, 'NOT_REPRODUCED');
  assert.equal(classifyReproduction(passingBaseline, {
    build: validation('build', 'passed'),
    test: validation('test', 'failed'),
  }, ['test/reported-bug.test.js']).status, 'INCONCLUSIVE');
  assert.equal(classifyReproduction({
    setup: validation('setup', 'unavailable'),
    build: validation('build', 'passed'),
    test: validation('test', 'failed'),
  }, {
    build: validation('build', 'passed'),
    test: validation('test', 'failed'),
  }).status, 'INCONCLUSIVE');
});

test('Python baseline uses a workspace-local virtualenv and bootstraps pytest', { skip: process.platform === 'win32' }, async () => {
  const workspace = tempDir('bonsai-python-repro-');
  try {
    fs.writeFileSync(path.join(workspace, 'setup.py'), 'from setuptools import setup\n');
    fs.writeFileSync(path.join(workspace, 'test_example.py'), 'def test_example():\n    assert True\n');
    const binDir = path.join(workspace, '.bonsai-venv', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakePython = path.join(binDir, 'python');
    fs.writeFileSync(fakePython, '#!/bin/sh\necho "$@" >> venv-invocations.log\nexit 0\n');
    fs.chmodSync(fakePython, 0o755);

    const baseline = await runBaselineValidation(workspace);

    assert.equal(baseline.setup.status, 'passed');
    assert.equal(baseline.build.status, 'passed');
    assert.equal(baseline.test.status, 'passed');
    assert.match(baseline.test.displayCommand, /\.bonsai-venv\/bin\/python -m pytest -q/);
    const invocations = fs.readFileSync(path.join(workspace, 'venv-invocations.log'), 'utf8');
    assert.match(invocations, /-m pip install .* pytest/);
    assert.match(invocations, /-m compileall -q \./);
    assert.match(invocations, /-m pytest -q/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('isolated reproduction clone establishes baseline and records a newly failing test', async () => {
  const source = tempDir('bonsai-repro-source-');
  const root = tempDir('bonsai-repro-workspaces-');
  try {
    initGitRepo(source);
    fs.mkdirSync(path.join(source, 'test'));
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'reproduction-fixture',
      version: '1.0.0',
      scripts: {
        build: 'node -e "process.exit(0)"',
        test: 'node -e "const fs=require(\\\"fs\\\");const p=\\\"test/reported-bug.test.js\\\";if(fs.existsSync(p)&&fs.readFileSync(p,\\\"utf8\\\").includes(\\\"actual\\\")){console.error(p);process.exit(1)}"',
      },
    }, null, 2));
    fs.writeFileSync(path.join(source, 'test', 'existing.test.js'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('baseline passes', () => assert.equal(1, 1));",
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: source });

    assert.deepEqual(discoverTestContextFiles(source, 5), ['test/existing.test.js']);
    const workspace = await prepareReproductionClone(source, 'owner', 'repo', 42, root);
    assert.match(execFileSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8' }), /bonsai-issue-42-reproduction/);

    const baseline = await runBaselineValidation(workspace);
    assert.equal(baseline.build.status, 'passed');
    assert.equal(baseline.test.status, 'passed');

    const generated = parseGeneratedReproductionTest(JSON.stringify({
      summary: 'Add an issue-specific failing regression assertion.',
      files: [{
        path: 'test/reported-bug.test.js',
        content: [
          "const test = require('node:test');",
          "const assert = require('node:assert/strict');",
          "test('reported behavior', () => assert.equal('actual', 'expected'));",
          '',
        ].join('\n'),
      }],
    }));
    const changedFiles = await applyGeneratedFix(workspace, generated);
    const reproduction = await runReproductionValidation(workspace);
    assert.equal(reproduction.build.status, 'passed');
    assert.equal(reproduction.test.status, 'failed');

    const report = await finalizeReproductionReport({
      workspacePath: workspace,
      changedFiles,
      generationSummary: generated.summary,
      baseline,
      reproduction,
    });
    assert.equal(report.status, 'REPRODUCED');
    assert.ok(fs.existsSync(report.reportPath));
    assert.ok(fs.existsSync(report.diffPath));
    assert.match(fs.readFileSync(report.reportPath, 'utf8'), /Status: \*\*REPRODUCED\*\*/);
    assert.equal(fs.existsSync(path.join(source, 'test', 'reported-bug.test.js')), false);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
