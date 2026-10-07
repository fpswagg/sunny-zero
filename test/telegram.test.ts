import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Invites } from '../src/users/invites.ts';
import { SYSTEM, UserStore } from '../src/users/users.ts';
import { checkBotToken } from '../src/telegram/setup.ts';
import { resolveTargets } from '../src/gateway/types.ts';
import { RateLimiter } from '../src/util/rate-limit.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
beforeEach(() => db.reset());
afterAll(() => db.drop());

describe('Invites', () => {
  it('links once, on the bot it was made for', () => {
    const invites = new Invites(60_000);
    const { code } = invites.create('alice', 'watcher');
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(invites.redeem(code, 'sunny', 'telegram:1')).toEqual({ ok: false, reason: 'invalid' });
    expect(invites.redeem(code.toLowerCase(), 'watcher', 'telegram:1')).toMatchObject({ ok: true, invite: { userId: 'alice', bot: 'watcher' } });
    expect(invites.redeem(code, 'watcher', 'telegram:2')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('expires codes and blocks repeated guessing', () => {
    const invites = new Invites(60_000);
    const { code, expiresAt } = invites.create('owner', 'sunny', 1_000);
    expect(invites.redeem(code, 'sunny', 'telegram:1', expiresAt + 1)).toEqual({ ok: false, reason: 'invalid' });
    const fresh = invites.create('owner', 'sunny');
    for (let i = 0; i < 5; i++) expect(invites.redeem('WRONGONE', 'sunny', 'telegram:9').ok).toBe(false);
    expect(invites.redeem(fresh.code, 'sunny', 'telegram:9')).toEqual({ ok: false, reason: 'blocked' });
    expect(invites.redeem(fresh.code, 'sunny', 'telegram:8').ok).toBe(true);
  });
});

describe('UserStore', () => {
  it('links accounts, grants agents and answers who may use what', async () => {
    const users = new UserStore(db.sql);
    const owner = await users.owner();
    expect(owner.role).toBe('owner');
    const alice = await users.create('alice', 'Alice');
    await expect(users.create('alice', 'Again')).rejects.toThrow(/exists/);
    await expect(users.create('Bad Id', 'x')).rejects.toThrow();

    expect(await users.addIdentity('alice', { channel: 'telegram', externalId: '42', label: 'Alice' })).toBe('added');
    // An account already linked stays with its user.
    expect(await users.addIdentity('owner', { channel: 'telegram', externalId: '42' })).toBe('exists');
    expect(await users.byIdentity('telegram', '42')).toMatchObject({ id: 'alice', role: 'member' });

    expect(await users.canUse(alice, 'watcher')).toBe(false);
    await users.grant('alice', 'watcher');
    expect(await users.canUse(alice, 'watcher')).toBe(true);
    expect(await users.canUse(alice, 'sunny')).toBe(false);
    expect(await users.canUse(owner, 'anything')).toBe(true);
    expect(await users.canUse(SYSTEM, 'anything')).toBe(true);

    const listed = await users.list();
    expect(listed.find((u) => u.id === 'alice')).toMatchObject({ agents: ['watcher'], identities: [{ externalId: '42' }] });

    await users.revokeAgent('watcher');
    expect(await users.agentsOf('alice')).toEqual([]);
    await expect(users.remove('owner')).rejects.toThrow();
    expect(await users.remove('alice')).toBe(true);
    expect(await users.byIdentity('telegram', '42')).toBeUndefined();
  });
});

describe('resolveTargets', () => {
  const homes = new Map([
    ['telegram', ['telegram:42']],
    ['cli', ['cli:default']],
    ['web', []],
  ]);

  it('defaults to Telegram', () => {
    expect(resolveTargets([], homes)).toEqual(['telegram:42']);
  });

  it('falls back to every open chat when Telegram reaches nobody', () => {
    expect(resolveTargets([], new Map([['telegram', []], ['cli', ['cli:a', 'cli:b']]]))).toEqual(['cli:a', 'cli:b']);
  });

  it('takes channel names and exact conversations, but only known homes', () => {
    expect(resolveTargets(['cli', 'telegram:42'], homes)).toEqual(['cli:default', 'telegram:42']);
    expect(resolveTargets(['telegram:999', 'web'], homes)).toEqual([]);
  });
});

describe('RateLimiter', () => {
  it('enforces every window', () => {
    const limiter = new RateLimiter([
      { windowMs: 1000, max: 2 },
      { windowMs: 10_000, max: 3 },
    ]);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('a', 2)).toBe(false);
    expect(limiter.take('b', 2)).toBe(true);
    expect(limiter.take('a', 1500)).toBe(true);
    expect(limiter.take('a', 2600)).toBe(false); // 3 in the last 10s
    expect(limiter.take('a', 10_001)).toBe(true);
  });
});

describe('checkBotToken', () => {
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  const reply = (status: number, body: object) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('returns the bot username', async () => {
    expect(await checkBotToken(token, reply(200, { ok: true, result: { id: 77, is_bot: true, username: 'sunny_bot' } }))).toEqual({ username: 'sunny_bot', id: 77 });
  });

  it('explains rejected and malformed tokens without echoing them', async () => {
    const rejected = await checkBotToken(token, reply(401, { ok: false, description: 'Unauthorized' }));
    expect(rejected).toEqual({ error: expect.stringContaining('rejected') });
    const malformed = await checkBotToken('hello', reply(200, {}));
    expect(JSON.stringify(malformed)).not.toContain('hello');
  });
});
