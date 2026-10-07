import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AuthFlow, Field, Screen } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { ApiError, UNTRUSTED_NOTE, WriteBudget, guard, ok } from '../shared.ts';
import { GramAuth, GramPort, type TelegramAuthPort, type TelegramPort } from './port.ts';

export const TELEGRAM_USER_SECRET_ID = 'telegram-user:account';

export interface TelegramUserDeps {
  secrets: SecretStore;
  /** Test seams. */
  makePort?: (apiId: number, apiHash: string, session: string) => TelegramPort;
  makeAuth?: () => TelegramAuthPort;
}

/** Telegram's own errors, in plain words. */
export function explainTelegram(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const wait = /A wait of (\d+) seconds/.exec(msg) ?? /FLOOD_WAIT_(\d+)/.exec(msg);
  if (wait) return `Telegram asks to slow down: wait ${wait[1]} seconds before this action. Sending too fast can get an account limited.`;
  if (/PEER_FLOOD/.test(msg)) return 'Telegram flagged this account for sending too much (PEER_FLOOD). Stop sending for a while.';
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(msg)) return 'The Telegram session is no longer valid. Ask the owner to run the Telegram setup again.';
  if (/PHONE_CODE_INVALID/.test(msg)) return 'That code is wrong.';
  if (/PHONE_CODE_EXPIRED/.test(msg)) return 'That code expired. Start the setup again to get a new one.';
  if (/PASSWORD_HASH_INVALID/.test(msg)) return 'That two-step verification password is wrong.';
  if (/PHONE_NUMBER_INVALID/.test(msg)) return 'That phone number is not valid. Use the international format, e.g. +237600000000.';
  if (/API_ID_INVALID/.test(msg)) return 'The api_id/api_hash pair is wrong. Copy both from my.telegram.org.';
  if (/MESSAGE_ID_INVALID|MESSAGE_NOT_MODIFIED/.test(msg)) return msg.includes('NOT_MODIFIED') ? 'The new text is the same as the old one.' : 'That message id does not exist in this chat.';
  if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL/.test(msg)) return 'The owner cannot write in this chat.';
  return msg;
}

const fmtTime = (s: number | undefined) => (s ? new Date(s * 1000).toISOString() : undefined);

/**
 * The owner's personal Telegram account (not a bot) over MTProto, with a session the owner
 * creates by signing in once (phone, code, optional 2FA password). The session string is as
 * powerful as the account, so it is stored encrypted and never shown to agents.
 *
 * Telegram allows personal API clients but bans accounts that look like spam, so this is kept
 * conservative: messages only go to chats the owner already has (never cold contacts), plain
 * text only (no forwarding, joining, bulk or media), edits and deletes only touch the owner's
 * own messages, and writes are capped per hour. Reading does not mark chats as read.
 */
export function telegramUserConnector(deps: TelegramUserDeps): Connector & { stop(): Promise<void> } {
  const makePort = deps.makePort ?? ((id, hash, session) => new GramPort(id, hash, session));
  const makeAuth = deps.makeAuth ?? (() => new GramAuth());
  const sends = new WriteBudget(20, 60 * 60_000);
  const changes = new WriteBudget(40, 60 * 60_000);
  let port: TelegramPort | undefined;

  const get = async (): Promise<TelegramPort> => {
    if (port) return port;
    const c = await deps.secrets.get(TELEGRAM_USER_SECRET_ID);
    if (!c?.session || !c.api_id || !c.api_hash) throw new ApiError('Telegram (personal account) is not connected: ask the owner to open the setup link (Sunny: setup_connector telegram-user).');
    return (port = makePort(Number(c.api_id), c.api_hash, c.session));
  };
  const run = <T>(fn: (p: TelegramPort) => Promise<T>) => async () => {
    try {
      return await fn(await get());
    } catch (err) {
      throw err instanceof ApiError ? err : new ApiError(explainTelegram(err));
    }
  };
  const fmt = (m: Awaited<ReturnType<TelegramPort['send']>>) => ({ ...m, at: fmtTime(m.at) });

  const setup = (): AuthFlow => {
    let auth: TelegramAuthPort | undefined;
    let creds: { api_id: string; api_hash: string } | undefined;
    const title = 'Connect your Telegram account';
    const f1: Field[] = [
      { name: 'api_id', label: 'api_id', type: 'number', help: 'From my.telegram.org → API development tools.' },
      { name: 'api_hash', label: 'api_hash', type: 'password' },
      { name: 'phone', label: 'Phone number', type: 'tel', placeholder: '+237600000000' },
    ];
    const form1 = (error?: string, values: Record<string, string> = {}): Screen => ({
      kind: 'form',
      title,
      description:
        'Agents will read your chats and, after asking you, send, edit and delete your own messages in chats you already have. Sunny keeps this to a few messages an hour because Telegram limits accounts that look automated. The session created here gives full access to your account: it is stored encrypted and never shown to agents. You can end it any time in Telegram → Settings → Devices.',
      links: [{ label: 'my.telegram.org', url: 'https://my.telegram.org/apps' }],
      fields: f1.map((f) => (f.name === 'api_hash' ? f : { ...f, value: values[f.name] })),
      submitLabel: 'Send me the code',
      error,
    });
    const form2 = (error?: string): Screen => ({ kind: 'form', title, description: 'Telegram sent a login code to your Telegram app (or SMS). Enter it here.', fields: [{ name: 'code', label: 'Login code' }], submitLabel: 'Sign in', error });
    const form3 = (error?: string): Screen => ({ kind: 'form', title, description: 'This account has two-step verification. Enter its password.', fields: [{ name: 'password', label: 'Two-step verification password', type: 'password' }], submitLabel: 'Sign in', error });
    let step: 1 | 2 | 3 = 1;

    const finish = async (): Promise<Screen> => {
      await deps.secrets.set(TELEGRAM_USER_SECRET_ID, { ...creds!, session: auth!.session() }, { kind: 'steps', label: 'Telegram personal account' });
      await auth!.close();
      auth = undefined;
      await port?.close();
      port = undefined;
      return { kind: 'done', title, message: 'Signed in. You can close this page and go back to the chat.' };
    };

    return {
      title,
      start: async () => ((step = 1), form1()),
      submit: async (v) => {
        try {
          if (step === 1) {
            const apiId = Number(v.api_id);
            if (!Number.isInteger(apiId) || !v.api_hash?.trim() || !v.phone?.trim()) return form1('Fill in api_id, api_hash and your phone number.', v);
            creds = { api_id: String(apiId), api_hash: v.api_hash.trim() };
            auth = makeAuth();
            await auth.sendCode(apiId, creds.api_hash, v.phone.trim());
            step = 2;
            return form2();
          }
          if (!auth) return form1('The login expired. Start again.');
          if (step === 2) {
            if (!v.code?.trim()) return form2('Enter the code.');
            if ((await auth.signIn(v.code)) === 'password') {
              step = 3;
              return form3();
            }
            return await finish();
          }
          if (!v.password) return form3('Enter the password.');
          await auth.password(v.password);
          return await finish();
        } catch (err) {
          const message = explainTelegram(err);
          if (step === 1) return form1(message, v);
          if (/expired|Start again/.test(message)) {
            step = 1;
            return form1(message);
          }
          return step === 2 ? form2(message) : form3(message);
        }
      },
    };
  };

  return {
    name: 'telegram-user',
    description: "The owner's personal Telegram account (not a bot): list chats, read and search messages; send, edit and delete the owner's own messages in existing chats (asking first).",
    mutatingTools: ['send', 'edit', 'delete'],
    status: async () => ((await deps.secrets.has(TELEGRAM_USER_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in (setup)' }),
    setup,
    stop: async () => {
      await port?.close();
      port = undefined;
    },
    server: () =>
      createSdkMcpServer({
        name: 'telegram-user',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('me', 'The signed-in Telegram account.', {}, guard(async () => ok(await run((p) => p.me())()))),
          tool(
            'list_chats',
            'The owner’s chats (people, groups, channels) with unread counts and the last message. `query` filters by name or @username.',
            { query: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).default(30) },
            guard(async ({ query, limit }) => {
              const chats = await run((p) => p.chats(limit, query))();
              return ok({ note: UNTRUSTED_NOTE, results: chats.map((c) => ({ ...c, lastAt: fmtTime(c.lastAt) })) });
            }),
          ),
          tool(
            'get_messages',
            'Recent messages of a chat, newest first (chat = id, @username or exact title from list_chats; "me" is Saved Messages). Does not mark the chat as read.',
            { chat: z.string().min(1), limit: z.number().int().min(1).max(100).default(30), beforeId: z.number().int().optional().describe('older than this message id') },
            guard(async ({ chat, limit, beforeId }) => ok({ note: UNTRUSTED_NOTE, results: (await run((p) => p.messages(chat, limit, beforeId))()).map(fmt) })),
          ),
          tool(
            'search',
            'Search message text, in one chat or across all of them.',
            { query: z.string().min(1).max(200), chat: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) },
            guard(async ({ query, chat, limit }) => ok({ note: UNTRUSTED_NOTE, results: (await run((p) => p.search(query, limit, chat))()).map(fmt) })),
          ),
          tool(
            'send',
            'Send a text message from the owner’s account to a chat they already have. Plain text only, max 4096 characters, about 20 an hour.',
            { chat: z.string().min(1), text: z.string().min(1).max(4096), replyTo: z.number().int().optional() },
            guard(async ({ chat, text, replyTo }) => {
              sends.take('messages');
              return ok({ sent: fmt(await run((p) => p.send(chat, text, replyTo))()) });
            }),
          ),
          tool(
            'edit',
            'Edit one of the owner’s own messages.',
            { chat: z.string().min(1), messageId: z.number().int(), text: z.string().min(1).max(4096) },
            guard(async ({ chat, messageId, text }) => {
              changes.take('edits and deletes');
              return ok({ edited: fmt(await run((p) => p.edit(chat, messageId, text))()) });
            }),
          ),
          tool(
            'delete',
            'Delete up to 10 of the owner’s own messages, for everyone in the chat (permanent). Refuses if any id is not the owner’s own message.',
            { chat: z.string().min(1), messageIds: z.array(z.number().int()).min(1).max(10) },
            guard(async ({ chat, messageIds }) => {
              changes.take('edits and deletes');
              return ok({ deleted: await run((p) => p.delete(chat, messageIds))() });
            }),
          ),
        ],
      }),
  };
}
