import type { Gateway } from '../gateway/gateway.ts';
import type { RunLog } from '../runtime/run-log.ts';
import type { AgentBackups } from './backup.ts';
import { isHHMM, Prefs } from './prefs.ts';
import type { SettingsStore } from './settings.ts';

export interface ExtrasDeps {
  gateway: Gateway;
  settings: SettingsStore;
  runs: RunLog;
  backups: AgentBackups;
  timezone: string;
  agents: () => string[];
}

const money = (n: number) => `$${n.toFixed(2)}`;
const ago = (d: Date) => {
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** /budget, /quiet, /backup and /activity. */
export function registerExtraCommands(d: ExtrasDeps): void {
  const prefs = () => Prefs.of(d.settings);

  d.gateway.addCommand('budget', {
    usage: '[agent|all] [amount|off] [block|alert]',
    help: 'daily spend limit per agent (alert at 80% and 100%, or block)',
    run: async (_c, arg) => {
      const w = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const p = prefs();
      if (!w.length) {
        const names = ['*', ...d.agents()];
        const lines: string[] = [];
        for (const n of names) {
          const b = p.budgetOwn(n);
          if (!b && n !== '*') continue;
          const spent = n === '*' ? undefined : await d.runs.spentToday(n, d.timezone);
          lines.push(`• **${n === '*' ? 'default' : n}**: ${b ? `${money(b.dailyUsd)}/day, ${b.block ? 'blocks' : 'alerts'}` : 'none'}${spent !== undefined ? ` · today ${money(spent)}` : ''}`);
        }
        return `**Daily budgets**\n${lines.join('\n')}\n\nUsage: \`/budget <agent|all> <amount|off> [block|alert]\``;
      }
      const target = w[0] === 'all' ? '*' : w[0]!;
      if (target !== '*' && !d.agents().includes(target)) return `⚠️ Unknown agent "${target}".`;
      if (w[1] === 'off') {
        await p.setBudget(target, null);
        return `Budget for **${w[0]}** removed.`;
      }
      const amount = Number(w[1]);
      if (!Number.isFinite(amount) || amount <= 0) return 'Usage: `/budget <agent|all> <amount|off> [block|alert]`';
      const block = w[2] ? w[2] === 'block' : (p.budgetOwn(target)?.block ?? false);
      await p.setBudget(target, { dailyUsd: amount, block });
      return `Budget for **${w[0]}**: ${money(amount)}/day, ${block ? 'blocks at the limit' : 'alerts only'}.`;
    },
  });

  d.gateway.addCommand('quiet', {
    usage: '[on|off|HH:MM-HH:MM]',
    help: 'notifications arrive without sound at night',
    run: async (_c, arg) => {
      const a = arg.trim().toLowerCase();
      const p = prefs();
      if (a === 'on' || a === 'off') await p.setQuiet({ enabled: a === 'on' });
      else if (a) {
        const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(a);
        const pad = (s: string) => s.padStart(5, '0');
        if (!m || !isHHMM(pad(m[1]!)) || !isHHMM(pad(m[2]!))) return 'Usage: `/quiet on|off` or `/quiet 22:00-07:00`';
        await p.setQuiet({ enabled: true, from: pad(m[1]!), to: pad(m[2]!) });
      }
      const q = p.quiet();
      return `Quiet mode: **${q.enabled ? 'on' : 'off'}** · ${q.from}–${q.to} (${d.timezone}).`;
    },
  });

  d.gateway.addCommand('backup', {
    usage: '[now]',
    help: 'backups of the agents (definitions, prompts, settings); `now` makes one and sends it',
    run: async (conversationId, arg) => {
      if (arg.trim().toLowerCase() === 'now') {
        const b = await d.backups.now();
        d.gateway.send(conversationId, { type: 'file', agent: 'sunny', path: b.path, name: b.name, kind: 'document', caption: `Agents backup · ${(b.size / 1024).toFixed(0)} KB` });
        return `Backup done: \`${b.name}\`.`;
      }
      const list = await d.backups.list();
      if (!list.length) return 'No backup yet. One is made daily; `/backup now` makes one.';
      return `**Agent backups** (daily, last 14)\n${list.slice(0, 8).map((b) => `• \`${b.name}\` · ${(b.size / 1024).toFixed(0)} KB · ${ago(b.at)}`).join('\n')}`;
    },
  });

  d.gateway.addCommand('activity', {
    usage: '[fallbacks|calls]',
    help: 'recent model fallbacks and agent-to-agent calls',
    run: async (_c, arg) => {
      const a = arg.trim().toLowerCase();
      const kind = a.startsWith('fall') ? 'fallback' : a.startsWith('call') ? 'agent_call' : undefined;
      const rows = await d.runs.activities({ kind, limit: 12 });
      if (!rows.length) return 'Nothing yet.';
      return rows
        .map((r) => {
          const when = ago(new Date(r.at));
          return r.kind === 'fallback'
            ? `🔀 **${r.agent}** · ${r.other} · ${when}\n_${r.detail.slice(0, 120)}_`
            : `📨 **${r.agent}** → **${r.other}** ${r.ok ? '' : '⚠️ '}· ${when}\n_${r.detail.split('\n')[0]!.slice(0, 120)}_`;
        })
        .join('\n');
    },
  });
}
