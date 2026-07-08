export interface PiModelCandidate {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  api: string;
  baseUrl?: string;
  compatible: boolean;
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

function normalizeSafeBaseUrl(rawBaseUrl: unknown): { baseUrl?: string; isLocal: boolean; blockedReason?: string } {
  const value = safeString(rawBaseUrl);
  if (!value) {
    return { isLocal: false, blockedReason: 'No base URL is configured for this model.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { isLocal: false, blockedReason: 'The configured base URL is not a valid absolute URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { isLocal: false, blockedReason: 'Only http(s) OpenAI-compatible endpoints are supported.' };
  }

  if (parsed.username || parsed.password) {
    return { isLocal: false, blockedReason: 'Base URLs with embedded credentials are intentionally not exposed.' };
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString().replace(/\/$/, '');
  const hostname = parsed.hostname.toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
  return { baseUrl: normalized, isLocal };
}

function toCandidate(model: unknown, providerDisplayName: (provider: string) => string): PiModelCandidate | null {
  if (!isRecord(model)) { return null; }

  const id = safeString(model.id);
  const provider = safeString(model.provider);
  const api = safeString(model.api);
  if (!id || !provider || !api) { return null; }

  const name = safeString(model.name) ?? id;
  const providerName = providerDisplayName(provider) || provider;
  const base = normalizeSafeBaseUrl(model.baseUrl);

  if (api !== 'openai-completions') {
    return {
      id,
      name,
      provider,
      providerName,
      api,
      compatible: false,
      reason: `Pi model uses ${api}; BonsAIDE currently supports local OpenAI chat-completions endpoints only.`
    };
  }

  if (!base.baseUrl || !base.isLocal) {
    return {
      id,
      name,
      provider,
      providerName,
      api,
      compatible: false,
      reason: base.blockedReason ?? 'Only local OpenAI-compatible endpoints are enabled without exposing Pi credentials.'
    };
  }

  return {
    id,
    name,
    provider,
    providerName,
    api,
    baseUrl: base.baseUrl,
    compatible: true,
    reason: 'Local OpenAI-compatible Pi model; usable with BonsAIDE chat-completions.'
  };
}

/**
 * Discover Pi models without exposing credentials.
 *
 * This intentionally calls ModelRegistry.getAvailable() only. It does not call
 * getApiKeyAndHeaders(), does not resolve command-backed secrets, and never
 * returns headers, API keys, auth records, or raw Pi config values beyond a
 * sanitized local base URL needed for BonsAIDE's current OpenAI-compatible path.
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
      .map((model: unknown) => toCandidate(model, providerDisplayName))
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
