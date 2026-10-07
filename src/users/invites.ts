import { randomInt } from 'node:crypto';

export interface Invite {
  /** User the redeeming account will belong to. */
  userId: string;
  /** Bot the code is valid on ("sunny" or an agent name). */
  bot: string;
  expiresAt: number;
}

export type RedeemResult = { ok: true; invite: Invite } | { ok: false; reason: 'invalid' | 'blocked' };

/** No 0/O, 1/I/L: codes are sometimes typed by hand. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60 * 60_000;

/**
 * One-time codes that link an account to a user: the owner's own extra accounts, or a friend.
 * The owner gets the code in a chat they already control and passes it on. Kept in memory: a
 * restart only invalidates open invites.
 */
export class Invites {
  private codes = new Map<string, Invite>();
  private failures = new Map<string, { count: number; since: number }>();

  constructor(private readonly ttlMs: number) {}

  create(userId: string, bot: string, now = Date.now()): { code: string; expiresAt: number } {
    for (const [code, invite] of this.codes) if (invite.expiresAt < now) this.codes.delete(code);
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const expiresAt = now + this.ttlMs;
    this.codes.set(code, { userId, bot, expiresAt });
    return { code, expiresAt };
  }

  /** Spends a code on `bot` for the account `who`. Repeated wrong codes from one account block it for an hour. */
  redeem(code: string, bot: string, who: string, now = Date.now()): RedeemResult {
    const fails = this.failures.get(who);
    if (fails && now - fails.since > FAILURE_WINDOW_MS) this.failures.delete(who);
    if ((this.failures.get(who)?.count ?? 0) >= MAX_FAILURES) return { ok: false, reason: 'blocked' };

    const normalized = code.trim().toUpperCase();
    const invite = this.codes.get(normalized);
    if (!invite || invite.expiresAt < now || invite.bot !== bot) {
      const f = this.failures.get(who) ?? { count: 0, since: now };
      f.count++;
      this.failures.set(who, f);
      return { ok: false, reason: 'invalid' };
    }
    this.codes.delete(normalized);
    this.failures.delete(who);
    return { ok: true, invite };
  }
}
