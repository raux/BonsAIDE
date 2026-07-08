# AGENTS.md — BonsAIDE Contributor & Agent Guide

This file describes the current repository layout, build/test commands, and conventions that automated agents and human contributors should follow when modifying BonsAIDE.

---

## Repository Overview

**BonsAIDE** (also called *Bonsai Code*) is a standalone web application for visual, tree-based code improvement. A local Node.js HTTP server serves the browser UI, maintains the in-memory Bonsai session, communicates with a local LM Studio OpenAI-compatible endpoint, computes code similarity, and optionally collects Lizard code metrics.

The legacy VS Code extension implementation may still exist in the repository for reference, but the active product described by `README.md` is the standalone web app served from `client/` by `src/server.ts`.

| Path | Purpose |
|---|---|
| `src/server.ts` | Main standalone HTTP server: routes, SSE, message handling, LLM calls, session import/export, GitHub repo analysis |
| `client/index.html` | Browser UI shell served at `/` |
| `client/js/app.js` | Frontend application logic: server messaging, Cytoscape graph, activity buttons, import/export UI |
| `client/css/styles.css` | Browser UI styles |
| `src/similarity.ts` | Pure TF-IDF cosine-similarity utilities with no server/UI dependency |
| `src/lizard-server.ts` | Standalone wrapper around the Python `lizard` package for code-complexity metrics |
| `tsconfig.server.json` | Active TypeScript build config for the standalone server |
| `package.json` | npm scripts and development dependencies |
| `README.md` | End-user setup and usage guide |
| `TUTORIAL.md` | Quick-start/tutorial material |
| `other/` | Diagrams, screenshots, publishing notes, compose files, and exported examples |
| `src/extension.ts`, `media/webview.html`, `webpack.config.js` | Legacy VS Code-extension artifacts; do not treat them as active unless explicitly asked |

---

## Environment Setup

```bash
# Install Node.js dependencies
npm install

# Compile the standalone server
npm run compile

# Run the standalone web app
npm run serve
```

Open the app at <http://localhost:3000> unless a different port is configured.

> **Python dependency:** The Lizard code-metrics feature requires Python 3 and the `lizard` package. `src/lizard-server.ts` attempts to install `lizard` automatically with `pip --user` if missing.

---

## Build, Run, and Development Scripts

| Script | Command | Description |
|---|---|---|
| `serve` | `npm run compile-server && node out-server/server.js` | Compile and launch the standalone server on port 3000 by default |
| `compile` | `npm run compile-server` | Compile active server TypeScript into `out-server/` |
| `compile-server` | `tsc -p tsconfig.server.json` | Direct TypeScript compile for standalone server files |
| `watch` | `tsc -p tsconfig.server.json -w` | Recompile active server files on change |
| `package` | `tsc -p tsconfig.server.json` | Production-equivalent TypeScript build for the standalone server |
| `lint` | `eslint src --ext ts` | ESLint over TypeScript source files |
| `test` | `npm run lint && npm run compile` | Current test gate: lint plus TypeScript compile |

To use a custom port:

```bash
PORT=8080 npm run serve
# or
npm run serve -- 4000
```

Always run `npm run lint` and `npm run compile` before committing TypeScript changes.

---

## LLM Configuration

BonsAIDE connects to a local [LM Studio](https://lmstudio.ai/) OpenAI-compatible server.

| Environment variable | Default | Description |
|---|---|---|
| `BONSAI_LM_URL` | `localhost:1234/v1` | Base URL/path for the LM Studio API |
| `BONSAI_LM_MODEL` | `deepseek/deepseek-r1-0528-qwen3-8b` | Model identifier sent to chat-completions requests |

Both values can also be configured in the browser UI.

Implementation note: `src/server.ts` currently constructs LM Studio requests internally. When changing URL handling, keep the documented forms in `README.md` and this guide consistent with the code.

---

## Runtime Architecture

### Server side (`src/server.ts`)

- Uses Node's built-in `http` module; there are no runtime npm dependencies.
- Serves static frontend files from `client/`.
- Maintains Bonsai state in memory: branches, nodes, selected node, LLM config, and logs.
- Sends server-to-browser updates over Server-Sent Events (`GET /events`).
- Receives browser commands through JSON POSTs to `/message`.
- Exposes JSON session export/import through `/export` and `/import`.
- Calls LM Studio chat completions for code generation and Agent.md workflows.
- Uses `src/similarity.ts` for leaf-code similarity and `src/lizard-server.ts` for optional metrics.

### Browser side (`client/`)

- `client/index.html` defines the UI controls, textareas, graph container, and output panes.
- `client/js/app.js` creates a small `vscode.postMessage` compatibility shim that forwards commands to the standalone server.
- Cytoscape.js is loaded from a CDN and used to render the Bonsai tree.
- The frontend listens to SSE events, updates the graph/details panes, and sends activity/import/export/config commands to the server.

### Message protocol

Message `command` strings are the discriminant between browser and server actions. Keep command names stable unless updating both `src/server.ts` and `client/js/app.js` together.

Common commands include:

| Command | Direction | Purpose |
|---|---|---|
| `generate` | browser → server | Generate one or more child code nodes from the selected node |
| `selectNode` / `unselectNode` | browser → server | Update selected node and similarity state |
| `trim` | browser → server | Delete a node and descendants |
| `importJSON` | browser → server | Import a Bonsai session JSON payload |
| `renderGraph` | server → browser | Replace the Cytoscape graph |
| `historyUpdate` | server → browser | Refresh prompt/output history |
| `leafSimilarities` | server → browser | Show similarity scores and graph borders |
| `connectionTestResult` | server → browser | Show LM Studio connectivity status |

---

## Code Conventions

### TypeScript

- `strict` mode is enabled in the active server build config.
- Target is ES2022 with `module: Node16`.
- Prefer `async`/`await` over raw Promise chains.
- Keep pure helper modules independent from server/global state.
- Avoid introducing runtime dependencies unless there is a clear need.
- Prefer typed interfaces over `any` when touching active code, especially request payloads and imported session data.

### Frontend JavaScript

- Keep `client/js/app.js` compatible with the plain browser environment served by the Node server.
- Escape user-supplied, imported, or LLM-generated text before injecting it with `innerHTML`.
- If changing the UI markup in `client/index.html`, update all related DOM lookups in `client/js/app.js`.

### Activity identifiers

Activity strings are used for node coloring and prompt routing:

| `activity` value | Meaning |
|---|---|
| `gen_tests` | Generate tests |
| `refactor` | Refactor |
| `exceptions` | Handle exceptions |
| `agent_md_alternative` | Generate alternative based on Agent.md |
| `initial` | Initial root node |
| `custom` / `other` | Fallback activity labels |

---

## Testing

The current `npm test` script runs lint and compile only:

```bash
npm run test
```

When adding behavior, prefer adding targeted tests around pure or easily isolated logic. Good first candidates are:

- `src/similarity.ts` similarity ranking behavior
- GitHub URL parsing and repository-summary helpers
- Bonsai session import/export validation
- LM Studio URL normalization and request construction
- bounded retry/error behavior for LLM calls

The existing `src/test/extension.test.ts` is legacy VS Code sample material and should not be treated as coverage for the standalone server.

---

## State, Export, and Import

- Runtime Bonsai state is in memory only while the Node server is running.
- Exported sessions use schema `bonsai.v1` and include branches, nodes, active branch ID, and logs.
- Import paths should validate schema, node IDs, parent links, and fallback/default values defensively.
- After import or trim operations, recompute leaf flags before rendering the graph.

---

## Security Notes

- BonsAIDE sends user-provided code and prompts to the configured LM Studio endpoint. Do not send secrets or proprietary code unless permitted.
- Treat all imported JSON, LLM responses, GitHub-fetched content, and UI text fields as untrusted input.
- Escape dynamic text before placing it in frontend HTML.
- Be careful with local-server exposure: endpoints such as `/message` can trigger LLM work and state changes.
- Do not hard-code API keys, external credentials, or private repository data.
- If adding remote fetches or new endpoints, set explicit timeouts and validate input sizes.

---

## Dependency and Artifact Hygiene

- `node_modules/`, `out-server/`, `dist/`, `out/`, and generated packages are ignored build/dependency outputs.
- Do not commit generated server output from `out-server/`.
- Keep experimental or generated research outputs under `artifacts/` unless the user asks to promote them.
- Avoid committing `.DS_Store` or other local environment files.

---

## Legacy VS Code Extension Files

Some VS Code-extension-era files may still be present. Unless Raul explicitly asks to revive or inspect the legacy extension, prefer modifying the standalone app paths:

- Active: `src/server.ts`, `client/`, `src/similarity.ts`, `src/lizard-server.ts`, `tsconfig.server.json`
- Legacy/reference: `src/extension.ts`, `src/lizard.ts`, `media/webview.html`, `webpack.config.js`, `.vscode-test.mjs`, `vsc-extension-quickstart.md`

If a change touches both active and legacy implementations, state that clearly and keep behavior consistent where practical.
