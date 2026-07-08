export interface PiModelCandidate {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  api: string;
  compatible: boolean;
  subscription?: boolean;
  reason: string;
}

export interface PiModelDiscoveryResult {
  models: PiModelCandidate[];
  compatibleCount: number;
  totalCount: number;
  warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toCandidate(model: unknown, modelRegistry: any, providerDisplayName: (provider: string) => string): PiModelCandidate | null {
  if (!isRecord(model)) { return null; }

  const id = safeString(model.id);
  const provider = safeString(model.provider);
  const api = safeString(model.api);
  if (!id || !provider || !api) { return null; }

  const name = safeString(model.name) ?? id;
  const providerName = providerDisplayName(provider) || provider;
  const hasAuth = typeof modelRegistry.hasConfiguredAuth === 'function'
    ? Boolean(modelRegistry.hasConfiguredAuth(model))
    : true;

  return {
    id,
    name,
    provider,
    providerName,
    api,
    compatible: hasAuth,
    subscription: true,
    reason: hasAuth
      ? 'Pi-managed model. Credentials stay in Pi auth storage and are never exposed to BonsAIDE.'
      : `Credentials are not configured for ${provider}. Run 'pi /login ${provider}' before using this model.`
  };
}

/**
 * Discover Pi models without exposing credentials.
 *
 * BonsAIDE is Pi-only for LLM execution. We return Pi registry model metadata
 * and never expose provider headers, API keys, or base URLs to the browser.
 */
export async function discoverPiModels(): Promise<PiModelDiscoveryResult> {
  try {
    const piModule: any = await import('@earendil-works/pi-coding-agent');
    const authStorage = piModule.AuthStorage.create();
    const modelRegistry = piModule.ModelRegistry.create(authStorage);
    const available = await Promise.resolve(modelRegistry.getAvailable());
    const loadError = typeof modelRegistry.getError === 'function' ? modelRegistry.getError() : undefined;
    const providerDisplayName = (provider: string): string => {
      try {
        return modelRegistry.getProviderDisplayName(provider) || provider;
      } catch {
        return provider;
      }
    };

    const models = (Array.isArray(available) ? available : [])
      .map((model: unknown) => toCandidate(model, modelRegistry, providerDisplayName))
      .filter((model: PiModelCandidate | null): model is PiModelCandidate => model !== null)
      .sort((a: PiModelCandidate, b: PiModelCandidate) => {
        if (a.compatible !== b.compatible) { return a.compatible ? -1 : 1; }
        return `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`);
      });

    return {
      models,
      compatibleCount: models.filter(model => model.compatible).length,
      totalCount: models.length,
      warning: safeString(loadError)
    };
  } catch (err: any) {
    throw new Error(`Unable to load Pi model registry: ${err?.message || err}`);
  }
}
