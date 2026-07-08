# 🌳 Bonsai Code

**Bonsai** is a visual **bug-fixing & software-engineering environment** that runs as a standalone web server.  
Paste your code, then apply activities powered by an **LLM** to generate **multiple options** and explore **alternative branches**:
- **Fix the problem** (mandatory first step, with or without a short description)
- **Generate tests**
- **Refactor**
- **Handle exceptions**

**Fill color = last activity**, **leaf borders = similarity** (blue→red vs. the selected leaf), **right-click → Trim** to prune subtrees, and **Export/Import** sessions as JSON.

![Bonsai web UI](other/bonsaide-initial-state.png)

> Note: The legacy VS Code extension has been removed. Bonsai now runs purely as a standalone web app served from this repository.

---

## Installation

Run Bonsai as a standalone web server accessible from any browser:

```bash
# In the repo folder
npm install
npm run serve
# Open http://localhost:3000 in your browser
```

The server uses port **3000** by default. To use a different port:

```bash
# Using PORT environment variable
PORT=8080 npm run serve

# Or pass the port as a CLI argument
npm run serve -- 4000
```

---

## Configuration

### LM Studio URL

Set your LM Studio URL before launching:

* macOS/Linux: `export BONSAI_LM_URL=http://localhost:1234/v1`
* Windows (PowerShell): `$env:BONSAI_LM_URL="http://localhost:1234/v1"`

### Model

Set your LM Studio model before launching:

* macOS/Linux: `export BONSAI_LM_MODEL=deepseek/deepseek-r1-0528-qwen3-8b`
* Windows (PowerShell): `$env:BONSAI_LM_MODEL="deepseek/deepseek-r1-0528-qwen3-8b"`

Both values can also be configured interactively in the Bonsai UI.

### Pi model registry integration

If you use [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), click **Load Pi Models** in the Bonsai UI to list available models from Pi's model registry.

#### Local models
BonsAIDE supports local `openai-completions` endpoints (LM Studio, Ollama, vLLM) with no credential handling — they run on localhost with a placeholder bearer token.

#### Subscription/cloud models
BonsAIDE also lists subscription-based models (OpenAI, Anthropic Claude, Google, etc.) via Pi's SDK. These models are:
- **Credential-safe**: All API keys and auth tokens are resolved by Pi from `~/.pi/agent/auth.json`, never exposed to BonsAIDE
- **On-demand**: Use `pi /login <provider>` to add credentials for cloud models you want to use (e.g., `pi /login anthropic`)
- **Delegated**: BonsAIDE delegates code generation to Pi's AgentSession, which manages the request lifecycle

To use a cloud model:
1. Open Pi and run `/login <provider>` (e.g., `/login openai`)
2. Return to BonsAIDE and click **Load Pi Models**
3. Select your cloud model from the dropdown
4. Generate code as usual

---

## Quick Use

1. Open **http://localhost:3000** in your browser after starting the server.
2. Paste your code in the text area — this becomes the first node.
3. **Always start with *Fix the problem***.
4. When applying an activity, use the **numeric input** to spawn **N branches** (N≥1) with different options.
5. Select a **leaf** to see **similarity borders** on other leaves (cool→warm = less→more similar).
6. Check the **Details** pane (Code, Reasoning, Similarity, Code Metrics).
7. **Right-click → Trim** to prune a node and its children.
8. **Export JSON** to save; **Import JSON** to restore.

![Agent.md loaded state](other/bonsaide-after-load-agent-md.png)

---

## UI Rearrangement & Interactivity Ideas

- Keep the code input, tree canvas, and details panel resizable with quick toggle buttons to focus on one region at a time.
- Add keyboard shortcuts and a tiny command palette for spawn/trim/select-parent plus a repeat-last-action hotkey.
- Surface connection + Agent.md load state inline in the header with a one-click reconnect or reload control.
- Collapse logs/metrics/diff panes into tabs next to Details and pair them with a small mini-map for quick jumps.
- Let users pin favorite activities and branch counts into a compact action bar near the header.

---

## API Endpoints

The server exposes the following HTTP endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the main web UI |
| `/events` | GET | Server-Sent Events stream for real-time updates |
| `/message` | POST | Send commands from browser to server |
| `/export` | GET | Download current session as JSON |
| `/import` | POST | Upload a previously-exported JSON session |

---

## Agent & Contributor Documentation

BonsAIDE includes repository-specific documentation to help human contributors and coding agents, especially local models, understand and maintain the project safely.

Start here:

* Contributor and agent rules: `AGENTS.md`
* Architecture and maintenance overview: `REPOSITORY_ANALYSIS.md`
* Agent skills proposal summary: `SKILLS_PROPOSAL_SUMMARY.md`
* Skills library entry point: `.pi/agent/skills/README.md`
* Task-to-skill router: `.pi/agent/skills/INDEX.md`

Specialized maintenance skills:

* `.pi/agent/skills/llm-integration-specialist/SKILL.md` — LM Studio, Pi model registry, cloud model delegation, prompt parsing, and token handling
* `.pi/agent/skills/state-and-protocol-guide/SKILL.md` — Bonsai state, branches/nodes, import/export schema, graph rendering, and browser/server protocol
* `.pi/agent/skills/similarity-and-analysis-crew/SKILL.md` — TF-IDF similarity, Lizard metrics, GitHub issue/repository analysis, and analysis tests

Recommended agent flow: read `AGENTS.md`, skim `REPOSITORY_ANALYSIS.md`, choose a task-specific skill through `.pi/agent/skills/INDEX.md`, then run `npm run lint && npm run compile && npm run test` before committing code changes.

---

## Links

* Quick Start & Tutorial: `TUTORIAL.md`
* Repository: [https://github.com/raux/BonsAIDE](https://github.com/raux/BonsAIDE)

> **Privacy note:** Bonsai sends code/prompts to your configured LLM. Don't include secrets or proprietary data unless permitted.
