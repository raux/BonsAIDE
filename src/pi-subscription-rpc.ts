/**
 * Pi model execution via AgentSession SDK.
 *
 * BonsAIDE delegates all LLM work to Pi. Pi resolves OAuth/API-key
 * credentials from ~/.pi/agent/auth.json and BonsAIDE never receives,
 * stores, or logs provider secrets.
 */

export interface PiPromptRequest {
  provider: string;
  modelId: string;
  prompt: string;
  timeoutMs?: number;
}

export interface PiPromptResult {
  text: string;
  tokens: { prompt: number; completion: number; total: number };
}

export interface SubscriptionGenerationRequest {
  provider: string;
  modelId: string;
  prompt: string;
  code: string;
  timeoutMs?: number;
}

export interface SubscriptionGenerationResult {
  content: string;
  reasoning: string;
  tokens: { prompt: number; completion: number; total: number };
}

async function resolvePiModel(provider: string, modelId: string): Promise<{ piModule: any; authStorage: any; modelRegistry: any; model: any }> {
  const piModule: any = await import('@earendil-works/pi-coding-agent');
  const authStorage = piModule.AuthStorage.create();
  const modelRegistry = piModule.ModelRegistry.create(authStorage);

  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Model not found in Pi registry: ${provider}/${modelId}`);
  }

  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `No credentials configured for ${provider}. ` +
      `Run 'pi /login ${provider}' or set up auth in ~/.pi/agent/auth.json`
    );
  }

  return { piModule, authStorage, modelRegistry, model };
}

export async function promptViaPiModel(request: PiPromptRequest): Promise<PiPromptResult> {
  const timeoutMs = request.timeoutMs ?? 300000;
  const { piModule, authStorage, modelRegistry, model } = await resolvePiModel(request.provider, request.modelId);
  const { createAgentSession, SessionManager } = piModule;

  const { session } = await createAgentSession({
    model,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    noTools: 'all'
  });

  let fullResponse = '';
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      fullResponse += event.assistantMessageEvent.delta || '';
    }
  });

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    await session.prompt(request.prompt, { signal: abortController.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Pi model generation timeout after ${timeoutMs}ms`);
    }
    throw new Error(`Pi model generation failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timeoutId);
    if (typeof unsubscribe === 'function') { unsubscribe(); }
  }

  const text = fullResponse.trim();
  if (!text) {
    throw new Error('Pi model returned an empty response.');
  }

  const promptTokens = Math.ceil(request.prompt.length / 4);
  const completionTokens = Math.ceil(text.length / 4);
  return {
    text,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens
    }
  };
}

/**
 * Generate code using a Pi model via AgentSession.
 */
export async function generateViaSubscription(
  request: SubscriptionGenerationRequest
): Promise<SubscriptionGenerationResult> {
  const systemPrompt = `
You are a code-generation assistant. You MUST return output using ONLY the two XML tags below, with nothing before or after them. Absolutely NO markdown, NO backticks, NO prose outside the tags.

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
  `.trim();

  const fullPrompt = `${systemPrompt}\n\nUser prompt:\n${request.prompt}\n\nInput code/context:\n${request.code}`;
  const result = await promptViaPiModel({
    provider: request.provider,
    modelId: request.modelId,
    prompt: fullPrompt,
    timeoutMs: request.timeoutMs
  });

  const output = result.text;
  const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
  const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
  const content = codeMatch?.[1]?.trim() ?? '';
  const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

  if (!content && !reasoning) {
    throw new Error(
      'No <code> or <reasoning> tags found in Pi model response. ' +
      'Check model configuration or retry.'
    );
  }

  return { content, reasoning, tokens: result.tokens };
}
