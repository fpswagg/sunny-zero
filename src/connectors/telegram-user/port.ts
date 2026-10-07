import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

export interface ChatInfo {
  id: string;
  title: string;
  kind: 'user' | 'group' | 'channel';
  username?: string;
  unread: number;
  lastMessage?: string;
  lastAt?: number;
}

export interface MessageInfo {
  id: number;
  chat: string;
  at: number;
  from?: string;
  out: boolean;
  text: string;
  replyTo?: number;
  media?: string;
  edited?: boolean;
}

/** What the connector needs from Telegram; the real one wraps gramjs, tests use a fake. */
export interface TelegramPort {
  me(): Promise<{ id: string; name: string; username?: string }>;
  chats(limit: number, query?: string): Promise<ChatInfo[]>;
  /** Resolves a chat the owner already has (by id, @username, title or "me"). Never reaches strangers. */
  resolve(chat: string): Promise<{ id: string; title: string } | undefined>;
  messages(chat: string, limit: number, beforeId?: number): Promise<MessageInfo[]>;
  search(query: string, limit: number, chat?: string): Promise<MessageInfo[]>;
  send(chat: string, text: string, replyTo?: number): Promise<MessageInfo>;
  edit(chat: string, id: number, text: string): Promise<MessageInfo>;
  /** Only the owner's own messages; returns the ids that were deleted. */
  delete(chat: string, ids: number[]): Promise<number[]>;
  close(): Promise<void>;
}

export interface TelegramAuthPort {
  sendCode(apiId: number, apiHash: string, phone: string): Promise<void>;
  /** 'password' when the account has two-step verification. */
  signIn(code: string): Promise<'done' | 'password'>;
  password(password: string): Promise<void>;
  session(): string;
  close(): Promise<void>;
}

const kindOf = (e: any): ChatInfo['kind'] => (e instanceof Api.User ? 'user' : e instanceof Api.Channel && !e.megagroup ? 'channel' : 'group'); // eslint-disable-line @typescript-eslint/no-explicit-any
const nameOf = (e: any): string => (e?.title ?? ([e?.firstName, e?.lastName].filter(Boolean).join(' ') || e?.username || String(e?.id ?? ''))); // eslint-disable-line @typescript-eslint/no-explicit-any

function mediaKind(m: Api.Message): string | undefined {
  const x = m.media;
  if (!x) return undefined;
  if (x instanceof Api.MessageMediaPhoto) return 'photo';
  if (x instanceof Api.MessageMediaDocument) return 'file';
  return x.className.replace('MessageMedia', '').toLowerCase();
}

/** Real client over MTProto. Connects on first use with the stored session string. */
export class GramPort implements TelegramPort {
  private client?: TelegramClient;
  private dialogs?: { at: number; list: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
    private readonly session: string,
  ) {}

  private async c(): Promise<TelegramClient> {
    if (this.client) return this.client;
    const client = new TelegramClient(new StringSession(this.session), this.apiId, this.apiHash, { connectionRetries: 3, floodSleepThreshold: 60, useWSS: false });
    client.setLogLevel('none' as never);
    await client.connect();
    if (!(await client.checkAuthorization())) {
      await client.disconnect();
      throw new Error('The Telegram session is no longer valid (logged out or revoked). Ask the owner to run the Telegram setup again.');
    }
    this.client = client;
    return client;
  }

  private async allDialogs() {
    if (this.dialogs && Date.now() - this.dialogs.at < 60_000) return this.dialogs.list;
    const list = [...(await (await this.c()).getDialogs({ limit: 200 }))];
    this.dialogs = { at: Date.now(), list };
    return list;
  }

  private info(m: Api.Message, chat: string): MessageInfo {
    const sender = (m as any).sender; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      id: m.id,
      chat,
      at: m.date,
      from: m.out ? 'me' : sender ? nameOf(sender) : m.senderId?.toString(),
      out: Boolean(m.out),
      text: m.message ?? '',
      replyTo: m.replyTo && 'replyToMsgId' in m.replyTo ? (m.replyTo.replyToMsgId ?? undefined) : undefined,
      media: mediaKind(m),
      edited: m.editDate ? true : undefined,
    };
  }

  async me() {
    const u = (await (await this.c()).getMe()) as Api.User;
    return { id: u.id.toString(), name: nameOf(u), username: u.username ?? undefined };
  }

  async chats(limit: number, query?: string) {
    const q = query?.toLowerCase();
    return (await this.allDialogs())
      .filter((d) => !q || String(d.title ?? '').toLowerCase().includes(q) || String(d.entity?.username ?? '').toLowerCase().includes(q))
      .slice(0, limit)
      .map((d) => ({ id: d.id.toString(), title: d.title ?? nameOf(d.entity), kind: kindOf(d.entity), username: d.entity?.username ?? undefined, unread: d.unreadCount ?? 0, lastMessage: d.message?.message?.slice(0, 120), lastAt: d.message?.date }));
  }

  async resolve(chat: string) {
    const key = chat.trim();
    if (key === 'me') return { id: 'me', title: 'Saved Messages' };
    const wanted = key.replace(/^@/, '').toLowerCase();
    const d = (await this.allDialogs()).find((x) => x.id.toString() === key || String(x.entity?.username ?? '').toLowerCase() === wanted || String(x.title ?? '').toLowerCase() === wanted);
    return d ? { id: d.id.toString(), title: d.title ?? nameOf(d.entity) } : undefined;
  }

  private async entity(chat: string) {
    const r = await this.resolve(chat);
    if (!r) throw new Error(`No chat "${chat}" among the owner's chats. Use list_chats to find it (messages can only go to existing chats).`);
    return { client: await this.c(), peer: r.id === 'me' ? 'me' : (await this.allDialogs()).find((d) => d.id.toString() === r.id)!.inputEntity, id: r.id };
  }

  async messages(chat: string, limit: number, beforeId?: number) {
    const { client, peer, id } = await this.entity(chat);
    return [...(await client.getMessages(peer, { limit, ...(beforeId ? { offsetId: beforeId } : {}) }))].map((m) => this.info(m, id));
  }

  async search(query: string, limit: number, chat?: string) {
    if (chat) {
      const { client, peer, id } = await this.entity(chat);
      return [...(await client.getMessages(peer, { limit, search: query }))].map((m) => this.info(m, id));
    }
    const client = await this.c();
    const res = (await client.invoke(
      new Api.messages.SearchGlobal({ q: query, filter: new Api.InputMessagesFilterEmpty(), minDate: 0, maxDate: 0, offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, limit }),
    )) as Api.messages.MessagesSlice;
    return res.messages.filter((m): m is Api.Message => m instanceof Api.Message).map((m) => this.info(m, m.peerId ? ((m.peerId as any).userId ?? (m.peerId as any).chatId ?? (m.peerId as any).channelId)?.toString() : '')); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async send(chat: string, text: string, replyTo?: number) {
    const { client, peer, id } = await this.entity(chat);
    return this.info(await client.sendMessage(peer, { message: text, ...(replyTo ? { replyTo } : {}), linkPreview: false }), id);
  }

  async edit(chat: string, id: number, text: string) {
    const { client, peer, id: chatId } = await this.entity(chat);
    const [m] = await client.getMessages(peer, { ids: [id] });
    if (!m?.out) throw new Error('Only the owner’s own messages can be edited.');
    return this.info(await client.editMessage(peer, { message: id, text }), chatId);
  }

  async delete(chat: string, ids: number[]) {
    const { client, peer } = await this.entity(chat);
    const found = await client.getMessages(peer, { ids });
    const own = found.filter((m) => m?.out).map((m) => m.id);
    if (own.length !== ids.length) throw new Error('Only the owner’s own messages can be deleted, and every id must exist. Nothing was deleted.');
    await client.deleteMessages(peer, own, { revoke: true });
    return own;
  }

  async close() {
    await this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
  }
}

/** Login helper: code, then optional two-step password; yields the session string. */
export class GramAuth implements TelegramAuthPort {
  private client?: TelegramClient;
  private creds?: { apiId: number; apiHash: string };
  private phone = '';
  private hash = '';

  async sendCode(apiId: number, apiHash: string, phone: string) {
    await this.close();
    this.creds = { apiId, apiHash };
    this.phone = phone;
    this.client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    this.client.setLogLevel('none' as never);
    await this.client.connect();
    this.hash = (await this.client.sendCode(this.creds, phone)).phoneCodeHash;
  }

  async signIn(code: string) {
    if (!this.client) throw new Error('Start again: the login expired.');
    try {
      await this.client.invoke(new Api.auth.SignIn({ phoneNumber: this.phone, phoneCodeHash: this.hash, phoneCode: code.replace(/\s/g, '') }));
      return 'done' as const;
    } catch (err) {
      if ((err as Error).message.includes('SESSION_PASSWORD_NEEDED')) return 'password' as const;
      throw err;
    }
  }

  async password(password: string) {
    if (!this.client || !this.creds) throw new Error('Start again: the login expired.');
    let failure: Error | undefined;
    await this.client.signInWithPassword(this.creds, {
      password: async () => password,
      onError: async (e) => {
        failure = e;
        return true;
      },
    });
    if (failure) throw failure;
  }

  session() {
    return (this.client!.session as StringSession).save();
  }

  async close() {
    await this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
  }
}
