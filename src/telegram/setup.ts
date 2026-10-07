import type { SecretStore } from '../secrets/store.ts';
import type { AuthFlow } from '../auth/types.ts';
import { formFlow } from '../auth/flows.ts';

/** Where a bot's token is stored: Sunny's own bot, or an agent's. */
export const botSecretId = (bot: string) => (bot === 'sunny' ? 'telegram:bot' : `telegram:bot:${bot}`);
export const BOT_SECRET_ID = botSecretId('sunny');

const TOKEN_SHAPE = /^\d{5,}:[\w-]{30,}$/;

/** Asks Telegram who the token belongs to. Never logs or returns the token. */
export async function checkBotToken(token: string, doFetch: typeof fetch = fetch, apiRoot = 'https://api.telegram.org'): Promise<{ username: string; id: number } | { error: string }> {
  if (!TOKEN_SHAPE.test(token)) return { error: 'That does not look like a bot token (it should look like 123456789:AA…).' };
  let res: Response;
  try {
    res = await doFetch(`${apiRoot}/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { error: `Could not reach Telegram: ${(err as Error).message}` };
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { id?: number; username?: string; is_bot?: boolean }; description?: string };
  if (res.status === 401 || res.status === 404) return { error: 'Telegram rejected this token. Copy it again from @BotFather.' };
  if (!body.ok || !body.result?.username) return { error: `Telegram said: ${body.description ?? res.status}` };
  return { username: body.result.username, id: body.result.id ?? 0 };
}

/**
 * The one-time page that collects a bot token. `check` can refuse a valid token, e.g. one
 * another of Sunny's bots already uses.
 */
export function botTokenFlow(
  secrets: SecretStore,
  bot: string,
  onSaved: (token: string) => Promise<void>,
  check: (botId: number) => string | undefined = () => undefined,
  apiRoot?: string,
): AuthFlow {
  const forAgent = bot !== 'sunny';
  return formFlow(secrets, {
    title: forAgent ? `Telegram bot for ${bot}` : 'Connect a Telegram bot',
    description: [
      `In Telegram, open @BotFather, send /newbot and follow the steps${forAgent ? ` (for example name "${bot[0]!.toUpperCase()}${bot.slice(1)}")` : ''}. It gives you a token that looks like 123456789:AA…; paste it here.`,
      forAgent
        ? `Sunny then sets the bot's name, description and picture, and only you (and people you give access to ${bot}) can use it.`
        : 'After saving, Sunny sends you a link that pairs your Telegram account with the bot.',
    ].join('\n\n'),
    links: [{ label: 'Open @BotFather', url: 'https://t.me/BotFather' }],
    fields: [{ name: 'token', label: 'Bot token', type: 'password' }],
    secretId: botSecretId(bot),
    label: forAgent ? `Telegram bot (${bot})` : 'Telegram bot',
    validate: async ({ token = '' }) => {
      const result = await checkBotToken(token, fetch, apiRoot);
      return 'error' in result ? result.error : check(result.id);
    },
    onSaved: ({ token = '' }) => onSaved(token),
  });
}
