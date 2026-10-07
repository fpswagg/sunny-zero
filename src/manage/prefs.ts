import type { SettingsStore } from './settings.ts';

interface Stored {
  /** Live console card (Telegram): `global`, then per agent bot, then per chat (most specific wins). */
  console?: { global?: boolean; agents?: Record<string, boolean>; chats?: Record<string, boolean> };
  /** Light model for voice turns, per agent (overrides the global switch). */
  voiceLight?: Record<string, boolean>;
  /** Daily spend limit per agent ("*" = every agent without its own). `block`: refuse runs once reached; otherwise only alert. */
  budgets?: Record<string, { dailyUsd: number; block: boolean }>;
  /** Quiet hours: agent notifications arrive without sound between `from` and `to` (HH:MM, owner's time zone). */
  quiet?: { enabled: boolean; from: string; to: string };
}

export interface Budget {
  dailyUsd: number;
  block: boolean;
}

export interface Quiet {
  enabled: boolean;
  from: string;
  to: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (s: string) => HHMM.test(s);

const KEY = 'prefs';

export type ConsoleScope = { global: true } | { agent: string } | { chat: string };

/**
 * Display and voice preferences that can be set globally, per agent or per chat. One shared
 * instance per settings store, kept in memory so sync code (the Telegram hub) can read it.
 */
export class Prefs {
  private static all = new WeakMap<SettingsStore, Prefs>();
  private data: Stored = {};

  static of(settings: SettingsStore): Prefs {
    let p = Prefs.all.get(settings);
    if (!p) Prefs.all.set(settings, (p = new Prefs(settings)));
    return p;
  }

  private constructor(private readonly settings: SettingsStore) {}

  async load(): Promise<this> {
    this.data = (await this.settings.get<Stored>(KEY)) ?? {};
    return this;
  }

  private async save(): Promise<void> {
    await this.settings.set(KEY, this.data);
  }

  // ── Console card ────────────────────────────────────────────────────────────────

  /** Whether the live console card shows for this chat / agent bot. On unless switched off. */
  consoleOn(chat: string, agent: string): boolean {
    const c = this.data.console;
    return c?.chats?.[chat] ?? c?.agents?.[agent] ?? c?.global ?? true;
  }

  consoleGlobal(): boolean {
    return this.data.console?.global ?? true;
  }

  /** The agent's own setting, or undefined when it follows the global one. */
  consoleAgent(agent: string): boolean | undefined {
    return this.data.console?.agents?.[agent];
  }

  /** `on: null` removes the override so the wider setting applies again. */
  async setConsole(scope: ConsoleScope, on: boolean | null): Promise<void> {
    const c = (this.data.console ??= {});
    if ('global' in scope) {
      if (on === null) delete c.global;
      else c.global = on;
    } else {
      const map = 'agent' in scope ? (c.agents ??= {}) : (c.chats ??= {});
      const key = 'agent' in scope ? scope.agent : scope.chat;
      if (on === null) delete map[key];
      else map[key] = on;
    }
    await this.save();
  }

  // ── Voice light ─────────────────────────────────────────────────────────────────

  /** The agent's own setting, or undefined when it follows the global switch. */
  voiceLight(agent: string): boolean | undefined {
    return this.data.voiceLight?.[agent];
  }

  async setVoiceLight(agent: string, on: boolean | null): Promise<void> {
    const m = (this.data.voiceLight ??= {});
    if (on === null) delete m[agent];
    else m[agent] = on;
    await this.save();
  }

  // ── Budgets ─────────────────────────────────────────────────────────────────────

  /** The agent's own budget, or the default one ("*"). */
  budget(agent: string): Budget | undefined {
    return this.data.budgets?.[agent] ?? this.data.budgets?.['*'];
  }

  budgetOwn(agent: string): Budget | undefined {
    return this.data.budgets?.[agent];
  }

  async setBudget(agent: string, budget: Budget | null): Promise<void> {
    const m = (this.data.budgets ??= {});
    if (!budget) delete m[agent];
    else m[agent] = { dailyUsd: Math.max(0.01, Math.min(10_000, budget.dailyUsd)), block: budget.block };
    await this.save();
  }

  // ── Quiet hours ─────────────────────────────────────────────────────────────────

  quiet(): Quiet {
    return this.data.quiet ?? { enabled: false, from: '22:00', to: '07:00' };
  }

  async setQuiet(q: Partial<Quiet>): Promise<void> {
    const next = { ...this.quiet(), ...q };
    if (!isHHMM(next.from) || !isHHMM(next.to)) throw new Error('Times look like 22:00.');
    this.data.quiet = next;
    await this.save();
  }

  /** True when `now` falls inside the quiet window (it may cross midnight). */
  isQuiet(timezone: string, now = new Date()): boolean {
    const q = this.quiet();
    if (!q.enabled) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    return q.from <= q.to ? parts >= q.from && parts < q.to : parts >= q.from || parts < q.to;
  }
}
