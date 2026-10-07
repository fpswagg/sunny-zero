import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.ts';
import { agentSchema } from '../src/agents/schema.ts';
import type { Gateway } from '../src/gateway/gateway.ts';
import { SecretStore } from '../src/secrets/store.ts';
import { TelegramHub } from '../src/telegram/hub.ts';
import { botSecretId } from '../src/telegram/setup.ts';
import { Inbox, type StagedFile } from '../src/media/inbox.ts';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { UserStore } from '../src/users/users.ts';
import { testDb } from './helpers/db.ts';

const TOKENS = { sunny: '111111111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', watcher: '222222222:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' };
const BOTS: Record<string, { id: number; username: string }> = {
  [TOKENS.sunny]: { id: 111111111, username: 'sunny_test_bot' },
  [TOKENS.watcher]: { id: 222222222, username: 'watcher_test_bot' },
};

/** A minimal Bot API for several bots: records calls and serves queued updates to long polling. */
class FakeBotApi {
  calls: { bot: string; method: string; body: Record<string, any> }[] = [];
  private updates = new Map<string, object[]>();
  /** Files bots can download, by file id. */
  files = new Map<string, Buffer>();
  private nextId = 1;
  private nextMessageId = 100;
  private server!: Server;
  url = '';

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const download = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(req.url!);
        if (download) return res.end(this.files.get(decodeURIComponent(download[1]!)));
        const [, tokenPart, method] = /^\/bot([^/]+)\/(\w+)/.exec(req.url!) ?? [];
        const bot = BOTS[tokenPart!]!.username;
        const raw = Buffer.concat(chunks);
        const multipart = String(req.headers['content-type']).startsWith('multipart/');
        const body = multipart ? { multipartBytes: raw.length } : raw.length ? JSON.parse(raw.toString()) : {};
        const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
        if (method === 'getUpdates') {
          const queue = this.updates.get(bot) ?? [];
          for (let i = 0; i < 20 && !queue.length; i++) await new Promise((r) => setTimeout(r, 25));
          return reply(queue.splice(0));
        }
        this.calls.push({ bot, method: method!, body });
        if (method === 'getMe') return reply({ ...BOTS[tokenPart!], is_bot: true, first_name: 'Bot' });
        if (method === 'sendMessage') return reply({ message_id: this.nextMessageId++, chat: { id: body.chat_id }, date: 0, text: body.text });
        if (method === 'getFile') return reply({ file_id: body.file_id, file_unique_id: body.file_id, file_path: `files/${encodeURIComponent(body.file_id)}` });
        if (/^send(Photo|Video|Animation|Audio|Voice|Document)$/.test(method!)) return reply({ message_id: this.nextMessageId++, chat: { id: 0 }, date: 0 });
        if (method === 'editMessageText') return reply({ message_id: body.message_id, chat: { id: body.chat_id }, date: 0, text: body.text });
        return reply(true);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  message(bot: string, from: number, text: string): void {
    const q = this.updates.get(bot) ?? [];
    this.updates.set(bot, q);
    q.push({ update_id: this.nextId++, message: { message_id: this.nextMessageId++, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: `U${from}` }, text } });
  }

  /** Any message: a photo, a document, a location... */
  update(bot: string, from: number, fields: object): void {
    const q = this.updates.get(bot) ?? [];
    this.updates.set(bot, q);
    q.push({ update_id: this.nextId++, message: { message_id: this.nextMessageId++, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: `U${from}` }, ...fields } });
  }

  press(bot: string, from: number, data: string): void {
    const q = this.updates.get(bot) ?? [];
    this.updates.set(bot, q);
    q.push({ update_id: this.nextId++, callback_query: { id: String(this.nextId), from: { id: from, is_bot: false, first_name: 'x' }, chat_instance: 'x', data, message: { message_id: 1, date: 0, chat: { id: from, type: 'private' } } } });
  }

  sent(bot: string, method = 'sendMessage') {
    return this.calls.filter((c) => c.bot === bot && c.method === method).map((c) => c.body);
  }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

describe('TelegramHub', () => {
  const api = new FakeBotApi();
  const notices: { to: string; event: any }[] = [];
  const handled: any[][] = [];
  const answered: any[][] = [];
  /** Lets a test answer a message the way the gateway would (e.g. a command's notice). */
  let onHandle: ((conv: string, text: string) => void) | undefined;
  const gateway = {
    addChannel: vi.fn(),
    setTelegram: vi.fn(),
    addCommand: vi.fn(),
    handleMessage: async (...args: any[]) => {
      handled.push(args);
      onHandle?.(args[0], args[1]);
    },
    answerApproval: (...args: any[]) => void answered.push(args),
    approvals: { latest: () => undefined },
    isRunning: () => false,
    send: (to: string, event: unknown) => notices.push({ to, event }),
    sendAuthLink: vi.fn(),
  };
  let hub: TelegramHub;
  let db: Awaited<ReturnType<typeof testDb>>;
  let users: UserStore;
  let pngPath: string;

  beforeAll(async () => {
    await api.listen();
    db = await testDb();
    const dir = mkdtempSync(join(tmpdir(), 'sunny-hub-'));
    const secrets = new SecretStore(db.sql, dir);
    users = new UserStore(db.sql);
    await users.addIdentity('owner', { channel: 'telegram', externalId: '100' });
    await users.create('alice', 'Alice');
    const registry = new AgentRegistry(join(dir, 'agents'), join(dir, 'trash'));
    await registry.load();
    const watcher = await registry.save({ name: 'watcher', description: 'Watches the server.' }, 'You are Watcher.');
    writeFileSync(join(watcher.dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="200" fill="#123"/></svg>');
    await secrets.set(botSecretId('sunny'), { token: TOKENS.sunny }, { kind: 'form' });
    await secrets.set(botSecretId('watcher'), { token: TOKENS.watcher }, { kind: 'form' });
    hub = new TelegramHub({
      gateway: gateway as unknown as Gateway,
      secrets,
      sql: db.sql,
      users,
      registry,
      sunny: { def: agentSchema.parse({ name: 'sunny', description: 'Sunny' }), prompt: '', dir },
      inviteTtlMs: 60_000,
      apiRoot: api.url,
      inbox: new Inbox({ stagingDir: join(dir, 'staging'), keepDays: 30 }),
      appUrl: 'https://sunny.test/app',
    });
    pngPath = join(dir, 'chart.png');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f80' } }).png().toFile(pngPath);
    await hub.start();
  });

  afterAll(async () => {
    await hub.stop();
    api.close();
    await db.drop();
  });

  it('starts every bot and gives the agent bot its profile', async () => {
    expect(hub.username('sunny')).toBe('sunny_test_bot');
    expect(hub.username('watcher')).toBe('watcher_test_bot');
    expect(api.sent('watcher_test_bot', 'setMyName')).toEqual([{ name: 'Watcher' }]);
    expect(api.sent('watcher_test_bot', 'setMyDescription')).toEqual([{ description: 'Watches the server.' }]);
    expect(api.sent('watcher_test_bot', 'setMyProfilePhoto')[0]!.multipartBytes).toBeGreaterThan(1000);
    expect(api.sent('watcher_test_bot', 'setMyCommands')[0]!.commands.map((c: any) => c.command)).toEqual(['app', 'usage', 'console', 'new', 'stop', 'status', 'help']);
  });

  it('does not update an unchanged profile again', async () => {
    const before = api.calls.length;
    await hub.refreshProfile('watcher');
    expect(api.calls.length).toBe(before);
  });

  it('routes the owner on an agent bot to that agent and remembers the chat', async () => {
    expect(await hub.homes('watcher')).toEqual([]);
    api.message('sunny_test_bot', 100, 'hello sunny');
    api.message('watcher_test_bot', 100, 'how is the server?');
    await until(() => handled.length === 2);
    expect(handled.map(([conv, text, ctx]) => [conv, text, ctx.pinnedAgent, ctx.speaker.role])).toEqual([
      ['telegram:sunny:100', 'hello sunny', undefined, 'owner'],
      ['telegram:watcher:100', 'how is the server?', 'watcher', 'owner'],
    ]);
    expect(await hub.homes('watcher')).toEqual(['telegram:watcher:100']);
    expect(await hub.homes('helper')).toEqual(['telegram:sunny:100']);
  });

  it("gives the owner's chat on Sunny's bot the full menu and the app button", async () => {
    await until(() => api.sent('sunny_test_bot', 'setChatMenuButton').length > 0);
    expect(api.sent('sunny_test_bot', 'setChatMenuButton')[0]).toEqual({ chat_id: 100, menu_button: { type: 'web_app', text: 'Agents', web_app: { url: 'https://sunny.test/app' } } });
    const scoped = api.sent('sunny_test_bot', 'setMyCommands').find((c) => c.scope?.chat_id === 100)!;
    expect(scoped.commands.map((c: any) => c.command)).toEqual(expect.arrayContaining(['manage', 'model', 'effort', 'providers']));
    // Guests see the plain menu.
    expect(api.sent('sunny_test_bot', 'setMyCommands').find((c) => !c.scope)!.commands.map((c: any) => c.command)).not.toContain('model');
  });

  it('turns notice buttons into a keyboard, and a pressed menu edits itself in place', async () => {
    hub.send('telegram:sunny:100', {
      type: 'notice',
      text: 'Pick an agent',
      buttons: [[{ label: 'builder', command: '/model builder' }, { label: 'Docs', url: 'https://example.com' }], [{ label: 'Open', app: '/agent/builder' }]],
    });
    await until(() => api.sent('sunny_test_bot').some((m) => m.text === 'Pick an agent'));
    const menu = api.sent('sunny_test_bot').find((m) => m.text === 'Pick an agent')!;
    const [[builder, docs], [open]] = menu.reply_markup.inline_keyboard;
    expect(builder.callback_data).toMatch(/^c:[0-9a-f]{12}$/);
    expect(docs).toEqual({ text: 'Docs', url: 'https://example.com' });
    expect(open).toEqual({ text: 'Open', web_app: { url: 'https://sunny.test/app?page=%2Fagent%2Fbuilder' } });

    onHandle = (conv, text) => text === '/model builder' && hub.send(conv, { type: 'notice', text: 'builder runs on opus', buttons: [[{ label: '◀ Back', command: '/model' }]] });
    api.press('sunny_test_bot', 100, builder.callback_data);
    await until(() => api.sent('sunny_test_bot', 'editMessageText').some((m) => m.text.includes('builder runs on opus')));
    onHandle = undefined;
    expect(handled.at(-1)!.slice(0, 2)).toEqual(['telegram:sunny:100', '/model builder']);
    const edit = api.sent('sunny_test_bot', 'editMessageText').find((m) => m.text.includes('builder runs on opus'))!;
    expect(edit.message_id).toBe(1);
    expect(edit.reply_markup.inline_keyboard[0][0].text).toBe('◀ Back');
    // Guests cannot press the owner's menus.
    const before = handled.length;
    api.press('sunny_test_bot', 200, builder.callback_data);
    await new Promise((r) => setTimeout(r, 200));
    expect(handled.length).toBe(before);
  });

  it('ignores unknown accounts', async () => {
    const before = handled.length;
    api.message('watcher_test_bot', 999, 'who are you');
    await new Promise((r) => setTimeout(r, 300));
    expect(handled).toHaveLength(before);
    expect(api.sent('watcher_test_bot').filter((m) => m.chat_id === 999)).toEqual([]);
  });

  it('links a guest with an invite, and checks their access to the agent', async () => {
    await hub.invite('cli:default', 'alice', 'watcher');
    const link = notices.at(-1)!.event.text as string;
    const code = /start=([A-Z0-9]+)/.exec(link)![1]!;
    expect(link).toContain('https://t.me/watcher_test_bot?start=');
    api.message('watcher_test_bot', 200, `/start ${code}`);
    await until(() => api.sent('watcher_test_bot').some((m) => m.chat_id === 200));
    expect(await users.byIdentity('telegram', '200')).toMatchObject({ id: 'alice' });
    // The owner hears about it on Sunny's bot.
    expect(notices.some((n) => n.to === 'telegram:sunny:100' && /linked to \*\*Alice\*\*/.test(n.event.text))).toBe(true);
    // Alice has no access to watcher yet.
    await until(() => api.sent('watcher_test_bot').some((m) => m.chat_id === 200 && /don't have access/.test(m.text)));
    await users.grant('alice', 'watcher');
    const before = handled.length;
    api.message('watcher_test_bot', 200, 'is the site up?');
    await until(() => handled.length === before + 1);
    expect(handled.at(-1)!.slice(0, 2)).toEqual(['telegram:watcher:200', 'is the site up?']);
    expect(handled.at(-1)![2]).toMatchObject({ pinnedAgent: 'watcher', speaker: { id: 'alice', role: 'member' } });
    // Notifications only go to the owner's chats.
    expect(await hub.homes('watcher')).toEqual(['telegram:watcher:100']);
  });

  it('only takes approval answers from the owner', async () => {
    api.press('watcher_test_bot', 200, 'ap:abc123:y');
    api.press('watcher_test_bot', 100, 'ap:abc123:n');
    await until(() => answered.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(answered).toEqual([['telegram:watcher:100', 'abc123', false, false]]);
  });

  it('sends notifications from the agent’s own bot without a header', async () => {
    hub.send('telegram:watcher:100', { type: 'notify', agent: 'watcher', text: 'All good', silent: true });
    hub.send('telegram:sunny:100', { type: 'notify', agent: 'watcher', text: 'All good', silent: false });
    await until(() => api.sent('sunny_test_bot').some((m) => m.text.includes('All good')));
    expect(api.sent('watcher_test_bot').find((m) => m.text === 'All good')).toMatchObject({ disable_notification: true });
    expect(api.sent('sunny_test_bot').find((m) => m.text.includes('All good'))!.text).toBe('🔔 <b>watcher</b>\n\nAll good');
  });

  it('refuses a token another bot already uses', async () => {
    await expect(hub.setToken('cli:default', TOKENS.sunny, 'watcher')).rejects.toThrow(/already belongs to sunny/);
  });

  describe('media', () => {
    const next = () => handled.length;
    const files = (i: number) => (handled[i]![2].files ?? []) as StagedFile[];

    it('downloads a photo into staging and hands it over with its caption', async () => {
      const n = next();
      api.files.set('photo-big', Buffer.from('jpeg bytes'));
      api.update('sunny_test_bot', 100, { caption: 'what is this?', photo: [{ file_id: 'photo-small', width: 90, height: 90 }, { file_id: 'photo-big', width: 1280, height: 960, file_size: 10 }] });
      await until(() => handled.length === n + 1);
      expect(handled[n]!.slice(0, 2)).toEqual(['telegram:sunny:100', 'what is this?']);
      const [file] = files(n);
      expect(file).toMatchObject({ kind: 'photo', mime: 'image/jpeg', size: 10 });
      expect(file!.name).toMatch(/^photo-\d+\.jpg$/);
      expect(readFileSync(file!.path, 'utf8')).toBe('jpeg bytes');
    });

    it('collects an album into one message', async () => {
      const n = next();
      api.files.set('a1', Buffer.from('1'));
      api.files.set('a2', Buffer.from('2'));
      api.update('sunny_test_bot', 100, { media_group_id: 'g1', caption: 'two shots', photo: [{ file_id: 'a1', width: 1, height: 1 }] });
      api.update('sunny_test_bot', 100, { media_group_id: 'g1', photo: [{ file_id: 'a2', width: 1, height: 1 }] });
      await until(() => handled.length === n + 1);
      await new Promise((r) => setTimeout(r, 1500));
      expect(handled).toHaveLength(n + 1);
      expect(handled[n]![1]).toBe('two shots');
      expect(files(n).map((f) => readFileSync(f.path, 'utf8'))).toEqual(['1', '2']);
    });

    it('explains files too big to download and passes the rest on', async () => {
      const n = next();
      api.update('sunny_test_bot', 100, { caption: 'the backup', document: { file_id: 'huge', file_name: 'dump.sql', file_size: 30 * 1024 * 1024 } });
      await until(() => handled.length === n + 1);
      expect(handled[n]![1]).toBe('the backup\n(They also sent "dump.sql", 30 MB, too big to download. They were told.)');
      expect(files(n)).toEqual([]);
      expect(api.sent('sunny_test_bot').some((m) => m.chat_id === 100 && /up to 20 MB/.test(m.text))).toBe(true);
      expect(api.calls.some((c) => c.method === 'getFile' && c.body.file_id === 'huge')).toBe(false);
    });

    it('spells out locations, and says what it cannot read', async () => {
      const n = next();
      api.update('watcher_test_bot', 100, { location: { latitude: 4.05, longitude: 9.7 } });
      await until(() => handled.length === n + 1);
      expect(handled[n]![1]).toMatch(/^📍 Location: 4\.050000, 9\.700000/);
      api.update('watcher_test_bot', 100, { game: { title: 'Snake' } });
      await until(() => api.sent('watcher_test_bot').some((m) => /can't read a game/.test(m.text)));
    });

    it('passes "yes" on as it is, even as a reply to the approval request', async () => {
      const n = next();
      api.update('sunny_test_bot', 100, { text: 'yes', reply_to_message: { message_id: 3, date: 0, chat: { id: 100, type: 'private' }, from: { id: 1, is_bot: true, first_name: 'Sunny' }, text: '⚠️ watcher wants to restart' } });
      await until(() => handled.length === n + 1);
      expect(handled[n]![1]).toBe('yes');
    });

    it('still treats plain "/x" text as a command', async () => {
      const n = next();
      api.message('sunny_test_bot', 100, '/status@sunny_test_bot');
      await until(() => handled.length === n + 1);
      expect(handled[n]![1]).toBe('/status');
      expect(handled[n]![2].files).toBeUndefined();
    });

    it('uploads files agents send, as a photo when it is one', async () => {
      hub.send('telegram:sunny:100', { type: 'file', agent: 'sunny', path: pngPath, name: 'chart.png', kind: 'photo', caption: '**CPU** this week' });
      hub.send('telegram:sunny:100', { type: 'file', agent: 'sunny', path: pngPath, name: 'chart.png', kind: 'document' });
      await until(() => api.sent('sunny_test_bot', 'sendDocument').length === 1);
      expect(api.sent('sunny_test_bot', 'sendPhoto')).toHaveLength(1);
      expect(api.sent('sunny_test_bot', 'sendPhoto')[0]!.multipartBytes).toBeGreaterThan(100);
    });
  });
});
