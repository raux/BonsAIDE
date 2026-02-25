# AGENTS.md — BonsAIDE Contributor & Agent Guide

This file describes the repository layout, how to build/test the project, and the conventions that automated agents (and human contributors) should follow when modifying this codebase.

---

## Repository Overview

**BonsAIDE** (a.k.a. *Bonsai Code*) is a VS Code extension that provides a visual, tree-based environment for iterative code improvement powered by a local LLM (via LM Studio).

| Path | Purpose |
|---|---|
| `src/extension.ts` | Main extension entry point — commands, webview lifecycle, LLM calls, state persistence |
| `src/similarity.ts` | Pure TF-IDF cosine-similarity utilities (no VS Code dependency) |
| `src/lizard.ts` | Wrapper around the `lizard` Python package for code-complexity metrics |
| `media/webview.html` | Cytoscape.js-based front-end rendered inside the VS Code Webview panel |
| `package.json` | Extension manifest, npm scripts, and devDependencies |
| `tsconfig.json` | TypeScript compiler options (`module: Node16`, `target: ES2022`, `strict: true`) |
| `webpack.config.js` | Bundles `src/` → `dist/extension.js` |
| `TUTORIAL.md` | End-user quick-start guide |
| `other/` | Diagrams, publishing notes, and icon assets |

---

## Environment Setup

```bash
# Install Node.js dependencies
npm install

# Compile (development, with source maps)
npm run compile

# Watch mode (recompiles on every save)
npm run watch

# Package for production (output: dist/)
npm run package
```

> **Python dependency:** The Lizard code-metrics feature requires Python 3 with the `lizard` package (`pip install lizard`). The extension attempts to install it automatically on first use.

---

## Running the Extension

1. Open this folder in VS Code.
2. Press **F5** to launch the *Extension Development Host*.
3. In the new VS Code window, open a source file and run **Ctrl/Cmd+Shift+P → "Start Bonsai IDE"**.

---

## LLM Configuration

BonsAIDE connects to a local [LM Studio](https://lmstudio.ai/) server.

| Environment variable | Default | Description |
|---|---|---|
| `BONSAI_LM_URL` | `localhost:1234/v1` | Base URL for the OpenAI-compatible LM Studio endpoint |
| `BONSAI_LM_MODEL` | `deepseek/deepseek-r1-0528-qwen3-8b` | Model identifier sent in every chat-completion request |

Both values can also be set interactively inside the Bonsai UI.

---

## Build & Lint Scripts

| Script | Command | Description |
|---|---|---|
| `compile` | `npm run compile` | Webpack development build |
| `watch` | `npm run watch` | Webpack watch mode |
| `package` | `npm run package` | Production build (`hidden-source-map`) |
| `lint` | `npm run lint` | ESLint over `src/` (TypeScript rules) |
| `compile-tests` | `npm run compile-tests` | `tsc` → `out/` for test runner |
| `test` | `npm run test` | Runs `pretest` (compile + lint) then `vscode-test` |

Always run `npm run lint` before committing TypeScript changes.

---

## Code Conventions

### TypeScript
- **Strict mode is on** (`"strict": true` in `tsconfig.json`). All code must type-check cleanly.
- Target is **ES2022** with `module: Node16`.
- Prefer `async/await` over raw Promise chains.
- Use `void expr` (not `// eslint-disable`) to intentionally discard floating promises (see `persistState` usages in `extension.ts`).

### Naming
- Extension-internal state (branches, nodes, IDs) lives in module-level `let` variables in `extension.ts`.
- Helper modules (`similarity.ts`, `lizard.ts`) export only pure functions or thin async wrappers — they must not import from `extension.ts`.

### Webview ↔ Extension messaging
- All webview→extension messages are handled in the `panel.webview.onDidReceiveMessage` listener in `extension.ts`.
- All extension→webview messages are sent via `panel.webview.postMessage(...)`.
- Message `type` strings act as the discriminant; keep them `snake_case`.

### Activity identifiers
Activity strings are used as keys for node coloring and LLM prompt routing:

| `activity` value | Meaning |
|---|---|
| `gen_tests` | Generate tests |
| `refactor` | Refactor |
| `exceptions` | Handle exceptions |
| `agent_md_alternative` | Generate alternative based on Agent.md |

---

## Testing

The test runner is `@vscode/test-cli` (`vscode-test`). Tests live under `src/test/` (compiled to `out/test/`).

```bash
# Full test run (lint + compile + vscode-test)
npm run test
```

When adding new features, add or update tests under `src/test/` following the existing Mocha patterns.

---

## State Persistence

Bonsai state (branches, nodes, active branch, LLM config) is stored in VS Code's `globalState` under the key `bonsai.state.v1`. State is tagged with `vscode.env.sessionId` and is discarded when a new VS Code session starts.

---

## Export / Import Format

Sessions are exported as JSON containing the full branch/node tree. The schema mirrors the `Branch[]` / `CodeNode` TypeScript interfaces in `extension.ts`. Logs are appended under a top-level `logs` key.

---

## Dependency Notes

- **No runtime npm dependencies** — the extension bundles only its own compiled TypeScript into `dist/extension.js`.
- All `devDependencies` are build/test tools (TypeScript, webpack, ESLint, `@vscode/test-*`).
- The `lizard` Python package is a runtime requirement installed on the user's machine (not bundled).

---

## Security Notes

- The LLM endpoint URL is configurable and user-supplied; never hard-code API keys in source.
- Code sent to the LLM comes from the user's own open files — do not transmit additional workspace data.
- Webview HTML is loaded from disk (`media/webview.html`) and served through VS Code's `asWebviewUri`; inline script sources must be kept minimal and CSP-compliant.
