import type { Gateway } from '../gateway/gateway.ts';
import type { SettingsStore } from './settings.ts';
import type { AgentManager } from './manager.ts';
import type { LimitWindow } from '../providers/usage.ts';
import { escapeHtml } from '../telegram/format.ts';
import { log } from '../log.ts';

/** What the card needs from the Telegram hub. */
export interface UsageCardHost {
  homes(agent: string): Promise<string[]>;
  usageCard(conversationId: string, html: string, messageId?: number): Promise<number | undefined>;
  removeUsageCard(conversationId: string, messageId: number): Promise<void>;
  usageRefresh?: () => Promise<void>;
}

const ENABLED_KEY = 'usage_card';
const pinKey = (conversationId: string) => `usage_card:${conversationId}`;
const EVERY_MS = 5 * 60_000;

const SHORT: Record<string, string> = {
  session: 'Session',
  five_hour: 'Session',
  weekly_all: 'Week',
  seven_day: 'Week',
  weekly_opus: 'Opus',
  seven_day_opus: 'Opus',
  weekly_sonnet: 'Sonnet',
  seven_day_sonnet: 'Sonnet',
};

const bar = (pct: number) => {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
};
const dot = (pct: number) => (pct >= 90 ? '🔴' : pct >= 75 ? '🟠' : '🟢');
const money = (usd: number) => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

function resetAt(iso: string | undefined, timezone: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  const far = at.getTime() - Date.now() > 20 * 3_600_000;
  return at.toLocaleString('en-GB', { timeZone: timezone, weekday: far ? 'short' : undefined, hour: '2-digit', minute: '2-digit' });
}

/** The card's HTML. Only absolute times, so it changes only when the numbers do. */
export async function usageCardHtml(manager: AgentManager): Promise<string> {
  const [sub, accounts, runs] = await Promise.all([
    manager.subscriptionUsage(false),
    manager.claudeAccounts().catch(() => []),
    manager.usage(1).catch(() => []),
  ]);
  const using = accounts.length > 1 ? accounts.find((a) => a.active) : undefined;
  const lines = [`📊 <b>Claude${sub.plan ? ` ${escapeHtml(sub.plan)}` : ''}</b>${using ? ` · ${escapeHtml(using.label)}` : ''}`];
  const windows: LimitWindow[] = sub.windows;
  if (!windows.length) lines.push(`<i>Limits unavailable${sub.error ? `: ${escapeHtml(sub.error.slice(0, 80))}` : ''}</i>`);
  for (const w of windows) {
    const name = (SHORT[w.kind] ?? w.label).padEnd(7);
    const pct = `${Math.round(w.percent)}%`.padStart(4);
    const reset = resetAt(w.resetsAt, manager.timezone);
    lines.push(`${dot(w.percent)} <code>${escapeHtml(name)} ${bar(w.percent)} ${pct}</code>${reset ? ` ↻ ${escapeHtml(reset)}` : ''}`);
  }
  if (sub.stale) lines.push('<i>last known numbers</i>');
  const total = runs.reduce((n, r) => n + r.runs, 0);
  const cost = runs.reduce((n, r) => n + r.costUsd, 0);
  if (total) lines.push(`⚡ <b>${total}</b> run${total > 1 ? 's' : ''} in 24 h · ${money(cost)} API-equivalent`);
  return lines.join('\n');
}

/**
 * The owner's usage at a glance: a pinned message at the top of Sunny's chat, kept up to date
 * every few minutes (only edited when the numbers change). `/usagecard on|off`.
 */
export class UsageCard {
  private timer?: NodeJS.Timeout;
  private last = new Map<string, string>();
  private running = false;

  constructor(
    private readonly deps: { host: UsageCardHost; manager: AgentManager; settings: SettingsStore; gateway: Gateway },
  ) {}

  start(): void {
    this.deps.host.usageRefresh = () => this.refresh(true);
    this.deps.gateway.addCommand('usagecard', {
      usage: '[on|off]',
      help: 'pinned usage card at the top of this chat (limits, kept up to date)',
      run: async (_conversationId, arg) => {
        const want = arg.trim().toLowerCase();
        if (want === 'off') {
          await this.deps.settings.set(ENABLED_KEY, false);
          await this.removeAll();
          return 'Usage card removed. `/usagecard on` brings it back.';
        }
        await this.deps.settings.set(ENABLED_KEY, true);
        await this.refresh(true);
        return 'Usage card pinned at the top of the chat. It updates every 5 minutes; ↻ refreshes it.';
      },
    });
    setTimeout(() => void this.refresh(false), 30_000).unref();
    this.timer = setInterval(() => void this.refresh(false), EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async refresh(force: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if ((await this.deps.settings.get<boolean>(ENABLED_KEY)) === false) return;
      const html = await usageCardHtml(this.deps.manager);
      for (const conv of await this.deps.host.homes('sunny')) {
        const saved = await this.deps.settings.get<{ messageId: number }>(pinKey(conv));
        if (!force && saved && this.last.get(conv) === html) continue;
        const messageId = await this.deps.host.usageCard(conv, html, saved?.messageId);
        this.last.set(conv, html);
        if (messageId !== undefined && messageId !== saved?.messageId) await this.deps.settings.set(pinKey(conv), { messageId });
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'usage card: refresh failed');
    } finally {
      this.running = false;
    }
  }

  private async removeAll(): Promise<void> {
    for (const conv of await this.deps.host.homes('sunny')) {
      const saved = await this.deps.settings.get<{ messageId: number }>(pinKey(conv));
      if (saved) await this.deps.host.removeUsageCard(conv, saved.messageId);
      await this.deps.settings.delete(pinKey(conv));
      this.last.delete(conv);
    }
  }
}
