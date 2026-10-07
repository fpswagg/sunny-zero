import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { Agent } from '../agents/schema.ts';
import type { AgentRegistry } from '../agents/registry.ts';
import { ICON_FILE, readIcon, renderIcon, SUNNY_ICON } from '../agents/icons.ts';
import type { Sql } from '../db/db.ts';
import { isApprovalAnswer, type Gateway } from '../gateway/gateway.ts';
import type { Button, Channel, Outbound, TelegramControl } from '../gateway/types.ts';
import type { Inbox, StagedFile } from '../media/inbox.ts';
import type { SecretStore } from '../secrets/store.ts';
import { Invites } from '../users/invites.ts';
import { OWNER_ID, type Speaker, type User, type UserStore } from '../users/users.ts';
import { KeyedMutex } from '../util/mutex.ts';
import { explainError } from '../runtime/explain-error.ts';
import { log } from '../log.ts';
import type { Prefs } from '../manage/prefs.ts';
import { renderDone, renderLive, type ConsoleStep } from './console.ts';
import { escapeHtml, splitMarkdown, toTelegramHtml } from './format.ts';
import { botSecretId, botTokenFlow, checkBotToken } from './setup.ts';
import { describeMessage, DOWNLOAD_LIMIT, type MediaRef } from './incoming.ts';

export interface TelegramDeps {
  gateway: Gateway;
  secrets: SecretStore;
  sql: Sql;
  users: UserStore;
  registry: AgentRegistry;
  sunny: Agent;
  /** How long an invite code stays valid. */
  inviteTtlMs: number;
  /** Bot API server; tests point it at a fake one. */
  apiRoot?: string;
  /** Where photos, files and voice messages go. Without it, bots read text only. */
  inbox?: Inbox;
  /** HTTPS address of the Telegram app (agent manager). Without it, app buttons and the menu button are left out. */
  appUrl?: string;
  /** An agent's web app URL (https), for its bot's menu button; undefined when not served over https. */
  agentAppUrl?: (agent: string) => string | undefined;
  /** Display preferences (live console card on/off). Without it the card always shows. */
  prefs?: Prefs;
}

/** Command menus: Sunny's bot switches between agents, an agent's bot talks to that agent only. */
const SUNNY_COMMANDS = [
  { command: 'agents', description: 'List agents' },
  { command: 'use', description: 'Talk to an agent directly (/use sunny to go back)' },
  { command: 'new', description: 'Fresh conversation with the current agent' },
  { command: 'stop', description: 'Stop what is running' },
  { command: 'status', description: 'Current agent and running work' },
  { command: 'help', description: 'All commands' },
];
/** The owner's menu on Sunny's bot: managing agents and models too. */
const OWNER_COMMANDS = [
  { command: 'manage', description: 'Open the agent manager' },
  { command: 'apps', description: 'Open the web app (manager and agents)' },
  { command: 'agents', description: 'Agents: pick one to manage it' },
  { command: 'model', description: 'Change an agent’s model' },
  { command: 'effort', description: 'Change an agent’s thinking effort' },
  { command: 'providers', description: 'Model providers and their keys' },
  { command: 'usage', description: 'Runs, tokens and cost per agent' },
  { command: 'console', description: 'Live progress card on/off' },
  { command: 'use', description: 'Talk to an agent directly (/use sunny to go back)' },
  { command: 'new', description: 'Fresh conversation with the current agent' },
  { command: 'stop', description: 'Stop what is running' },
  { command: 'status', description: 'Current agent and running work' },
  { command: 'help', description: 'All commands' },
];
const AGENT_COMMANDS = [
  { command: 'app', description: 'Open the app (chat and voice call)' },
  { command: 'usage', description: 'Usage and limits' },
  { command: 'console', description: 'Live progress card on/off' },
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'stop', description: 'Stop what is running' },
  { command: 'status', description: 'What is running' },
  { command: 'help', description: 'Commands' },
];

/** Menu buttons stay valid this long. */
const MENU_TTL_MS = 24 * 3_600_000;
const MENU_MAX = 2_000;

/** Streaming replies are shown by editing a message at most this often. */
const STREAM_EDIT_MS = 1000;
const PROGRESS_EDIT_MS = 800;
/** The live card's clock ticks this often (an edit, only while the card is the last message). */
const PROGRESS_TICK_MS = 10_000;
const TYPING_EVERY_MS = 4500;
/** The photos of an album arrive one by one; wait this long after the last before handing them over. */
const ALBUM_WAIT_MS = 1200;
const CAPTION_LIMIT = 1024;

/** A message waiting for the rest of its album. */
interface Album {
  bot: string;
  chatId: number;
  user: User;
  pinned?: string;
  texts: string[];
  media: MediaRef[];
  timer?: NodeJS.Timeout;
}

interface Stream {
  agent: string;
  text: string;
  messageId?: number;
  shown?: string;
  timer?: NodeJS.Timeout;
}

interface ChatState {
  bot: string;
  chatId: number;
  stream?: Stream;
  /** Agents whose reply already streamed this turn, so the final reply is not sent twice. */
  streamed: Set<string>;
  /** The live console card: the latest steps, kept at the bottom of the chat, folded into a summary when the turn ends. */
  progress?: { lead: string; steps: ConsoleStep[]; startedAt: number; messageId?: number; timer?: NodeJS.Timeout; ticker?: NodeJS.Timeout };
  approvals: Map<string, { messageId: number; html: string }>;
  lastMessageId?: number;
  typing?: NodeJS.Timeout;
  /** Message whose menu button was pressed: the command's answer replaces it. */
  editNext?: number;
}

type SendExtra = { reply_markup?: InlineKeyboard; disable_notification?: boolean };

/** An error as a short card; long details fold away. */
function errorHtml(text: string, agent?: string): string {
  const head = `⚠️ <b>${agent ? `${escapeHtml(agent)} hit a problem` : 'Problem'}</b>`;
  const plain = explainError(text);
  if (plain) return `${head}\n${escapeHtml(plain)}\n<blockquote expandable>${escapeHtml(text.slice(0, 1500))}</blockquote>`;
  const body = text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
  return body.length > 160 || body.includes('\n') ? `${head}\n<blockquote expandable>${escapeHtml(body)}</blockquote>` : `${head}\n${escapeHtml(body)}`;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const isParseError = (err: unknown) => err instanceof GrammyError && /can't parse entities|unsupported start tag|can't find end/i.test(err.description);
const isNotModified = (err: unknown) => err instanceof GrammyError && /message is not modified/i.test(err.description);
const displayName = (bot: string) => bot.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/** "telegram:<bot>:<chat id>" */
export const conversationOf = (bot: string, chatId: number) => `telegram:${bot}:${chatId}`;
export function parseConversation(conversationId: string): { bot: string; chatId: number } | undefined {
  const m = /^telegram:([a-z][a-z0-9-]*):(-?\d+)$/.exec(conversationId);
  return m ? { bot: m[1]!, chatId: Number(m[2]) } : undefined;
}

/**
 * All of Sunny's Telegram bots: its own ("sunny") and one per agent that has one. Each bot
 * long-polls (no inbound port), answers only linked accounts in private chats, streams
 * replies by editing messages, and turns approvals and auth links into buttons.
 */
export class TelegramHub implements Channel, TelegramControl {
  readonly id = 'telegram';
  readonly invites: Invites;
  private bots = new Map<string, Bot>();
  private chats = new Map<string, ChatState>();
  /** Chats already recorded in telegram_chats (so notifications can reach them). */
  private known = new Set<string>();
  private queue = new KeyedMutex();
  private albums = new Map<string, Album>();
  /** Conversations whose message is still being handled (downloads, transcription, the turn). */
  private busy = new Set<string>();
  /** Commands behind menu buttons, by the id in their callback data (Telegram allows 64 bytes). */
  private menus = new Map<string, { command: string; at: number }>();

  constructor(private readonly deps: TelegramDeps) {
    this.invites = new Invites(deps.inviteTtlMs);
    deps.gateway.addChannel(this);
    deps.gateway.setTelegram(this);
    deps.gateway.addCommand('telegram', {
      usage: '[pair | unlink <telegram id>]',
      help: 'your Telegram bots, a link to add another of your accounts, or unlink one',
      run: (conversationId, arg) => this.command(conversationId, arg),
    });
    // A changed description or icon is applied to the agent's bot.
    deps.registry.on('changed', (changed) => {
      for (const name of changed === '*' ? [...this.bots.keys()].filter((b) => b !== 'sunny') : [changed]) {
        if (this.bots.has(name)) void this.refreshProfile(name).catch((err) => log.warn({ err: (err as Error).message, bot: name }, 'telegram: profile update failed'));
      }
    });
  }

  username(bot: string): string | undefined {
    const b = this.bots.get(bot);
    return b?.isInited() ? b.botInfo.username : undefined;
  }

  /** Starts every bot that has a token: Sunny's and the agents'. */
  async start(): Promise<void> {
    const ids = (await this.deps.secrets.list()).map((s) => s.id).filter((id) => id === 'telegram:bot' || id.startsWith('telegram:bot:'));
    for (const id of ids) {
      const bot = id === 'telegram:bot' ? 'sunny' : id.slice('telegram:bot:'.length);
      if (bot !== 'sunny' && !this.deps.registry.get(bot)) {
        log.warn({ bot }, 'telegram: token for an agent that no longer exists, not started');
        continue;
      }
      const token = (await this.deps.secrets.get(id))?.token;
      if (!token) continue;
      await this.launch(bot, token).catch((err) => log.error({ err: (err as Error).message, bot }, 'telegram: bot did not start'));
    }
    if (!ids.length) log.info('telegram: no bot token yet (sunny setup telegram, or ask Sunny)');
  }

  async stop(): Promise<void> {
    for (const name of [...this.bots.keys()]) await this.stopBot(name);
  }

  private async stopBot(name: string): Promise<void> {
    const bot = this.bots.get(name);
    this.bots.delete(name);
    for (const chat of this.chats.values()) if (chat.bot === name) clearInterval(chat.typing);
    if (bot?.isRunning()) await bot.stop().catch(() => {});
  }

  private async launch(name: string, token: string): Promise<void> {
    await this.stopBot(name);
    const bot = new Bot(token, { client: { apiRoot: this.deps.apiRoot } });
    bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
    bot.on('message', (ctx) => this.onMessage(name, ctx));
    bot.on('callback_query:data', (ctx) => this.onCallback(name, ctx));
    bot.catch(({ error }) => log.error({ err: error, bot: name }, 'telegram: update failed'));
    await bot.init();
    await bot.api
      .setMyCommands(name === 'sunny' ? SUNNY_COMMANDS : AGENT_COMMANDS)
      .catch((err) => log.warn({ err: (err as Error).message }, 'telegram: setMyCommands failed'));
    this.bots.set(name, bot);
    void this.poll(name, bot);
    log.info({ bot: name, username: bot.botInfo.username }, 'telegram: bot is up');
    // Agent bots: the menu button shows the commands (/app opens the app). Telegram keeps an old button until it is reset.
    if (name !== 'sunny') {
      await bot.api
        .setChatMenuButton({ menu_button: { type: 'commands' } })
        .catch((err) => log.warn({ err: (err as Error).message, bot: name }, 'telegram: menu button not reset'));
    }
    if (name === 'sunny') {
      const owners = await this.deps.sql<{ chat_id: number }[]>`
        select tc.chat_id from telegram_chats tc join users u on u.id = tc.user_id where tc.bot = 'sunny' and u.role = 'owner'`;
      for (const { chat_id } of owners) await this.ownerMenu(chat_id);
    }
    await this.refreshProfile(name).catch((err) => log.warn({ err: (err as Error).message, bot: name }, 'telegram: profile update failed'));
  }

  /** Long polling. Restarts after errors such as a second instance polling the same bot (409). */
  private async poll(name: string, bot: Bot): Promise<void> {
    while (this.bots.get(name) === bot) {
      try {
        await bot.start({ allowed_updates: ['message', 'callback_query'] });
        return;
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 401) {
          log.error({ bot: name }, 'telegram: the bot token was revoked; set a new one with Sunny');
          if (this.bots.get(name) === bot) this.bots.delete(name);
          return;
        }
        log.error({ err: (err as Error).message, bot: name }, 'telegram: polling failed, retrying in 15s');
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  }

  // ── Profiles, setup, invites ───────────────────────────────────────────────────

  /** Name, description and picture of a bot, from the agent's definition and icon. Applied only when they change. */
  async refreshProfile(name: string): Promise<void> {
    const bot = this.bots.get(name);
    const agent = name === 'sunny' ? this.deps.sunny : this.deps.registry.get(name);
    if (!bot || !agent) return;
    const iconPath = name === 'sunny' ? SUNNY_ICON : join(agent.dir, ICON_FILE);
    const svg = await readIcon(iconPath);
    const title = displayName(name);
    const description = name === 'sunny' ? 'Your personal agent system: Sunny creates, manages and runs your agents.' : agent.def.description;
    const hash = createHash('sha256').update(JSON.stringify([title, description, svg ?? ''])).digest('hex');
    const [state] = await this.deps.sql<{ value: { hash: string; botId: number } }[]>`
      select value from connector_state where connector = 'telegram' and key = ${`profile:${name}`}`;
    if (state?.value.hash === hash && state.value.botId === bot.botInfo.id) return;

    await bot.api.setMyName(title).catch((err) => log.warn({ err: (err as Error).message }, 'telegram: setMyName failed'));
    await bot.api.setMyDescription(description.slice(0, 512));
    await bot.api.setMyShortDescription(description.slice(0, 120));
    if (svg) await bot.api.setMyProfilePhoto({ type: 'static', photo: new InputFile(await renderIcon(svg, 640, 'jpeg'), `${name}.jpg`) });
    await this.deps.sql`
      insert into connector_state (connector, key, value) values ('telegram', ${`profile:${name}`}, ${this.deps.sql.json({ hash, botId: bot.botInfo.id })})
      on conflict (connector, key) do update set value = excluded.value, updated_at = now()`;
    log.info({ bot: name }, 'telegram: profile updated');
  }

  /** The owner's chat with Sunny's bot gets the full command list and a menu button that opens the agent manager. */
  private async ownerMenu(chatId: number): Promise<void> {
    const bot = this.bots.get('sunny');
    if (!bot) return;
    const scope = { type: 'chat' as const, chat_id: chatId };
    await bot.api.setMyCommands(OWNER_COMMANDS, { scope }).catch((err) => log.warn({ err: (err as Error).message }, 'telegram: owner commands not set'));
    if (this.deps.appUrl) {
      await bot.api
        .setChatMenuButton({ chat_id: chatId, menu_button: { type: 'web_app', text: 'Agents', web_app: { url: this.deps.appUrl } } })
        .catch((err) => log.warn({ err: (err as Error).message }, 'telegram: menu button not set'));
    }
  }

  async botStatus(bot: string): Promise<{ username?: string; stored: boolean }> {
    return { username: this.username(bot), stored: await this.deps.secrets.has(botSecretId(bot)) };
  }

  /** Refuses a token another bot already runs with: two pollers on one bot fight. */
  private reuse(name: string, botId: number): string | undefined {
    for (const [other, bot] of this.bots) {
      if (other !== name && bot.isInited() && bot.botInfo.id === botId) return `That bot already belongs to ${other}. Create a new one with /newbot.`;
    }
    return undefined;
  }

  private checkBotName(bot: string): void {
    if (bot !== 'sunny' && !this.deps.registry.get(bot)) throw new Error(`No agent named "${bot}".`);
  }

  async describe(): Promise<string> {
    const chats = await this.deps.sql<{ bot: string; user_id: string; name: string }[]>`
      select tc.bot, tc.user_id, u.name from telegram_chats tc join users u on u.id = tc.user_id order by tc.started_at`;
    const lines: string[] = [];
    for (const name of ['sunny', ...this.deps.registry.list().map((a) => a.def.name)]) {
      const stored = await this.deps.secrets.has(botSecretId(name));
      if (!stored && name !== 'sunny') continue;
      const users = [...new Set(chats.filter((c) => c.bot === name).map((c) => c.name))];
      const state = this.username(name) ? `@${this.username(name)} running` : stored ? 'token stored but not running (see the daemon log)' : 'not set up';
      lines.push(`- ${name}: ${state}${users.length ? `; used by ${users.join(', ')}` : ''}`);
    }
    const others = this.deps.registry.list().filter((a) => !lines.some((l) => l.startsWith(`- ${a.def.name}:`)));
    if (others.length) lines.push(`Agents without their own bot (reachable through Sunny's bot): ${others.map((a) => a.def.name).join(', ')}.`);
    return `Telegram bots:\n${lines.join('\n')}`;
  }

  async setup(conversationId: string, bot: string): Promise<string> {
    this.checkBotName(bot);
    const username = this.username(bot);
    if (username) {
      this.deps.gateway.send(conversationId, {
        type: 'notice',
        text:
          bot === 'sunny'
            ? `Telegram bot **@${username}** is running. Use \`/telegram pair\` to link another of your accounts.`
            : `**${bot}** has its own bot: open https://t.me/${username} and press Start. Your linked accounts work there right away.`,
      });
      return `${bot}'s bot @${username} is already running; the owner got its link. ${await this.describe()}`;
    }
    this.deps.gateway.sendAuthLink(
      conversationId,
      botTokenFlow(
        this.deps.secrets,
        bot,
        async (token) => {
          await this.launch(bot, token);
          this.announce(conversationId, bot);
        },
        (botId) => this.reuse(bot, botId),
        this.deps.apiRoot,
      ),
    );
    return `A secure page for ${bot === 'sunny' ? 'the' : `${bot}'s`} bot token was sent to the owner. After they save it, the bot starts and they get its link in this chat.`;
  }

  async setToken(conversationId: string, raw: string, bot: string): Promise<void> {
    this.checkBotName(bot);
    const token = raw.trim();
    const check = await checkBotToken(token, fetch, this.deps.apiRoot);
    if ('error' in check) throw new Error(check.error);
    const reused = this.reuse(bot, check.id);
    if (reused) throw new Error(reused);
    await this.deps.secrets.set(botSecretId(bot), { token }, { kind: 'form', label: bot === 'sunny' ? 'Telegram bot' : `Telegram bot (${bot})` });
    await this.launch(bot, token);
    this.announce(conversationId, bot);
  }

  /** After setup: Sunny's bot needs the owner's account linked; an agent's bot just needs a Start. */
  private announce(conversationId: string, bot: string): void {
    const username = this.username(bot);
    if (!username) return;
    if (bot !== 'sunny') {
      this.deps.gateway.send(conversationId, {
        type: 'notice',
        text: `✓ **${bot}** now has its own Telegram bot **@${username}**. Open https://t.me/${username} and press Start; your linked accounts work there right away.`,
      });
      return;
    }
    const { code, expiresAt } = this.invites.create(OWNER_ID, 'sunny');
    this.deps.gateway.send(conversationId, {
      type: 'notice',
      text: [
        `✓ Telegram bot **@${username}** is connected.`,
        `To link your Telegram account, open https://t.me/${username}?start=${code} on your phone (or send \`/start ${code}\` to @${username}).`,
        `The code works once and expires at ${time(expiresAt)}.`,
      ].join('\n'),
    });
  }

  async invite(conversationId: string, userId: string, bot: string): Promise<string> {
    this.checkBotName(bot);
    const user = await this.deps.users.get(userId);
    if (!user) throw new Error(`No user "${userId}".`);
    const username = this.username(bot);
    if (!username) throw new Error(bot === 'sunny' ? 'The Telegram bot is not running yet.' : `${bot} has no Telegram bot yet (set one up first).`);
    const { code, expiresAt } = this.invites.create(userId, bot);
    const url = `https://t.me/${username}?start=${code}`;
    const who = user.role === 'owner' ? 'your other Telegram account' : user.name;
    this.deps.gateway.send(conversationId, {
      type: 'notice',
      text: `🔗 Invite link for **${who}** on @${username}: ${url}\nIt works once, for one Telegram account, until ${time(expiresAt)}. ${user.role === 'owner' ? 'Open it from that account.' : 'Send it to them.'}`,
    });
    return `An invite link for ${user.name} on @${username} was sent to the owner to pass on. You never see the code.`;
  }

  async removeBot(bot: string): Promise<boolean> {
    const existed = this.bots.has(bot) || (await this.deps.secrets.has(botSecretId(bot)));
    await this.stopBot(bot);
    await this.deps.secrets.delete(botSecretId(bot));
    await this.deps.sql`delete from telegram_chats where bot = ${bot}`;
    await this.deps.sql`delete from connector_state where connector = 'telegram' and key = ${`profile:${bot}`}`;
    return existed;
  }

  private async command(conversationId: string, arg: string): Promise<string> {
    const [sub, value] = arg.split(/\s+/);
    if (!sub) return `${await this.describe()}\n\`/telegram pair\`: link another of your accounts · \`/telegram unlink <id>\`: unlink one.`;
    if (sub === 'pair') {
      await this.invite(conversationId, OWNER_ID, 'sunny');
      return 'The link works for one more of your Telegram accounts.';
    }
    if ((sub === 'unlink' || sub === 'remove') && value && /^\d+$/.test(value)) {
      const owners = (await this.deps.users.list()).find((u) => u.id === OWNER_ID)?.identities.filter((i) => i.channel === 'telegram') ?? [];
      if (owners.length === 1 && owners[0]!.externalId === value) return 'That is your only linked account; link another one first.';
      const removed = await this.deps.users.removeIdentity('telegram', value);
      if (removed) await this.deps.sql`delete from telegram_chats where chat_id = ${Number(value)}`;
      return removed ? `Unlinked ${value}.` : `${value} is not linked.`;
    }
    return 'Usage: `/telegram`, `/telegram pair`, `/telegram unlink <id>`';
  }

  /** The owner's chats `agent` reaches: on its own bot when the owner started it, else on Sunny's. */
  async homes(agent: string): Promise<string[]> {
    const ownerChats = async (bot: string) =>
      (
        await this.deps.sql<{ chat_id: number }[]>`
          select tc.chat_id from telegram_chats tc join users u on u.id = tc.user_id where tc.bot = ${bot} and u.role = 'owner'`
      ).map((r) => conversationOf(bot, r.chat_id));
    if (agent !== 'sunny' && this.bots.has(agent)) {
      const own = await ownerChats(agent);
      if (own.length) return own;
    }
    return this.bots.has('sunny') ? ownerChats('sunny') : [];
  }

  // ── Incoming ───────────────────────────────────────────────────────────────────

  private async onMessage(bot: string, ctx: Context): Promise<void> {
    const { from, chat, message } = ctx;
    if (!from || !chat || !message || chat.type !== 'private' || from.is_bot) return;
    const text = message.text ?? '';
    const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9]{4,32})$/.exec(text.trim());
    let user = await this.deps.users.byIdentity('telegram', String(from.id));

    if (start) {
      if (user) {
        await this.remember(bot, chat.id, user);
        return void (await this.reply(bot, chat.id, 'This account is already linked. Send /help to see the commands.'));
      }
      user = await this.redeem(bot, chat.id, start[1]!, from);
      if (!user) return;
    }
    if (!user) {
      log.info({ bot, userId: from.id, username: from.username }, 'telegram: ignored a message from an unknown account');
      return;
    }

    const pinned = bot === 'sunny' ? undefined : bot;
    if (pinned && !(await this.deps.users.canUse(user, pinned))) {
      await this.reply(bot, chat.id, `You don't have access to ${pinned}. Ask the owner.`);
      return;
    }
    await this.remember(bot, chat.id, user);
    if (start) return;

    // Commands and approval answers ("yes", also as a reply to the request) are plain text
    // messages; a forwarded or captioned "/x" is just a message.
    if (message.text && !message.forward_origin && (message.text.startsWith('/') || isApprovalAnswer(message.text))) {
      const clean = message.text.replace(/^\/(\w+)@\w+/, '/$1');
      const speaker: Speaker = { id: user.id, name: user.name, role: user.role };
      this.deps.gateway.handleMessage(conversationOf(bot, chat.id), clean, { speaker, pinnedAgent: pinned }).catch((err) => log.error({ err }, 'telegram: message failed'));
      return;
    }

    const described = describeMessage(message);
    if (described.unsupported) return void (await this.reply(bot, chat.id, `I can't read ${escapeHtml(described.unsupported)} yet. Send text, a photo, a file, a voice message, a location or a contact.`));

    if (message.media_group_id) {
      const key = `${bot}:${chat.id}:${message.media_group_id}`;
      const album = this.albums.get(key) ?? { bot, chatId: chat.id, user, pinned, texts: [], media: [] };
      this.albums.set(key, album);
      if (described.text) album.texts.push(described.text);
      album.media.push(...described.media);
      clearTimeout(album.timer);
      album.timer = setTimeout(() => {
        this.albums.delete(key);
        void this.dispatch(album.bot, album.chatId, album.user, album.pinned, album.texts.join('\n'), album.media);
      }, ALBUM_WAIT_MS);
      return;
    }
    await this.dispatch(bot, chat.id, user, pinned, described.text, described.media);
  }

  /** Downloads the files and hands the message to the gateway. */
  private async dispatch(bot: string, chatId: number, user: User, pinned: string | undefined, text: string, media: MediaRef[]): Promise<void> {
    const conversationId = conversationOf(bot, chatId);
    const speaker: Speaker = { id: user.id, name: user.name, role: user.role };
    const notes: string[] = [];
    const files: StagedFile[] = [];
    this.busy.add(conversationId);
    this.startTyping(conversationId);

    if (media.length && !this.deps.inbox) {
      if (!text.trim()) {
        this.busy.delete(conversationId);
        return void (await this.reply(bot, chatId, 'I can only read text messages here.'));
      }
      notes.push(`(They also sent ${media.length} file(s) that could not be received here.)`);
    } else {
      for (const ref of media) {
        if (ref.size && ref.size > DOWNLOAD_LIMIT) {
          await this.reply(bot, chatId, `⚠️ <b>${escapeHtml(ref.name)}</b> is ${Math.round(ref.size / 1024 / 1024)} MB. Bots can only download files up to 20 MB: send a smaller file or a link.`);
          notes.push(`(They also sent "${ref.name}", ${Math.round(ref.size / 1024 / 1024)} MB, too big to download. They were told.)`);
          continue;
        }
        try {
          files.push(await this.download(bot, ref));
        } catch (err) {
          log.warn({ err: (err as Error).message, bot, file: ref.name }, 'telegram: download failed');
          notes.push(`(They also sent "${ref.name}", which could not be downloaded.)`);
        }
      }
    }
    const full = [text, ...notes].filter(Boolean).join('\n');
    if (!full.trim() && !files.length) return void this.busy.delete(conversationId);
    // Not awaited: a turn can take minutes, and approval buttons must still be handled meanwhile.
    this.busy.add(conversationId);
    this.deps.gateway
      .handleMessage(conversationId, full, { speaker, pinnedAgent: pinned, files, spoken: files.some((f) => f.kind === 'voice' || f.kind === 'video_note') })
      .catch((err) => log.error({ err }, 'telegram: message failed'))
      .finally(() => this.busy.delete(conversationId));
  }

  /** Saves a file from Telegram into the inbox staging folder. */
  private async download(bot: string, ref: MediaRef): Promise<StagedFile> {
    const api = this.bots.get(bot);
    if (!api || !this.deps.inbox) throw new Error('bot not running');
    const file = await api.api.getFile(ref.fileId);
    if (!file.file_path) throw new Error('Telegram gave no file path');
    const res = await fetch(`${this.deps.apiRoot ?? 'https://api.telegram.org'}/file/bot${api.token}/${file.file_path}`);
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const path = await this.deps.inbox.stagingPath(ref.name);
    let size = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        done(size > DOWNLOAD_LIMIT ? new Error('file too large') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), cap, createWriteStream(path, { mode: 0o600 }));
    return { kind: ref.kind, path, name: ref.name, mime: ref.mime, size, note: ref.note };
  }

  private async redeem(bot: string, chatId: number, code: string, from: NonNullable<Context['from']>): Promise<User | undefined> {
    const result = this.invites.redeem(code, bot, `telegram:${from.id}`);
    log.info({ bot, userId: from.id, username: from.username, ok: result.ok }, 'telegram: invite attempt');
    if (!result.ok) {
      if (result.reason === 'invalid') await this.reply(bot, chatId, 'That link is not valid (anymore). Ask for a new one.');
      return undefined;
    }
    const label = `${[from.first_name, from.last_name].filter(Boolean).join(' ')}${from.username ? ` (@${from.username})` : ''}`;
    await this.deps.users.addIdentity(result.invite.userId, { channel: 'telegram', externalId: String(from.id), label });
    const user = (await this.deps.users.get(result.invite.userId))!;
    const agents = user.role === 'member' ? await this.deps.users.agentsOf(user.id) : [];
    const welcome =
      user.role === 'owner'
        ? '☀ <b>Linked.</b> This account is yours now. Send /help to see the commands.'
        : bot === 'sunny'
          ? `👋 Welcome, ${escapeHtml(user.name)}! You can use: ${escapeHtml(agents.join(', ') || 'nothing yet')}. Send /help to start.`
          : `👋 Welcome, ${escapeHtml(user.name)}! Just write your message.`;
    await this.reply(bot, chatId, welcome);
    await this.alertOwner(`🔐 Telegram account ${label} (id ${from.id}) was linked to **${user.name}** on @${this.username(bot)}. If this was not expected, send \`/telegram unlink ${from.id}\`.`);
    return user;
  }

  /** Records that this account started this bot, so the bot may message it later. */
  private async remember(bot: string, chatId: number, user: User): Promise<void> {
    const key = `${bot}:${chatId}:${user.id}`;
    if (this.known.has(key)) return;
    await this.deps.sql`
      insert into telegram_chats (bot, chat_id, user_id) values (${bot}, ${chatId}, ${user.id})
      on conflict (bot, chat_id) do update set user_id = excluded.user_id`;
    this.known.add(key);
    if (bot === 'sunny' && user.role === 'owner') await this.ownerMenu(chatId);
  }

  private async onCallback(bot: string, ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    const chatId = ctx.chat?.id;
    const user = query ? await this.deps.users.byIdentity('telegram', String(query.from.id)) : undefined;
    // Only the owner answers approvals.
    if (!query?.data || chatId === undefined || user?.role !== 'owner') {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const menu = /^c:([0-9a-f]+)$/.exec(query.data);
    if (menu) return this.onMenu(bot, chatId, ctx, menu[1]!, user);
    if (query.data === 'uc:r') {
      await ctx.answerCallbackQuery({ text: 'Refreshing…' }).catch(() => {});
      await this.usageRefresh?.().catch((err) => log.warn({ err: (err as Error).message }, 'telegram: usage card refresh failed'));
      return;
    }
    if (query.data === 'uc:l') {
      await ctx.answerCallbackQuery().catch(() => {});
      const speaker: Speaker = { id: user.id, name: user.name, role: user.role };
      await this.deps.gateway.handleMessage(conversationOf(bot, chatId), '/usage', { speaker, pinnedAgent: bot === 'sunny' ? undefined : bot }).catch(() => {});
      return;
    }
    const m = /^ap:([0-9a-f]+):([yna])$/.exec(query.data);
    if (m) this.deps.gateway.answerApproval(conversationOf(bot, chatId), m[1]!, m[2] !== 'n', m[2] === 'a');
    await ctx.answerCallbackQuery(m ? { text: m[2] === 'a' ? 'Always allowed' : m[2] === 'y' ? 'Approved' : 'Denied' } : undefined).catch(() => {});
  }

  /** A menu button: runs its command, whose answer replaces the menu message. */
  private async onMenu(bot: string, chatId: number, ctx: Context, id: string, user: User): Promise<void> {
    const entry = this.menus.get(id);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'This menu expired. Send the command again.' }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const conversationId = conversationOf(bot, chatId);
    const state = this.chat(conversationId)!;
    const messageId = ctx.callbackQuery?.message?.message_id;
    state.editNext = messageId;
    const speaker: Speaker = { id: user.id, name: user.name, role: user.role };
    try {
      await this.deps.gateway.handleMessage(conversationId, entry.command, { speaker, pinnedAgent: bot === 'sunny' ? undefined : bot });
    } catch (err) {
      log.error({ err }, 'telegram: menu command failed');
    } finally {
      if (state.editNext === messageId) state.editNext = undefined;
    }
  }

  // ── Usage card (a pinned message kept up to date) ──────────────────────────────

  /** Set by the usage card: refreshes it now (its ↻ button). */
  usageRefresh?: () => Promise<void>;

  /** Shows the usage card: edits it in place, or sends and pins a new one. Returns its message id. */
  async usageCard(conversationId: string, html: string, messageId?: number): Promise<number | undefined> {
    const parsed = parseConversation(conversationId);
    const api = parsed && this.bots.get(parsed.bot)?.api;
    if (!parsed || !api) return undefined;
    const reply_markup = new InlineKeyboard().text('↻ Refresh', 'uc:r').text('📊 Details', 'uc:l');
    if (messageId !== undefined) {
      try {
        await api.editMessageText(parsed.chatId, messageId, html, { parse_mode: 'HTML', reply_markup });
        return messageId;
      } catch (err) {
        if (isNotModified(err)) return messageId;
        log.debug({ err: (err as Error).message }, 'telegram: usage card gone, sending a new one');
      }
    }
    const sent = await api.sendMessage(parsed.chatId, html, { parse_mode: 'HTML', reply_markup, disable_notification: true });
    await api.pinChatMessage(parsed.chatId, sent.message_id, { disable_notification: true }).catch((err) => log.debug({ err: (err as Error).message }, 'telegram: could not pin'));
    return sent.message_id;
  }

  async removeUsageCard(conversationId: string, messageId: number): Promise<void> {
    const parsed = parseConversation(conversationId);
    const api = parsed && this.bots.get(parsed.bot)?.api;
    if (!parsed || !api) return;
    await api.unpinChatMessage(parsed.chatId, messageId).catch(() => {});
    await api.deleteMessage(parsed.chatId, messageId).catch(() => {});
  }

  /** Stores a menu command and returns the id for its button. */
  private menu(command: string): string {
    const now = Date.now();
    if (this.menus.size >= MENU_MAX) {
      for (const [id, m] of this.menus) if (now - m.at > MENU_TTL_MS || this.menus.size >= MENU_MAX) this.menus.delete(id);
    }
    const id = randomBytes(6).toString('hex');
    this.menus.set(id, { command, at: now });
    return id;
  }

  /** Inline keyboard for a notice's buttons. App buttons need the app's HTTPS address and only work on Sunny's bot. */
  private keyboard(bot: string, rows: Button[][] | undefined): InlineKeyboard | undefined {
    if (!rows?.length) return undefined;
    const kb = new InlineKeyboard();
    let any = false;
    for (const row of rows) {
      let used = false;
      for (const b of row) {
        if (b.command) kb.text(b.label, `c:${this.menu(b.command)}`);
        else if (b.url) kb.url(b.label, b.url);
        else if (b.webApp?.startsWith('https://')) kb.webApp(b.label, b.webApp);
        else if (b.app && this.deps.appUrl && bot === 'sunny') kb.webApp(b.label, b.app === '/' ? this.deps.appUrl : `${this.deps.appUrl}?page=${encodeURIComponent(b.app)}`);
        else continue;
        used = any = true;
      }
      if (used) kb.row();
    }
    return any ? kb : undefined;
  }

  private async alertOwner(text: string): Promise<void> {
    for (const target of await this.homes('sunny')) this.deps.gateway.send(target, { type: 'notice', text });
  }

  private async reply(bot: string, chatId: number, html: string): Promise<void> {
    await this.sendHtml(conversationOf(bot, chatId), html).catch((err) => log.warn({ err: (err as Error).message }, 'telegram: reply failed'));
  }

  /** A turn started elsewhere (web app, another agent, a trigger): show "typing…" in the chat too. */
  working(conversationId: string): void {
    if (this.bots.has(this.chat(conversationId)?.bot ?? '')) this.startTyping(conversationId);
  }

  private startTyping(conversationId: string): void {
    const state = this.chat(conversationId);
    if (!state || state.typing) return;
    let ticks = 0;
    const tick = () => {
      // The first tick comes before the gateway has registered the run.
      if (ticks++ > 0 && !this.busy.has(conversationId) && !this.deps.gateway.isRunning(conversationId)) {
        clearInterval(state.typing);
        state.typing = undefined;
        return;
      }
      if (this.deps.gateway.approvals.latest(conversationId) === undefined) this.bots.get(state.bot)?.api.sendChatAction(state.chatId, 'typing').catch(() => {});
    };
    state.typing = setInterval(tick, TYPING_EVERY_MS);
    tick();
  }

  // ── Outgoing ───────────────────────────────────────────────────────────────────

  send(conversationId: string, event: Outbound): void {
    const state = this.chat(conversationId);
    if (!state || !this.bots.has(state.bot)) {
      log.debug({ conversationId, type: event.type }, 'telegram: bot not running, event dropped');
      return;
    }
    const c = conversationId;
    switch (event.type) {
      case 'text': {
        if (state.stream && state.stream.agent !== event.agent) this.seal(c);
        const stream = (state.stream ??= { agent: event.agent, text: '' });
        stream.text += event.text;
        state.streamed.add(event.agent);
        stream.timer ??= setTimeout(() => {
          stream.timer = undefined;
          this.enqueue(c, () => this.flush(c, stream));
        }, STREAM_EDIT_MS);
        return;
      }
      case 'tool':
        if (!this.consoleOn(c, state.bot)) return;
        return this.progress(c, { agent: event.agent, text: event.summary, kind: 'tool' });
      case 'status':
        if (!this.consoleOn(c, state.bot)) return;
        return this.progress(c, { agent: event.agent ?? state.bot, text: event.text, kind: 'status' });
      case 'reply': {
        if (state.stream?.agent === event.agent) this.seal(c);
        const streamed = state.streamed.delete(event.agent);
        // A delegated agent's reply (shown as its own message) does not end the lead's card.
        if (!state.progress || state.progress.lead === event.agent) this.clearProgress(c, !event.isError);
        if (event.isError) this.enqueue(c, () => this.sendHtml(c, errorHtml(event.text || 'Something went wrong.', event.agent)));
        else if (!streamed && event.text.trim()) this.enqueue(c, () => this.sendMarkdown(c, event.text));
        return;
      }
      case 'approval': {
        this.seal(c);
        const html = `🛡 <b>${escapeHtml(event.agent)}</b> needs your OK\n<blockquote><b>${escapeHtml(event.summary)}</b>${event.reason ? `\n<i>${escapeHtml(event.reason)}</i>` : ''}</blockquote>`;
        const keyboard = new InlineKeyboard()
          .text('✅ Allow', `ap:${event.id}:y`)
          .text('❌ Deny', `ap:${event.id}:n`)
          .row()
          .text('♾ Always allow', `ap:${event.id}:a`);
        this.enqueue(c, async () => {
          const messageId = await this.sendHtml(c, `${html}\n⏱ <i>open until ${time(event.expiresAt)}</i>`, { reply_markup: keyboard });
          if (messageId) state.approvals.set(event.id, { messageId, html });
        });
        return;
      }
      case 'approval_closed':
        this.enqueue(c, async () => {
          const sent = state.approvals.get(event.id);
          if (!sent) return;
          state.approvals.delete(event.id);
          const outcome = event.allowed
            ? event.always ? '♾ <b>Always allowed</b>' : '✅ <b>Allowed</b>'
            : event.by === 'timeout' ? '⌛ <b>Expired</b>, denied' : event.by === 'cancelled' ? '⏹ <b>Cancelled</b>' : '❌ <b>Denied</b>';
          await this.editHtml(c, sent.messageId, `${sent.html}\n${outcome}`);
        });
        return;
      case 'auth_link':
        this.enqueue(c, async () => {
          const html = `🔑 <b>${escapeHtml(event.title)}</b>\nThis link works once and expires at ${time(event.expiresAt)}.`;
          try {
            await this.sendHtml(c, html, { reply_markup: new InlineKeyboard().url('Open', event.url) });
          } catch {
            // Telegram refuses buttons with non-public URLs (e.g. localhost); show the link instead.
            await this.sendHtml(c, `${html}\n${escapeHtml(event.url)}`);
          }
        });
        return;
      case 'notify': {
        // On the agent's own bot the agent's name is already the sender.
        const header = state.bot === event.agent ? '' : `🔔 **${event.agent}**\n\n`;
        this.enqueue(c, () => this.sendMarkdown(c, `${header}${event.text}`, { disable_notification: event.silent }));
        return;
      }
      case 'notice': {
        const keyboard = this.keyboard(state.bot, event.buttons);
        const edit = state.editNext;
        state.editNext = undefined;
        this.enqueue(c, async () => {
          // A menu answer replaces the menu (when it fits in one message).
          if (edit !== undefined && splitMarkdown(event.text).length === 1) {
            try {
              await this.editMarkdown(c, edit, event.text, keyboard);
              return;
            } catch (err) {
              log.debug({ err: (err as Error).message }, 'telegram: menu edit failed, sending instead');
            }
          }
          await this.sendMarkdown(c, event.text, keyboard ? { reply_markup: keyboard } : {});
        });
        return;
      }
      case 'file':
        this.seal(c);
        this.enqueue(c, () => this.sendFile(c, event));
        return;
      case 'error':
        this.clearProgress(c, false);
        this.enqueue(c, () => this.sendHtml(c, errorHtml(event.text)));
        return;
    }
  }

  private chat(conversationId: string): ChatState | undefined {
    let state = this.chats.get(conversationId);
    if (state) return state;
    const parsed = parseConversation(conversationId);
    if (!parsed) return undefined;
    state = { ...parsed, streamed: new Set(), approvals: new Map() };
    this.chats.set(conversationId, state);
    return state;
  }

  /** Telegram calls for one chat run in order, so messages never overtake each other. */
  private enqueue(conversationId: string, task: () => Promise<unknown>): void {
    this.queue.run(conversationId, task).catch((err) => log.warn({ err: (err as Error).message, conversationId }, 'telegram: send failed'));
  }

  /** Ends the current streamed message; the next text starts a new one below. */
  private seal(conversationId: string): void {
    const state = this.chat(conversationId)!;
    const stream = state.stream;
    if (!stream) return;
    clearTimeout(stream.timer);
    stream.timer = undefined;
    state.stream = undefined;
    this.enqueue(conversationId, () => this.flush(conversationId, stream));
  }

  /** Shows a stream's text so far: edits its message, and moves on to new messages past the length limit. */
  private async flush(conversationId: string, stream: Stream): Promise<void> {
    const snapshot = stream.text;
    if (!snapshot.trim()) return;
    const chunks = splitMarkdown(snapshot);
    for (const [i, chunk] of chunks.entries()) {
      if (i === 0 && stream.messageId !== undefined) {
        if (chunk !== stream.shown) await this.editMarkdown(conversationId, stream.messageId, chunk);
      } else {
        stream.messageId = await this.sendMarkdownChunk(conversationId, chunk);
      }
      stream.shown = chunk;
    }
    // Finished pieces stay as they are; keep streaming into the last one.
    if (chunks.length > 1) stream.text = chunks.at(-1)! + stream.text.slice(snapshot.length);
  }

  private consoleOn(conversationId: string, bot: string): boolean {
    return this.deps.prefs?.consoleOn(conversationId, bot) ?? true;
  }

  private progress(conversationId: string, step: ConsoleStep): void {
    const state = this.chat(conversationId)!;
    this.seal(conversationId);
    const progress = (state.progress ??= { lead: step.agent, steps: [], startedAt: Date.now() });
    progress.steps.push(step);
    if (progress.steps.length > 300) progress.steps.splice(0, progress.steps.length - 300);
    this.drawProgress(conversationId, progress, true);
    progress.ticker ??= setInterval(() => {
      // Nothing runs any more (e.g. a status after the reply): close the card.
      if (!this.busy.has(conversationId) && !this.deps.gateway.isRunning(conversationId)) return this.clearProgress(conversationId);
      this.drawProgress(conversationId, progress, false);
    }, PROGRESS_TICK_MS);
  }

  /** Redraws the live card soon. `move`: bring it back to the bottom if messages came after it. */
  private drawProgress(conversationId: string, progress: NonNullable<ChatState['progress']>, move: boolean): void {
    const state = this.chat(conversationId)!;
    if (progress.timer) return;
    progress.timer = setTimeout(() => {
      progress.timer = undefined;
      this.enqueue(conversationId, async () => {
        if (state.progress !== progress) return;
        const html = renderLive(progress.lead, progress.steps, progress.startedAt);
        if (progress.messageId !== undefined && progress.messageId === state.lastMessageId) {
          await this.editHtml(conversationId, progress.messageId, html);
        } else if (move || progress.messageId === undefined) {
          if (progress.messageId !== undefined) await this.bots.get(state.bot)?.api.deleteMessage(state.chatId, progress.messageId).catch(() => {});
          progress.messageId = await this.sendHtml(conversationId, html, { disable_notification: true });
        }
      });
    }, move ? PROGRESS_EDIT_MS : 0);
  }

  /** Ends the live card: a turn that used tools leaves a one-line summary (steps folded inside); otherwise it goes. */
  private clearProgress(conversationId: string, ok = true): void {
    const state = this.chat(conversationId)!;
    const progress = state.progress;
    if (!progress) return;
    clearTimeout(progress.timer);
    clearInterval(progress.ticker);
    state.progress = undefined;
    const used = progress.steps.some((s) => s.kind === 'tool');
    this.enqueue(conversationId, async () => {
      if (progress.messageId === undefined) {
        if (used) await this.sendHtml(conversationId, renderDone(progress.lead, progress.steps, progress.startedAt, ok), { disable_notification: true });
        return;
      }
      if (used) await this.editHtml(conversationId, progress.messageId, renderDone(progress.lead, progress.steps, progress.startedAt, ok));
      else await this.bots.get(state.bot)?.api.deleteMessage(state.chatId, progress.messageId).catch(() => {});
    });
  }

  // ── Telegram API wrappers ──────────────────────────────────────────────────────

  private async sendMarkdown(conversationId: string, md: string, extra: SendExtra = {}): Promise<number | undefined> {
    let last: number | undefined;
    const chunks = splitMarkdown(md);
    for (const [i, chunk] of chunks.entries()) {
      last = await this.sendMarkdownChunk(conversationId, chunk, i === chunks.length - 1 ? extra : { disable_notification: extra.disable_notification });
    }
    return last;
  }

  private async sendMarkdownChunk(conversationId: string, md: string, extra: SendExtra = {}): Promise<number | undefined> {
    try {
      return await this.sendHtml(conversationId, toTelegramHtml(md), extra);
    } catch (err) {
      if (!isParseError(err)) throw err;
      return this.sendRaw(conversationId, md, extra, false);
    }
  }

  private sendHtml(conversationId: string, html: string, extra: SendExtra = {}): Promise<number | undefined> {
    return this.sendRaw(conversationId, html, extra, true);
  }

  private async sendRaw(conversationId: string, text: string, extra: SendExtra, html: boolean): Promise<number | undefined> {
    const state = this.chat(conversationId);
    const bot = state && this.bots.get(state.bot);
    if (!state || !bot) return undefined;
    const msg = await bot.api.sendMessage(state.chatId, text, { ...(html ? { parse_mode: 'HTML' as const } : {}), link_preview_options: { is_disabled: true }, ...extra });
    state.lastMessageId = msg.message_id;
    return msg.message_id;
  }

  /** Uploads a file the way it is best shown; anything Telegram refuses as media goes as a document. */
  private async sendFile(conversationId: string, event: Extract<Outbound, { type: 'file' }>): Promise<void> {
    const state = this.chat(conversationId);
    const bot = state && this.bots.get(state.bot);
    if (!state || !bot) return;
    const caption = event.caption ? event.caption.slice(0, CAPTION_LIMIT) : undefined;
    const html = caption ? toTelegramHtml(caption) : undefined;
    const send = async (kind: typeof event.kind, parse: boolean) => {
      const file = new InputFile(event.path, event.name);
      const extra = { caption: parse ? (html && html.length <= CAPTION_LIMIT ? html : escapeHtml(caption ?? '').slice(0, CAPTION_LIMIT)) || undefined : caption, ...(parse ? { parse_mode: 'HTML' as const } : {}) };
      const api = bot.api;
      switch (kind) {
        case 'photo':
          return api.sendPhoto(state.chatId, file, extra);
        case 'video':
          return api.sendVideo(state.chatId, file, { ...extra, supports_streaming: true });
        case 'animation':
          return api.sendAnimation(state.chatId, file, extra);
        case 'audio':
          return api.sendAudio(state.chatId, file, extra);
        case 'voice':
          return api.sendVoice(state.chatId, file, extra);
        default:
          return api.sendDocument(state.chatId, file, extra);
      }
    };
    await bot.api.sendChatAction(state.chatId, event.kind === 'photo' ? 'upload_photo' : event.kind === 'video' ? 'upload_video' : event.kind === 'voice' ? 'upload_voice' : 'upload_document').catch(() => {});
    let msg;
    try {
      msg = await send(event.kind, true);
    } catch (err) {
      if (isParseError(err)) msg = await send(event.kind, false);
      else if (event.kind !== 'document' && err instanceof GrammyError && err.error_code === 400) msg = await send('document', true);
      else throw err;
    }
    state.lastMessageId = msg.message_id;
  }

  private async editMarkdown(conversationId: string, messageId: number, md: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.edit(conversationId, messageId, toTelegramHtml(md), true, keyboard);
    } catch (err) {
      if (!isParseError(err)) throw err;
      await this.edit(conversationId, messageId, md, false, keyboard);
    }
  }

  private editHtml(conversationId: string, messageId: number, html: string): Promise<void> {
    return this.edit(conversationId, messageId, html, true);
  }

  private async edit(conversationId: string, messageId: number, text: string, html: boolean, keyboard?: InlineKeyboard): Promise<void> {
    const state = this.chat(conversationId);
    const bot = state && this.bots.get(state.bot);
    if (!state || !bot) return;
    try {
      await bot.api.editMessageText(state.chatId, messageId, text, {
        ...(html ? { parse_mode: 'HTML' as const } : {}),
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }
}
