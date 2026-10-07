import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.ts';
import { agentSchema } from '../src/agents/schema.ts';
import { AuthManager } from '../src/auth/manager.ts';
import { ConversationStore } from '../src/gateway/conversations.ts';
import { Gateway } from '../src/gateway/gateway.ts';
import type { Outbound } from '../src/gateway/types.ts';
import type { RunRequest, RunResult, Runner } from '../src/runtime/runner.ts';
import { SessionStore } from '../src/runtime/sessions.ts';
import { UserStore, type Speaker } from '../src/users/users.ts';
import { testDb } from './helpers/db.ts';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { Inbox, type StagedFile } from '../src/media/inbox.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
afterAll(() => db.drop());

/** Runs "turns" without Claude: records who asked, and asks for approval when the message says so. */
class FakeRunner {
  calls: { agent: string; conversationId: string; speaker: Speaker; origin?: string }[] = [];
  /** The last message and image count each agent got. */
  last = new Map<string, { message: string; images: number }>();
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push({ agent: req.agent.def.name, conversationId: req.conversationId, speaker: req.speaker, origin: req.origin });
    this.last.set(req.agent.def.name, { message: req.message, images: req.images?.length ?? 0 });
    if (req.message.includes('chart')) req.hooks.onEvent({ type: 'file', agent: req.agent.def.name, path: '/w/chart.png', name: 'chart.png', kind: 'photo' });
    if (req.message.includes('voice only')) {
      await req.hooks.speak?.('Tout est bon.', true);
      req.hooks.onEvent({ type: 'text', agent: req.agent.def.name, text: 'Voice sent, summary in text.' });
      return { text: 'Voice sent, summary in text.', isError: false, durationMs: 1 };
    }
    if (req.message.includes('restart')) {
      const allowed = await req.hooks.approve({ agent: req.agent.def.name, tool: 'mcp__vps__restart', summary: 'vps.restart pm2:api', reason: 'this action changes something' });
      return { text: allowed ? 'restarted' : 'not allowed', isError: false, durationMs: 1 };
    }
    return { text: `${req.agent.def.name} says hi`, isError: false, durationMs: 1 };
  }
}

const OWNER_CHAT = 'telegram:sunny:100';
const OWNER_WATCHER_CHAT = 'telegram:watcher:100';
const GUEST_CHAT = 'telegram:watcher:200';
const GUEST_SUNNY_CHAT = 'telegram:sunny:200';

describe('Gateway', () => {
  const sent: { to: string; event: Outbound }[] = [];
  const working: string[] = [];
  const runner = new FakeRunner();
  let gateway: Gateway;
  let guest: Speaker;
  let inbox: Inbox;
  let registryDir: string;
  const events = (to: string, type?: Outbound['type']) => sent.filter((s) => s.to === to && (!type || s.event.type === type)).map((s) => s.event);
  const settle = () => new Promise((r) => setTimeout(r, 20));

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sunny-gw-'));
    registryDir = join(dir, 'agents');
    inbox = new Inbox({ stagingDir: join(dir, 'staging'), keepDays: 30 });
    const registry = new AgentRegistry(join(dir, 'agents'), join(dir, 'trash'));
    await registry.load();
    await registry.save({ name: 'watcher', description: 'watches the server' }, 'You are Watcher.');
    await registry.save({ name: 'helper', description: 'helps' }, 'You help.');
    await registry.save({ name: 'reporter', description: 'reports', connectors: [] }, 'You report.');
    const users = new UserStore(db.sql);
    await users.create('alice', 'Alice');
    await users.grant('alice', 'watcher');
    guest = { id: 'alice', name: 'Alice', role: 'member' };
    gateway = new Gateway({
      registry,
      runner: runner as unknown as Runner,
      sessions: new SessionStore(db.sql),
      auth: new AuthManager('https://sunny.test', 60_000),
      conversations: new ConversationStore(db.sql),
      users,
      sunny: { def: agentSchema.parse({ name: 'sunny', description: 'Sunny' }), prompt: '', dir },
      sunnyDeps: () => {
        throw new Error('not used');
      },
      approvalTimeoutMs: 60_000,
      inbox,
      tts: { voiceFile: async () => '/w/outbox/voice.ogg' } as never,
    });
    // The owner is reachable on Watcher's bot for Watcher, and on Sunny's bot for everything else.
    gateway.addChannel({
      id: 'telegram',
      send: (to, event) => sent.push({ to, event }),
      working: (to) => working.push(to),
      homes: async (agent) => (agent === 'watcher' ? [OWNER_WATCHER_CHAT] : [OWNER_CHAT]),
    });
  });

  beforeEach(() => {
    sent.length = 0;
    working.length = 0;
    runner.calls.length = 0;
  });

  it('lets a guest talk to their agent on its bot, as a guest', async () => {
    await gateway.handleMessage(GUEST_CHAT, 'how is the server?', { speaker: guest, pinnedAgent: 'watcher' });
    expect(runner.calls).toEqual([{ agent: 'watcher', conversationId: GUEST_CHAT, speaker: guest, origin: 'message' }]);
    expect(events(GUEST_CHAT, 'reply')).toMatchObject([{ text: 'watcher says hi' }]);
  });

  it('tells the channel an agent is working whenever a turn starts, whatever started it', async () => {
    await gateway.turn(OWNER_WATCHER_CHAT, 'watcher', 'asked by another agent', 'agent');
    expect(working).toEqual([OWNER_WATCHER_CHAT]);
  });

  it('keeps an agent bot pinned to its agent', async () => {
    await gateway.handleMessage(GUEST_CHAT, '@helper hi', { speaker: guest, pinnedAgent: 'watcher' });
    await gateway.handleMessage(GUEST_CHAT, '/use helper', { speaker: guest, pinnedAgent: 'watcher' });
    expect(runner.calls).toEqual([]);
    expect(events(GUEST_CHAT).map((e) => ('text' in e ? e.text : ''))).toEqual(['This bot only talks to watcher.', 'This bot only talks to **watcher**.']);
  });

  it('limits a guest on Sunny’s bot to their agents, never Sunny', async () => {
    await gateway.handleMessage(GUEST_SUNNY_CHAT, 'hello', { speaker: guest });
    expect(runner.calls.map((c) => c.agent)).toEqual(['watcher']);
    await gateway.handleMessage(GUEST_SUNNY_CHAT, '@helper hello', { speaker: guest });
    await gateway.handleMessage(GUEST_SUNNY_CHAT, '/use sunny', { speaker: guest });
    await gateway.handleMessage(GUEST_SUNNY_CHAT, '/agents', { speaker: guest });
    await gateway.handleMessage(GUEST_SUNNY_CHAT, '/telegram', { speaker: guest });
    expect(runner.calls.map((c) => c.agent)).toEqual(['watcher']);
    const texts = events(GUEST_SUNNY_CHAT).filter((e) => e.type !== 'reply').map((e) => ('text' in e ? e.text : ''));
    expect(texts[0]).toMatch(/don't have access to helper/);
    expect(texts[1]).toMatch(/No agent named "sunny" that you can use/);
    expect(texts[2]).toBe('▸ **watcher**: watches the server');
    expect(texts[3]).toMatch(/Unknown command/);
  });

  it('sends a guest’s approvals to the owner, who alone can answer', async () => {
    const turn = gateway.handleMessage(GUEST_CHAT, 'please restart the api', { speaker: guest, pinnedAgent: 'watcher' });
    await settle();
    const approval = events(OWNER_WATCHER_CHAT, 'approval')[0] as Extract<Outbound, { type: 'approval' }>;
    expect(approval).toMatchObject({ agent: 'watcher', reason: expect.stringContaining('for Alice') });
    expect(events(GUEST_CHAT, 'approval')).toEqual([]);
    // The guest's "yes" is just a message to the agent, not an answer.
    expect(gateway.approvals.answer(GUEST_CHAT, approval.id, true)).toBe(false);
    gateway.answerApproval(OWNER_WATCHER_CHAT, approval.id, true);
    await turn;
    expect(events(GUEST_CHAT, 'notice').map((e) => (e as { text: string }).text)).toEqual([expect.stringMatching(/Waiting for the owner/), '✓ The owner approved.']);
    expect(events(GUEST_CHAT, 'reply')).toMatchObject([{ text: 'restarted' }]);
    expect(events(OWNER_WATCHER_CHAT, 'approval_closed')).toMatchObject([{ allowed: true }]);
  });

  it('lets the owner answer their own approvals in place, also with "yes"', async () => {
    const turn = gateway.handleMessage(OWNER_WATCHER_CHAT, 'restart the api', { pinnedAgent: 'watcher' });
    await settle();
    expect(events(OWNER_WATCHER_CHAT, 'approval')).toHaveLength(1);
    await gateway.handleMessage(OWNER_WATCHER_CHAT, 'yes', { pinnedAgent: 'watcher' });
    await turn;
    expect(events(OWNER_WATCHER_CHAT, 'reply')).toMatchObject([{ text: 'restarted' }]);
  });

  it('runs background tasks as the system: approvals and the reply reach the owner', async () => {
    const run = gateway.runTask('reporter', 'restart if needed', 'cron 0 8 * * *');
    await settle();
    const approval = events(OWNER_CHAT, 'approval')[0] as Extract<Outbound, { type: 'approval' }>;
    expect(approval.reason).toMatch(/background run/);
    gateway.answerApproval(OWNER_CHAT, approval.id, false);
    await run;
    expect(runner.calls[0]).toMatchObject({ conversationId: 'task:reporter', speaker: { role: 'system' }, origin: 'cron 0 8 * * *' });
    // reporter has no notify connector, so its reply is delivered as a notification.
    await settle();
    expect(events(OWNER_CHAT, 'notify')).toMatchObject([{ agent: 'reporter', text: 'not allowed' }]);
  });

  it('refuses agents a guest was not given', async () => {
    const stranger: Speaker = { id: 'bob', name: 'Bob', role: 'member' };
    await gateway.handleMessage('telegram:helper:300', 'hi', { speaker: stranger, pinnedAgent: 'helper' });
    expect(runner.calls).toEqual([]);
    expect(events('telegram:helper:300', 'error')).toMatchObject([{ text: 'You have not been given access to any agent yet.' }]);
  });

  describe('files', () => {
    const photo = async (): Promise<StagedFile> => {
      const path = await inbox.stagingPath('photo-1.jpg');
      await sharp({ create: { width: 40, height: 30, channels: 3, background: '#09c' } }).jpeg().toFile(path);
      return { kind: 'photo', path, name: 'photo-1.jpg', mime: 'image/jpeg', size: 1 };
    };

    it("puts files in the addressed agent's inbox and shows photos to it", async () => {
      await gateway.handleMessage(OWNER_CHAT, '@helper', { files: [await photo()] });
      expect(runner.calls.map((c) => c.agent)).toEqual(['helper']);
      const got = runner.last.get('helper')!;
      expect(got.images).toBe(1);
      expect(got.message).toMatch(new RegExp(`^The user sent this:\\n\\n🖼 Photo \\(shown to you with this message\\)\\nSaved as ${join(registryDir, 'helper', 'inbox')}/\\d{4}-\\d{2}-\\d{2}/photo-1\\.jpg$`));
    });

    it('never treats a caption as a command or an approval answer', async () => {
      await gateway.handleMessage(OWNER_WATCHER_CHAT, '/new', { pinnedAgent: 'watcher', files: [await photo()] });
      expect(runner.calls.map((c) => c.agent)).toEqual(['watcher']);
      expect(runner.last.get('watcher')!.message).toMatch(/^\/new\n\nThe user sent this/);
    });

    it("delivers files from background runs to the owner's chats", async () => {
      await gateway.runTask('reporter', 'send the weekly chart', 'cron');
      await settle();
      expect(events(OWNER_CHAT, 'file')).toMatchObject([{ agent: 'reporter', name: 'chart.png', kind: 'photo' }]);
    });

    it('deletes the files when the message is refused', async () => {
      const file = await photo();
      await gateway.handleMessage(GUEST_SUNNY_CHAT, '@helper look', { speaker: guest, files: [file] });
      expect(runner.calls).toEqual([]);
      expect(events(GUEST_SUNNY_CHAT, 'error')).toHaveLength(1);
      expect(existsSync(file.path)).toBe(false);
    });
  });
  it('a voice-only reply sends the voice note and no text until the user writes again', async () => {
    await gateway.handleMessage(OWNER_CHAT, '@helper answer by voice only');
    await settle();
    expect(events(OWNER_CHAT, 'file').map((e) => (e as { kind: string }).kind)).toEqual(['voice']);
    expect(events(OWNER_CHAT, 'text')).toEqual([]);
    expect(events(OWNER_CHAT, 'reply').map((e) => (e as { text: string }).text)).toEqual(['']);
    sent.length = 0;
    await gateway.handleMessage(OWNER_CHAT, '@helper hello');
    await settle();
    expect(events(OWNER_CHAT, 'reply').map((e) => (e as { text: string }).text)).toEqual(['helper says hi']);
  });
});
