/**
 * Model providers an agent can run on. Every run still goes through Claude Code (tools,
 * permissions, sessions); only the model behind it changes:
 * - claude: the Claude subscription logged in on this machine (the default).
 * - anthropic: the Claude API, billed to an API key.
 * - kimi, openrouter: speak Anthropic's Messages API themselves; Sunny's proxy only swaps the key.
 * - openai, gemini: speak OpenAI's Chat Completions; Sunny's proxy translates.
 * Keys never reach an agent: its CLI talks to the local proxy with a token that only lives for one run.
 */

export const PROVIDER_IDS = ['claude', 'anthropic', 'openai', 'codex', 'gemini', 'kimi', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Provider {
  id: ProviderId;
  /** "OpenAI" */
  name: string;
  /** What people call its models: "GPT", "Gemini". */
  family: string;
  protocol: 'subscription' | 'anthropic' | 'openai' | 'responses';
  /** Upstream API root. Anthropic protocol: without /v1. OpenAI protocol: including the version path. */
  baseUrls: string[];
  auth: 'none' | 'x-api-key' | 'bearer';
  /** Where to create a key, and one line on how. */
  keyUrl?: string;
  keyHelp?: string;
  /** Lists models: relative to the base URL, or absolute. */
  modelsPath?: string;
  /** Checks a key (a cheap authenticated GET); defaults to modelsPath. */
  keyCheckPath?: string;
  /** Proposed when picking a model, in order. Only those the provider still lists are shown (except Claude's aliases). */
  suggested: string[];
  /** Cheap, fast model used for spoken turns (voice messages and calls) so they do not burn the main model's budget. */
  lightModel?: string;
  /** Whether Sunny's proxy forces every request to the agent's model (third-party models do not know Claude's names). */
  forceModel: boolean;
  /** How effort reaches the model: Claude Code's own (Claude models), `output_config.effort` injected, or OpenAI's reasoning_effort. */
  effort: 'native' | 'output_config' | 'reasoning_effort';
  /** Largest output a request may ask for, when the provider caps it below Claude Code's default. */
  maxOutput?: number;
  /** Context window Claude Code compacts at, when known. */
  contextWindow?: number;
  /** Fallback pricing per model in USD per million tokens, used when the provider's /models endpoint does not list it. */
  pricing?: Record<string, { input: number; output: number }>;
  /** Shown in the app and to Sunny. */
  notes?: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  claude: {
    id: 'claude',
    lightModel: 'haiku',
    name: 'Claude subscription',
    family: 'Claude',
    protocol: 'subscription',
    baseUrls: [],
    auth: 'none',
    suggested: ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
    forceModel: false,
    effort: 'native',
    notes: 'The `claude` login on this server. Aliases (opus, sonnet, haiku, fable) follow the latest version.',
  },
  anthropic: {
    id: 'anthropic',
    lightModel: 'claude-haiku-4-5-20251001',
    name: 'Claude API',
    family: 'Claude',
    protocol: 'anthropic',
    baseUrls: ['https://api.anthropic.com'],
    auth: 'x-api-key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHelp: 'In the Anthropic Console, open API keys and create a key (starts with sk-ant-).',
    modelsPath: '/v1/models?limit=100',
    suggested: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
    forceModel: false,
    effort: 'native',
    notes: 'Claude models billed per token to an API key, instead of the subscription.',
  },
  openai: {
    id: 'openai',
    lightModel: 'gpt-5-mini',
    name: 'OpenAI',
    family: 'GPT',
    protocol: 'openai',
    baseUrls: ['https://api.openai.com/v1'],
    auth: 'bearer',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHelp: 'In the OpenAI platform, open API keys and create a secret key (starts with sk-).',
    modelsPath: '/models',
    suggested: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5', 'gpt-5-mini'],
    forceModel: true,
    effort: 'reasoning_effort',
    notes: 'Translated by Sunny. WebSearch is a Claude-only tool and is not available on GPT.',
  },
  codex: {
    id: 'codex',
    name: 'ChatGPT (Codex)',
    family: 'GPT',
    // Not a key: the Codex CLI's ChatGPT sign-in on this machine, spoken to in the Responses API.
    protocol: 'responses',
    baseUrls: ['https://chatgpt.com/backend-api/codex'],
    auth: 'none',
    suggested: ['gpt-5.6-terra', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5'],
    lightModel: 'gpt-5.6-luna',
    forceModel: true,
    effort: 'reasoning_effort',
    contextWindow: 272_000,
    notes: 'Runs on your ChatGPT account through the Codex sign-in (its own allowance, no API key). Translated by Sunny; WebSearch is a Claude-only tool.',
  },
  gemini: {
    id: 'gemini',
    lightModel: 'gemini-3.5-flash-lite',
    name: 'Google Gemini',
    family: 'Gemini',
    protocol: 'openai',
    baseUrls: ['https://generativelanguage.googleapis.com/v1beta/openai'],
    auth: 'bearer',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHelp: 'In Google AI Studio, open "Get API key" and create a key.',
    modelsPath: '/models',
    suggested: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    forceModel: true,
    effort: 'reasoning_effort',
    maxOutput: 65_536,
    contextWindow: 1_048_576,
    notes: 'Translated by Sunny. WebSearch is a Claude-only tool and is not available on Gemini.',
  },
  kimi: {
    id: 'kimi',
    lightModel: 'kimi-k2-turbo-preview',
    name: 'Moonshot Kimi',
    family: 'Kimi',
    protocol: 'anthropic',
    // International platform first; keys from the Chinese platform work on the second.
    baseUrls: ['https://api.moonshot.ai/anthropic', 'https://api.moonshot.cn/anthropic'],
    auth: 'bearer',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    keyHelp: 'On the Moonshot platform, open API Keys and create a key.',
    // Model list and key check live on the OpenAI-style API next to the Anthropic one.
    modelsPath: '../v1/models',
    suggested: ['kimi-k3', 'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-turbo-preview'],
    forceModel: true,
    effort: 'output_config',
    // USD per million tokens. Kimi's /v1/models does not expose pricing, so we keep a fallback table.
    pricing: {
      'kimi-k3': { input: 3.0, output: 15.0 },
      'kimi-k2.7-code': { input: 0.95, output: 4.0 },
      'kimi-k2.7-code-highspeed': { input: 1.9, output: 8.0 },
      'kimi-k2.6': { input: 0.95, output: 4.0 },
      'kimi-k2.5': { input: 0.6, output: 3.0 },
      'kimi-k2': { input: 0.6, output: 2.5 },
    },
    notes: 'Kimi speaks Claude Code’s protocol natively.',
  },
  openrouter: {
    id: 'openrouter',
    lightModel: 'google/gemini-3.5-flash-lite',
    name: 'OpenRouter',
    family: 'OpenRouter',
    protocol: 'anthropic',
    baseUrls: ['https://openrouter.ai/api'],
    auth: 'bearer',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHelp: 'On OpenRouter, open Settings → API Keys and create a key (starts with sk-or-).',
    modelsPath: '/v1/models',
    keyCheckPath: '/v1/key',
    suggested: ['moonshotai/kimi-k3', 'google/gemini-3.8-flash', 'openai/gpt-5.5', 'deepseek/deepseek-v4', 'qwen/qwen3-coder', 'z-ai/glm-5', 'x-ai/grok-5'],
    forceModel: true,
    effort: 'output_config',
    notes: 'Hundreds of models behind one key, through OpenRouter’s Anthropic-compatible API. Only models with tool use are listed.',
  },
};

export const providerSecretId = (id: ProviderId) => `provider:${id}`;

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export function getProvider(id: string | undefined): Provider {
  return PROVIDERS[id && isProviderId(id) ? id : 'claude'];
}

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

/**
 * Reads "provider:model" ("openai:gpt-5.5", "openrouter:deepseek/deepseek-r1:free") or a bare
 * Claude model ("opus"). The prefix only counts when it names a provider, so model ids that
 * contain colons stay whole.
 */
export function parseModelRef(ref: string): ModelRef {
  const s = ref.trim();
  const i = s.indexOf(':');
  if (i > 0) {
    const prefix = s.slice(0, i).toLowerCase();
    if (isProviderId(prefix)) return { provider: prefix, model: s.slice(i + 1).trim() };
  }
  return { provider: 'claude', model: s };
}

/** "openai:gpt-5.5", or the bare model for the subscription. */
export function formatModelRef(provider: string | undefined, model: string | undefined, fallback = 'default'): string {
  const p = getProvider(provider);
  const m = model ?? fallback;
  return p.id === 'claude' ? m : `${p.id}:${m}`;
}

/** The bare id sent upstream: Claude Code's "[1m]" context suffix is a client-side alias. */
export const upstreamModel = (model: string) => model.replace(/\[\w+\]$/, '');

/**
 * reasoning_effort values to try for an effort, best first. Providers accept different sets
 * (Gemini 3 previews refused "medium", older GPTs know no "xhigh"); the proxy walks the list
 * when one is refused and remembers what worked.
 */
export function reasoningEffortCandidates(effort: Effort): string[] {
  switch (effort) {
    case 'max':
      return ['max', 'xhigh', 'high'];
    case 'xhigh':
      return ['xhigh', 'high'];
    case 'high':
      return ['high'];
    case 'medium':
      return ['medium', 'high', 'low'];
    case 'low':
      return ['low', 'minimal'];
  }
}

/** Effort implied by a Claude `thinking` budget, for requests that carry one but no effort. */
export function effortFromBudget(budget: number | undefined): Effort | undefined {
  if (!budget) return undefined;
  if (budget < 4_000) return 'low';
  if (budget < 16_000) return 'medium';
  return 'high';
}
