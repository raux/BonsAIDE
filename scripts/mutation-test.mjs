#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const MUTANTS_PATH = path.join(ROOT, 'test-mutants', 'mutants.json');
const REPORT_DIR = path.join(ROOT, 'artifacts', 'mutation-testing');
const DEFAULT_TEST_COMMAND = process.env.MUTATION_TEST_COMMAND || 'npm test';

function parseArgs(argv) {
  const options = {
    mutantIds: new Set(),
    skipBaseline: false,
    command: DEFAULT_TEST_COMMAND,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-baseline') {
      options.skipBaseline = true;
    } else if (arg === '--mutant' || arg === '--id') {
      const value = argv[++i];
      if (!value) { throw new Error(`${arg} requires a mutant id`); }
      options.mutantIds.add(value);
    } else if (arg === '--command') {
      const value = argv[++i];
      if (!value) { throw new Error('--command requires a shell command'); }
      options.command = value;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/mutation-test.mjs [options]\n\nOptions:\n  --mutant <id>       Run only one mutant. May be repeated.\n  --skip-baseline     Do not run the baseline test suite first.\n  --command <cmd>     Test command to run for each mutant. Default: ${DEFAULT_TEST_COMMAND}\n  -h, --help          Show this help.\n\nEnvironment:\n  MUTATION_TEST_COMMAND can override the default test command.\n`);
}

function run(command) {
  const start = Date.now();
  const result = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  return {
    command,
    status: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs: Date.now() - start,
  };
}

function summarizeOutput(output, maxChars = 6000) {
  const combined = `${output.stdout || ''}${output.stderr ? `\n--- stderr ---\n${output.stderr}` : ''}`;
  if (combined.length <= maxChars) { return combined; }
  return `${combined.slice(0, 2000)}\n\n... output truncated ...\n\n${combined.slice(-maxChars + 2000)}`;
}

function loadMutants(options) {
  const mutants = JSON.parse(fs.readFileSync(MUTANTS_PATH, 'utf8'));
  if (!Array.isArray(mutants)) {
    throw new Error(`${MUTANTS_PATH} must contain a JSON array`);
  }

  const selected = options.mutantIds.size
    ? mutants.filter(mutant => options.mutantIds.has(mutant.id))
    : mutants;

  if (options.mutantIds.size && selected.length !== options.mutantIds.size) {
    const found = new Set(selected.map(mutant => mutant.id));
    const missing = [...options.mutantIds].filter(id => !found.has(id));
    throw new Error(`Unknown mutant id(s): ${missing.join(', ')}`);
  }

  return selected;
}

function validateMutant(mutant) {
  for (const key of ['id', 'description', 'file', 'old', 'new']) {
    if (typeof mutant[key] !== 'string' || mutant[key].length === 0) {
      throw new Error(`Mutant is missing required string field: ${key}`);
    }
  }
}

function applyMutant(mutant, originalByFile) {
  const filePath = path.join(ROOT, mutant.file);
  const original = fs.readFileSync(filePath, 'utf8');
  if (!originalByFile.has(filePath)) {
    originalByFile.set(filePath, original);
  }

  const occurrences = original.split(mutant.old).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one match for ${mutant.id} in ${mutant.file}, found ${occurrences}`);
  }

  fs.writeFileSync(filePath, original.replace(mutant.old, mutant.new));
}

function restoreFiles(originalByFile) {
  for (const [filePath, original] of originalByFile.entries()) {
    fs.writeFileSync(filePath, original);
  }
  originalByFile.clear();
}

function writeReports(report) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(REPORT_DIR, `${stamp}-mutation-report.json`);
  const mdPath = path.join(REPORT_DIR, `${stamp}-mutation-report.md`);
  const latestJsonPath = path.join(REPORT_DIR, 'latest.json');
  const latestMdPath = path.join(REPORT_DIR, 'latest.md');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(latestJsonPath, JSON.stringify(report, null, 2) + '\n');

  const rows = report.results.map(result => (
    `| ${result.id} | ${escapeMd(result.description)} | ${result.status} | ${result.exitCode} | ${result.durationMs} | ${escapeMd(result.expected || '')} |`
  )).join('\n');

  const md = `# Mutation Testing Report\n\n` +
    `- Created: ${report.createdAt}\n` +
    `- Command: \`${report.command}\`\n` +
    `- Baseline: ${report.baseline?.status === 0 ? 'passed' : report.baseline ? 'failed' : 'skipped'}\n` +
    `- Total mutants: ${report.summary.total}\n` +
    `- Killed: ${report.summary.killed}\n` +
    `- Survived: ${report.summary.survived}\n` +
    `- Invalid: ${report.summary.invalid}\n` +
    `- Score: ${report.summary.scorePercent.toFixed(1)}%\n\n` +
    `| Mutant | Description | Result | Exit | ms | Expected |\n` +
    `|---|---|---:|---:|---:|---|\n` +
    `${rows}\n`;

  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(latestMdPath, md);

  return { jsonPath, mdPath, latestJsonPath, latestMdPath };
}

function escapeMd(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function getGitStatus() {
  const result = run('git status --short');
  return result.status === 0 ? result.stdout.trim() : '';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mutants = loadMutants(options);
  const originalByFile = new Map();
  const createdAt = new Date().toISOString();
  const gitStatusBefore = getGitStatus();

  console.log(`Mutation test command: ${options.command}`);
  if (gitStatusBefore) {
    console.log('Working tree is not clean; runner will restore mutated files after each mutant.');
    console.log(gitStatusBefore);
  }

  let baseline = null;
  if (!options.skipBaseline) {
    console.log('\n== Baseline ==');
    baseline = run(options.command);
    console.log(`Baseline exit=${baseline.status} duration=${baseline.durationMs}ms`);
    if (baseline.status !== 0) {
      console.error('Baseline test suite failed. Aborting mutation run.');
      console.error(summarizeOutput(baseline));
      const report = {
        createdAt,
        command: options.command,
        gitStatusBefore,
        baseline: { status: baseline.status, durationMs: baseline.durationMs, output: summarizeOutput(baseline) },
        results: [],
        summary: { total: 0, killed: 0, survived: 0, invalid: 0, scorePercent: 0 },
      };
      const paths = writeReports(report);
      console.error(`Report written: ${path.relative(ROOT, paths.latestMdPath)}`);
      process.exit(2);
    }
  }

  const results = [];

  for (const [index, mutant] of mutants.entries()) {
    console.log(`\n== ${index + 1}/${mutants.length} ${mutant.id}: ${mutant.description} ==`);
    let runResult = null;
    try {
      validateMutant(mutant);
      applyMutant(mutant, originalByFile);
      runResult = run(options.command);
      const killed = runResult.status !== 0;
      const status = killed ? 'killed' : 'survived';
      console.log(`${mutant.id}: ${status} exit=${runResult.status} duration=${runResult.durationMs}ms`);
      results.push({
        id: mutant.id,
        description: mutant.description,
        file: mutant.file,
        expected: mutant.expected || '',
        status,
        exitCode: runResult.status,
        signal: runResult.signal,
        durationMs: runResult.durationMs,
        output: summarizeOutput(runResult),
      });
    } catch (error) {
      console.error(`${mutant.id}: invalid (${error.message})`);
      results.push({
        id: mutant.id || '(unknown)',
        description: mutant.description || '',
        file: mutant.file || '',
        expected: mutant.expected || '',
        status: 'invalid',
        exitCode: null,
        signal: null,
        durationMs: 0,
        output: String(error.stack || error),
      });
    } finally {
      restoreFiles(originalByFile);
    }
  }

  // Confirm the restored tree still passes after all mutations.
  console.log('\n== Final restored test run ==');
  const finalRun = run(options.command);
  console.log(`Final restored exit=${finalRun.status} duration=${finalRun.durationMs}ms`);

  const killed = results.filter(result => result.status === 'killed').length;
  const survived = results.filter(result => result.status === 'survived').length;
  const invalid = results.filter(result => result.status === 'invalid').length;
  const totalValid = killed + survived;
  const scorePercent = totalValid ? (killed / totalValid) * 100 : 0;

  const report = {
    createdAt,
    command: options.command,
    gitStatusBefore,
    baseline: baseline ? { status: baseline.status, durationMs: baseline.durationMs, output: summarizeOutput(baseline) } : null,
    finalRun: { status: finalRun.status, durationMs: finalRun.durationMs, output: summarizeOutput(finalRun) },
    results,
    summary: {
      total: results.length,
      killed,
      survived,
      invalid,
      scorePercent,
    },
  };

  const paths = writeReports(report);

  console.log('\n== Summary ==');
  console.log(`Killed:   ${killed}`);
  console.log(`Survived: ${survived}`);
  console.log(`Invalid:  ${invalid}`);
  console.log(`Score:    ${scorePercent.toFixed(1)}%`);
  console.log(`Report:   ${path.relative(ROOT, paths.latestMdPath)}`);

  if (finalRun.status !== 0) {
    console.error('Final restored test run failed; inspect the working tree before continuing.');
    process.exit(3);
  }
  if (survived > 0 || invalid > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
