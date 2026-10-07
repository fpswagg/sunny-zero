import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.ts';
import { agentSchema } from '../src/agents/schema.ts';
import { AuthManager } from '../src/auth/manager.ts';
import { ConversationStore } from '../src/gateway/conversations.ts';
import { Gateway } from '../src/gateway/gateway.ts';
import type { Outbound } from '../src/gateway/types.ts';
import type { RunRequest, RunResult, Runner } from '../src/runtime/runner.ts';
import { SessionStore } from '../src/runtime/sessions.ts';
import { PendingTasks } from '../src/triggers/pending.ts';
import { UserStore } from '../src/users/users.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
afterAll(() => db.drop());

/** Fails with a limit message while `limited`; the route signature is whatever the test sets. */
class LimitRunner {
  limited = true;
  signature = 'a';
  messages: string[] = [];
  async routeSignature() {
    return this.signature;
  }
  async run(req: RunRequest): Promise<RunResult> {
    this.messages.push(req.message);
    return this.limited
      ? { text: "You've hit your limit · resets 3am (UTC)", isError: true, durationMs: 1 }
      : { text: 'done', isError: false, durationMs: 1 };
  }
}

describe('background runs and limits', () => {
  it('parks on a limit, stays parked, and resumes once the models change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sunny-pf-'));
    const registry = new AgentRegistry(join(dir, 'agents'), join(dir, 'trash'));
    await registry.load();
    await registry.save({ name: 'worker', description: 'works' }, 'You work.');
    const runner = new LimitRunner();
    const sent: Outbound[] = [];
    const pending = new PendingTasks(db.sql);
    const gateway = new Gateway({
      registry,
      runner: runner as unknown as Runner,
      sessions: new SessionStore(db.sql),
      auth: new AuthManager('https://sunny.test', 60_000),
      conversations: new ConversationStore(db.sql),
      users: new UserStore(db.sql),
      sunny: { def: agentSchema.parse({ name: 'sunny', description: 'Sunny' }), prompt: '', dir },
      sunnyDeps: () => {
        throw new Error('not used');
      },
      approvalTimeoutMs: 60_000,
      timezone: 'UTC',
      pending,
    });
    gateway.addChannel({ id: 'telegram', send: (_to, e) => sent.push(e), homes: async () => ['telegram:sunny:1'] });

    await gateway.runTask('worker', 'do the thing', 'cron');
    const [parked] = await pending.list('waiting');
    expect(parked).toMatchObject({ agent: 'worker', message: 'do the thing', signature: 'a' });
    expect(parked!.resumeAfter!.getTime()).toBeGreaterThan(Date.now());
    expect(sent.filter((e) => 'text' in e && e.text.includes('waiting'))).toHaveLength(1);

    // Nothing changed and the reset is in the future: it stays parked.
    await gateway.resumePending();
    expect(runner.messages).toHaveLength(1);

    // The Claude account or a model changed: it runs again, with a note, and is done.
    runner.signature = 'b';
    runner.limited = false;
    await gateway.resumePending();
    expect(runner.messages).toHaveLength(2);
    expect(runner.messages[1]).toContain('do the thing');
    expect(runner.messages[1]).toMatch(/restarted or a limit/);
    expect(await pending.list()).toEqual([]);
  });

  it('picks up a chat turn cut by a restart, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sunny-ct-'));
    const registry = new AgentRegistry(join(dir, 'agents'), join(dir, 'trash'));
    await registry.load();
    await registry.save({ name: 'worker', description: 'works' }, 'You work.');
    const runner = new LimitRunner();
    runner.limited = false;
    const sent: { to: string; e: Outbound }[] = [];
    const pending = new PendingTasks(db.sql);
    const owner = { id: 'owner', name: 'Owner', role: 'owner' };
    await pending.openTurn('telegram:worker:1', 'worker', owner, 0);
    await pending.openTurn('telegram:worker:2', 'worker', owner, 1);
    await new Promise((r) => setTimeout(r, 20));
    const gateway = new Gateway({
      registry,
      runner: runner as unknown as Runner,
      sessions: new SessionStore(db.sql),
      auth: new AuthManager('https://sunny.test', 60_000),
      conversations: new ConversationStore(db.sql),
      users: new UserStore(db.sql),
      sunny: { def: agentSchema.parse({ name: 'sunny', description: 'Sunny' }), prompt: '', dir },
      sunnyDeps: () => {
        throw new Error('not used');
      },
      approvalTimeoutMs: 60_000,
      timezone: 'UTC',
      pending,
    });
    gateway.addChannel({ id: 'telegram', send: (to, e) => sent.push({ to, e }), homes: async () => [] });
    await gateway.resumeCutTurns();
    await new Promise((r) => setTimeout(r, 100));
    expect(runner.messages).toHaveLength(1);
    expect(runner.messages[0]).toMatch(/Sunny restarted while you were/);
    // Already picked up once: only a short notice.
    expect(sent.some(({ to, e }) => to === 'telegram:worker:2' && e.type === 'notice' && /back up/.test(e.text))).toBe(true);
    expect(await db.sql`select * from open_turns`).toHaveLength(0);
    // Only once per start.
    await gateway.resumeCutTurns();
    expect(runner.messages).toHaveLength(1);
  });

  it('tells a chat Sunny is back when its turn ended just before a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sunny-nr-'));
    const registry = new AgentRegistry(join(dir, 'agents'), join(dir, 'trash'));
    await registry.load();
    await registry.save({ name: 'worker', description: 'works' }, 'You work.');
    const runner = new LimitRunner();
    runner.limited = false;
    const pending = new PendingTasks(db.sql);
    const make = () =>
      new Gateway({
        registry,
        runner: runner as unknown as Runner,
        sessions: new SessionStore(db.sql),
        auth: new AuthManager('https://sunny.test', 60_000),
        conversations: new ConversationStore(db.sql),
        users: new UserStore(db.sql),
        sunny: { def: agentSchema.parse({ name: 'sunny', description: 'Sunny' }), prompt: '', dir },
        sunnyDeps: () => {
          throw new Error('not used');
        },
        approvalTimeoutMs: 60_000,
        timezone: 'UTC',
        pending,
      });
    const before = make();
    before.addChannel({ id: 'telegram', send: () => {}, homes: async () => [] });
    await before.handleMessage('telegram:worker:9', 'restart please', { pinnedAgent: 'worker' });
    await before.noteRestart();
    await new Promise((r) => setTimeout(r, 20));
    const after = make();
    const sent: { to: string; e: Outbound }[] = [];
    after.addChannel({ id: 'telegram', send: (to, e) => sent.push({ to, e }), homes: async () => [] });
    await after.resumeCutTurns();
    expect(sent.some(({ to, e }) => to === 'telegram:worker:9' && e.type === 'notice' && e.text.includes('back up'))).toBe(true);
    expect(runner.messages).toEqual(['restart please']);
  });
});
