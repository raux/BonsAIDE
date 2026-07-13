import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { safeRepoCacheName } from './repo-analyzer';

export const FIX_CANDIDATE_COUNT = 4;
const MAX_GENERATED_FILES = 16;
const MAX_GENERATED_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_CHARS = 120_000;
const MAX_LOG_CHARS = 200_000;

export interface FixPlanLike {
  title: string;
  summary: string;
  implementations?: Array<{
    title: string;
    summary: string;
    todos: Array<{
      bugLocation: string;
      fixIdea: string;
      potentialMethod: string;
      sourceCodeSketch: string;
      tests: string[];
    }>;
  }>;
  todos?: Array<{
    bugLocation: string;
    fixIdea: string;
    potentialMethod: string;
    sourceCodeSketch: string;
    tests: string[];
  }>;
}

export interface GeneratedFileChange {
  path: string;
  content: string;
}

export interface GeneratedFix {
  summary: string;
  files: GeneratedFileChange[];
}

export interface ValidationCommand {
  label: 'setup' | 'build' | 'test';
  command: string;
  args: string[];
}

export type ValidationStatus = 'passed' | 'failed' | 'unavailable';

export interface ValidationResult {
  label: 'setup' | 'build' | 'test';
  displayCommand: string;
  status: ValidationStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  logPath?: string;
}

export type CandidateStatus = 'PASS' | 'PARTIAL' | 'FAIL';

export interface FixCandidateReport {
  candidate: number;
  title: string;
  workspacePath: string;
  changedFiles: string[];
  gitStatus: string;
  diffStat: string;
  diffPath: string;
  reportPath: string;
  setup: ValidationResult;
  build: ValidationResult;
  test: ValidationResult;
  status: CandidateStatus;
  generationSummary: string;
  error?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export function defaultFixWorkspacesRoot(): string {
  return path.join(process.cwd(), 'artifacts', 'repo-fix-workspaces');
}

function issueWorkspaceRoot(owner: string, repo: string, issueNumber: number, root: string): string {
  return path.join(root, safeRepoCacheName(owner, repo), `issue-${issueNumber}`);
}

function execFileCaptured(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise(resolve => {
    execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 600_000,
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

export async function prepareFourFixClones(
  sourceRepoPath: string,
  owner: string,
  repo: string,
  issueNumber: number,
  root = defaultFixWorkspacesRoot()
): Promise<string[]> {
  if (!fs.existsSync(path.join(sourceRepoPath, '.git'))) {
    throw new Error(`Source repository is not a Git checkout: ${sourceRepoPath}`);
  }

  const workspaceRoot = issueWorkspaceRoot(owner, repo, issueNumber, root);
  await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  await fs.promises.mkdir(workspaceRoot, { recursive: true });

  const clones: string[] = [];
  for (let index = 1; index <= FIX_CANDIDATE_COUNT; index += 1) {
    const clonePath = path.join(workspaceRoot, `clone-${index}`);
    const cloned = await execFileCaptured('git', ['clone', '--quiet', '--no-hardlinks', sourceRepoPath, clonePath], { timeout: 180_000 });
    if (cloned.exitCode !== 0) {
      throw new Error(`Failed to create clone ${index}: ${cloned.stderr || cloned.stdout}`);
    }
    const branch = `bonsai-issue-${issueNumber}-candidate-${index}`;
    const checkout = await execFileCaptured('git', ['checkout', '-b', branch], { cwd: clonePath, timeout: 30_000 });
    if (checkout.exitCode !== 0) {
      throw new Error(`Failed to create branch for clone ${index}: ${checkout.stderr || checkout.stdout}`);
    }
    clones.push(clonePath);
  }
  return clones;
}

function safeRelativeGeneratedPath(value: string): string {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || path.posix.isAbsolute(normalized)) {
    throw new Error(`Generated file path must be relative: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Generated file path contains an unsafe segment: ${value}`);
  }
  if (parts[0] === '.git' || parts.includes('node_modules')) {
    throw new Error(`Generated file path targets a protected directory: ${value}`);
  }
  return normalized;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseGeneratedFix(raw: string): GeneratedFix {
  const trimmed = String(raw || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  const rawFiles = Array.isArray(parsed.files) ? parsed.files.slice(0, MAX_GENERATED_FILES) : [];
  const files: GeneratedFileChange[] = rawFiles.map(item => {
    const file = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const relativePath = safeRelativeGeneratedPath(stringValue(file.path));
    const content = stringValue(file.content);
    if (Buffer.byteLength(content, 'utf8') > MAX_GENERATED_FILE_BYTES) {
      throw new Error(`Generated file exceeds ${MAX_GENERATED_FILE_BYTES} bytes: ${relativePath}`);
    }
    return { path: relativePath, content };
  });
  if (files.length === 0) {
    throw new Error('Model returned no generated files.');
  }
  return { summary: stringValue(parsed.summary).trim(), files };
}

export function collectFixContext(repoPath: string, relativeFiles: string[]): string {
  let remaining = MAX_CONTEXT_CHARS;
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const requested of relativeFiles) {
    let relativeFile: string;
    try { relativeFile = safeRelativeGeneratedPath(requested); } catch { continue; }
    if (seen.has(relativeFile)) { continue; }
    seen.add(relativeFile);
    const fullPath = path.resolve(repoPath, relativeFile);
    if (!fullPath.startsWith(path.resolve(repoPath) + path.sep) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) { continue; }
    const content = fs.readFileSync(fullPath, 'utf8');
    const available = Math.max(0, remaining - relativeFile.length - 80);
    if (available === 0) { break; }
    const included = content.slice(0, available);
    blocks.push(`FILE: ${relativeFile}\n--- BEGIN FILE ---\n${included}\n--- END FILE ---`);
    remaining -= included.length + relativeFile.length + 80;
    if (remaining <= 0) { break; }
  }
  return blocks.join('\n\n');
}

function planAsText(plan: FixPlanLike): string {
  const lines = [`Title: ${plan.title}`, `Summary: ${plan.summary}`];
  const implementations = plan.implementations?.length
    ? plan.implementations
    : [{ title: 'Implementation', summary: '', todos: plan.todos || [] }];
  implementations.forEach((implementation, implementationIndex) => {
    lines.push(`Implementation ${implementationIndex + 1}: ${implementation.title}`);
    if (implementation.summary) { lines.push(`Tradeoff: ${implementation.summary}`); }
    implementation.todos.forEach((todo, todoIndex) => {
      lines.push(`Todo ${todoIndex + 1}:`);
      lines.push(`- Bug location: ${todo.bugLocation}`);
      lines.push(`- Fix idea: ${todo.fixIdea}`);
      lines.push(`- Potential method: ${todo.potentialMethod}`);
      lines.push(`- Required tests: ${(todo.tests || []).join('; ') || '(infer regression tests)'}`);
    });
  });
  return lines.join('\n');
}

export function buildFixGenerationPrompt(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  candidate: number;
  plan: FixPlanLike;
  fileContext: string;
  generationInstructions?: string;
}): string {
  return `
You are implementing candidate ${input.candidate} of exactly four isolated fixes for a GitHub issue.
Work only from the issue, selected plan, and repository files supplied below.

Return ONLY valid JSON with this shape:
{
  "summary": "concise description of the implemented fix",
  "files": [
    { "path": "relative/path/in/repository", "content": "complete final file content" }
  ]
}

Rules:
- Return complete final contents for every file you modify or add, not a diff.
- Keep the change focused on this candidate's distinct plan.
- Preserve unrelated behavior and public APIs unless the plan explicitly requires a change.
- Add or update focused automated tests when a suitable test location is included in context.
- Use only relative paths. Never write .git, node_modules, build outputs, lockfiles, or secrets.
- Do not claim build/tests passed; BonsAIDE will run them after applying the files.
- Do not include Markdown or code fences outside JSON string values.

Repository: ${input.owner}/${input.repo}
Issue: #${input.issueNumber} ${input.issueTitle}
Issue description:
${input.issueBody || 'No description provided.'}

Selected fix plan:
${planAsText(input.plan)}

User-specified code generation instructions:
${input.generationInstructions?.trim() || '(none supplied)'}

Current complete repository files:
${input.fileContext || '(No complete file context was available. Return no invented paths.)'}
  `.trim();
}

export async function applyGeneratedFix(workspacePath: string, generated: GeneratedFix): Promise<string[]> {
  const root = path.resolve(workspacePath);
  const changedFiles: string[] = [];
  for (const file of generated.files) {
    const relativeFile = safeRelativeGeneratedPath(file.path);
    const target = path.resolve(root, relativeFile);
    if (!target.startsWith(root + path.sep)) {
      throw new Error(`Generated file escapes workspace: ${relativeFile}`);
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, file.content, 'utf8');
    changedFiles.push(relativeFile);
  }
  return changedFiles;
}

function readPackageScripts(workspacePath: string): Record<string, string> {
  const packagePath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(packagePath)) { return {}; }
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> };
    return parsed.scripts || {};
  } catch {
    return {};
  }
}

function command(label: ValidationCommand['label'], executable: string, args: string[]): ValidationCommand {
  return { label, command: executable, args };
}

export function detectValidationCommands(workspacePath: string): Partial<Record<ValidationCommand['label'], ValidationCommand>> {
  const scripts = readPackageScripts(workspacePath);
  if (Object.keys(scripts).length > 0) {
    let executable = 'npm';
    let runner: string[] = ['run'];
    let setup: ValidationCommand | undefined;
    if (fs.existsSync(path.join(workspacePath, 'pnpm-lock.yaml'))) {
      executable = 'pnpm';
      setup = command('setup', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']);
    } else if (fs.existsSync(path.join(workspacePath, 'yarn.lock'))) {
      executable = 'yarn';
      runner = [];
      setup = command('setup', 'yarn', ['install', '--frozen-lockfile', '--ignore-scripts']);
    } else if (fs.existsSync(path.join(workspacePath, 'package-lock.json'))) {
      setup = command('setup', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    }
    const buildScript = ['build', 'compile', 'compile-server', 'package'].find(name => scripts[name]);
    return {
      setup,
      build: buildScript ? command('build', executable, [...runner, buildScript]) : undefined,
      test: scripts.test ? command('test', executable, [...runner, 'test']) : undefined,
    };
  }

  if (fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) {
    return { build: command('build', 'cargo', ['build']), test: command('test', 'cargo', ['test']) };
  }
  if (fs.existsSync(path.join(workspacePath, 'go.mod'))) {
    return { build: command('build', 'go', ['build', './...']), test: command('test', 'go', ['test', './...']) };
  }
  if (fs.existsSync(path.join(workspacePath, 'pom.xml'))) {
    return { build: command('build', 'mvn', ['-B', '-DskipTests', 'package']), test: command('test', 'mvn', ['-B', 'test']) };
  }
  if (fs.existsSync(path.join(workspacePath, 'gradlew'))) {
    return { build: command('build', './gradlew', ['assemble', '--no-daemon']), test: command('test', './gradlew', ['test', '--no-daemon']) };
  }
  if (fs.existsSync(path.join(workspacePath, 'pyproject.toml')) || fs.existsSync(path.join(workspacePath, 'setup.py'))) {
    const hasTests = fs.existsSync(path.join(workspacePath, 'tests')) || fs.existsSync(path.join(workspacePath, 'pytest.ini'));
    return {
      build: command('build', 'python3', ['-m', 'compileall', '-q', '.']),
      test: hasTests ? command('test', 'python3', ['-m', 'pytest', '-q']) : undefined,
    };
  }
  return {};
}

export function unavailableValidation(label: ValidationResult['label'], message: string): ValidationResult {
  return { label, displayCommand: '(not detected)', status: 'unavailable', exitCode: null, durationMs: 0, stdout: '', stderr: message };
}

async function runValidationCommand(workspacePath: string, spec: ValidationCommand | undefined, reportDir: string): Promise<ValidationResult> {
  if (!spec) { return unavailableValidation('build', 'No command detected.'); }
  const executed = await execFileCaptured(spec.command, spec.args, { cwd: workspacePath, timeout: spec.label === 'setup' ? 600_000 : 900_000 });
  const displayCommand = [spec.command, ...spec.args].join(' ');
  const logPath = path.join(reportDir, `${spec.label}.log`);
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
    label: spec.label,
    displayCommand,
    status: executed.exitCode === 0 ? 'passed' : 'failed',
    exitCode: executed.exitCode,
    durationMs: executed.durationMs,
    stdout: executed.stdout,
    stderr: executed.stderr,
    logPath,
  };
}

export async function validateFixWorkspace(workspacePath: string): Promise<{ setup: ValidationResult; build: ValidationResult; test: ValidationResult }> {
  const reportDir = path.join(workspacePath, '.bonsai-reports');
  await fs.promises.mkdir(reportDir, { recursive: true });
  const commands = detectValidationCommands(workspacePath);
  const setup = commands.setup
    ? await runValidationCommand(workspacePath, commands.setup, reportDir)
    : unavailableValidation('setup', 'No dependency setup command was required or detected.');
  // Build and tests are both attempted even if setup/build fails so every candidate
  // has an explicit validation outcome, as required by the four-clone workflow.
  const build = commands.build
    ? await runValidationCommand(workspacePath, commands.build, reportDir)
    : unavailableValidation('build', 'No safe build command was detected.');
  const test = commands.test
    ? await runValidationCommand(workspacePath, commands.test, reportDir)
    : unavailableValidation('test', 'No safe test command was detected.');
  return { setup, build, test };
}

function candidateStatus(build: ValidationResult, test: ValidationResult): CandidateStatus {
  if (build.status === 'passed' && test.status === 'passed') { return 'PASS'; }
  if (build.status === 'failed' || test.status === 'failed') { return 'FAIL'; }
  return 'PARTIAL';
}

function markdownResult(result: ValidationResult): string {
  return `- ${result.label}: **${result.status.toUpperCase()}** — \`${result.displayCommand}\`${result.logPath ? ` — log: \`${result.logPath}\`` : ''}`;
}

async function collectCompleteDiff(workspacePath: string, changedFiles: string[]): Promise<string> {
  const trackedDiff = await execFileCaptured('git', ['diff', '--no-ext-diff'], { cwd: workspacePath, timeout: 30_000 });
  const parts = [trackedDiff.stdout.trimEnd()].filter(Boolean);
  for (const relativeFile of changedFiles) {
    const tracked = await execFileCaptured('git', ['ls-files', '--error-unmatch', '--', relativeFile], { cwd: workspacePath, timeout: 10_000 });
    if (tracked.exitCode === 0) { continue; }
    const untrackedDiff = await execFileCaptured('git', ['diff', '--no-index', '--', '/dev/null', relativeFile], { cwd: workspacePath, timeout: 30_000 });
    if (untrackedDiff.stdout.trim()) { parts.push(untrackedDiff.stdout.trimEnd()); }
  }
  return parts.join('\n');
}

export async function finalizeCandidateReport(input: {
  candidate: number;
  title: string;
  workspacePath: string;
  changedFiles: string[];
  generationSummary: string;
  validation: { setup: ValidationResult; build: ValidationResult; test: ValidationResult };
  error?: string;
}): Promise<FixCandidateReport> {
  const reportDir = path.join(input.workspacePath, '.bonsai-reports');
  await fs.promises.mkdir(reportDir, { recursive: true });
  const statusResult = await execFileCaptured('git', ['status', '--short', '--', '.', ':(exclude).bonsai-reports'], { cwd: input.workspacePath, timeout: 30_000 });
  const statResult = await execFileCaptured('git', ['diff', '--stat'], { cwd: input.workspacePath, timeout: 30_000 });
  const completeDiff = await collectCompleteDiff(input.workspacePath, input.changedFiles);
  const diffPath = path.join(reportDir, 'changes.diff');
  await fs.promises.writeFile(diffPath, completeDiff, 'utf8');
  const reportPath = path.join(reportDir, 'report.md');
  const status = input.error ? 'FAIL' : candidateStatus(input.validation.build, input.validation.test);
  const report: FixCandidateReport = {
    candidate: input.candidate,
    title: input.title,
    workspacePath: input.workspacePath,
    changedFiles: input.changedFiles,
    gitStatus: statusResult.stdout.trim(),
    diffStat: statResult.stdout.trim(),
    diffPath,
    reportPath,
    setup: input.validation.setup,
    build: input.validation.build,
    test: input.validation.test,
    status,
    generationSummary: input.generationSummary,
    error: input.error,
  };
  const markdown = [
    `# Fix Candidate ${input.candidate}: ${input.title}`,
    '',
    `- Status: **${status}**`,
    `- Workspace: \`${input.workspacePath}\``,
    `- Changed files: ${input.changedFiles.join(', ') || '(none)'}`,
    `- Generation summary: ${input.generationSummary || '(none)'}`,
    ...(input.error ? [`- Error: ${input.error}`] : []),
    '',
    '## Validation',
    markdownResult(input.validation.setup),
    markdownResult(input.validation.build),
    markdownResult(input.validation.test),
    '',
    '## Diff stat',
    '```',
    report.diffStat || '(no tracked diff)',
    '```',
    '',
    `Full diff: \`${diffPath}\``,
  ].join('\n');
  await fs.promises.writeFile(reportPath, markdown, 'utf8');
  await fs.promises.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}
