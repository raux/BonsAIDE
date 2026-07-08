/**
 * Pi subscription model execution via AgentSession SDK.
 *
 * This module delegates code generation to Pi's AgentSession, which handles
 * all subscription/OAuth credential resolution from ~/.pi/agent/auth.json.
 *
 * BonsAIDE never sees, stores, or logs API keys or credentials.
 */

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

/**
 * Generate code using a Pi subscription model via AgentSession.
 *
 * Credentials are resolved by Pi from ~/.pi/agent/auth.json.
 * This function never receives, stores, or exposes API keys.
 */
export async function generateViaSubscription(
  request: SubscriptionGenerationRequest
): Promise<SubscriptionGenerationResult> {
  const piModule: any = await import('@earendil-works/pi-coding-agent');
  const authStorage = piModule.AuthStorage.create();
  const modelRegistry = piModule.ModelRegistry.create(authStorage);

  const model = modelRegistry.find(request.provider, request.modelId);
  if (!model) {
    throw new Error(
      `Model not found: ${request.provider}/${request.modelId}`
    );
  }

  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `No credentials configured for ${request.provider}. ` +
      `Run 'pi /login ${request.provider}' or set up auth in ~/.pi/agent/auth.json`
    );
  }

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

  const fullPrompt = `${request.prompt}\n${request.code}`;
  const timeoutMs = request.timeoutMs ?? 300000;

  try {
    const { createAgentSession, SessionManager } = piModule;

    const { session } = await createAgentSession({
      model,
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry
    });

    let fullResponse = '';
    let isStreaming = true;

    const handler = async (message: any) => {
      if (message.type === 'assistant' && message.role === 'assistant') {
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text') {
              fullResponse += block.text || '';
            }
          }
        }
      }
    };

    session.onMessage(handler);

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      await session.prompt(fullPrompt, {
        signal: abortController.signal
      });

      isStreaming = false;
      clearTimeout(timeoutId);

      const output = fullResponse.trim();
      const codeMatch = output.match(/<code>([\s\S]*?)<\/code>/i);
      const reasoningMatch = output.match(/<reasoning>([\s\S]*?)<\/reasoning>/i);
      const content = codeMatch?.[1]?.trim() ?? '';
      const reasoning = reasoningMatch?.[1]?.trim() ?? '(no reasoning provided)';

      if (!content && !reasoning) {
        throw new Error(
          'No <code> or <reasoning> tags found in model response. ' +
          'Check model configuration or retry.'
        );
      }

      // Estimate token usage from response length
      const promptTokens = Math.ceil(fullPrompt.length / 4);
      const completionTokens = Math.ceil(output.length / 4);
      const totalTokens = promptTokens + completionTokens;

      return {
        content,
        reasoning,
        tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens }
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Code generation timeout after ${timeoutMs}ms`);
    }
    throw new Error(`Subscription model generation failed: ${err?.message || err}`);
  }
}
