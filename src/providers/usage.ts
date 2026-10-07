import { codexAuth } from './codex.ts';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.ts';
import type { UsageRow } from '../runtime/run-log.ts';
import { getProvider, parseModelRef, PROVIDER_IDS, PROVIDERS, type ProviderId } from './catalog.ts';
import type { Credentials, Providers } from './providers.ts';

/**
 * Account-side usage: the Claude subscription's limits (session and weekly windows, the numbers
 * claude.ai and Claude Code's /usage show) and, for API providers, whatever their API tells a
 * normal key: OpenRouter credits and key limits, Kimi balance. OpenAI, Anthropic API and Gemini
 * only expose billing to admin keys, so for them Sunny shows its own count of what runs cost.
 *
 * Keys and the subscription token are used in place and never returned.
 */

export interface LimitWindow {
  /** "session", "weekly_all", "weekly_opus"... */
  kind: string;
  label: string;
  /** 0–100. */
  percent: number;
  resetsAt?: string;
  /** "normal" | "warning" | "critical"... as Anthropic reports it. */
  severity?: string;
}

export interface SubscriptionUsage {
  ok: boolean;
  plan?: string;
  windows: LimitWindow[];
  extraUsage?: { enabled: boolean; usedCredits?: number | null; monthlyLimit?: number | null; currency?: string | null };
  error?: string;
  /** The numbers are from an earlier check: Anthropic refused or failed this time. */
  stale?: boolean;
  checkedAt: string;
}

export interface ProviderAccount {
  id: ProviderId;
  name: string;
  connected: boolean;
  /** What the provider reports: balance, credits, limits. */
  facts: { label: string; value: string }[];
  /** Why there is nothing from the provider itself, or what failed. */
  note?: string;
  error?: string;
}

export interface ProviderSpend {
  provider: ProviderId;
  name: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;

const WINDOW_LABELS: Record<string, string> = {
  session: 'Session (5 h)',
  five_hour: 'Session (5 h)',
  weekly_all: 'Week, all models',
  seven_day: 'Week, all models',
  weekly_opus: 'Week, Opus',
  seven_day_opus: 'Week, Opus',
  weekly_sonnet: 'Week, Sonnet',
  seven_day_sonnet: 'Week, Sonnet',
};

const label = (kind: string) => WINDOW_LABELS[kind] ?? kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Normalises Anthropic's /api/oauth/usage answer (undocumented; read defensively). */
export function parseSubscriptionUsage(data: unknown): LimitWindow[] {
  const d = (data ?? {}) as Record<string, unknown>;
  const out: LimitWindow[] = [];
  if (Array.isArray(d.limits)) {
    for (const l of d.limits as Record<string, unknown>[]) {
      const percent = Number(l.percent);
      if (typeof l.kind !== 'string' || !Number.isFinite(percent)) continue;
      out.push({ kind: l.kind, label: label(l.kind), percent, resetsAt: typeof l.resets_at === 'string' ? l.resets_at : undefined, severity: typeof l.severity === 'string' ? l.severity : undefined });
    }
  }
  if (!out.length) {
    for (const kind of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      const w = d[kind] as { utilization?: number; resets_at?: string } | null | undefined;
      if (w && typeof w.utilization === 'number') out.push({ kind, label: label(kind), percent: w.utilization, resetsAt: w.resets_at });
    }
  }
  return out;
}

export class UsageService {
  private subCache?: { at: number; ttl: number; value: SubscriptionUsage };
  private lastGood?: SubscriptionUsage;
  private accountCache = new Map<ProviderId, { at: number; value: ProviderAccount }>();

  constructor(
    private readonly providers?: Providers,
    private readonly opts: { claudeConfigDir?: string; fetch?: typeof fetch } = {},
  ) {
    // Another Claude account is now in use: its limits are not the cached ones.
    providers?.claude?.onChange(() => this.resetSubscription());
  }

  resetSubscription(): void {
    this.subCache = undefined;
    this.lastGood = undefined;
  }

  private get fetch() {
    return this.opts.fetch ?? globalThis.fetch;
  }

  /** The Claude subscription's limits, from the same endpoint Claude Code's /usage reads. */
  async subscription(force = false): Promise<SubscriptionUsage> {
    // Anthropic rate-limits this endpoint hard: ask rarely, and honour Retry-After.
    // Forced refreshes wait 30 s after a good answer and never skip a backoff after a failure.
    const failed = !!this.subCache && (!this.subCache.value.ok || this.subCache.value.stale);
    if (this.subCache && Date.now() - this.subCache.at < (force && !failed ? 30_000 : this.subCache.ttl)) return this.subCache.value;
    const checkedAt = new Date().toISOString();
    let value: SubscriptionUsage;
    let backoffMs = 0;
    try {
      const dir = this.opts.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
      const creds = JSON.parse(await readFile(join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string } };
      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken) throw new Error('No Claude subscription login on this server.');
      const res = await this.fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'sunny' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401) throw new Error('The subscription login has expired; it renews on the next agent run.');
      if (res.status === 429 || res.status === 403) {
        const wait = Number(res.headers.get('retry-after'));
        backoffMs = Math.max(Number.isFinite(wait) ? wait * 1000 : 0, 2 * 60_000);
        throw new Error(res.status === 429 ? 'Anthropic is limiting how often the usage can be read; it will retry shortly.' : 'Anthropic refused to share the usage for this login; it will retry later.');
      }
      if (!res.ok) throw new Error(`Anthropic answered HTTP ${res.status}.`);
      const data = (await res.json()) as Record<string, unknown>;
      const extra = data.extra_usage as { is_enabled?: boolean; used_credits?: number | null; monthly_limit?: number | null; currency?: string | null } | null | undefined;
      value = {
        ok: true,
        plan: oauth.subscriptionType,
        windows: parseSubscriptionUsage(data),
        extraUsage: extra ? { enabled: !!extra.is_enabled, usedCredits: extra.used_credits, monthlyLimit: extra.monthly_limit, currency: extra.currency } : undefined,
        checkedAt,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn({ err: error }, 'usage: subscription limits unavailable');
      // Keep showing the last numbers we trust, marked as old, rather than an empty badge.
      value = this.lastGood ? { ...this.lastGood, stale: true, error } : { ok: false, windows: [], error, checkedAt };
    }
    if (value.ok && !value.stale) this.lastGood = value;
    // After a failure wait longer before asking again (Anthropic answers 429 when asked too often).
    this.subCache = { at: Date.now(), ttl: value.ok && !value.stale ? 2 * CACHE_MS : Math.max(backoffMs, 2 * CACHE_MS), value };
    return value;
  }

  /** Balance, credits or limits each connected API provider reports to its key. */
  async accounts(force = false): Promise<ProviderAccount[]> {
    const ids = PROVIDER_IDS.filter((id) => PROVIDERS[id].protocol !== 'subscription');
    return Promise.all(ids.map((id) => this.account(id, force)));
  }

  private async account(id: ProviderId, force: boolean): Promise<ProviderAccount> {
    const cached = this.accountCache.get(id);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const base: ProviderAccount = { id, name: PROVIDERS[id].name, connected: false, facts: [] };
    let value: ProviderAccount;
    try {
      if (id === 'codex') {
        const auth = await codexAuth(this.fetch).catch(() => undefined);
        value = auth ? { ...base, connected: true, facts: [{ label: 'Plan', value: auth.plan ?? 'ChatGPT' }], note: 'Uses the account’s Codex allowance; no balance to show.' } : base;
        this.accountCache.set(id, { at: Date.now(), value });
        return value;
      }
      const creds = await this.providers?.credentials(id);
      if (!creds) value = base;
      else value = { ...base, connected: true, ...(await this.query(id, creds)) };
    } catch (err) {
      value = { ...base, connected: true, error: err instanceof Error ? err.message : String(err) };
    }
    this.accountCache.set(id, { at: Date.now(), value });
    return value;
  }

  private async json(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private async query(id: ProviderId, creds: Credentials): Promise<Pick<ProviderAccount, 'facts' | 'note'>> {
    const bearer = { authorization: `Bearer ${creds.apiKey}` };
    if (id === 'openrouter') {
      const facts: ProviderAccount['facts'] = [];
      const credits = (await this.json('https://openrouter.ai/api/v1/credits', bearer).catch(() => null))?.data as { total_credits?: number; total_usage?: number } | undefined;
      if (credits && typeof credits.total_credits === 'number') {
        facts.push({ label: 'Credits left', value: usd(credits.total_credits - (credits.total_usage ?? 0)) });
        facts.push({ label: 'Bought / used', value: `${usd(credits.total_credits)} / ${usd(credits.total_usage ?? 0)}` });
      }
      const key = (await this.json('https://openrouter.ai/api/v1/key', bearer)).data as { usage?: number; limit?: number | null; limit_remaining?: number | null; usage_daily?: number; usage_weekly?: number; usage_monthly?: number; is_free_tier?: boolean };
      if (typeof key.usage_daily === 'number') facts.push({ label: 'Key: today / week / month', value: `${usd(key.usage_daily)} / ${usd(key.usage_weekly ?? 0)} / ${usd(key.usage_monthly ?? 0)}` });
      if (key.limit != null) facts.push({ label: 'Key limit left', value: `${usd(key.limit_remaining ?? 0)} of ${usd(key.limit)}` });
      if (key.is_free_tier) facts.push({ label: 'Tier', value: 'free' });
      return { facts };
    }
    if (id === 'kimi') {
      const origin = new URL(creds.baseUrl).origin;
      const data = (await this.json(`${origin}/v1/users/me/balance`, bearer)).data as { available_balance?: number; voucher_balance?: number; cash_balance?: number };
      const cur = origin.endsWith('.cn') ? '¥' : '$';
      const facts = [{ label: 'Available balance', value: `${cur}${(data.available_balance ?? 0).toFixed(2)}` }];
      if (data.voucher_balance) facts.push({ label: 'Vouchers / cash', value: `${cur}${data.voucher_balance.toFixed(2)} / ${cur}${(data.cash_balance ?? 0).toFixed(2)}` });
      return { facts };
    }
    const where: Partial<Record<ProviderId, string>> = {
      openai: 'platform.openai.com/usage',
      anthropic: 'console.anthropic.com/usage',
      gemini: 'aistudio.google.com/usage',
    };
    return { facts: [], note: `Billing isn't readable with a normal API key; see ${where[id] ?? getProvider(id).keyUrl ?? 'the provider dashboard'}. Sunny's own count is below.` };
  }
}

/** Sunny's own spend per provider, from the run log (subscription costs are API-equivalent). */
export function spendByProvider(rows: UsageRow[]): ProviderSpend[] {
  const map = new Map<ProviderId, ProviderSpend>();
  for (const r of rows) {
    const provider = r.model ? parseModelRef(r.model).provider : 'claude';
    const s = map.get(provider) ?? { provider, name: PROVIDERS[provider].name, runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    s.runs += r.runs;
    s.costUsd += r.costUsd;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    map.set(provider, s);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
}

function usd(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}$${abs.toFixed(abs !== 0 && abs < 1 ? 3 : 2)}`;
}
