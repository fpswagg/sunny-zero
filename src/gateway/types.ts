/** How a sent file is shown: Telegram has a different upload for each. */
export type FileKind = 'photo' | 'video' | 'animation' | 'audio' | 'voice' | 'document';

/**
 * A button under a notice. `command` runs that chat command when pressed (Telegram edits the
 * menu in place), `url` opens a link, `app` opens a page of the Telegram app (e.g. "/agent/helper").
 * Channels without buttons show the commands as text.
 */
export interface Button {
  label: string;
  command?: string;
  url?: string;
  app?: string;
  /** A full https URL opened as a Telegram Mini App (an agent's web app). */
  webApp?: string;
}

/** Events a channel delivers to the user. Channels render what they can and ignore the rest. */
export type Outbound =
  /** Streaming reply text (a delta). */
  | { type: 'text'; agent: string; text: string }
  /** The agent is using a tool. */
  | { type: 'tool'; agent: string; summary: string }
  | { type: 'status'; agent?: string; text: string }
  /** End of a turn, with the full reply (for channels that do not stream). */
  | { type: 'reply'; agent: string; text: string; isError: boolean; costUsd?: number; durationMs: number }
  | { type: 'approval'; id: string; agent: string; summary: string; reason: string; expiresAt: number; always?: boolean }
  | { type: 'approval_closed'; id: string; allowed: boolean; by: 'user' | 'timeout' | 'cancelled'; always?: boolean }
  | { type: 'auth_link'; title: string; url: string; expiresAt: number }
  /** A notification an agent sent with the notify connector. `silent` delivers it without sound. */
  | { type: 'notify'; agent: string; text: string; silent: boolean }
  /** A file an agent sends (chat.send_file). Channels that cannot upload show where it is. */
  | { type: 'file'; agent: string; path: string; name: string; kind: FileKind; caption?: string }
  /** Output of a chat command or a system notice, with optional buttons (rows). */
  | { type: 'notice'; text: string; buttons?: Button[][] }
  | { type: 'error'; text: string };

export interface Channel {
  /** Prefix of the conversation ids this channel owns, e.g. "telegram" for "telegram:12345". */
  id: string;
  send(conversationId: string, event: Outbound): void;
  /** The owner's conversations on this channel that `agent`'s notifications and approvals go to. */
  homes?(agent: string): Promise<string[]>;
  /** A turn started in the conversation (from any source): show that the agent is working. */
  working?(conversationId: string): void;
}

/**
 * Telegram bots: Sunny's own ("sunny") and one per agent that has its own. Used by chat
 * commands and Sunny's tools; implemented by the Telegram hub.
 */
export interface TelegramControl {
  /** Status for Sunny: bots and who started them. Never includes a token or an invite code. */
  describe(): Promise<string>;
  /** Sends the owner the bot-token page for `bot` (not set up yet) or a link to open it. Returns a note for Sunny. */
  setup(conversationId: string, bot: string): Promise<string>;
  /** Stores a token typed in the terminal (`sunny setup telegram`) and starts the bot. */
  setToken(conversationId: string, token: string, bot: string): Promise<void>;
  /** Sends the owner a one-time link that links a Telegram account to `userId` on `bot`. */
  invite(conversationId: string, userId: string, bot: string): Promise<string>;
  /** Re-applies an agent's name, description and icon to its bot, when it has one. */
  refreshProfile(bot: string): Promise<void>;
  /** Stops an agent's bot and forgets its token. */
  removeBot(bot: string): Promise<boolean>;
  /** Whether a bot has a stored token, and its username while it runs. */
  botStatus(bot: string): Promise<{ username?: string; stored: boolean }>;
}

export const channelOf = (conversationId: string) => conversationId.split(':', 1)[0]!;

/**
 * Which conversations a notification goes to. Entries are channel names ("telegram", "cli",
 * "web") or exact conversation ids, and only reach conversations that channel lists as homes
 * (the owner's). With no entries: Telegram, or if that reaches nobody, every open conversation.
 */
export function resolveTargets(entries: string[], homes: Map<string, string[]>): string[] {
  const out = new Set<string>();
  for (const entry of entries.length ? entries : ['telegram']) {
    if (entry.includes(':')) {
      if (homes.get(channelOf(entry))?.includes(entry)) out.add(entry);
    } else {
      for (const id of homes.get(entry) ?? []) out.add(id);
    }
  }
  if (!out.size && !entries.length) for (const ids of homes.values()) for (const id of ids) out.add(id);
  return [...out];
}
