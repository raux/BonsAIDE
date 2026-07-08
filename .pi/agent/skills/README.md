# BonsAIDE Agent Skills Library

Specialized skills to help agents (especially local models) maintain the BonsAIDE repository.

## Quick Navigation

### 🎯 START HERE

**New to BonsAIDE?**
1. Read `/BonsAIDE/REPOSITORY_ANALYSIS.md` (comprehensive overview)
2. Read `INDEX.md` (this directory) (skill router)
3. Pick a task and follow the matching skill below

### 📚 Core Skills

| Skill | Purpose | Best For |
|-------|---------|----------|
| **llm-integration-specialist** | LLM config, system prompts, model support | Agents modifying code generation |
| **state-and-protocol-guide** | Session state, message protocol, data models | Agents modifying core state management |
| **similarity-and-analysis-crew** | Similarity algorithm, code metrics, repo analysis | Agents improving analysis features |

### 🧭 Routing Guide

See `INDEX.md` for quick lookup:
- **"Which skill do I use?"** → INDEX.md Quick Task Router
- **"I'm new to BonsAIDE"** → INDEX.md Recommended Learning Path
- **"How do I test my changes?"** → INDEX.md Testing Quick Reference

## Files in This Directory

```
.pi/agent/skills/
├── README.md (this file)
├── INDEX.md (skill router & quick reference)
├── llm-integration-specialist/
│   └── SKILL.md (12 KB, step-by-step LLM integration guide)
├── state-and-protocol-guide/
│   └── SKILL.md (16 KB, session state & protocol reference)
└── similarity-and-analysis-crew/
    └── SKILL.md (16 KB, similarity algorithm & code analysis guide)
```

## Referenced Repository Files

These skills document and guide changes to:
- `src/server.ts` — Main HTTP server
- `src/bonsai-state.ts` — Session state model
- `src/similarity.ts` — TF-IDF similarity (pure)
- `src/pi-models.ts` — Pi model discovery
- `src/pi-subscription-rpc.ts` — Pi AgentSession integration
- `src/repo-analyzer.ts` — GitHub issue analysis
- `src/lizard-server.ts` — Code metrics wrapper
- `client/index.html` — Browser UI
- `client/js/app.js` — Graph & event handling

## Complete Documentation

For comprehensive context, see:
- `/BonsAIDE/REPOSITORY_ANALYSIS.md` — 16 KB, high-level architecture
- `/BonsAIDE/SKILLS_PROPOSAL_SUMMARY.md` — 14 KB, this proposal summary
- `/BonsAIDE/AGENTS.md` — Existing contributor guide (read first!)
- `/BonsAIDE/README.md` — User guide

## Example: Using These Skills

**Scenario:** Agent needs to add a new activity type button

**Step 1:** Identify skill → INDEX.md says "state-and-protocol-guide"

**Step 2:** Read skill → Opens state-and-protocol-guide/SKILL.md

**Step 3:** Find section → "Activities & Color Mapping"

**Step 4:** Follow steps:
1. Add color to `getActivityColor()` in `src/server-utils.ts`
2. Add button to `client/index.html`
3. Add handler in `client/js/app.js`
4. Test: `npm run test` + manual UI test

**Step 5:** Commit with clear message

## Support & Feedback

If skills need improvement:
- **Typos/clarity:** Edit the SKILL.md directly
- **Missing content:** File an issue or contact Raul
- **New skill needed:** Propose to Raul with use cases

## Version & Maintenance

**Created:** 2026-07-08  
**Status:** Ready for production use  
**Maintenance:** Review quarterly when code changes significantly

## Key Principles

✅ **Task-focused** — Each skill guides a specific type of change  
✅ **Well-tested** — Supported by unit tests in `test/`  
✅ **Pure algorithms** — Core logic tested in isolation  
✅ **Defensive** — Handles errors gracefully  
✅ **Documented** — Code comments + external guides  

## Agent-Friendly Features

- ✨ Code examples included in each skill
- ✨ Step-by-step walkthroughs for complex tasks
- ✨ Testing patterns documented
- ✨ Anti-patterns explicitly called out
- ✨ Clear entry points (no "where do I start?" confusion)
- ✨ Gradual complexity (easy tasks → medium → hard)

---

**Ready to start?** Pick a skill above and dive in!
