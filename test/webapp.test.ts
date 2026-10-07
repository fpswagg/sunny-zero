import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { speakable } from '../src/media/tts.ts';
import { WebSessions } from '../src/webapp/sessions.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
afterAll(() => db.drop());

describe('web sessions', () => {
  it('creates, verifies and revokes a browser session (hash only in the database)', async () => {
    const s = new WebSessions(db.sql);
    const token = await s.create('owner', 'test-agent');
    expect(await s.verify(token)).toBe('owner');
    const [row] = await db.sql<{ token_hash: string }[]>`select token_hash from web_sessions`;
    expect(row!.token_hash).not.toContain(token);
    expect(await s.verify('x'.repeat(43))).toBeUndefined();
    expect(await s.verify(undefined)).toBeUndefined();
    await s.revoke(token);
    expect(await s.verify(token)).toBeUndefined();
  });

  it('expired sessions do not sign in', async () => {
    const s = new WebSessions(db.sql, -1000);
    expect(await s.verify(await s.create('owner'))).toBeUndefined();
  });

  it('sign-in links work once, for their agent only', () => {
    const s = new WebSessions(db.sql);
    const t = s.link('owner', 'builder');
    expect(s.consumeLink(t, 'operator')).toBeUndefined();
    const t2 = s.link('owner', 'builder');
    expect(s.consumeLink(t2, 'builder')).toBe('owner');
    expect(s.consumeLink(t2, 'builder')).toBeUndefined();
    const t3 = s.link('owner', 'builder', -1);
    expect(s.consumeLink(t3, 'builder')).toBeUndefined();
  });
});

describe('speakable', () => {
  it('drops code, links and Markdown, keeps the words', () => {
    const out = speakable('Done ✅ **Rex** runs.\n```bash\npm2 ls\n```\nSee [the logs](https://x.y/z) or https://a.b/c, file `server.ts`.\n- one\n- two');
    expect(out).not.toMatch(/```|\*\*|https?:|pm2 ls|✅/);
    expect(out).toContain('Rex runs.');
    expect(out).toContain('the logs');
    expect(out).toContain('server.ts');
  });

  it('cuts long text at a sentence end', () => {
    const out = speakable('Une phrase. '.repeat(400), 200);
    expect(out.length).toBeLessThanOrEqual(202);
    expect(out.endsWith('…')).toBe(true);
  });
});
