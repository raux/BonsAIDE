export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
}

const DEFAULT_LM_STUDIO_BASE_URL = 'localhost:1234/v1';

/** Parse owner and repo name from a GitHub URL or owner/repo shorthand. */
export function parseGitHubUrl(url: string): ParsedGitHubRepo | null {
  const trimmed = url.trim();
  if (!trimmed) { return null; }

  const githubUrlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?(?:[/?#].*)?$/i
  );
  if (githubUrlMatch) {
    return { owner: githubUrlMatch[1], repo: githubUrlMatch[2] };
  }

  const shorthandMatch = trimmed.match(/^([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?$/);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1], repo: shorthandMatch[2] };
  }

  return null;
}

/** Normalize LM Studio base URL input to an absolute http(s) URL without a trailing slash. */
export function normalizeLmStudioBaseUrl(rawUrl?: string): string {
  const trimmed = (rawUrl || DEFAULT_LM_STUDIO_BASE_URL).trim();
  if (!trimmed) {
    throw new Error('Invalid URL format. Expected format: host:port/path (e.g., localhost:1234/v1)');
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('Invalid URL protocol. Expected http or https.');
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid URL format. Expected format: host:port/path (e.g., localhost:1234/v1)');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid URL protocol. Expected http or https.');
  }
  if (!parsed.hostname) {
    throw new Error('Invalid URL format. Expected format: host:port/path (e.g., localhost:1234/v1)');
  }

  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** Build an LM Studio endpoint URL from a configured base URL and endpoint path. */
export function buildLmStudioUrl(rawBaseUrl: string | undefined, endpoint: string): string {
  const base = normalizeLmStudioBaseUrl(rawBaseUrl);
  const cleanEndpoint = endpoint.replace(/^\/+/, '');
  return `${base}/${cleanEndpoint}`;
}

export interface GitHubIssueForDisplay {
  number: number;
  title: string;
  html_url: string;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  created_at?: string;
  updated_at?: string;
  comments?: number;
  body?: string;
}

export function formatGitHubIssues(owner: string, repo: string, issues: GitHubIssueForDisplay[]): string {
  const header = `# Open Issues for ${owner}/${repo}`;
  if (issues.length === 0) {
    return `${header}\n\nNo open issues found.`;
  }

  const lines = [header, '', `Found ${issues.length} open issue${issues.length === 1 ? '' : 's'}.`, ''];
  for (const issue of issues) {
    const author = issue.user?.login ? ` by @${issue.user.login}` : '';
    const labels = (issue.labels || [])
      .map(label => label.name)
      .filter((name): name is string => Boolean(name))
      .join(', ');
    const summary = (issue.body || '')
      .trim()
      .split(/\r?\n/)
      .find(line => line.trim().length > 0);

    lines.push(`## #${issue.number}: ${issue.title}`);
    lines.push(`- URL: ${issue.html_url}`);
    lines.push(`- Author: ${author ? author.replace(/^ by /, '') : 'unknown'}`);
    if (labels) { lines.push(`- Labels: ${labels}`); }
    if (typeof issue.comments === 'number') { lines.push(`- Comments: ${issue.comments}`); }
    if (issue.created_at) { lines.push(`- Created: ${issue.created_at}`); }
    if (issue.updated_at) { lines.push(`- Updated: ${issue.updated_at}`); }
    if (summary) { lines.push(`- Summary: ${summary.slice(0, 300)}`); }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function getActivityColor(activity?: string): string {
  switch (activity) {
    case 'gen_tests':           return '#970071';
    case 'refactor':            return '#006d18';
    case 'exceptions':          return '#00b0b6';
    case 'agent_md_alternative': return '#4c51bf';
    case 'repo_issue_analysis':  return '#b45309';
    case 'repo_agentic_analysis': return '#7c3aed';
    case 'repo_clone':           return '#2563eb';
    case 'repo_code_snippet':    return '#7c3aed';
    case 'repo_test_pass':       return '#15803d';
    case 'repo_test_partial':    return '#ca8a04';
    case 'repo_test_fail':       return '#b91c1c';
    default:                    return '#777777';
  }
}

/** Map common file extensions to MIME types. */
export function mimeType(filePath: string): string {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.js':   return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json';
    case '.png':  return 'image/png';
    case '.svg':  return 'image/svg+xml';
    default:      return 'application/octet-stream';
  }
}
