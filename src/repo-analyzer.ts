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

export interface RepoIssueAnalysis {
  owner: string;
  repo: string;
  repoPath: string;
  issue: GitHubIssueForDisplay;
  keywords: string[];
  snippets: ImpactedSnippet[];
  content: string;
  agenticAnalysis?: string;
  specPath?: string;
}

export interface AnalyzeRepoOptions {
  cacheRoot?: string;
  specRoot?: string;
  maxFiles?: number;
  maxSnippets?: number;
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

function extractSnippet(relativeFile: string, content: string, keywords: string[], fileScore: number, matchedKeywords: string[]): ImpactedSnippet | null {
  const lines = content.split(/\r?\n/);
  const hitLines: number[] = [];
  const lowerLines = lines.map(line => line.toLowerCase());

  for (let i = 0; i < lowerLines.length; i += 1) {
    if (keywords.some(keyword => lowerLines[i].includes(keyword))) {
      hitLines.push(i + 1);
    }
  }

  if (hitLines.length === 0) { return null; }

  const startLine = Math.max(1, hitLines[0] - 5);
  const endLine = Math.min(lines.length, hitLines[0] + 8);
  const snippetLines = lines.slice(startLine - 1, endLine);
  const reason = `Matched ${matchedKeywords.slice(0, 8).join(', ')} in ${relativeFile}`;

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
  const keywords = extractIssueKeywords(issue);
  const files = discoverCandidateFiles(repoPath, options.maxFiles ?? 5000);
  const snippets: ImpactedSnippet[] = [];

  for (const relativeFile of files) {
    const fullPath = path.join(repoPath, relativeFile);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch { continue; }

    const lowerPath = relativeFile.toLowerCase();
    const lowerContent = content.toLowerCase();
    let score = 0;
    const matchedKeywords: string[] = [];

    for (const keyword of keywords) {
      const pathHits = countOccurrences(lowerPath, keyword);
      const contentHits = countOccurrences(lowerContent, keyword);
      if (pathHits || contentHits) {
        matchedKeywords.push(keyword);
        score += pathHits * 10 + Math.min(contentHits, 20);
      }
    }

    if (score === 0) { continue; }
    const ext = path.extname(relativeFile).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs'].includes(ext)) { score += 5; }
    if (['.md', '.txt'].includes(ext)) { score -= 2; }

    const snippet = extractSnippet(relativeFile, content, keywords, score, matchedKeywords);
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
    content: formatRepoIssueAnalysis(owner, repo, issue, keywords, limited)
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
  lines.push('- No repository code was executed. No dependencies were installed.');
  lines.push('- Relevant snippets were gathered with static keyword search as context.');
  lines.push('- A Pi-selected model can review the issue and snippets to draft a root-cause hypothesis, fix specification, and test plan when agentic analysis is attached.');
  lines.push('');
  lines.push('## Extracted context keywords');
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
  snippets: ImpactedSnippet[]
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
  lines.push(`Context keywords: ${keywords.join(', ') || '(none)'}`);
  lines.push('');

  if (snippets.length === 0) {
    lines.push('No likely impacted code snippets were found using static keyword search.');
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
