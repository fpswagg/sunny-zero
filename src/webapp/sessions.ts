import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Browser sessions for the agent web apps: the cookie holds a random token, the database its hash. */
export class WebSessions {
  /** One-time links that sign a browser in (opened from Telegram): token → user, agent, expiry. */
  private links = new Map<string, { userId: string; agent: string; expiresAt: number }>();

  constructor(
    private readonly sql: Sql,
    readonly ttlMs = 30 * 24 * 3600_000,
  ) {}

  async create(userId: string, userAgent?: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.sql`
      insert into web_sessions (token_hash, user_id, expires_at, user_agent)
      values (${hash(token)}, ${userId}, ${new Date(Date.now() + this.ttlMs)}, ${userAgent?.slice(0, 300) ?? null})`;
    return token;
  }

  /** The user a session token belongs to; slides the expiry (at most once an hour). */
  async verify(token: string | undefined): Promise<string | undefined> {
    if (!token || token.length < 32 || token.length > 100) return undefined;
    const [row] = await this.sql<{ user_id: string; last_seen_at: Date }[]>`
      select user_id, last_seen_at from web_sessions where token_hash = ${hash(token)} and expires_at > now()`;
    if (!row) return undefined;
    if (Date.now() - row.last_seen_at.getTime() > 3600_000) {
      await this.sql`update web_sessions set last_seen_at = now(), expires_at = ${new Date(Date.now() + this.ttlMs)} where token_hash = ${hash(token)}`;
    }
    return row.user_id;
  }

  async revoke(token: string): Promise<void> {
    await this.sql`delete from web_sessions where token_hash = ${hash(token)}`;
  }

  async prune(): Promise<void> {
    await this.sql`delete from web_sessions where expires_at < now()`;
  }

  /** A single-use link token, valid `ttlMs` (default 10 minutes). */
  link(userId: string, agent: string, ttlMs = 10 * 60_000): string {
    for (const [t, l] of this.links) if (l.expiresAt < Date.now()) this.links.delete(t);
    const token = randomBytes(24).toString('base64url');
    this.links.set(token, { userId, agent, expiresAt: Date.now() + ttlMs });
    return token;
  }

  consumeLink(token: string, agent: string): string | undefined {
    const l = this.links.get(token);
    if (!l) return undefined;
    this.links.delete(token);
    return l.expiresAt >= Date.now() && l.agent === agent ? l.userId : undefined;
  }
}
