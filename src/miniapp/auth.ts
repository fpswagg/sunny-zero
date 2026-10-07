import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** How long a Mini App launch stays valid. Telegram signs initData once, when the app opens. */
export const INIT_DATA_MAX_AGE_S = 24 * 3600;

/**
 * Checks Telegram Mini App launch data (`Telegram.WebApp.initData`): the HMAC Telegram made
 * with the bot's token, and its age. Returns the user, or a reason.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(initData: string, botToken: string, now = Date.now()): { user: WebAppUser } | { error: string } {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { error: 'missing signature' };
  params.delete('hash');
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { error: 'bad signature' };
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > INIT_DATA_MAX_AGE_S) return { error: 'expired: close and reopen the app' };
  try {
    const user = JSON.parse(params.get('user') ?? '') as WebAppUser;
    if (typeof user.id !== 'number') return { error: 'no user' };
    return { user };
  } catch {
    return { error: 'no user' };
  }
}

/** Signs launch data like Telegram does (tests and local previews). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
