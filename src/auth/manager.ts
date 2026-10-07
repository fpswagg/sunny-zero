import { randomBytes } from 'node:crypto';
import { log } from '../log.ts';
import type { AuthFlow, FlowContext, Screen } from './types.ts';

export interface AuthLink {
  token: string;
  url: string;
  title: string;
  expiresAt: number;
}

interface Pending {
  flow: AuthFlow;
  ctx: FlowContext;
  screen?: Screen;
  expiresAt: number;
  finished: boolean;
  attempts: number;
  onFinish?: (ok: boolean, screen: Screen) => void;
}

const MAX_ATTEMPTS = 20;

/**
 * One-time links to the auth page. Each link runs one flow; it expires after a TTL and stops
 * accepting input once the flow is done or failed.
 */
export class AuthManager {
  private pending = new Map<string, Pending>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly publicUrl: string,
    private readonly ttlMs: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get oauthRedirectUri(): string {
    return `${this.publicUrl}/auth/oauth/callback`;
  }

  create(flow: AuthFlow, onFinish?: Pending['onFinish']): AuthLink {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.pending.set(token, {
      flow,
      ctx: { token, oauthRedirectUri: this.oauthRedirectUri },
      expiresAt,
      finished: false,
      attempts: 0,
      onFinish,
    });
    return { token, url: `${this.publicUrl}/auth/${token}`, title: flow.title, expiresAt };
  }

  private live(token: string): Pending | undefined {
    const p = this.pending.get(token);
    if (!p || p.expiresAt < Date.now()) return undefined;
    return p;
  }

  /** When an open link expires (undefined once its flow has finished). */
  expiry(token: string): number | undefined {
    const p = this.live(token);
    return p && !p.finished ? p.expiresAt : undefined;
  }

  /** The current screen for a link, or undefined when the link is unknown or expired. */
  async view(token: string): Promise<Screen | undefined> {
    const p = this.live(token);
    if (!p) return undefined;
    p.screen ??= await this.guard(p, () => p.flow.start(p.ctx));
    return p.screen;
  }

  async submit(token: string, values: Record<string, string>): Promise<Screen | undefined> {
    const p = this.live(token);
    if (!p) return undefined;
    if (p.finished) return p.screen;
    if (++p.attempts > MAX_ATTEMPTS) return this.finish(p, { kind: 'failed', title: p.flow.title, message: 'Too many attempts. Ask Sunny for a new link.' });
    return this.advance(p, () => p.flow.submit(values, p.ctx));
  }

  async callback(state: string, params: URLSearchParams): Promise<Screen | undefined> {
    const p = this.live(state);
    if (!p || !p.flow.callback) return undefined;
    if (p.finished) return p.screen;
    return this.advance(p, () => p.flow.callback!(params, p.ctx));
  }

  private async advance(p: Pending, step: () => Promise<Screen>): Promise<Screen> {
    const screen = await this.guard(p, step);
    if (screen.kind === 'done' || screen.kind === 'failed') return this.finish(p, screen);
    p.screen = screen;
    return screen;
  }

  private async guard(p: Pending, step: () => Promise<Screen>): Promise<Screen> {
    try {
      return await step();
    } catch (err) {
      log.error({ err, flow: p.flow.title }, 'auth flow failed');
      return { kind: 'failed', title: p.flow.title, message: `Something went wrong: ${(err as Error).message}` };
    }
  }

  private finish(p: Pending, screen: Screen): Screen {
    p.finished = true;
    p.screen = screen;
    // Keep the final screen viewable for a few minutes (refreshes), then drop the link.
    p.expiresAt = Math.min(p.expiresAt, Date.now() + 5 * 60_000);
    p.onFinish?.(screen.kind === 'done', screen);
    return screen;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, p] of this.pending) {
      if (p.expiresAt >= now) continue;
      this.pending.delete(token);
      if (!p.finished) p.onFinish?.(false, { kind: 'failed', title: p.flow.title, message: 'The link expired.' });
    }
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
