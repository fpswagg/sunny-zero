import { codexConnected, codexModels } from './codex.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { AuthFlow } from '../auth/types.ts';
import { formFlow } from '../auth/flows.ts';
import { getProvider, PROVIDER_IDS, PROVIDERS, providerSecretId, type Provider, type ProviderId } from './catalog.ts';
import { upstreamMessage } from './translate.ts';
import { ClaudeAccounts } from './claude-accounts.ts';

export interface ModelInfo {
  id: string;
  name?: string;
  /** Context window in tokens, when the provider says. */
  context?: number;
  /** USD per million tokens, when the provider says (OpenRouter). */
  pricing?: { input: number; output: number };
  /** Listed among the provider's suggestions. */
  suggested?: boolean;
}

export interface Credentials {
  apiKey: string;
  /** The base URL that accepted the key (Kimi has an international and a Chinese platform). */
  baseUrl: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  family: string;
  connected: boolean;
  updatedAt?: string;
  notes?: string;
  keyUrl?: string;
}

const MODELS_TTL_MS = 60 * 60_000;

/** A provider path: "/models" is appended to the base URL, "../v1/models" resolved against it, a full URL used as is. */
export function apiUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  if (path.startsWith('.')) return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
  return `${base.replace(/\/+$/, '')}${path}`;
}

export function authHeaders(provider: Provider, apiKey: string): Record<string, string> {
  if (provider.auth === 'x-api-key') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (provider.auth === 'bearer') return { authorization: `Bearer ${apiKey}` };
  return {};
}

/** Chat models only: embeddings, speech, images and the like cannot drive an agent. */
const NOT_CHAT: Partial<Record<ProviderId, RegExp>> = {
  openai: /(audio|realtime|transcribe|tts|image|embedding|search|moderation|instruct|dall-e|whisper|davinci|babbage|computer-use|deep-research)/,
  gemini: /(embedding|image|tts|aqa|live|native-audio|imagen|veo|robotics|computer-use)/,
  kimi: /(vision-preview)/,
};

/** Puts suggested models first (in their order), then the newest. */
export function rankModels(provider: Provider, models: (ModelInfo & { created?: number })[]): ModelInfo[] {
  const order = new Map(provider.suggested.map((id, i) => [id, i]));
  return models
    .map((m) => ({ ...m, suggested: order.has(m.id) || undefined }))
    .sort((a, b) => {
      const sa = order.get(a.id) ?? Infinity;
      const sb = order.get(b.id) ?? Infinity;
      if (sa !== sb) return sa - sb;
      if ((b.created ?? 0) !== (a.created ?? 0)) return (b.created ?? 0) - (a.created ?? 0);
      return b.id.localeCompare(a.id, 'en', { numeric: true });
    })
    .map(({ created: _, ...m }) => m);
}

/** Normalizes a provider's model list response. */
export function parseModels(provider: Provider, body: unknown): (ModelInfo & { created?: number })[] {
  const data = ((body as { data?: unknown[] })?.data ?? (body as { models?: unknown[] })?.models ?? []) as Record<string, unknown>[];
  const out: (ModelInfo & { created?: number })[] = [];
  for (const m of data) {
    const rawId = String(m.id ?? m.name ?? '');
    const id = rawId.replace(/^models\//, '');
    if (!id || NOT_CHAT[provider.id]?.test(id)) continue;
    if (provider.id === 'gemini' && !id.startsWith('gemini')) continue;
    if (provider.id === 'openai' && !/^(gpt-|o\d|chatgpt-)/.test(id)) continue;
    if (provider.id === 'openrouter') {
      const params = m.supported_parameters as string[] | undefined;
      if (params && !params.includes('tools')) continue;
    }
    const listPricing = m.pricing as { prompt?: string; completion?: string } | undefined;
    const input = Number(listPricing?.prompt);
    const output = Number(listPricing?.completion);
    const hasListPricing = Number.isFinite(input) && Number.isFinite(output) && listPricing;
    const fallback = provider.pricing?.[id];
    out.push({
      id,
      name: typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' && m.name !== rawId ? m.name : undefined,
      context: typeof m.context_length === 'number' ? m.context_length : typeof m.context_window === 'number' ? m.context_window : undefined,
      pricing: hasListPricing ? { input: input * 1e6, output: output * 1e6 } : fallback ? { input: fallback.input, output: fallback.output } : undefined,
      created: typeof m.created === 'number' ? m.created : typeof m.created_at === 'string' ? Date.parse(m.created_at) / 1000 : undefined,
    });
  }
  return out;
}

/**
 * Model providers: their keys (in the secret store, collected on Sunny's secure pages), key
 * checks and live model lists.
 */
export class Providers {
  private models = new Map<ProviderId, { at: number; list: ModelInfo[] }>();
  /** The Claude subscriptions saved on this server, and which one agents run on. */
  readonly claude = new ClaudeAccounts();

  constructor(
    private readonly secrets: SecretStore,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  list(): Provider[] {
    return PROVIDER_IDS.map((id) => PROVIDERS[id]);
  }

  async credentials(id: ProviderId): Promise<Credentials | undefined> {
    const provider = PROVIDERS[id];
    if (provider.protocol === 'subscription' || provider.protocol === 'responses') return undefined;
    const values = await this.secrets.get(providerSecretId(id));
    if (!values?.api_key) return undefined;
    return { apiKey: values.api_key, baseUrl: values.base_url || provider.baseUrls[0]! };
  }

  async connected(id: ProviderId): Promise<boolean> {
    if (id === 'codex') return codexConnected();
    return PROVIDERS[id].protocol === 'subscription' || (await this.secrets.has(providerSecretId(id)));
  }

  async status(): Promise<ProviderStatus[]> {
    const stored = new Map((await this.secrets.list()).map((s) => [s.id, s]));
    const codex = await codexConnected();
    return this.list().map((p) => {
      const secret = stored.get(providerSecretId(p.id));
      return {
        id: p.id,
        name: p.name,
        family: p.family,
        connected: p.protocol === 'subscription' || (p.id === 'codex' ? codex : !!secret),
        updatedAt: secret?.updatedAt,
        notes: p.notes,
        keyUrl: p.keyUrl,
      };
    });
  }

  /** Tries a key on each of the provider's base URLs; returns the one that took it. */
  async checkKey(id: ProviderId, apiKey: string): Promise<{ baseUrl: string } | { error: string }> {
    const provider = PROVIDERS[id];
    const path = provider.keyCheckPath ?? provider.modelsPath;
    if (!path) return { error: `${provider.name} needs no key.` };
    let last = 'no answer';
    for (const baseUrl of provider.baseUrls) {
      let res: Response;
      try {
        res = await this.doFetch(apiUrl(baseUrl, path), { headers: authHeaders(provider, apiKey), signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        last = `could not reach ${new URL(baseUrl).host}: ${(err as Error).message}`;
        continue;
      }
      if (res.ok) return { baseUrl };
      const text = await res.text().catch(() => '');
      last = res.status === 401 || res.status === 403 ? `${provider.name} rejected this key.` : `${provider.name} said (${res.status}): ${upstreamMessage(text)}`;
    }
    return { error: last };
  }

  /** The provider's models (chat models with tool use), suggested ones first. Cached for an hour. */
  async listModels(id: ProviderId, refresh = false): Promise<ModelInfo[]> {
    const provider = PROVIDERS[id];
    if (provider.protocol === 'subscription') return provider.suggested.map((m) => ({ id: m, suggested: true }));
    if (id === 'codex') {
      const list = (await codexModels()).map((m) => ({ id: m.id, name: m.name, context: m.context, suggested: provider.suggested.includes(m.id) }));
      this.models.set(id, { at: Date.now(), list });
      return list;
    }
    const cached = this.models.get(id);
    if (!refresh && cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.list;
    const creds = await this.credentials(id);
    if (!creds) throw new Error(`${provider.name} is not connected.`);
    const res = await this.doFetch(apiUrl(creds.baseUrl, provider.modelsPath!), { headers: authHeaders(provider, creds.apiKey), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${provider.name} did not list its models (${res.status}): ${upstreamMessage(await res.text().catch(() => ''))}`);
    const list = rankModels(provider, parseModels(provider, await res.json()));
    this.models.set(id, { at: Date.now(), list });
    return list;
  }

  /** A model from the cached list, for its price and context window. */
  cachedModel(id: ProviderId, model: string): ModelInfo | undefined {
    return this.models.get(id)?.list.find((m) => m.id === model);
  }

  /** Models to propose: the suggestions the provider still lists, else its newest. */
  async suggestions(id: ProviderId, limit = 8): Promise<ModelInfo[]> {
    const list = await this.listModels(id);
    const suggested = list.filter((m) => m.suggested);
    return (suggested.length ? suggested : list).slice(0, limit);
  }

  /**
   * The secure page that collects a provider's key. The key is checked against the provider
   * before it is stored, and never shown again.
   */
  keyFlow(id: ProviderId, onSaved?: () => Promise<void> | void): AuthFlow {
    const provider = getProvider(id);
    let baseUrl = provider.baseUrls[0] ?? '';
    return formFlow(this.secrets, {
      title: `Connect ${provider.name}`,
      description: [
        `Your agents can then run on ${provider.family} models. ${provider.keyHelp ?? ''}`,
        'The key is checked with the provider, stored encrypted on your server, and never shown to an agent or in chat.',
        provider.notes ?? '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      links: provider.keyUrl ? [{ label: `Get a ${provider.name} key`, url: provider.keyUrl }] : undefined,
      fields: [{ name: 'api_key', label: 'API key', type: 'password' }],
      secretId: providerSecretId(id),
      label: `${provider.name} API key`,
      validate: async ({ api_key = '' }) => {
        const result = await this.checkKey(id, api_key);
        if ('error' in result) return result.error;
        baseUrl = result.baseUrl;
        return undefined;
      },
      onSaved: async () => {
        // Record which platform took the key (only differs for Kimi).
        if (baseUrl !== provider.baseUrls[0]) await this.secrets.patch(providerSecretId(id), { base_url: baseUrl });
        this.models.delete(id);
        await onSaved?.();
      },
    });
  }

  async disconnect(id: ProviderId): Promise<boolean> {
    this.models.delete(id);
    if (id === 'codex') return false;
    return this.secrets.delete(providerSecretId(id));
  }
}
