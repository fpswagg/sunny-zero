import { formatModelRef, getProvider, type Effort, type Provider } from './catalog.ts';
import type { Providers } from './providers.ts';
import type { Lease, LlmProxy } from './proxy.ts';

export interface ModelChoice {
  name: string;
  provider?: string;
  model?: string;
  effort?: Effort;
}

/** How one run reaches its model: the CLI's model and effort, its environment, and the proxy lease to release after. */
export interface ModelRoute {
  provider: Provider;
  model: string;
  effort?: Effort;
  env: Record<string, string | undefined>;
  lease?: Lease;
}

export interface RouteDeps {
  providers?: Providers;
  proxy?: LlmProxy;
  /** Claude model for agents that name none. */
  defaultModel: string;
}

/** Claude Code's model tiers; a third-party model stands in for all of them. */
const TIER_VARS = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

/**
 * Picks the model route for a run. The subscription runs as before. Any other provider gets a
 * proxy lease: the CLI calls Sunny's local proxy with a token that only lives for this run,
 * and never sees the provider's key or the subscription login.
 */
export async function routeModel(choice: ModelChoice, baseEnv: Record<string, string | undefined>, deps: RouteDeps): Promise<ModelRoute> {
  const provider = getProvider(choice.provider);
  if (provider.protocol === 'subscription') return { provider, model: choice.model ?? deps.defaultModel, effort: choice.effort, env: baseEnv };

  const ref = formatModelRef(provider.id, choice.model, '?');
  if (!choice.model) throw new Error(`${choice.name} is set to ${provider.name} but has no model. Pick one with /model ${choice.name}.`);
  if (!deps.proxy || !deps.providers) throw new Error(`${provider.name} models are not available in this daemon.`);
  if (!(await deps.providers.connected(provider.id))) {
    throw new Error(`${choice.name} runs on ${ref}, but ${provider.name} is not connected. Ask Sunny to connect it (/connect ${provider.id}), or switch the model (/model ${choice.name}).`);
  }
  const info = deps.providers.cachedModel(provider.id, choice.model);
  const lease = deps.proxy.lease(provider, choice.model, choice.effort, choice.name, info?.pricing);

  const env: Record<string, string | undefined> = { ...baseEnv };
  // The subscription login must not go to a third party, and an inherited API key must not win over the lease.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.ANTHROPIC_API_KEY = '';
  env.ANTHROPIC_BASE_URL = deps.proxy.localUrl;
  env.ANTHROPIC_AUTH_TOKEN = lease.token;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (provider.forceModel) {
    for (const v of TIER_VARS) env[v] = choice.model;
    // Claude Code only sends effort for models it knows; this makes it send it for any.
    if (choice.effort) env.CLAUDE_CODE_EFFORT_LEVEL = choice.effort;
    const context = info?.context ?? provider.contextWindow;
    if (context) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(context);
  }
  return { provider, model: choice.model, effort: choice.effort, env, lease };
}
