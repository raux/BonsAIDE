import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  GeneratedFix,
  ValidationCommand,
  ValidationResult,
  applyGeneratedFix,
  detectValidationCommands,
  parseGeneratedFix,
  unavailableValidation,
} from './fix-workspaces';
import { safeRepoCacheName } from './repo-analyzer';

const MAX_LOG_CHARS = 200_000;

export type ReproductionStatus = 'REPRODUCED' | 'NOT_REPRODUCED' | 'INCONCLUSIVE';

export interface ReproductionValidation {
  setup?: ValidationResult;
  build: ValidationResult;
  test: ValidationResult;
}

export interface ReproductionReport {
  status: ReproductionStatus;
  reason: string;
  workspacePath: string;
  changedFiles: string[];
  generationSummary: string;
  baseline: ReproductionValidation;
  reproduction: ReproductionValidation;
  diffPath: string;
  reportPath: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

function execFileCaptured(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    const started = Date.now();
    execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 900_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    }, (error: any, stdout, stderr) => {
      resolve({
        stdout: String(stdout || '').slice(-MAX_LOG_CHARS),
        stderr: String(stderr || '').slice(-MAX_LOG_CHARS),
        exitCode: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
        durationMs: Date.now() - started,
      });
    });
  });
}

export function defaultReproductionWorkspacesRoot(): string {
  return path.join(process.cwd(), 'artifacts', 'repo-reproduction-workspaces');
}

export async function prepareReproductionClone(
  sourceRepoPath: string,
  owner: string,
  repo: string,
  issueNumber: number,
  root = defaultReproductionWorkspacesRoot()
): Promise<string> {
  if (!fs.existsSync(path.join(sourceRepoPath, '.git'))) {
    throw new Error(`Source repository is not a Git checkout: ${sourceRepoPath}`);
  }
  const issueRoot = path.join(root, safeRepoCacheName(owner, repo), `issue-${issueNumber}`);
  const workspacePath = path.join(issueRoot, 'reproduction');
  await fs.promises.rm(issueRoot, { recursive: true, force: true });
  await fs.promises.mkdir(issueRoot, { recursive: true });
  const cloned = await execFileCaptured('git', ['clone', '--quiet', '--no-hardlinks', sourceRepoPath, workspacePath], { timeout: 180_000 });
  if (cloned.exitCode !== 0) {
    throw new Error(`Failed to create reproduction clone: ${cloned.stderr || cloned.stdout}`);
  }
  const branch = `bonsai-issue-${issueNumber}-reproduction`;
  const checkout = await execFileCaptured('git', ['checkout', '-b', branch], { cwd: workspacePath, timeout: 30_000 });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to create reproduction branch: ${checkout.stderr || checkout.stdout}`);
  }
  return workspacePath;
}

export function isLikelyTestPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/');
  const base = parts[parts.length - 1] || '';
  if (parts.some(part => ['test', 'tests', '__tests__', 'spec', 'specs'].includes(part))) { return true; }
  return /(^test[_-].+|.+[_-]test|.+\.tests?|.+\.spec)\.[a-z0-9]+$/.test(base)
    || /tests?\.(java|kt|kts|cs|cpp|c)$/.test(base);
}

export function parseGeneratedReproductionTest(raw: string): GeneratedFix {
  const generated = parseGeneratedFix(raw);
  const unsafe = generated.files.find(file => !isLikelyTestPath(file.path));
  if (unsafe) {
    throw new Error(`Reproduction generation may only write test files: ${unsafe.path}`);
  }
  return generated;
}

export function discoverTestContextFiles(repoPath: string, maxFiles = 10): string[] {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '.next', '.cache']);
  const found: string[] = [];
  const visit = (directory: string): void => {
    if (found.length >= maxFiles) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxFiles) { break; }
      if (ignored.has(entry.name)) { continue; }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(repoPath, fullPath).replace(/\\/g, '/');
        if (isLikelyTestPath(relativePath)) { found.push(relativePath); }
      }
    }
  };
  visit(repoPath);
  return found;
}

export function buildReproductionTestPrompt(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueInterpretation: string;
  snippetContext: string;
  fileContext: string;
  generationInstructions?: string;
}): string {
  return `
You are creating a focused regression test that attempts to reproduce a reported GitHub issue in an isolated repository clone.

Return ONLY valid JSON with this exact shape:
{
  "summary": "what behavior the regression test exercises and why it should fail before a fix",
  "files": [
    { "path": "relative/path/to/a/test-file", "content": "complete final test file content" }
  ]
}

Rules:
- Write test files only. Do not modify production source, manifests, lockfiles, snapshots, build outputs, or configuration.
- Follow the repository's existing test framework, naming, imports, and conventions from the supplied files.
- Return complete final contents for every test file you add or modify, not a diff.
- The test must assert the behavior described by the issue and should fail on the current buggy revision for the issue-specific reason.
- Keep the test deterministic, bounded, and independent of network services, secrets, user data, and destructive operations.
- Do not weaken assertions or intentionally throw an unrelated error merely to force failure.
- Use only relative paths containing a conventional test/spec filename or test directory.
- Do not claim the test was run; BonsAIDE will run detected repository commands after applying it.
- Do not include Markdown or code fences outside JSON string values.

Repository: ${input.owner}/${input.repo}
Issue: #${input.issueNumber} ${input.issueTitle}
Issue description:
${input.issueBody || 'No description provided.'}

Issue interpretation:
${input.issueInterpretation || '(not available)'}

Likely impacted snippets:
${input.snippetContext || '(not available)'}

User-specified constraints:
${input.generationInstructions?.trim() || '(none supplied)'}

Relevant source, test, and manifest files:
${input.fileContext || '(No complete file context was available.)'}
  `.trim();
}

async function runCommand(
  workspacePath: string,
  spec: ValidationCommand | undefined,
  reportDir: string,
  logName: string,
  label: ValidationResult['label']
): Promise<ValidationResult> {
  if (!spec) { return unavailableValidation(label, `No safe ${label} command was detected.`); }
  const executed = await execFileCaptured(spec.command, spec.args, {
    cwd: workspacePath,
    timeout: spec.label === 'setup' ? 600_000 : 900_000,
  });
  const displayCommand = [spec.command, ...spec.args].join(' ');
  const logPath = path.join(reportDir, `${logName}.log`);
  await fs.promises.writeFile(logPath, [
    `$ ${displayCommand}`,
    `exitCode=${executed.exitCode}`,
    `durationMs=${executed.durationMs}`,
    '',
    '--- stdout ---',
    executed.stdout,
    '',
    '--- stderr ---',
    executed.stderr,
  ].join('\n'), 'utf8');
  return {
    label,
    displayCommand,
    status: executed.exitCode === 0 ? 'passed' : 'failed',
    exitCode: executed.exitCode,
    durationMs: executed.durationMs,
    stdout: executed.stdout,
    stderr: executed.stderr,
    logPath,
  };
}

function usesPythonValidation(commands: Partial<Record<ValidationCommand['label'], ValidationCommand>>): boolean {
  return commands.build?.command === 'python3' || commands.test?.command === 'python3';
}

function pythonVenvExecutable(workspacePath: string): string {
  return process.platform === 'win32'
    ? path.join(workspacePath, '.bonsai-venv', 'Scripts', 'python.exe')
    : path.join(workspacePath, '.bonsai-venv', 'bin', 'python');
}

function usePythonVenv(
  workspacePath: string,
  commands: Partial<Record<ValidationCommand['label'], ValidationCommand>>
): Partial<Record<ValidationCommand['label'], ValidationCommand>> {
  if (!usesPythonValidation(commands)) { return commands; }
  const venvPython = pythonVenvExecutable(workspacePath);
  return {
    ...commands,
    build: commands.build ? { ...commands.build, command: venvPython } : undefined,
    test: commands.test ? { ...commands.test, command: venvPython } : undefined,
  };
}

async function bootstrapPythonTestEnvironment(workspacePath: string, reportDir: string): Promise<ValidationResult> {
  const venvPython = pythonVenvExecutable(workspacePath);
  const venvArgs = ['-m', 'venv', '.bonsai-venv'];
  const installArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'pytest'];
  const created = fs.existsSync(venvPython)
    ? { stdout: 'Existing isolated virtual environment reused.\n', stderr: '', exitCode: 0, durationMs: 0 }
    : await execFileCaptured('python3', venvArgs, { cwd: workspacePath, timeout: 180_000 });
  const installed = created.exitCode === 0
    ? await execFileCaptured(venvPython, installArgs, { cwd: workspacePath, timeout: 300_000 })
    : { stdout: '', stderr: 'Skipped pytest installation because virtual-environment creation failed.', exitCode: 1, durationMs: 0 };
  const displayCommand = `python3 ${venvArgs.join(' ')} && ${venvPython} ${installArgs.join(' ')}`;
  const logPath = path.join(reportDir, 'baseline-setup.log');
  const stdout = [created.stdout, installed.stdout].filter(Boolean).join('\n');
  const stderr = [created.stderr, installed.stderr].filter(Boolean).join('\n');
  await fs.promises.writeFile(logPath, [
    `$ ${displayCommand}`,
    `exitCode=${created.exitCode === 0 ? installed.exitCode : created.exitCode}`,
    `durationMs=${created.durationMs + installed.durationMs}`,
    '',
    '--- stdout ---',
    stdout,
    '',
    '--- stderr ---',
    stderr,
  ].join('\n'), 'utf8');
  const exitCode = created.exitCode === 0 ? installed.exitCode : created.exitCode;
  return {
    label: 'setup',
    displayCommand,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    durationMs: created.durationMs + installed.durationMs,
    stdout,
    stderr,
    logPath,
  };
}

export async function runBaselineValidation(workspacePath: string): Promise<ReproductionValidation> {
  const reportDir = path.join(workspacePath, '.bonsai-reports', 'reproduction');
  await fs.promises.mkdir(reportDir, { recursive: true });
  const detectedCommands = detectValidationCommands(workspacePath);
  const pythonValidation = usesPythonValidation(detectedCommands);
  const setup = pythonValidation
    ? await bootstrapPythonTestEnvironment(workspacePath, reportDir)
    : detectedCommands.setup
      ? await runCommand(workspacePath, detectedCommands.setup, reportDir, 'baseline-setup', 'setup')
      : unavailableValidation('setup', 'No dependency setup command was required or detected.');
  const commands = pythonValidation ? usePythonVenv(workspacePath, detectedCommands) : detectedCommands;
  const build = await runCommand(workspacePath, commands.build, reportDir, 'baseline-build', 'build');
  const test = await runCommand(workspacePath, commands.test, reportDir, 'baseline-test', 'test');
  return { setup, build, test };
}

export async function runReproductionValidation(workspacePath: string): Promise<ReproductionValidation> {
  const reportDir = path.join(workspacePath, '.bonsai-reports', 'reproduction');
  await fs.promises.mkdir(reportDir, { recursive: true });
  const detectedCommands = detectValidationCommands(workspacePath);
  const commands = fs.existsSync(pythonVenvExecutable(workspacePath))
    ? usePythonVenv(workspacePath, detectedCommands)
    : detectedCommands;
  const build = await runCommand(workspacePath, commands.build, reportDir, 'reproduction-build', 'build');
  const test = await runCommand(workspacePath, commands.test, reportDir, 'reproduction-test', 'test');
  return { build, test };
}

export function classifyReproduction(
  baseline: ReproductionValidation,
  reproduction: ReproductionValidation,
  generatedTestFiles: string[] = []
): { status: ReproductionStatus; reason: string } {
  if (baseline.setup?.status === 'failed') {
    return { status: 'INCONCLUSIVE', reason: 'Dependency setup failed before a clean baseline could be established.' };
  }
  if (baseline.build.status === 'failed' || baseline.test.status !== 'passed') {
    return { status: 'INCONCLUSIVE', reason: 'The baseline build/test did not pass, so a new issue-specific failure cannot be isolated.' };
  }
  if (reproduction.build.status === 'failed') {
    return { status: 'INCONCLUSIVE', reason: 'The generated test did not build cleanly; its failure is not evidence of the reported behavior.' };
  }
  if (reproduction.test.status === 'failed') {
    const output = `${reproduction.test.stdout}\n${reproduction.test.stderr}`.replace(/\\/g, '/').toLowerCase();
    const mentionsGeneratedTest = generatedTestFiles.length === 0 || generatedTestFiles.some(file => {
      const normalized = file.replace(/\\/g, '/').toLowerCase();
      return output.includes(normalized) || output.includes(path.posix.basename(normalized));
    });
    if (!mentionsGeneratedTest) {
      return { status: 'INCONCLUSIVE', reason: 'The post-test run failed, but its output did not identify a generated regression test.' };
    }
    return { status: 'REPRODUCED', reason: 'The baseline passed and the generated regression test was identified in the failing test output.' };
  }
  if (reproduction.test.status === 'passed') {
    return { status: 'NOT_REPRODUCED', reason: 'The generated regression test passed on the current revision.' };
  }
  return { status: 'INCONCLUSIVE', reason: 'No safe test command was available after adding the regression test.' };
}

async function collectDiff(workspacePath: string, changedFiles: string[]): Promise<string> {
  const tracked = await execFileCaptured('git', ['diff', '--no-ext-diff'], { cwd: workspacePath, timeout: 30_000 });
  const parts = [tracked.stdout.trimEnd()].filter(Boolean);
  for (const relativeFile of changedFiles) {
    const isTracked = await execFileCaptured('git', ['ls-files', '--error-unmatch', '--', relativeFile], { cwd: workspacePath, timeout: 10_000 });
    if (isTracked.exitCode === 0) { continue; }
    const untracked = await execFileCaptured('git', ['diff', '--no-index', '--', '/dev/null', relativeFile], { cwd: workspacePath, timeout: 30_000 });
    if (untracked.stdout.trim()) { parts.push(untracked.stdout.trimEnd()); }
  }
  return parts.join('\n');
}

function validationLine(name: string, result: ValidationResult): string {
  return `- ${name}: **${result.status.toUpperCase()}** — \`${result.displayCommand}\`${result.logPath ? ` — log: \`${result.logPath}\`` : ''}`;
}

export async function finalizeReproductionReport(input: {
  workspacePath: string;
  changedFiles: string[];
  generationSummary: string;
  baseline: ReproductionValidation;
  reproduction: ReproductionValidation;
}): Promise<ReproductionReport> {
  const classification = classifyReproduction(input.baseline, input.reproduction, input.changedFiles);
  const reportDir = path.join(input.workspacePath, '.bonsai-reports', 'reproduction');
  await fs.promises.mkdir(reportDir, { recursive: true });
  const diffPath = path.join(reportDir, 'test-changes.diff');
  await fs.promises.writeFile(diffPath, await collectDiff(input.workspacePath, input.changedFiles), 'utf8');
  const reportPath = path.join(reportDir, 'report.md');
  const report: ReproductionReport = {
    ...classification,
    workspacePath: input.workspacePath,
    changedFiles: input.changedFiles,
    generationSummary: input.generationSummary,
    baseline: input.baseline,
    reproduction: input.reproduction,
    diffPath,
    reportPath,
  };
  const markdown = [
    '# Issue Reproduction Attempt',
    '',
    `- Status: **${report.status}**`,
    `- Reason: ${report.reason}`,
    `- Workspace: \`${report.workspacePath}\``,
    `- Generated test files: ${report.changedFiles.join(', ') || '(none)'}`,
    `- Generation summary: ${report.generationSummary || '(none)'}`,
    '',
    '## Baseline',
    ...(report.baseline.setup ? [validationLine('Setup', report.baseline.setup)] : []),
    validationLine('Build', report.baseline.build),
    validationLine('Test', report.baseline.test),
    '',
    '## Reproduction run',
    validationLine('Build', report.reproduction.build),
    validationLine('Test', report.reproduction.test),
    '',
    `Generated-test diff: \`${report.diffPath}\``,
  ].join('\n');
  await fs.promises.writeFile(reportPath, markdown, 'utf8');
  await fs.promises.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

export { applyGeneratedFix };
