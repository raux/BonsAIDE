# SKILL: BonsAIDE LLM Integration Guide

**For:** Agents modifying code generation, model configuration, and LLM communication  
**Scope:** Pi-only model routing through Pi's model registry and AgentSession SDK  
**Related files:** `src/server.ts`, `src/pi-models.ts`, `src/pi-subscription-rpc.ts`

> **Current implementation note:** BonsAIDE no longer calls LM Studio/local OpenAI-compatible endpoints directly. Any older local-LM guidance below is historical; new work must route all LLM calls through Pi.

---

## Overview

BonsAIDE supports two LLM paths:

1. **Local (LM Studio):** OpenAI-compatible HTTP endpoint, no auth needed
2. **Cloud (Pi Subscription):** OpenAI, Claude, Google, etc. via Pi SDK with secure credential handling

Both paths must:
- Return code in `<code>` tags and reasoning in `<reasoning>` tags
- Estimate token counts (prompt + completion)
- Handle timeouts gracefully (5-minute limit)
- Never expose API keys or credentials

---

## Local LLM Setup (LM Studio)

### Configuration

```bash
# Start LM Studio server (listens on :1234)
# https://lmstudio.ai/

# Set env vars (or configure in UI)
export BONSAI_LM_URL="http://localhost:1234/v1"
export BONSAI_LM_MODEL="deepseek/deepseek-r1-0528-qwen3-8b"

# Launch BonsAIDE
npm run serve
```

### Request Flow

1. User clicks "Generate" → browser sends POST /message
2. Server calls `fetchFromLocalLMStudio(prompt, code)`
3. Function builds chat-completions request to `${BONSAI_LM_URL}/chat/completions`
4. Parses `<code>` and `<reasoning>` from response
5. Estimates tokens: `Math.ceil(text.length / 4)`

### System Prompt (Critical)

Located in `src/server.ts` and `src/pi-subscription-rpc.ts`:

```
You are a code-generation assistant. You MUST return output using ONLY the two XML tags below, 
with nothing before or after them. Absolutely NO markdown, NO backticks, NO prose outside the tags.

### REQUIRED SCHEMA (use exactly these tags and order):
<code>
[ONLY the final code here — no comments, no prose]
</code>
<reasoning>
[ONLY the explanation here — plain text, no code fences]
</reasoning>

### RULES (strict):
1) Output MUST start with "<code>" on the first line and end with "</reasoning>" on the last line.
2) No additional tags, headers, or text outside the two blocks.
3) Put ALL executable or final code inside <code>. Do NOT include explanations, comments, or markdown there.
4) Put ALL explanation inside <reasoning>. Do NOT include code fences or pseudo-tags there.
5) Do NOT wrap anything in triple backticks.
6) If unsure, still produce both tags (they may be empty), but NEVER add anything else.

Validate your output against the RULES before responding.
```

**Why so strict?** Simple regex parsing (`/<code>([\s\S]*?)<\/code>/i`) expects clean XML-like blocks.

### Modifying the System Prompt

If changing the system prompt:
1. Update **both** `src/server.ts` (local path) **and** `src/pi-subscription-rpc.ts` (cloud path)
2. Ensure the XML tags remain: `<code>` and `<reasoning>` (case-insensitive regex)
3. Test locally with a cheap model before deploying
4. Verify regex extraction works: run `npm run test` to check parsing

### Error Handling

Common issues in `src/server.ts`:

```typescript
// Timeout after 5 minutes
const abortController = new AbortController();
const timeoutId = setTimeout(() => abortController.abort(), 300000);

// Parse XML tags (case-insensitive)
const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);

// Fallback if tags missing
if (!codeMatch && !reasoningMatch) {
  throw new Error('No <code> or <reasoning> tags found in model response.');
}
```

---

## Cloud LLM Setup (Pi Subscription Models)

### Prerequisites

1. **Install Pi:** `npm install -g @earendil-works/pi-coding-agent`
2. **Add credentials:** `pi /login openai` (or anthropic, google, etc.)
3. **BonsAIDE discovers models:** Click "Load Pi Models" in UI

### Credential Handling (Security Critical)

**Policy:** BonsAIDE never sees, stores, or logs API keys.

**How it works:**
1. Server calls `discoverPiModels()` from `src/pi-models.ts`
2. Dynamically imports Pi SDK: `await import('@earendil-works/pi-coding-agent')`
3. Pi SDK queries `ModelRegistry.getAvailable()` (metadata only, no credentials)
4. Returns array of models with `provider`, `id`, `api`, `baseUrl`
5. BonsAIDE filters: local OpenAI-compatible endpoints only, or marks cloud as "delegated"
6. On generate, calls `generateViaSubscription(provider, modelId, prompt, code)`
7. Pi SDK handles all auth internally via AgentSession → never exposed

**Key invariant:** If a model is `api: 'openai-completions'` and `baseUrl` is NOT localhost, BonsAIDE blocks it with reason: "Only local OpenAI-compatible endpoints enabled without exposing Pi credentials."

### Model Discovery (`src/pi-models.ts`)

```typescript
export async function discoverPiModels(): Promise<PiModelDiscoveryResult> {
  // Load Pi SDK dynamically (don't fail if missing)
  const piModule = await import('@earendil-works/pi-coding-agent');
  
  // Query model registry (metadata only)
  const modelRegistry = piModule.ModelRegistry.create(authStorage);
  const available = await modelRegistry.getAvailable();
  
  // Convert to BonsAIDE candidates with safety checks
  const models = available
    .map((model) => toCandidate(model, providerDisplayName))
    .filter((model) => model !== null)
    .sort((a, b) => /* sort by compatibility */);
  
  return {
    models,
    compatibleCount: models.filter(m => m.compatible).length,
    totalCount: models.length
  };
}
```

### Code Generation via Pi (`src/pi-subscription-rpc.ts`)

```typescript
export async function generateViaSubscription(
  request: SubscriptionGenerationRequest
): Promise<SubscriptionGenerationResult> {
  // Create session with Pi's credential resolution
  const { session } = await createAgentSession({
    model,                    // Pi finds credentials for this model
    authStorage,              // Reads ~/.pi/agent/auth.json
    modelRegistry
  });
  
  // Send prompt (Pi handles auth headers internally)
  await session.prompt(fullPrompt, { signal: abortController.signal });
  
  // Parse response (same XML format as local)
  const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
  const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
  
  return {
    content: codeMatch?.[1]?.trim() ?? '',
    reasoning: reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)',
    tokens: { prompt, completion, total }
  };
}
```

---

## Integration Points in `src/server.ts`

### Handling the "Generate" Command

```typescript
// Browser sends: { command: "generate", data: { nodeId, activity, count, modelId?, provider? } }

// In handleMessage():
if (command === 'generate') {
  const { nodeId, activity, count, modelId, provider } = data;
  
  // Decide which generation path
  if (provider && modelId) {
    // Cloud model: use generateViaSubscription
    for (let i = 0; i < count; i++) {
      const result = await generateViaSubscription({
        provider,
        modelId,
        prompt: userPrompt,
        code: selectedCode,
        timeoutMs: 300000
      });
      // Create node from result.content, result.reasoning, result.tokens
    }
  } else {
    // Local model: use fetchFromLocalLMStudio
    for (let i = 0; i < count; i++) {
      const result = await fetchFromLocalLMStudio(userPrompt, selectedCode);
      // Create node from result.content, result.reasoning, result.tokens
    }
  }
  
  // Broadcast updated graph
  broadcast({ type: 'renderGraph', data: createGraphFromBranch(activeBranch) });
}
```

### Activity Mapping

Activities determine the user's intent (visible in UI color coding):

```typescript
// In server.ts, activities include:
const ACTIVITIES = {
  'initial': 'Initial code',
  'gen_tests': 'Generate tests',
  'refactor': 'Refactor',
  'exceptions': 'Handle exceptions',
  'agent_md_alternative': 'Alternative via Agent.md'
};
```

**Modifying activities:**
1. Update ACTIVITIES enum in `src/server.ts`
2. Update color mapping in `src/server-utils.ts` (getActivityColor)
3. Update browser UI button labels in `client/index.html`
4. Add corresponding button handler in `client/js/app.js`
5. Test: `npm run test`

---

## Token Counting & Cost Estimation

### Current Strategy

Both local and cloud paths estimate tokens:

```typescript
const promptTokens = Math.ceil(fullPrompt.length / 4);
const completionTokens = Math.ceil(output.length / 4);
const totalTokens = promptTokens + completionTokens;
```

**Why divide by 4?** Rough heuristic: ~1 token per 4 characters (varies by model/language).

**Limitation:** Estimates only. Real models may differ. For production cost tracking, use actual token counts from model API.

### Improving Token Counting

To use actual token counts:

1. **LM Studio:** Parse `usage.prompt_tokens` from chat-completions response
2. **Pi Models:** Request actual token usage from Pi SDK (may require SDK enhancement)

Example for LM Studio:

```typescript
async function fetchFromLocalLMStudio(prompt, code) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLMmodel,
      messages: [ { role: 'system', content: systemPrompt }, ... ],
      temperature: 0.7
    })
  });
  
  const data = await response.json();
  
  // Use actual token counts from response
  const actualTokens = {
    prompt: data.usage?.prompt_tokens ?? estimate,
    completion: data.usage?.completion_tokens ?? estimate,
    total: data.usage?.total_tokens ?? estimate
  };
  
  return {
    content: extractCode(data.choices[0].message.content),
    reasoning: extractReasoning(...),
    tokens: actualTokens
  };
}
```

---

## Testing LLM Integration

### Unit Tests

Located in `test/` (uses mocked responses):

```bash
npm run test
```

### Manual Testing

1. **Start LM Studio:** Launch LM Studio app, ensure model is loaded
2. **Start BonsAIDE:** `npm run serve`
3. **Test local path:**
   - Open http://localhost:3000
   - Paste sample code
   - Click "Fix the problem" → Enter 1 branch count
   - Watch for `<code>` and `<reasoning>` extraction
4. **Test cloud path:**
   - Click "Load Pi Models"
   - Select a cloud model (if configured)
   - Click "Generate" → Should use Pi SDK
5. **Check logs:** Browser console + `npm run serve` stdout

### Debugging

**Issue:** LM Studio returns response without `<code>` tags

**Debug:**
1. Check network tab → inspect full response body
2. Verify system prompt is being sent
3. Try simpler prompt (fewer tokens)
4. Check LM Studio model output format (some models output markdown by default)

**Issue:** "No credentials configured for provider"

**Debug:**
1. Run `pi /login openai` (or desired provider)
2. Verify `~/.pi/agent/auth.json` has entry for provider
3. Check Pi SDK can read auth file
4. Retry "Load Pi Models"

---

## Common Modifications

### Change System Prompt

1. Edit system prompt in `src/server.ts` (local path)
2. Edit system prompt in `src/pi-subscription-rpc.ts` (cloud path)
3. Ensure XML tag names (`<code>`, `<reasoning>`) stay consistent
4. Test: `npm run serve` → manual test with both local and cloud models

### Add New Activity Type

1. Add enum entry in `src/server.ts`
2. Add color mapping in `src/server-utils.ts` (getActivityColor)
3. Add button + handler in `client/index.html` and `client/js/app.js`
4. Test: Create node via UI, verify color in tree

### Support New Model Provider

If adding support for a provider that's not OpenAI-compatible:

1. Create new generation function: `generateViaMyProvider(request)` in a new file
2. Update `src/server.ts` message handler to call new function
3. Add model discovery logic (similar to `discoverPiModels`)
4. **Security:** Ensure credentials are never logged or exposed
5. Test: `npm run lint && npm run compile && npm run test`

### Tune Temperature / Top-P / Other Hyperparams

In `src/server.ts` or `src/pi-subscription-rpc.ts`, modify the chat-completions request:

```typescript
body: JSON.stringify({
  model: LLMmodel,
  messages: [...],
  temperature: 0.7,      // Adjust here (0-2)
  top_p: 0.95,          // Adjust here (0-1)
  max_tokens: 2048      // Add here to limit output
})
```

---

## References

- **System Prompt Docs:** Embedded in code (see src/server.ts lines ~120-150)
- **LM Studio:** https://lmstudio.ai/ (OpenAI-compatible server)
- **Pi SDK:** https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- **OpenAI API:** https://platform.openai.com/docs/api-reference/chat/create
- **Code in repo:**
  - Local generation: `src/server.ts` → `fetchFromLocalLMStudio()`
  - Cloud generation: `src/pi-subscription-rpc.ts` → `generateViaSubscription()`
  - Model discovery: `src/pi-models.ts` → `discoverPiModels()`

---

**End of Skill**
