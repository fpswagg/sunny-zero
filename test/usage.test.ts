import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseSubscriptionUsage, spendByProvider, UsageService } from '../src/providers/usage.ts';
import type { Providers } from '../src/providers/providers.ts';

const row = (model: string | null, cost: number, runs = 1) => ({ agent: 'a', model, runs, errors: 0, costUsd: cost, inputTokens: 10, outputTokens: 5, lastAt: new Date() });

describe('usage', () => {
  it('reads the limits array, else the five_hour / seven_day windows', () => {
    expect(parseSubscriptionUsage({ limits: [{ kind: 'session', percent: 13, resets_at: 'x', severity: 'normal' }, { kind: 'weekly_all', percent: 59 }] })).toEqual([
      { kind: 'session', label: 'Session (5 h)', percent: 13, resetsAt: 'x', severity: 'normal' },
      { kind: 'weekly_all', label: 'Week, all models', percent: 59, resetsAt: undefined, severity: undefined },
    ]);
    expect(parseSubscriptionUsage({ five_hour: { utilization: 20, resets_at: 'r' }, seven_day: null, seven_day_opus: { utilization: 5 } }).map((w) => [w.kind, w.percent])).toEqual([
      ['five_hour', 20],
      ['seven_day_opus', 5],
    ]);
    expect(parseSubscriptionUsage(null)).toEqual([]);
  });

  it('groups Sunny spend by provider', () => {
    const s = spendByProvider([row(null, 1), row('claude-opus-5-5', 2), row('openai:gpt-5', 0.5, 3), row('kimi:k2', 0.1)]);
    expect(s.map((p) => [p.provider, p.runs, p.costUsd])).toEqual([
      ['claude', 2, 3],
      ['openai', 3, 0.5],
      ['kimi', 1, 0.1],
    ]);
  });

  it('reads the subscription limits with the local login, without leaking the token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-'));
    await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'pro' } }));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ limits: [{ kind: 'session', percent: 40 }], extra_usage: { is_enabled: false } })));
    const u = new UsageService(undefined, { claudeConfigDir: dir, fetch: fetch as unknown as typeof globalThis.fetch });
    const sub = await u.subscription();
    expect(sub).toMatchObject({ ok: true, plan: 'pro', windows: [{ kind: 'session', percent: 40 }], extraUsage: { enabled: false } });
    expect(JSON.stringify(sub)).not.toContain('tok');
    await u.subscription();
    expect(fetch).toHaveBeenCalledTimes(1); // cached
    const missing = await new UsageService(undefined, { claudeConfigDir: join(dir, 'nope') }).subscription();
    expect(missing.ok).toBe(false);
  });

  it('reads OpenRouter credits and Kimi balance; notes the others', async () => {
    const providers = { credentials: async (id: string) => (['openrouter', 'kimi', 'openai'].includes(id) ? { apiKey: 'k', baseUrl: id === 'kimi' ? 'https://api.moonshot.ai/anthropic' : 'x' } : undefined) } as unknown as Providers;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/credits')) return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 2.5 } }));
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: { usage_daily: 0.1, usage_weekly: 1, usage_monthly: 2, limit: null } }));
      if (url === 'https://api.moonshot.ai/v1/users/me/balance') return new Response(JSON.stringify({ data: { available_balance: 8.62 } }));
      return new Response('', { status: 404 });
    });
    const accounts = await new UsageService(providers, { fetch: fetch as unknown as typeof globalThis.fetch }).accounts();
    const by = Object.fromEntries(accounts.map((a) => [a.id, a]));
    expect(by.openrouter!.facts[0]).toEqual({ label: 'Credits left', value: '$7.50' });
    expect(by.kimi!.facts[0]).toEqual({ label: 'Available balance', value: '$8.62' });
    expect(by.openai!.note).toMatch(/platform\.openai\.com/);
    expect(by.gemini!.connected).toBe(false);
  });
});
