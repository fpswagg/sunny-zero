import { log } from '../log.ts';
import { AUTH_FAILURE, LIMIT_REACHED, type ClaudeAccount } from './claude-accounts.ts';

/** The part of ClaudeAccounts the fallback needs (so tests can fake it). */
export interface AccountsLike {
  list(): Promise<ClaudeAccount[]>;
  switchTo(which: string): Promise<ClaudeAccount>;
  probe(which: string): Promise<'ok' | 'dead' | 'unknown'>;
}

export interface SettingsLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface AccountHealth {
  lastOk?: string;
  lastFail?: string;
  lastError?: string;
  /** When the account may work again, as Claude worded it ("resets 3pm"), if it said. */
  resetHint?: string;
}

/** Stored under the `subscription_fallback` setting. */
export interface FallbackState {
  /** The account that should normally be in use. */
  main?: string;
  /** The account agents run on now. */
  current?: string;
  switchedAt?: string;
  accounts: Record<string, AccountHealth>;
}

export const FALLBACK_KEY = 'subscription_fallback';
/** Setting: which account is MAIN (id, label or e-mail). */
export const CLAUDE_MAIN_KEY = 'claude_main';
const PROBE_EVERY_MS = 5 * 60_000;
/** After a failure, the other account is not abandoned again for this long unless it worked since. */
const FLAP_GUARD_MS = 60_000;
const OK_WRITE_EVERY_MS = 60_000;

/**
 * Claude subscriptions: agents run on the account in use. When it stops working (expired session, 403,
 * limit reached), the next run switches to the next account and retries. There is no MAIN: the account
 * switched to simply becomes the one in use. No restart needed.
 */
export class SubscriptionFallback {
  private lastProbe = 0;
  private lastOkWrite = 0;

  constructor(
    private readonly accounts: AccountsLike,
    private readonly settings: SettingsLike,
    private readonly mainRef: () => Promise<string>,
    private readonly now: () => number = Date.now,
    private readonly notify?: (text: string) => void,
  ) {}

  /** The login is dead (expired session, 401/403) or the plan's limit is reached: another account may work. */
  static isFailure(text: string): boolean {
    return AUTH_FAILURE.test(text) || LIMIT_REACHED.test(text);
  }

  static resetHint(text: string): string | undefined {
    return text.match(/resets?\s+(?:at\s+|in\s+)?([^.\n()]{2,40})/i)?.[1]?.trim();
  }

  async state(): Promise<FallbackState> {
    return (await this.settings.get<FallbackState>(FALLBACK_KEY)) ?? { accounts: {} };
  }

  private async save(state: FallbackState): Promise<void> {
    await this.settings.set(FALLBACK_KEY, state);
  }

  private async resolveMain(list: ClaudeAccount[]): Promise<ClaudeAccount | undefined> {
    const q = ((await this.mainRef()) ?? '').toLowerCase();
    return list.find((a) => a.id === q || a.email?.toLowerCase() === q || a.label.toLowerCase() === q) ?? list.find((a) => a.email?.toLowerCase().startsWith(q) || a.id.startsWith(q));
  }

  /** Before a run on the subscription: nothing to do. The account in use stays in use until it fails. */
  async beforeRun(): Promise<void> {}

  /** A run on the subscription worked: remember it for the account in use, and try to return to the main account if it recovered. */
  async onSuccess(): Promise<void> {
    if (this.now() - this.lastOkWrite < OK_WRITE_EVERY_MS) return;
    this.lastOkWrite = this.now();
    try {
      const list = await this.accounts.list();
      const active = list.find((a) => a.active);
      if (!active) return;
      const state = await this.state();
      (state.accounts[active.id] ??= {}).lastOk = new Date(this.now()).toISOString();
      state.current = active.id;
      // If we're on a fallback account, periodically probe the main account to see if it recovered.
      if (state.main && state.main !== active.id && this.now() - this.lastProbe > PROBE_EVERY_MS) {
        this.lastProbe = this.now();
        const mainHealth = state.accounts[state.main];
        const main = list.find((a) => a.id === state.main);
        if (main && mainHealth?.lastFail && mainHealth.resetHint) {
          const probeResult = await this.accounts.probe(state.main);
          if (probeResult === 'ok') {
            // The main account recovered: switch back.
            await this.accounts.switchTo(state.main);
            state.current = state.main;
            delete mainHealth.lastFail;
            delete mainHealth.lastError;
            delete mainHealth.resetHint;
            log.info({ resumed: state.main }, 'claude subscription: main account recovered, switched back');
            this.notify?.(`✅ Claude: ${main.label} is ready again. Agents switched back.`);
          }
        }
      }
      await this.save(state);
    } catch (err) {
      log.warn({ err }, 'claude subscription fallback could not record a success');
    }
  }

  /** A run on the subscription failed with `error`. True when another account is now live, so the run should retry. */
  async onFailure(error: string): Promise<boolean> {
    if (!SubscriptionFallback.isFailure(error)) return false;
    try {
      const list = await this.accounts.list();
      const active = list.find((a) => a.active);
      const other = list.find((a) => !a.active);
      if (!active || !other || list.length < 2) return false;
      const state = await this.state();
      const now = new Date(this.now()).toISOString();
      const failed = (state.accounts[active.id] ??= {});
      failed.lastFail = now;
      failed.lastError = error.split('\n')[0]!.slice(0, 200);
      failed.resetHint = SubscriptionFallback.resetHint(error);
      const target = state.accounts[other.id] ?? {};
      const targetFailedRecently = target.lastFail && this.now() - Date.parse(target.lastFail) < FLAP_GUARD_MS && !(target.lastOk && target.lastOk > target.lastFail);
      if (targetFailedRecently) {
        await this.save(state);
        log.warn({ failed: active.label, other: other.label }, 'claude subscription: both accounts failed, not switching');
        return false;
      }
      await this.accounts.switchTo(other.id);
      state.current = other.id;
      state.switchedAt = now;
      state.main = (await this.resolveMain(list))?.id ?? state.main;
      await this.save(state);
      this.lastProbe = this.now();
      log.warn({ failed: active.label, now: other.label, error: failed.lastError, resets: failed.resetHint }, 'claude subscription: account failed, switched to the other one');
      this.notify?.(`⚠️ Claude: ${active.label} failed (${failed.lastError})${failed.resetHint ? `, resets ${failed.resetHint}` : ''}. Agents now run on ${other.label}.`);
      return true;
    } catch (err) {
      log.warn({ err }, 'claude subscription fallback could not switch');
      return false;
    }
  }
}
