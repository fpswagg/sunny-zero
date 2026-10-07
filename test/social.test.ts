import { describe, expect, it } from 'vitest';
import { ApiError, RestClient, WriteBudget } from '../src/connectors/shared.ts';
import { xConnector, explainX } from '../src/connectors/x/index.ts';
import { instagramConnector } from '../src/connectors/instagram/index.ts';
import { tiktokConnector } from '../src/connectors/tiktok/index.ts';
import { letterboxdConnector, signRequest, ratingSchema } from '../src/connectors/letterboxd/index.ts';
import { telegramUserConnector, explainTelegram } from '../src/connectors/telegram-user/index.ts';

const secrets = (v: Record<string, string> | null = null) => ({ get: async () => v ?? undefined, has: async () => Boolean(v), set: async () => {}, patch: async () => {} }) as never;
const json = (status: number, body: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...h } });

describe('shared', () => {
  it('retries 429 honouring Retry-After', async () => {
    const rs = [json(429, {}, { 'retry-after': '2' }), json(200, { a: 1 })];
    const sleeps: number[] = [];
    const c = new RestClient({ baseUrl: 'https://x.test', minGapMs: 0, service: 't', explain: (e) => String(e), doFetch: (async () => rs.shift()!) as never, sleep: async (ms) => void sleeps.push(ms) });
    expect(await c.request({ method: 'GET', path: '/a', what: 'a' })).toEqual({ a: 1 });
    expect(sleeps.some((s) => s >= 2000)).toBe(true);
  });
  it('write budget runs out', () => {
    const b = new WriteBudget(2, 1000);
    b.take('x');
    b.take('x');
    expect(() => b.take('x')).toThrow();
  });
});

describe('connectors', () => {
  it('shape: only the right tools ask', () => {
    const s = secrets();
    expect(instagramConnector({ secrets: s }).mutatingTools ?? []).toEqual([]);
    expect(tiktokConnector({ secrets: s }).mutatingTools ?? []).toEqual([]);
    expect(xConnector({ secrets: s }).mutatingTools).toEqual(expect.arrayContaining(['post', 'retweet', 'like', 'delete_post']));
    expect(letterboxdConnector({ secrets: s }).mutatingTools).toEqual(expect.arrayContaining(['rate', 'review', 'delete_review']));
    expect(telegramUserConnector({ secrets: s }).mutatingTools).toEqual(['send', 'edit', 'delete']);
  });
  it('status reflects missing credentials', async () => {
    for (const c of [xConnector({ secrets: secrets() }), instagramConnector({ secrets: secrets() }), tiktokConnector({ secrets: secrets() }), letterboxdConnector({ secrets: secrets() }), telegramUserConnector({ secrets: secrets() })])
      expect((await c.status()).ready).toBe(false);
  });
  it('explains errors', () => {
    expect(explainTelegram(new Error('A wait of 30 seconds is required'))).toContain('30');
    expect(explainTelegram(new Error('PHONE_CODE_INVALID'))).toContain('wrong');
    expect(typeof explainX(429, {}, 'post')).toBe('string');
  });
  it('letterboxd signing is deterministic and ratings are half steps', () => {
    expect(signRequest('s', 'GET', 'https://a/b', '')).toBe(signRequest('s', 'GET', 'https://a/b', ''));
    expect(signRequest('s', 'GET', 'https://a/b', '')).not.toBe(signRequest('t', 'GET', 'https://a/b', ''));
    expect(ratingSchema.safeParse(3.5).success).toBe(true);
    expect(ratingSchema.safeParse(3.3).success).toBe(false);
  });
  it('telegram login: code, 2FA, session stored', async () => {
    const saved: unknown[] = [];
    const st = { get: async () => undefined, has: async () => false, set: async (_i: string, v: unknown) => void saved.push(v) } as never;
    const auth = { sendCode: async () => {}, signIn: async () => 'password' as const, password: async () => {}, session: () => 'SESSION', close: async () => {} };
    const flow = await telegramUserConnector({ secrets: st, makeAuth: () => auth }).setup!();
    const ctx = { token: 't', oauthRedirectUri: 'https://x/cb' };
    await flow.start(ctx);
    expect((await flow.submit({ api_id: '1', api_hash: 'h', phone: '+1' }, ctx)) as { fields: { name: string }[] }).toMatchObject({ fields: [{ name: 'code' }] });
    expect(await flow.submit({ code: '1' }, ctx)).toMatchObject({ fields: [{ name: 'password' }] });
    expect(await flow.submit({ password: 'p' }, ctx)).toMatchObject({ kind: 'done' });
    expect(saved[0]).toMatchObject({ session: 'SESSION' });
  });
});
