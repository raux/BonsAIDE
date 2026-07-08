# BonsAIDE Repository Architecture & Agent Maintenance Guide

**Last Updated:** 2026-07-08  
**Repository:** https://github.com/raux/BonsAIDE

---

## 1. Repository Overview

BonsAIDE is a standalone web application for **visual, tree-based code improvement**. It empowers developers to explore alternative code branches, applying AI-driven activities (fixes, refactoring, testing, exception handling) and comparing results via code similarity metrics and complexity analysis.

### Core Characteristics

- **Deployment:** Standalone Node.js HTTP server (no external dependencies at runtime)
- **UI:** Browser-based (HTML/CSS/JavaScript + Cytoscape.js graph from CDN)
- **LLM Integration:** Local (LM Studio OpenAI-compatible) or cloud (Pi subscription models)
- **State:** In-memory Bonsai sessions with JSON import/export
- **Metrics:** TF-IDF code similarity, Lizard complexity analysis, token usage tracking
- **License:** GPL-3.0-only

### Build Language

- **TypeScript** (ES2022, strict mode, Node16 module target)
- **ESLint** for code quality
- **Node unit tests** (node:test, node:assert/strict)
- **Mutation testing** for pure functions

---

## 2. High-Level Architecture

### Server-Side Runtime (`src/server.ts`)

The main HTTP server maintains:
- **Branches & Nodes:** In-memory Bonsai tree structure (branches[])
- **Active Branch:** Currently selected session (activeBranchId)
- **LLM Config:** Base URL + model name (env: BONSAI_LM_URL, BONSAI_LM_MODEL)
- **SSE Clients:** Real-time event stream to connected browsers

**Key responsibilities:**
1. Serve static frontend from `client/`
2. Handle browser-to-server JSON messages (POST /message)
3. Broadcast server events to all connected browsers (SSE GET /events)
4. Generate code via LM Studio or Pi subscription models
5. Compute leaf-node code similarity (via similarity.ts)
6. Analyze GitHub issues and extract code impact (repo-analyzer.ts)
7. Export/import sessions as JSON (schema: bonsai.v1)

### Browser-Side UI (`client/`)

- `client/index.html` — DOM structure, textareas, graph canvas, activity buttons, details panes
- `client/js/app.js` — Cytoscape graph, event handlers, SSE listening, message sending
- `client/css/styles.css` — Layout and styling

**Message Protocol:**
- Browser → Server: POST /message with `{ command: "...", data: {...} }`
- Server → Browser: SSE event with `{ type: "...", data: {...} }`

### Key Modules

| File | Purpose | Dependencies |
|------|---------|---|
| `src/server.ts` | Main HTTP server | fs, path, http, (no npm runtime deps) |
| `src/bonsai-state.ts` | Session state, import/export, graph generation | None (pure TS) |
| `src/similarity.ts` | TF-IDF cosine similarity for code | None (pure TS) |
| `src/repo-analyzer.ts` | GitHub repo checkout, issue analysis, snippet extraction | child_process (execFile) |
| `src/pi-models.ts` | Pi model registry discovery (credential-safe) | @earendil-works/pi-coding-agent (dynamic import) |
| `src/pi-subscription-rpc.ts` | Code generation via Pi AgentSession | @earendil-works/pi-coding-agent (dynamic import) |
| `src/lizard-server.ts` | Code complexity metrics via Python subprocess | child_process (execFile), Python 3 + lizard |
| `src/server-utils.ts` | URL parsing, GitHub helpers, activity coloring | None (pure TS) |

---

## 3. Data Models & State Management

### Bonsai Session State

```typescript
interface CodeNode {
  id: number;                        // Unique node ID (incrementing)
  prompt: string;                    // User or LLM prompt
  code: string;                      // Generated code snippet
  parentId: number | null;           // Parent node (null = root)
  children: CodeNode[];              // Child nodes (populated on-the-fly)
  durationMs?: number;               // Generation time
  tokens?: { prompt, completion, total };  // Token usage
  reasoning?: string;                // LLM reasoning/explanation
  lizard?: LizardMetrics;            // Code complexity from Lizard
  isLeaf: boolean;                   // True if no children
  activity: string;                  // Activity type (gen_tests, refactor, exceptions, etc.)
}

interface Branch {
  id: string;                        // Branch identifier ("main", etc.)
  name: string;                      // Display name
  nodes: CodeNode[];                 // All nodes in this branch
}
```

### Import/Export Schema

**Format:** `bonsai.v1` (JSON)

```json
{
  "schema": "bonsai.v1",
  "branches": [
    {
      "id": "main",
      "name": "Main Branch",
      "nodes": [
        {
          "id": 0,
          "prompt": "Fix bug in login",
          "code": "function login() { ... }",
          "parentId": null,
          "activity": "initial",
          "isLeaf": false,
          "tokens": { "prompt": 50, "completion": 120, "total": 170 }
        }
      ]
    }
  ],
  "activeBranchId": "main",
  "currentId": 42
}
```

**Validation on import:**
- Schema check (must be "bonsai.v1")
- Type coercion for id, parentId (numbers)
- Defensive defaults for optional fields
- Recompute `isLeaf` flags after import
- Validate parent-child links

---

## 4. Message Protocol

### Browser → Server (POST /message)

**Command Structure:**
```typescript
{
  "command": "generate" | "selectNode" | "trim" | "importJSON" | "setLMConfig" | ...,
  "data": { /* command-specific payload */ }
}
```

**Common Commands:**
| Command | Data | Purpose |
|---------|------|---------|
| `generate` | `{ nodeId, activity, count, modelId?, provider? }` | Generate N child nodes from selected |
| `selectNode` | `{ nodeId }` | Set selection and compute similarities |
| `trim` | `{ nodeId }` | Delete node and descendants |
| `importJSON` | `{ json }` | Import a session from JSON string |
| `setLMConfig` | `{ baseUrl, model }` | Update LLM endpoint & model |
| `loadPiModels` | `{}` | Discover available Pi models |
| `exportSession` | `{}` | Download current state as JSON |

### Server → Browser (SSE Events)

**Event Structure:**
```typescript
{
  "type": "renderGraph" | "historyUpdate" | "leafSimilarities" | "connectionTestResult" | ...,
  "data": { /* event-specific payload */ }
}
```

**Common Events:**
| Event | Data | When |
|-------|------|------|
| `renderGraph` | `{ nodes[], edges[] }` (Cytoscape format) | After state change (generate, trim, etc.) |
| `historyUpdate` | `{ prompt, code, reasoning, tokens, activity }` | When node details change |
| `leafSimilarities` | `{ scores[], ... }` | After selectNode, with similarity scores |
| `connectionTestResult` | `{ connected, reason }` | After testing LM Studio connection |
| `logMessage` | `{ message }` | Server log entry |
| `piModels` | `{ models[], count, warning? }` | After loadPiModels |

---

## 5. Code Generation Workflow

### LM Studio (Local, OpenAI-compatible)

```
1. User clicks "Generate" on activity X, requests N branches
2. Browser sends: POST /message { command: "generate", data: { nodeId, activity, count } }
3. Server loops N times:
   a. Call fetchFromLocalLMStudio(prompt, code)
   b. Parse <code> and <reasoning> from response
   c. Create CodeNode with tokens, duration, activity
   d. Mark parent node isLeaf = false
   e. Broadcast SSE renderGraph update
```

### Pi Subscription Models (Cloud: OpenAI, Claude, Google, etc.)

```
1. User loads Pi models (click "Load Pi Models")
2. Server calls discoverPiModels():
   a. Import @earendil-works/pi-coding-agent dynamically
   b. Query model registry (credentials NOT exposed)
   c. Return compatible + cloud models with safety warnings
3. User selects a cloud model
4. On generate, server calls generateViaSubscription(provider, modelId, prompt, code):
   a. Create AgentSession via Pi SDK (credentials from ~/.pi/agent/auth.json)
   b. Pi SDK handles all auth/headers internally
   c. Return { content, reasoning, tokens }
5. BonsAIDE never sees or logs API keys
```

### System Prompt (Both Paths)

```
You are a code-generation assistant. Output ONLY two XML tags:
<code>[final code]</code>
<reasoning>[explanation]</reasoning>
No markdown, backticks, or extra text allowed.
```

---

## 6. Similarity Computation

### Algorithm: TF-IDF Cosine Similarity

**Pure, dependency-free implementation in `src/similarity.ts`.**

```
1. Tokenize all leaf-node code strings (case-insensitive, split on non-word chars)
2. Compute document frequency (DF) for each token across all leaves
3. Compute inverse document frequency (IDF) with smoothing: log((N+1)/(DF+1)) + 1
4. Build normalized TF-IDF vectors for each leaf
5. Compute cosine product between target leaf and all other leaves
6. Sort results descending by similarity
7. Return array of { id, similarity } for non-target leaves
```

**No External Dependencies:** Pure TypeScript, no npm modules.

**Performance:** O(n × m × log n) where n = # leaves, m = avg tokens per leaf.

### Frontend Visualization

- **Leaf borders:** Color gradient (cool → warm = low → high similarity)
- **Details panel:** Shows similarity scores, code diff, metrics

---

## 7. GitHub Issue Integration

### Workflow: `repo-analyzer.ts`

```
1. Parse GitHub issue URL → extract owner, repo
2. Clone/pull repository (git shallow clone if not cached)
3. Extract issue keywords from title, body, labels
4. Discover candidate source files (ignore node_modules, .git, etc.)
5. Score files by keyword match + heuristics
6. Extract top N snippets from scored files
7. Return RepoIssueAnalysis with issue + snippets + keywords
```

### Caching

- **Location:** `artifacts/repo-cache/` (e.g., `owner__repo/`)
- **Git shallow clone:** `--depth=1` for speed
- **Update strategy:** `git pull --ff-only` on subsequent runs

### Safe Handling

- File size limits (max 512 KB per file)
- Directory ignore list (build artifacts, node_modules, etc.)
- Keyword stop-words (common English words)
- Snippet extraction via regex lines, not entire files

---

## 8. Testing Strategy

### Unit Tests (node:test)

**Location:** `test/*.test.mjs`

**Coverage:**
- **similarity.test.mjs** — TF-IDF, tokenization, edge cases
- **bonsai-state.test.mjs** — Import/export, leaf flags, graph generation
- **server-utils.test.mjs** — URL parsing, GitHub URL parsing, color functions
- **repo-analyzer.test.mjs** — Keyword extraction, file discovery, caching
- **server-integration.test.mjs** — HTTP endpoints, message protocol, SSE

### Running Tests

```bash
npm run test           # Lint + compile + unit tests
npm run test:unit     # Unit tests only
npm run test:mutation # Mutation testing for pure functions
```

### Key Principles

1. **Pure functions first:** Test similarity, import/export, URL parsing without mocking
2. **No external dependencies in tests:** Use node:test and node:assert only
3. **Mock child processes:** repo-analyzer tests use mocked git/grep
4. **Snapshot where needed:** Graph generation tests validate Cytoscape structure

---

## 9. Build & Development

### TypeScript Compilation

- **Config:** `tsconfig.server.json` (strict mode enabled)
- **Output:** `out-server/` directory
- **Watch mode:** `npm run watch`

### Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run compile-server` | `tsc -p tsconfig.server.json` | Compile TS to JS |
| `npm run serve` | compile + node out-server/server.js | Dev server on :3000 |
| `npm run lint` | `eslint src --ext ts` | ESLint check |
| `npm run watch` | tsc -p tsconfig.server.json -w | Watch recompile |
| `npm run test` | lint + compile + unit tests | Full gate |

### Port Management

```bash
PORT=3000 npm run serve      # Custom port via env
npm run serve -- 4000        # Custom port via CLI arg
```

### Artifact Hygiene

**Committed:**
- `src/`, `client/`, `test/`, `other/`
- `AGENTS.md`, `README.md`, `TUTORIAL.md`
- `tsconfig.json`, `package.json`, `.eslintrc.json`

**Ignored (`.gitignore`):**
- `node_modules/`, `out-server/`, `dist/`, `out/`
- `*.swp`, `.DS_Store`
- Experimental research under `artifacts/` (optional backup)

---

## 10. Environment Configuration

### Required Env Vars (Optional at Runtime)

```bash
# LM Studio (local)
export BONSAI_LM_URL="http://localhost:1234/v1"    # Default
export BONSAI_LM_MODEL="deepseek/deepseek-r1-0528-qwen3-8b"  # Default

# Server
export PORT="3000"  # Default
```

### Dynamic Configuration

Users can override LM settings in the browser UI without restarting.

### Pi Model Registry

- **Credentials:** Loaded from `~/.pi/agent/auth.json` (never exposed to BonsAIDE)
- **Setup:** `pi /login <provider>` to add cloud model credentials

---

## 11. Legacy Code & Deprecations

### VS Code Extension (Legacy)

The VS Code extension has been superseded by the standalone web app. Legacy files remain for reference:

- `src/extension.ts` — Old VS Code WebView host (do not modify unless explicitly asked)
- `media/webview.html` — Old webview shell (deprecated)
- `webpack.config.js` — Old bundler config (unused)
- `.vscode-test.mjs` — Old VS Code test launcher (unused)

**Policy:** Do not modify or clean up legacy files unless Raul explicitly requests a deprecation sweep.

---

## 12. Security Considerations

### Code & Secrets

- **All user code sent to LLM:** Never include proprietary/secret code in Bonsai
- **Credentials safe with Pi:** Cloud model API keys are managed by Pi SDK, never logged by BonsAIDE
- **Input validation:** All imported JSON, GitHub-fetched content, and LLM responses are treated as untrusted

### HTTP & Network

- **No remote auth:** BonsAIDE uses placeholder bearer token for local LM Studio (no secrets)
- **localhost-only for cloud:** Only local OpenAI-compatible endpoints are exposed without auth
- **Timeouts:** LLM generation has 5-minute timeout to prevent hanging requests
- **SSE broadcasting:** Be cautious of XSS when broadcasting LLM-generated content

### Local Repo Cloning

- **Shallow clone only:** `--depth=1` prevents full history fetch
- **Timeout:** 120-180 seconds for git operations
- **No credentials:** Public repos only (authentication via Git credential helper if needed)

---

## 13. Known Limitations & Future Directions

### Current Constraints

1. **In-memory state only** — Session lost on server restart
2. **No multi-user** — Shared in-memory state; not suitable for concurrent users
3. **Code size limits** — Inputs > 1 MB may cause issues with LLM APIs
4. **UI complexity** — No keyboard shortcuts, limited accessibility features

### Potential Enhancements

- **Persistent storage:** SQLite or PostgreSQL for sessions
- **User accounts:** Auth + per-user session isolation
- **Diff view:** Side-by-side code diff for leaf pairs
- **Advanced metrics:** AST-based code similarity, coverage reports
- **CLI integration:** Export fix specs for automated patching
- **Model benchmarking:** Track model performance across activities

---

## 14. Agent Maintenance Workflow

### Recommended Approach for Agents

1. **Scout the repo** first: Read AGENTS.md, README.md, this document
2. **Identify the module:** Which source file(s) does the task touch?
3. **Understand the message protocol:** How will the change propagate browser↔server?
4. **Check tests:** Is there a test for the behavior you're changing?
5. **Compile & lint:** `npm run lint && npm run compile`
6. **Run tests:** `npm run test`
7. **Manual QA:** Visit http://localhost:3000 and try the feature
8. **Commit:** Clear commit message referencing which module(s) changed

### Common Tasks & Entry Points

| Task | Files | Key Concept |
|------|-------|-------------|
| Add new activity type | server.ts, app.js, server-utils.ts | Activity enum, color mapping |
| Change LLM system prompt | server.ts, pi-subscription-rpc.ts | XML tag parsing |
| Improve similarity algorithm | similarity.ts, test/similarity.test.mjs | TF-IDF, tokenization |
| Add new metric | bonsai-state.ts, server.ts | CodeNode interface, graph generation |
| Fix GitHub parsing | repo-analyzer.ts, test/repo-analyzer.test.mjs | Keyword extraction, snippet scoring |
| Enhance UI | client/index.html, client/js/app.js | DOM manipulation, message sending |
| Optimize build | tsconfig.server.json, package.json | Compilation targets, dependencies |

---

## 15. Key Files Quick Reference

```
BonsAIDE/
├── src/
│   ├── server.ts                    # Main HTTP server, state, event broadcast
│   ├── bonsai-state.ts              # Bonsai session model, import/export
│   ├── similarity.ts                # TF-IDF code similarity (pure)
│   ├── repo-analyzer.ts             # GitHub issue + code snippet analysis
│   ├── pi-models.ts                 # Pi model registry discovery
│   ├── pi-subscription-rpc.ts        # Pi AgentSession code generation
│   ├── lizard-server.ts             # Python/Lizard code metrics
│   ├── server-utils.ts              # Helpers: URL, GitHub, colors
│   └── test/
│       └── *.ts (legacy VS Code test)
├── client/
│   ├── index.html                   # Browser UI
│   ├── js/app.js                    # Cytoscape graph, event handlers
│   └── css/styles.css               # Styles
├── test/
│   ├── similarity.test.mjs          # Unit tests for similarity
│   ├── bonsai-state.test.mjs        # Unit tests for state management
│   ├── server-utils.test.mjs        # Unit tests for utilities
│   ├── repo-analyzer.test.mjs       # Unit tests for repo analysis
│   └── server-integration.test.mjs  # Integration tests
├── package.json                     # npm scripts, dev dependencies
├── tsconfig.server.json             # TS config (strict mode)
├── .eslintrc.json                   # ESLint rules
├── AGENTS.md                        # This file + agent guidelines
├── README.md                        # End-user guide
└── TUTORIAL.md                      # Quick-start guide
```

---

## 16. Appendix: Common Errors & Troubleshooting

### "Cannot find module '@earendil-works/pi-coding-agent'"

**Cause:** Dynamic import of Pi SDK fails at compile time or runtime.  
**Fix:** Ensure `package.json` has `@earendil-works/pi-coding-agent` as a dependency. Dynamic imports are used to make Pi optional.

### "Connection refused: localhost:1234"

**Cause:** LM Studio server not running or wrong port.  
**Fix:** Start LM Studio, verify `BONSAI_LM_URL` env var, or change in UI.

### "Git clone timeout"

**Cause:** Network issue or very large repo.  
**Fix:** Increase timeout in `repo-analyzer.ts` (currently 180s), or skip repo analysis.

### "Python lizard not found"

**Cause:** Python 3 or `lizard` package missing.  
**Fix:** Install Python 3 + `pip install lizard`, or disable Lizard metrics.

### Tests fail with "out-server/ not found"

**Cause:** TypeScript not compiled yet.  
**Fix:** Run `npm run compile` before tests.

### ESLint errors on TypeScript

**Cause:** ESLint config mismatch or outdated parser.  
**Fix:** Run `npm install` to update dependencies, then `npm run lint`.

---

**End of Repository Analysis**
