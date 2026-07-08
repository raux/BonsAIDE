# SKILL: BonsAIDE Similarity & Code Analysis Guide

**For:** Agents modifying code similarity, Lizard metrics, GitHub issue analysis  
**Scope:** Pure TF-IDF similarity, Lizard complexity, repo analysis, snippet extraction  
**Related files:** `src/similarity.ts`, `src/lizard-server.ts`, `src/repo-analyzer.ts`

---

## Overview

BonsAIDE computes three types of analysis:

1. **Code Similarity (TF-IDF):** Compare code snippets among leaf nodes
2. **Code Complexity (Lizard):** Extract metrics like cyclomatic complexity, LOC
3. **GitHub Issue Analysis:** Parse issues and find impacted code in repos

All three are **optional features** — failure gracefully degrades.

---

## Code Similarity (Pure TF-IDF)

### Algorithm: `src/similarity.ts`

**Key characteristic:** No external dependencies. Pure TypeScript, suitable for testing and embedding.

```typescript
export interface SimilarityNode {
  id: number;
  code: string;
  isLeaf: boolean;
}

export interface SimilarityScore {
  id: number;          // Node ID of the other leaf
  similarity: number;  // Cosine similarity [0, 1]
}

export function computeLeafSimilaritiesForCode(
  branch: SimilarityBranch,
  target: SimilarityNode
): SimilarityScore[] {
  // Returns array of similarities sorted descending
}
```

### Step-by-Step: How Similarity Works

**1. Tokenization (case-insensitive, punctuation-stripped)**

```typescript
function tokenizeCode(text: string): string[] {
  return (text || '')
    .toLowerCase()                       // CASE INSENSITIVE
    .split(/[^a-zA-Z0-9_]+/g)           // SPLIT ON NON-WORD
    .filter(Boolean);                    // REMOVE EMPTIES
}

// Example:
// Input:  "function add(a, b) { return a + b; }"
// Output: ["function", "add", "a", "b", "return", "a", "b"]
```

**2. Document Frequency (DF) — How many docs contain each token?**

```typescript
const df = new Map<string, number>();  // token -> # docs containing it
tokensPerDoc.forEach(tokens => {
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!seen.has(t)) {
      df.set(t, (df.get(t) || 0) + 1);
      seen.add(t);
    }
  }
});
```

**3. Inverse Document Frequency (IDF) — How rare is each token?**

```typescript
// IDF formula: log((N+1)/(DF+1)) + 1
// More documents → lower IDF (common tokens are "cheaper")
// Fewer documents → higher IDF (rare tokens are "expensive")

const N = docs.length;
const idf = new Map<string, number>();
for (const [t, dfi] of df.entries()) {
  idf.set(t, Math.log((N + 1) / (dfi + 1)) + 1);
}
```

**4. TF-IDF Vectors (Term Frequency × Inverse Document Frequency)**

```typescript
// For each document:
// 1. Count term frequencies (TF)
const tf = new Map<string, number>();
for (const token of tokens) {
  tf.set(token, (tf.get(token) || 0) + 1);
}

// 2. Apply IDF weight
const vec = new Map<string, number>();
for (const [t, freq] of tf.entries()) {
  const weight = freq * (idf.get(t) || 0);
  vec.set(t, weight);
}

// 3. L2-normalize (so vector magnitude = 1)
const norm = Math.sqrt(sumOfSquares);
for (const [t, w] of vec.entries()) {
  vec.set(t, w / norm);
}
```

**5. Cosine Similarity (dot product of normalized vectors)**

```typescript
function cosineSparse(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, wa] of small.entries()) {
    const wb = large.get(t);
    if (wb) dot += wa * wb;
  }
  return dot;  // Already normalized, so no division needed
}
```

### Frontend: Visualizing Similarity

When user selects a leaf node:

```typescript
// Browser sends: POST /message { command: "selectNode", data: { nodeId } }

// Server computes:
const scores = computeLeafSimilaritiesForCode(activeBranch, selectedNode);

// Broadcasts:
broadcast({ type: 'leafSimilarities', data: { scores } });

// Browser renders:
// - Details pane shows top similar leaves
// - Leaf node borders colored by similarity (cool → warm = low → high)
```

### Color Gradient (Similarity Visualization)

In `src/server.ts`:

```typescript
// Map similarity score [0, 1] to color gradient
// 0.0 = cool (blue)     → close to white
// 1.0 = warm (red)      → saturated red

function similarityToColor(similarity: number): string {
  // similarity is in [0, 1]
  const hue = (1 - similarity) * 240;  // Blue (240) to Red (0)
  return `hsl(${hue}, 100%, 50%)`;
}
```

### Testing Similarity

```bash
npm run test  # Includes test/similarity.test.mjs
```

**Test examples:**

```javascript
test('returns empty array for single leaf', () => {
  const target = { id: 1, code: 'function add(a, b) { return a + b; }', isLeaf: true };
  const result = computeLeafSimilaritiesForCode({ nodes: [target] }, target);
  assert.deepEqual(result, []);
});

test('sorts similarities descending', () => {
  const target = { id: 1, code: 'function add(a, b) { return a + b; }', isLeaf: true };
  const similar = { id: 2, code: 'function add(x, y) { return x + y; }', isLeaf: true };
  const different = { id: 3, code: 'class Foo { bar() {} }', isLeaf: true };
  
  const result = computeLeafSimilaritiesForCode({ nodes: [target, different, similar] }, target);
  
  assert.equal(result[0].id, 2);  // Similar comes first
  assert.ok(result[0].similarity >= result[1].similarity);
});

test('handles empty code strings', () => {
  const target = { id: 1, code: '', isLeaf: true };
  const other = { id: 2, code: '', isLeaf: true };
  
  const result = computeLeafSimilaritiesForCode({ nodes: [target, other] }, target);
  
  assert.equal(result.length, 1);
  assert.equal(result[0].similarity, 0);
});
```

### Improving Similarity Algorithm

**Current limitations:**

- Simple tokenization (no AST, no semantic understanding)
- All tokens weighted equally after TF-IDF
- No special handling for variable names vs. keywords

**Potential enhancements:**

1. **Semantic tokenization:** Parse variable names as single tokens (e.g., `camelCase` → `["camel", "case"]`)
2. **Syntax weight:** Weight keywords lower than unique identifiers
3. **AST-based:** Compare syntax trees instead of raw tokens
4. **Context:** Include method/class names in similarity computation
5. **Caching:** Pre-compute similarities on node creation

Example: Add keyword weighting

```typescript
const KEYWORDS = new Set(['function', 'const', 'let', 'var', 'return', 'if', 'for', ...]);

// Lower IDF for keywords (less distinctive)
idf.set(t, KEYWORDS.has(t) ? 0.5 : Math.log((N+1)/(dfi+1)) + 1);
```

---

## Code Complexity (Lizard)

### Setup

Lizard requires Python 3 + pip:

```bash
pip install lizard
# Or: pip install --user lizard  (user-local install)
```

### How It Works: `src/lizard-server.ts`

Lizard is a Python package. BonsAIDE spawns a subprocess:

```typescript
export async function analyzeCodeWithLizardServer(code: string): Promise<LizardMetrics> {
  // 1. Check if lizard is available
  const result = await execFile('lizard', ['--version'], { timeout: 5000 });
  if (!result.stdout) {
    bonsaiLog('Warning: Lizard not installed. Install with: pip install lizard');
    return { available: false };
  }
  
  // 2. Write code to temp file
  const tmpFile = path.join(os.tmpdir(), `bonsai-${Date.now()}.js`);
  await fs.promises.writeFile(tmpFile, code);
  
  // 3. Run Lizard
  const { stdout } = await execFile('lizard', [tmpFile], { timeout: 10000 });
  
  // 4. Parse output (CSV-like format)
  // Extract: cyclomatic complexity, NLOC (non-comment lines), function count, etc.
  
  // 5. Clean up temp file
  fs.promises.unlink(tmpFile).catch(() => {});
  
  return { complexity, nloc, functions, available: true };
}
```

### Metrics Returned

```typescript
export interface LizardMetrics {
  available?: boolean;            // Lizard installed/ran successfully
  complexity?: number;            // Cyclomatic complexity
  nloc?: number;                  // Non-comment lines of code
  functions?: number;             // Number of functions
  fileMetric?: string;            // File-level metric
  [key: string]: any;             // Other fields from Lizard
}
```

### Integration in `src/server.ts`

After generating code:

```typescript
// After LLM returns code
if (supportLizard) {  // Feature flag
  const metrics = await analyzeCodeWithLizardServer(generatedCode);
  childNode.lizard = metrics;
}

// Broadcast includes metrics
broadcast({
  type: 'historyUpdate',
  data: {
    code: generatedCode,
    lizard: metrics
  }
});
```

### Handling Lizard Errors

```typescript
try {
  const metrics = await analyzeCodeWithLizardServer(code);
  return metrics;
} catch (err: any) {
  if (err.message.includes('not found')) {
    bonsaiLog('Lizard not installed. Metrics unavailable.');
    // Gracefully continue without metrics
    return { available: false };
  }
  throw err;
}
```

### Disabling Lizard

If Lizard is unavailable or too slow:

```typescript
// In server.ts, skip the call
// const metrics = await analyzeCodeWithLizardServer(...);  // Commented out
// childNode.lizard = metrics;                             // Commented out

childNode.lizard = undefined;  // Skip metrics
```

---

## GitHub Issue Analysis

### Workflow: `src/repo-analyzer.ts`

**Goal:** Given a GitHub issue, find code snippets in the repo that likely impact the issue.

### Step 1: Parse GitHub Issue URL

```typescript
// Input: "https://github.com/raux/BonsAIDE/issues/42"
// Output: { owner: "raux", repo: "BonsAIDE", issueNumber: 42 }

export function parseGitHubUrl(url: string): { owner: string; repo: string; issueNumber?: number } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)(?:\/issues\/(\d+))?/);
  if (!match) throw new Error('Invalid GitHub URL');
  return { owner: match[1], repo: match[2], issueNumber: Number(match[3]) };
}
```

### Step 2: Ensure Repo Checked Out

```typescript
export async function ensureRepoCheckout(
  owner: string,
  repo: string,
  cacheRoot = defaultRepoCacheRoot()
): Promise<string> {
  // 1. Check if already cloned
  const repoPath = path.join(cacheRoot, safeRepoCacheName(owner, repo));
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    // Pull latest
    await execFilePromise('git', ['-C', repoPath, 'pull', '--ff-only']);
    return repoPath;
  }
  
  // 2. Clone if not cached
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  await execFilePromise('git', ['clone', '--depth=1', cloneUrl, repoPath]);
  return repoPath;
}
```

### Step 3: Extract Keywords from Issue

```typescript
export function extractIssueKeywords(
  issue: { title?: string; body?: string; labels?: Array<{ name: string }> }
): string[] {
  // Combine title + body + labels
  const labels = (issue.labels || []).map(l => l.name).join(' ');
  const raw = `${issue.title || ''}\n${issue.body || ''}\n${labels}`;
  
  // Expand camelCase, replace punctuation with spaces
  const expanded = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._/:-]+/g, ' ')
    .toLowerCase();
  
  // Extract tokens (3+ chars, not stop words)
  const tokens = expanded.match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
  const unique: string[] = [];
  const seen = new Set<string>();
  
  const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'issue', 'bug', 'fix', ...]);
  
  for (const token of tokens) {
    const clean = token.replace(/^-+|-+$/g, '');
    if (!STOP_WORDS.has(clean) && !seen.has(clean)) {
      seen.add(clean);
      unique.push(clean);
    }
  }
  
  return unique.slice(0, 40);  // Top 40 keywords
}
```

### Step 4: Find Candidate Source Files

```typescript
export function discoverCandidateFiles(repoPath: string, maxFiles = 5000): string[] {
  const files: string[] = [];
  
  const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', ...]);
  const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', ...]);
  
  function walk(dir: string): void {
    if (files.length >= maxFiles) return;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const stat = fs.statSync(fullPath);
        if (TEXT_EXTENSIONS.has(ext) && stat.size > 0 && stat.size <= 512 * 1024) {
          files.push(path.relative(repoPath, fullPath));
        }
      }
    }
  }
  
  walk(repoPath);
  return files;
}
```

### Step 5: Score & Extract Snippets

```typescript
export async function analyzeRepoForIssue(
  owner: string,
  repo: string,
  issue: GitHubIssueForDisplay,
  options: AnalyzeRepoOptions = {}
): Promise<RepoIssueAnalysis> {
  // 1. Extract keywords from issue
  const keywords = extractIssueKeywords(issue);
  
  // 2. Ensure repo is checked out
  const repoPath = await ensureRepoCheckout(owner, repo, options.cacheRoot);
  
  // 3. Discover candidate files
  const candidateFiles = discoverCandidateFiles(repoPath, options.maxFiles ?? 500);
  
  // 4. Score files by keyword matches
  const fileScores = new Map<string, number>();
  for (const file of candidateFiles) {
    const content = fs.readFileSync(path.join(repoPath, file), 'utf8');
    let score = 0;
    for (const keyword of keywords) {
      score += countOccurrences(content, keyword);
    }
    if (score > 0) fileScores.set(file, score);
  }
  
  // 5. Extract snippets from top-scored files
  const snippets: ImpactedSnippet[] = [];
  const topFiles = Array.from(fileScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.maxSnippets ?? 10);
  
  for (const [file, _] of topFiles) {
    const filePath = path.join(repoPath, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    // Find lines with keyword matches
    for (let i = 0; i < lines.length; i++) {
      let lineScore = 0;
      for (const keyword of keywords) {
        lineScore += countOccurrences(lines[i], keyword);
      }
      if (lineScore > 0) {
        snippets.push({
          file,
          startLine: i + 1,
          endLine: Math.min(i + 5, lines.length),
          code: lines.slice(i, Math.min(i + 5, lines.length)).join('\n'),
          score: lineScore,
          reason: `Matched ${lineScore} keyword(s)`
        });
      }
    }
  }
  
  // 6. Sort by score, limit results
  snippets.sort((a, b) => b.score - a.score);
  
  return {
    owner,
    repo,
    repoPath,
    issue,
    keywords,
    snippets: snippets.slice(0, options.maxSnippets ?? 10),
    content: `Analysis for ${owner}/${repo} issue #${issue.number}`
  };
}
```

### Caching Strategy

- **Location:** `artifacts/repo-cache/owner__repo/`
- **Update:** `git pull --ff-only` on next access (fast-forward only)
- **Shallow:** `--depth=1` (no full history)

---

## Testing Analysis Functions

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitHubUrl,
  extractIssueKeywords,
  safeRepoCacheName
} from '../out-server/repo-analyzer.js';

test('parseGitHubUrl parses standard URL', () => {
  const result = parseGitHubUrl('https://github.com/user/repo/issues/42');
  assert.deepEqual(result, { owner: 'user', repo: 'repo', issueNumber: 42 });
});

test('extractIssueKeywords filters stop words', () => {
  const issue = {
    title: 'Fix authentication bug',
    body: 'The login function fails',
    labels: []
  };
  const keywords = extractIssueKeywords(issue);
  assert.ok(keywords.includes('authentication'));
  assert.ok(keywords.includes('login'));
  assert.ok(!keywords.includes('the'));
  assert.ok(!keywords.includes('bug'));
});

test('safeRepoCacheName sanitizes unsafe chars', () => {
  const name = safeRepoCacheName('user/bad', 'repo@2.0');
  assert.equal(name, 'user_bad__repo_2.0');
});
```

---

## Error Handling & Graceful Degradation

### Similarity

- If both leafs have empty code: return similarity = 0
- No external dependencies: always works

### Lizard

- If Python/Lizard not installed: skip metrics, warn in logs
- If subprocess times out: return `{ available: false }`
- Graceful: UI still works without metrics

### Repo Analysis

- If repo clone fails: display error, offer retry
- If keyword extraction fails: return empty snippets
- If file read fails: skip that file, continue

---

## References

- **TF-IDF:** https://en.wikipedia.org/wiki/Tf%E2%80%93idf
- **Cosine Similarity:** https://en.wikipedia.org/wiki/Cosine_similarity
- **Lizard:** https://github.com/terryyin/lizard
- **Code:**
  - Similarity: `src/similarity.ts`
  - Lizard: `src/lizard-server.ts`
  - Repo analysis: `src/repo-analyzer.ts`
- **Tests:** `test/similarity.test.mjs`, `test/repo-analyzer.test.mjs`

---

**End of Skill**
