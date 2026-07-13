import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitHubIssueForDisplay } from './server-utils';

export interface ImpactedSnippet {
  file: string;
  startLine: number;
  endLine: number;
  code: string;
  score: number;
  reason: string;
}

export interface IssueLocationHypothesis {
  rephrasedIssue: string;
  suspectedBehavior: string[];
  likelyComponents: string[];
  likelyFiles: string[];
  likelyFunctions: string[];
  searchSignals: string[];
  negativeSignals: string[];
}

export interface RepoIssueAnalysis {
  owner: string;
  repo: string;
  repoPath: string;
  issue: GitHubIssueForDisplay;
  keywords: string[];
  snippets: ImpactedSnippet[];
  content: string;
  agenticAnalysis?: string;
  locationHypothesis?: IssueLocationHypothesis;
  specPath?: string;
}

export interface AnalyzeRepoOptions {
  cacheRoot?: string;
  specRoot?: string;
  maxFiles?: number;
  maxSnippets?: number;
  locationHypothesis?: IssueLocationHypothesis;
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.rs', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.swift', '.kt', '.kts', '.scala', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.sql', '.html', '.css', '.scss', '.sass',
  '.md', '.mdx', '.json', '.yaml', '.yml', '.toml', '.xml', '.txt', '.env', '.ini', '.cfg', '.conf'
]);

const TEXT_FILENAMES = new Set(['dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile']);
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '.next', '.turbo', '.cache']);
const MAX_FILE_BYTES = 512 * 1024;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'there', 'their', 'issue', 'bug', 'fix', 'add', 'new', 'use', 'using',
  'can', 'not', 'all', 'you', 'your', 'our', 'are', 'was', 'were', 'have', 'has', 'had', 'will', 'would', 'should', 'could',
  'into', 'onto', 'than', 'then', 'when', 'where', 'what', 'why', 'how', 'about', 'more', 'less', 'feature', 'request', 'error'
]);

function execFilePromise(bin: string, args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024, timeout: opts.timeout ?? 120000, cwd: opts.cwd }, (error, stdout, stderr) => {
      if (error) { return reject({ error, stdout, stderr }); }
      resolve({ stdout, stderr });
    });
  });
}

export function safeRepoCacheName(owner: string, repo: string): string {
  return `${owner}__${repo}`.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

export function defaultRepoCacheRoot(): string {
  return path.join(process.cwd(), 'artifacts', 'repo-cache');
}

export function defaultRepoAnalysisSpecRoot(): string {
  return path.join(process.cwd(), 'artifacts', 'repo-analysis-specs');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'issue';
}

export async function ensureRepoCheckout(owner: string, repo: string, cacheRoot = defaultRepoCacheRoot()): Promise<string> {
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const repoPath = path.join(cacheRoot, safeRepoCacheName(owner, repo));
  const gitDir = path.join(repoPath, '.git');

  if (fs.existsSync(gitDir)) {
    await execFilePromise('git', ['-C', repoPath, 'pull', '--ff-only'], { timeout: 120000 });
    return repoPath;
  }

  if (fs.existsSync(repoPath)) {
    throw new Error(`Repository cache path exists but is not a Git checkout: ${repoPath}`);
  }

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  await execFilePromise('git', ['clone', '--depth=1', cloneUrl, repoPath], { timeout: 180000 });
  return repoPath;
}

export function extractIssueKeywords(issue: Pick<GitHubIssueForDisplay, 'title' | 'body' | 'labels'>): string[] {
  const labels = (issue.labels || []).map(label => label.name || '').join(' ');
  const raw = `${issue.title || ''}\n${issue.body || ''}\n${labels}`;
  const expanded = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._/:-]+/g, ' ')
    .toLowerCase();
  const tokens = expanded.match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const clean = token.replace(/^-+|-+$/g, '');
    if (clean.length < 3 || STOP_WORDS.has(clean) || seen.has(clean)) { continue; }
    seen.add(clean);
    unique.push(clean);
  }

  return unique.slice(0, 40);
}

function normalizeSignal(value: string): string {
  return (value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._/:-]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueSignals(values: Array<string | undefined>, limit = 80): string[] {
  const seen = new Set<string>();
  const signals: string[] = [];
  for (const value of values) {
    const normalized = normalizeSignal(value || '');
    if (normalized.length < 3 || seen.has(normalized)) { continue; }
    seen.add(normalized);
    signals.push(normalized);
    if (signals.length >= limit) { break; }
  }
  return signals;
}

function issueLocationSignals(hypothesis: IssueLocationHypothesis | undefined, fallbackKeywords: string[]): string[] {
  if (!hypothesis) { return fallbackKeywords; }
  return uniqueSignals([
    ...hypothesis.likelyFiles,
    ...hypothesis.likelyFunctions,
    ...hypothesis.likelyComponents,
    ...hypothesis.searchSignals,
    ...hypothesis.suspectedBehavior,
    ...fallbackKeywords,
  ], 40);
}

function countSignalHits(lowerText: string, normalizedText: string, signal: string): number {
  const normalized = normalizeSignal(signal);
  if (!normalized) { return 0; }
  const raw = (signal || '').toLowerCase().trim();
  const rawHits = raw && raw !== normalized ? countOccurrences(lowerText, raw) : 0;
  return rawHits + countOccurrences(normalizedText, normalized);
}

function addWeightedSignalMatches(
  lowerPath: string,
  normalizedPath: string,
  lowerContent: string,
  normalizedContent: string,
  terms: string[],
  pathWeight: number,
  contentWeight: number,
  matchedSignals: string[]
): number {
  let score = 0;
  for (const term of terms) {
    const pathHits = countSignalHits(lowerPath, normalizedPath, term);
    const contentHits = countSignalHits(lowerContent, normalizedContent, term);
    if (pathHits || contentHits) {
      matchedSignals.push(normalizeSignal(term));
      score += pathHits * pathWeight + Math.min(contentHits, 20) * contentWeight;
    }
  }
  return score;
}

function scoreFileForIssueLocation(
  relativeFile: string,
  content: string,
  fallbackKeywords: string[],
  hypothesis: IssueLocationHypothesis | undefined
): { score: number; matchedSignals: string[]; snippetSignals: string[] } {
  const lowerPath = relativeFile.toLowerCase();
  const lowerContent = content.toLowerCase();
  const normalizedPath = normalizeSignal(relativeFile);
  const normalizedContent = normalizeSignal(content);
  const matchedSignals: string[] = [];
  let score = 0;

  if (hypothesis) {
    score += addWeightedSignalMatches(lowerPath, normalizedPath, lowerContent, normalizedContent, hypothesis.likelyFiles, 45, 10, matchedSignals);
    score += addWeightedSignalMatches(lowerPath, normalizedPath, lowerContent, normalizedContent, hypothesis.likelyFunctions, 20, 30, matchedSignals);
    score += addWeightedSignalMatches(lowerPath, normalizedPath, lowerContent, normalizedContent, hypothesis.likelyComponents, 20, 15, matchedSignals);
    score += addWeightedSignalMatches(lowerPath, normalizedPath, lowerContent, normalizedContent, hypothesis.searchSignals, 12, 10, matchedSignals);
    score += addWeightedSignalMatches(lowerPath, normalizedPath, lowerContent, normalizedContent, hypothesis.suspectedBehavior, 8, 8, matchedSignals);
    const negativeMatches: string[] = [];
    score -= addWeightedSignalMatches(lowerPath, normalizedPath, lowerContent, normalizedContent, hypothesis.negativeSignals, 5, 5, negativeMatches);
  }

  score += addWeightedSignalMatches(lowerPath, normalizedPath, lowerContent, normalizedContent, fallbackKeywords, hypothesis ? 3 : 10, hypothesis ? 2 : 1, matchedSignals);

  return {
    score,
    matchedSignals: uniqueSignals(matchedSignals, 20),
    snippetSignals: uniqueSignals([...matchedSignals, ...fallbackKeywords], 60)
  };
}

function formatIssueLocationHypothesis(hypothesis: IssueLocationHypothesis): string[] {
  const lines: string[] = [];
  lines.push('## Issue interpretation');
  lines.push('');
  lines.push('### Rephrased issue');
  lines.push(hypothesis.rephrasedIssue || '(not provided)');
  lines.push('');
  lines.push('### Suspected behavior');
  lines.push(hypothesis.suspectedBehavior.length ? hypothesis.suspectedBehavior.map(item => `- ${item}`).join('\n') : '- (none)');
  lines.push('');
  lines.push('### Location hypotheses');
  lines.push(`- Components: ${hypothesis.likelyComponents.join(', ') || '(none)'}`);
  lines.push(`- Files: ${hypothesis.likelyFiles.join(', ') || '(none)'}`);
  lines.push(`- Functions: ${hypothesis.likelyFunctions.join(', ') || '(none)'}`);
  lines.push(`- Search signals: ${hypothesis.searchSignals.join(', ') || '(none)'}`);
  lines.push(`- Negative signals: ${hypothesis.negativeSignals.join(', ') || '(none)'}`);
  return lines;
}

function isTextCandidate(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(base);
}

export function discoverCandidateFiles(repoPath: string, maxFiles = 5000): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    if (files.length >= maxFiles) { return; }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) { return; }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) { continue; }
        walk(fullPath);
      } else if (entry.isFile() && isTextCandidate(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.size > 0 && stat.size <= MAX_FILE_BYTES) {
          files.push(path.relative(repoPath, fullPath));
        }
      }
    }
  }

  walk(repoPath);
  return files;
}

function countOccurrences(text: string, keyword: string): number {
  if (!keyword) { return 0; }
  let count = 0;
  let index = text.indexOf(keyword);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(keyword, index + keyword.length);
  }
  return count;
}

function extractSnippet(relativeFile: string, content: string, searchSignals: string[], fileScore: number, matchedSignals: string[]): ImpactedSnippet | null {
  const lines = content.split(/\r?\n/);
  const hitLines: number[] = [];
  const lowerLines = lines.map(line => line.toLowerCase());
  const normalizedLines = lines.map(line => normalizeSignal(line));

  for (let i = 0; i < lowerLines.length; i += 1) {
    if (searchSignals.some(signal => countSignalHits(lowerLines[i], normalizedLines[i], signal) > 0)) {
      hitLines.push(i + 1);
    }
  }

  const anchorLine = hitLines[0] ?? 1;
  const startLine = Math.max(1, anchorLine - 5);
  const endLine = Math.min(lines.length, anchorLine + 8);
  const snippetLines = lines.slice(startLine - 1, endLine);
  const reason = matchedSignals.length
    ? `Matched ${matchedSignals.slice(0, 8).join(', ')} in ${relativeFile}`
    : `Selected ${relativeFile} from issue location hypothesis`;

  return {
    file: relativeFile,
    startLine,
    endLine,
    code: snippetLines.join('\n'),
    score: fileScore,
    reason
  };
}

export function analyzeCheckout(repoPath: string, owner: string, repo: string, issue: GitHubIssueForDisplay, options: AnalyzeRepoOptions = {}): RepoIssueAnalysis {
  const fallbackKeywords = extractIssueKeywords(issue);
  const hypothesis = options.locationHypothesis;
  const keywords = issueLocationSignals(hypothesis, fallbackKeywords);
  const files = discoverCandidateFiles(repoPath, options.maxFiles ?? 5000);
  const snippets: ImpactedSnippet[] = [];

  for (const relativeFile of files) {
    const fullPath = path.join(repoPath, relativeFile);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch { continue; }

    const { score: rawScore, matchedSignals, snippetSignals } = scoreFileForIssueLocation(relativeFile, content, fallbackKeywords, hypothesis);
    if (rawScore <= 0) { continue; }

    let score = rawScore;
    const ext = path.extname(relativeFile).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs'].includes(ext)) { score += 5; }
    if (['.md', '.txt'].includes(ext)) { score -= 2; }
    if (score <= 0) { continue; }

    const snippet = extractSnippet(relativeFile, content, snippetSignals, score, matchedSignals);
    if (snippet) { snippets.push(snippet); }
  }

  snippets.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const limited = snippets.slice(0, options.maxSnippets ?? 8);
  return {
    owner,
    repo,
    repoPath,
    issue,
    keywords,
    snippets: limited,
    content: formatRepoIssueAnalysis(owner, repo, issue, keywords, limited, hypothesis),
    locationHypothesis: hypothesis
  };
}

export async function analyzeRepoForIssue(owner: string, repo: string, issue: GitHubIssueForDisplay, options: AnalyzeRepoOptions = {}): Promise<RepoIssueAnalysis> {
  const repoPath = await ensureRepoCheckout(owner, repo, options.cacheRoot);
  const analysis = analyzeCheckout(repoPath, owner, repo, issue, options);
  const specPath = await writeFixSpecFile(analysis, options.specRoot ?? defaultRepoAnalysisSpecRoot());
  analysis.specPath = specPath;
  analysis.content = `${analysis.content}\n\nFix specification file:\n${specPath}`;
  return analysis;
}

export function formatFixSpecification(analysis: RepoIssueAnalysis): string {
  const lines: string[] = [];
  lines.push(`# Fix Specification: ${analysis.owner}/${analysis.repo} issue #${analysis.issue.number}`);
  lines.push('');
  lines.push('## Issue');
  lines.push(`- Repository: ${analysis.owner}/${analysis.repo}`);
  lines.push(`- Issue: #${analysis.issue.number} ${analysis.issue.title}`);
  if (analysis.issue.html_url) { lines.push(`- URL: ${analysis.issue.html_url}`); }
  if (analysis.issue.user?.login) { lines.push(`- Author: @${analysis.issue.user.login}`); }
  lines.push('');
  lines.push('## Issue description');
  lines.push((analysis.issue.body || '').trim() || 'No description provided.');
  lines.push('');
  lines.push('## Agentic analysis method');
  lines.push('- The repository was cloned or fast-forward updated into the local repo cache.');
  lines.push('- The initial location-analysis phase did not execute repository code or install dependencies.');
  lines.push('- Relevant snippets were gathered with issue rephrasing, location hypotheses, and static repository scanning as context.');
  lines.push('- When four-clone candidate results are attached below, dependency setup, build, and test commands were subsequently executed only inside those isolated clones.');
  lines.push('- A Pi-selected model reviews the issue and snippets to draft root-cause hypotheses, concrete fix steps, and test plans.');
  lines.push('');
  if (analysis.locationHypothesis) {
    lines.push(...formatIssueLocationHypothesis(analysis.locationHypothesis));
    lines.push('');
  }
  lines.push('## Context search signals');
  lines.push(analysis.keywords.length ? analysis.keywords.join(', ') : '(none)');
  lines.push('');
  lines.push('## Agentic fix steps');
  if (analysis.agenticAnalysis) {
    lines.push(analysis.agenticAnalysis.trim());
  } else {
    lines.push('- Agentic fix steps were not attached yet. Review the snippets below before editing.');
  }
  lines.push('');
  lines.push('## Context snippets supplied to the agent');

  if (analysis.snippets.length === 0) {
    lines.push('No snippets identified.');
  } else {
    analysis.snippets.forEach((snippet, index) => {
      lines.push(`### ${index + 1}. ${snippet.file}:${snippet.startLine}-${snippet.endLine}`);
      lines.push(`- Score: ${snippet.score}`);
      lines.push(`- Reason: ${snippet.reason}`);
      lines.push('');
      lines.push('```');
      lines.push(snippet.code);
      lines.push('```');
      lines.push('');
    });
  }

  return lines.join('\n').trimEnd() + '\n';
}

export async function writeFixSpecFile(analysis: RepoIssueAnalysis, specRoot = defaultRepoAnalysisSpecRoot()): Promise<string> {
  const repoDir = path.join(specRoot, safeRepoCacheName(analysis.owner, analysis.repo));
  await fs.promises.mkdir(repoDir, { recursive: true });
  const filename = `issue-${analysis.issue.number}-${slugify(analysis.issue.title || 'issue')}.md`;
  const specPath = path.join(repoDir, filename);
  await fs.promises.writeFile(specPath, formatFixSpecification(analysis), 'utf8');
  return specPath;
}

export function formatRepoIssueAnalysis(
  owner: string,
  repo: string,
  issue: GitHubIssueForDisplay,
  keywords: string[],
  snippets: ImpactedSnippet[],
  locationHypothesis?: IssueLocationHypothesis
): string {
  const lines: string[] = [];
  lines.push(`Repository: ${owner}/${repo}`);
  lines.push(`Issue: #${issue.number} ${issue.title}`);
  if (issue.html_url) { lines.push(`URL: ${issue.html_url}`); }
  lines.push('');
  lines.push('Issue description:');
  lines.push((issue.body || '').trim() || 'No description provided.');
  lines.push('');
  lines.push('Static context gathered for agentic fix analysis');
  if (locationHypothesis) {
    lines.push(...formatIssueLocationHypothesis(locationHypothesis));
    lines.push('');
  }
  lines.push(`Context search signals: ${keywords.join(', ') || '(none)'}`);
  lines.push('');

  if (snippets.length === 0) {
    lines.push('No likely impacted code snippets were found using the issue interpretation and static repository scan.');
    return lines.join('\n');
  }

  snippets.forEach((snippet, index) => {
    lines.push(`${index + 1}. ${snippet.file}:${snippet.startLine}-${snippet.endLine}`);
    lines.push(`   Score: ${snippet.score}`);
    lines.push(`   Reason: ${snippet.reason}`);
    lines.push('```');
    lines.push(snippet.code);
    lines.push('```');
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}
