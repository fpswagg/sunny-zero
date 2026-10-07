import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/db.ts';
import { importLegacyFiles } from '../src/db/import-files.ts';
import { ConversationStore } from '../src/gateway/conversations.ts';
import { RunLog } from '../src/runtime/run-log.ts';
import { SessionStore } from '../src/runtime/sessions.ts';
import { SecretStore } from '../src/secrets/store.ts';
import { UserStore } from '../src/users/users.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
beforeEach(() => db.reset());
afterAll(() => db.drop());

describe('migrate', () => {
  it('is idempotent', async () => {
    expect(await migrate(db.sql)).toBe(0);
  });

  it('moves Telegram owners to users and renames Telegram conversations (migration 2)', async () => {
    const old = await testDb(1);
    try {
      await old.sql`insert into telegram_owners (id, name, username) values (748631404, 'PF', 'pf')`;
      await old.sql`insert into conversations (id, agent) values ('telegram:748631404', 'helper'), ('cli:default', 'sunny')`;
      await old.sql`insert into sessions (key, session_id, cwd) values ('sunny::telegram:748631404', 's1', '/w'), ('sunny::cli:default', 's2', '/w')`;
      await old.sql`insert into notifications (agent, conversation, silent, delivered, text) values ('a', 'cli:x', false, ${['telegram:748631404', 'cli:x']}, 't')`;
      expect(await migrate(old.sql, 2)).toBe(1);
      expect(await old.sql`select id, role from users`).toEqual([{ id: 'owner', role: 'owner' }]);
      expect(await old.sql`select external_id, user_id, label from identities`).toEqual([{ external_id: '748631404', user_id: 'owner', label: 'PF (@pf)' }]);
      expect(await old.sql`select bot, chat_id from telegram_chats`).toEqual([{ bot: 'sunny', chat_id: 748631404 }]);
      expect((await old.sql`select id from conversations order by id`).map((r) => r.id)).toEqual(['cli:default', 'telegram:sunny:748631404']);
      expect((await old.sql`select key from sessions order by key`).map((r) => r.key)).toEqual(['sunny::cli:default', 'sunny::telegram:sunny:748631404']);
      expect(await old.sql`select delivered from notifications`).toEqual([{ delivered: ['telegram:sunny:748631404', 'cli:x'] }]);
    } finally {
      await old.drop();
    }
  });
});

describe('SessionStore', () => {
  it('stores per key and working directory, and forgets an agent', async () => {
    const s = new SessionStore(db.sql);
    await s.set('helper::cli:a', 'sess-1', '/w');
    await s.set('helper::cli:a', 'sess-2', '/w');
    await s.set('helper::*', 'sess-3', '/w');
    await s.set('helper-two::cli:a', 'sess-4', '/w');
    expect(await s.get('helper::cli:a', '/w')).toBe('sess-2');
    expect(await s.get('helper::cli:a', '/elsewhere')).toBeUndefined();
    await s.clearAgent('helper');
    expect(await s.get('helper::*', '/w')).toBeUndefined();
    expect(await s.get('helper-two::cli:a', '/w')).toBe('sess-4');
  });
});

describe('ConversationStore', () => {
  it('remembers the current agent', async () => {
    const c = new ConversationStore(db.sql);
    expect(await c.agent('cli:x')).toBeUndefined();
    await c.setAgent('cli:x', 'helper');
    await c.setAgent('cli:x', 'other');
    expect(await c.agent('cli:x')).toBe('other');
  });
});

describe('RunLog', () => {
  it('returns the latest runs of an agent, oldest first', async () => {
    const runs = new RunLog(db.sql);
    for (const i of [1, 2, 3]) await runs.append({ agent: 'a', conversation: 'cli:x', origin: 'message', message: `m${i}`, reply: 'r', isError: false, durationMs: 1.6 });
    await runs.append({ agent: 'b', conversation: 'cli:x', origin: 'sunny', message: 'other', reply: 'r', isError: true, durationMs: 1 });
    const recent = await runs.recent('a', 2);
    expect(recent.map((r) => r.message)).toEqual(['m2', 'm3']);
    expect(recent[0]).toMatchObject({ durationMs: 2, isError: false, costUsd: undefined });
  });
});

describe('importLegacyFiles', () => {
  it('imports the old data/ files once and renames them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sunny-import-'));
    const keyDir = mkdtempSync(join(tmpdir(), 'sunny-key-'));
    // A secret written the old way: same encryption, so it is copied as is.
    const writer = new SecretStore(db.sql, keyDir);
    await writer.set('telegram:bot', { token: 't0ken' }, { kind: 'form', label: 'Telegram bot' });
    const [row] = await db.sql`select * from secrets`;
    await db.reset();
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ 'telegram:bot': { id: 'telegram:bot', kind: 'form', label: 'Telegram bot', fields: ['token'], iv: row!.iv, tag: row!.tag, data: row!.data, createdAt: '2026-10-03T12:13:00.000Z', updatedAt: '2026-10-03T12:13:00.000Z' } }));
    writeFileSync(join(dir, 'telegram.json'), JSON.stringify({ owners: [{ id: 5551234567, name: 'Ada', username: 'ada', pairedAt: '2026-10-03T12:14:00.000Z' }] }));
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ 'sunny::cli:default': { sessionId: 's1', cwd: '/a', updatedAt: '2026-10-03T12:00:00.000Z' } }));
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify({ 'cli:default': { agent: 'helper' } }));
    mkdirSync(join(dir, 'runs'));
    writeFileSync(join(dir, 'runs', 'helper.jsonl'), JSON.stringify({ at: '2026-10-03T12:00:00.000Z', agent: 'helper', conversation: 'cli:default', origin: 'message', message: 'hi', reply: 'yo', isError: false, durationMs: 10 }) + '\n');
    writeFileSync(join(dir, 'notifications.jsonl'), JSON.stringify({ at: '2026-10-03T12:00:00.000Z', agent: 'pinger', conversation: 'cli:t2', silent: false, delivered: ['cli:t2'], text: 'done' }) + '\n');

    await importLegacyFiles(db.sql, dir);

    expect(await new SecretStore(db.sql, keyDir).get('telegram:bot')).toEqual({ token: 't0ken' });
    expect(await new UserStore(db.sql).byIdentity('telegram', '5551234567')).toMatchObject({ id: 'owner', role: 'owner' });
    expect(await db.sql`select bot, chat_id from telegram_chats`).toEqual([{ bot: 'sunny', chat_id: 5551234567 }]);
    expect(await new SessionStore(db.sql).get('sunny::cli:default', '/a')).toBe('s1');
    expect(await new ConversationStore(db.sql).agent('cli:default')).toBe('helper');
    expect(await new RunLog(db.sql).recent('helper', 5)).toHaveLength(1);
    expect(await db.sql`select text, delivered from notifications`).toEqual([{ text: 'done', delivered: ['cli:t2'] }]);
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
    expect(existsSync(join(dir, 'secrets.json.imported'))).toBe(true);
    expect(existsSync(join(dir, 'runs', 'helper.jsonl.imported'))).toBe(true);

    // A second start finds nothing left to import.
    await importLegacyFiles(db.sql, dir);
    expect(await new RunLog(db.sql).recent('helper', 5)).toHaveLength(1);
  });
});
