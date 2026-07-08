# BonsAIDE Agent Skills Index & Router

**Quick reference for choosing the right skill when maintaining BonsAIDE.**

---

## When to Use Each Skill

### 1. **llm-integration-specialist**

**Use when:**
- Modifying LLM configuration (LM Studio or Pi models)
- Changing the system prompt or `<code>`/`<reasoning>` parsing
- Adding support for new model providers
- Fixing token counting or timeout behavior
- Debugging model connectivity issues
- Implementing new code generation activities

**Key files:** `src/server.ts`, `src/pi-models.ts`, `src/pi-subscription-rpc.ts`

**Example tasks:**
- "Add support for Ollama endpoint"
- "Change system prompt to require explanation comments"
- "Implement Claude model via Pi subscription"

---

### 2. **state-and-protocol-guide**

**Use when:**
- Adding new message commands or SSE events
- Modifying the Bonsai session model (branches, nodes)
- Changing import/export schema
- Debugging graph rendering issues
- Fixing parent-child linkage bugs
- Adding new activity types

**Key files:** `src/bonsai-state.ts`, `src/server.ts` (handleMessage), `client/js/app.js`

**Example tasks:**
- "Add support for multiple branches"
- "Export to different format (YAML, CSV)"
- "Fix leaf flag recomputation bug"
- "Add persistent storage backend"

---

### 3. **similarity-and-analysis-crew**

**Use when:**
- Modifying code similarity algorithm
- Improving code complexity metrics (Lizard)
- Fixing GitHub issue parsing or snippet extraction
- Adding new code analysis features
- Debugging repo caching or keyword extraction

**Key files:** `src/similarity.ts`, `src/lizard-server.ts`, `src/repo-analyzer.ts`

**Example tasks:**
- "Improve TF-IDF tokenization for Python code"
- "Add AST-based similarity comparison"
- "Fix GitHub issue keyword extraction"
- "Cache similarity scores for faster UI rendering"

---

## Quick Task Router

| Task | Skill | Priority |
|------|-------|----------|
| Add activity type button | state-and-protocol-guide | Medium |
| Change LLM system prompt | llm-integration-specialist | High |
| Fix similarity computation | similarity-and-analysis-crew | High |
| Add cloud model support | llm-integration-specialist | Medium |
| Fix import/export bug | state-and-protocol-guide | High |
| Improve code metrics | similarity-and-analysis-crew | Low |
| Debug model not responding | llm-integration-specialist | High |
| Refactor graph rendering | state-and-protocol-guide | Low |
| Add GitHub issue analysis | similarity-and-analysis-crew | Low |
| Persist sessions to database | state-and-protocol-guide | Medium |

---

## Recommended Learning Path for New Agents

### Phase 1: Understand the Architecture

1. Read `REPOSITORY_ANALYSIS.md` (this directory) — 30 min
2. Skim `AGENTS.md` in repo root — 15 min
3. Read README.md to understand user-facing features — 10 min

### Phase 2: Pick Your First Task

Choose based on interest:

**LLM-focused?** → Start with **llm-integration-specialist**
- Small, isolated changes
- Well-tested system prompts
- Direct model API interaction

**Data & State-focused?** → Start with **state-and-protocol-guide**
- Core data structures
- Well-documented schema
- Integration tests available

**Analysis-focused?** → Start with **similarity-and-analysis-crew**
- Pure algorithms (no I/O)
- Comprehensive unit tests
- Sandbox-safe (pure functions)

### Phase 3: Execute a Task

1. Read the relevant SKILL.md (30-45 min)
2. Read the source files mentioned (30 min)
3. Run tests: `npm run test` (5 min)
4. Make your change (15-60 min depending on complexity)
5. Run tests again (5 min)
6. Manual testing in browser (10 min)
7. Commit with clear message

---

## Common Patterns & Anti-Patterns

### ✅ DO

- **Recompute leaf flags** after any structural change
- **Validate imported JSON** defensively (schema, types, ranges)
- **Test pure functions** with unit tests before integration tests
- **Gracefully handle missing features** (e.g., Lizard not installed)
- **Use env vars** for configuration (BONSAI_LM_URL, BONSAI_LM_MODEL, PORT)
- **Broadcast state changes** via SSE to keep browser in sync
- **Type-coerce untrusted input** (imported JSON, LLM responses)

### ❌ DON'T

- **Expose API keys or credentials** in logs or error messages
- **Assume nodes exist** without checking first
- **Forget to sanitize HTML** before injecting into browser
- **Hardcode ports or model names** — use env vars
- **Modify legacy VS Code code** unless explicitly asked
- **Send large code blobs to LLM** without checking size limits
- **Break the message protocol** — keep command names stable

---

## Testing Quick Reference

```bash
# Run all tests
npm run test

# Run only unit tests (faster)
npm run test:unit

# Run mutation tests (pure functions)
npm run test:mutation

# Check linting before committing
npm run lint

# Compile TypeScript
npm run compile

# Start dev server for manual testing
npm run serve
```

---

## Key Contacts & Resources

### Within BonsAIDE

- **Main server:** `src/server.ts` (1200+ lines, handles all HTTP routes)
- **State model:** `src/bonsai-state.ts` (pure, well-tested)
- **Protocol definition:** In comments at top of `src/server.ts`
- **Tests:** `test/*.test.mjs` (node:test + node:assert)

### External References

- **LM Studio:** https://lmstudio.ai/
- **Pi SDK:** https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- **Cytoscape.js:** https://js.cytoscape.org/
- **Lizard (code metrics):** https://github.com/terryyin/lizard
- **TF-IDF (algorithm):** https://en.wikipedia.org/wiki/Tf%E2%80%93idf

---

## Known Challenges

### Complexity Levels

| Level | Challenge | Skill | Time |
|-------|-----------|-------|------|
| **Easy** | Add activity type | state-and-protocol-guide | 30 min |
| **Easy** | Fix typo in system prompt | llm-integration-specialist | 10 min |
| **Medium** | Add token counting from API response | llm-integration-specialist | 1 hr |
| **Medium** | Improve similarity algorithm | similarity-and-analysis-crew | 2 hr |
| **Hard** | Add persistent storage | state-and-protocol-guide | 4 hr |
| **Hard** | Support multi-user sessions | state-and-protocol-guide | 8 hr |
| **Hard** | Integrate with Jira/Linear APIs | similarity-and-analysis-crew | 6 hr |

---

## Session Memory Archival

After working on BonsAIDE, save your session context:

```bash
# Obsidian capture (if doing research)
pi /capture idea --title "BonsAIDE mod summary" --door "Research & Students"

# Or manually append to session log
echo "Completed: [task], Modified: [files], Tested: [tests]" >> .pi/memory/latest.md
```

---

## Troubleshooting Checklist

**Tests failing?**
- [ ] Ran `npm run compile` first? (Tests expect `out-server/`)
- [ ] Check Node version: `node --version` (should be 18+)
- [ ] Clear any .swp files: `find . -name "*.swp" -delete`

**Linting errors?**
- [ ] Ran `npm install`? (Updates eslint deps)
- [ ] Check TypeScript strict mode is configured: `tsconfig.server.json`

**Can't connect to LM Studio?**
- [ ] LM Studio running? (Check http://localhost:1234)
- [ ] Model loaded in LM Studio? (Check app UI)
- [ ] Correct port in env var? (`echo $BONSAI_LM_URL`)

**UI changes not reflecting?**
- [ ] Recompiled? (`npm run compile`)
- [ ] Restarted server? (`npm run serve`)
- [ ] Cleared browser cache? (Hard refresh)

---

## Agent Maintenance Checklist

Before each work session:

- [ ] Read REPOSITORY_ANALYSIS.md (high-level overview)
- [ ] Scout the repo: `garden-scout` skill or `ls -la` key directories
- [ ] Understand the specific SKILL.md for your task
- [ ] Run `npm run lint && npm run compile && npm run test` → verify all pass
- [ ] Start dev server: `npm run serve`
- [ ] Test manually in browser: http://localhost:3000

After each change:

- [ ] `npm run lint` passes
- [ ] `npm run compile` produces no errors
- [ ] `npm run test` passes
- [ ] Manual QA in browser works as expected
- [ ] Commit message mentions module(s) changed
- [ ] No credentials/secrets in code or logs

---

**End of Agent Skills Index**

---

**Next Steps:**

1. Identify your task
2. Find the matching skill above
3. Read that SKILL.md file
4. Follow the step-by-step guidance
5. Run tests and commit

**Questions?** Check the relevant SKILL.md's "References" section or the source code comments.
