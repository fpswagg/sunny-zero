import { startCodexLogin } from '../providers/codex.ts';
import type { CommandReply, Gateway } from '../gateway/gateway.ts';
import type { Button } from '../gateway/types.ts';
import { EFFORTS, formatModelRef, isProviderId, PROVIDERS, type Effort, type ProviderId } from '../providers/catalog.ts';
import type { Providers } from '../providers/providers.ts';
import type { AgentManager, AgentView } from './manager.ts';

export interface CommandDeps {
  gateway: Gateway;
  manager: AgentManager;
  providers: Providers;
  /** Whether the Telegram app is served (HTTPS address set). */
  appAvailable: boolean;
}

const rows = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const effortLabel = (e: Effort | undefined) => e ?? 'default';
const money = (usd: number) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(3)}` : '$0');
const bar = (pct: number) => {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
};
/** "in 4 h 40 min (18:59)" in the owner's time zone. */
const resetsIn = (iso: string | undefined, timezone: string) => {
  if (!iso) return '';
  const at = new Date(iso);
  const min = Math.max(0, Math.round((at.getTime() - Date.now()) / 60_000));
  const span = min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${Math.round(min / 1440)} d`;
  const clock = at.toLocaleString('en-GB', { timeZone: timezone, weekday: min >= 24 * 60 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' });
  return `resets in ${span} (${clock})`;
};
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const ago = (d: Date) => {
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
};

/** "Claude (subscription)", "GPT · OpenAI" */
const providerLabel = (id: ProviderId) => {
  const p = PROVIDERS[id];
  if (id === 'claude') return 'Claude · subscription';
  if (id === 'anthropic') return 'Claude · API key';
  return p.family === p.name ? p.name : `${p.family} · ${p.name.replace(/^(Google|Moonshot) /, '')}`;
};

function card(v: AgentView): string {
  const lines = [
    `${v.isSunny ? '☀' : v.enabled ? '🟢' : '⏸'} **${v.name}**${v.enabled ? '' : ' · paused'}`,
    v.description,
    '',
    `🧠 \`${v.modelRef}\`${v.modelDefault ? ' (default)' : ''} · effort ${effortLabel(v.effort)}${v.ready ? '' : ` · ⚠️ ${v.providerName} not connected`}`,
  ];
  if (!v.isSunny) {
    lines.push(`🤖 ${v.bot.username ? `@${v.bot.username}` : v.bot.stored ? 'own bot (not running)' : 'no own bot, reached through Sunny'}`);
    const sched = v.next.filter((n) => n.next).map((n) => `${n.schedule} → ${new Date(n.next!).toISOString().slice(5, 16).replace('T', ' ')}`);
    const events = v.triggers.filter((t) => t.type === 'event').map((t) => (t.type === 'event' ? `${t.source}:${t.on}` : ''));
    if (sched.length || events.length) lines.push(`⏰ ${[...sched, ...events.map((e) => `on ${e}`)].join(' · ')}`);
    if (v.guests.length) lines.push(`👥 ${v.guests.map((g) => g.name).join(', ')}`);
    lines.push(`🔐 ${v.privileges.length ? v.privileges.join('; ') : 'restricted: its own folder, asks for the rest'}`);
  }
  return lines.join('\n');
}

/** Registers the owner's management commands on the gateway. */
/** Subscription limits and provider balances, as Telegram lines. */
async function accountLines(manager: AgentManager, force = false): Promise<string[]> {
  const [sub, accounts, claude] = await Promise.all([manager.subscriptionUsage(force), manager.providerAccounts(force), manager.claudeAccounts().catch(() => [])]);
  const using = claude.length > 1 ? claude.find((a) => a.active) : undefined;
  const lines: string[] = [`**Claude subscription**${sub.plan ? ` (${sub.plan})` : ''}${using ? ` · ${using.label}` : ''}`];
  if (!sub.ok) lines.push(`_Limits unavailable: ${sub.error}_`);
  for (const w of sub.windows) {
    const warn = w.percent >= 90 ? ' 🔴' : w.percent >= 75 ? ' 🟠' : '';
    lines.push(`${w.label}: ${bar(w.percent)} **${Math.round(w.percent)}%**${warn} · ${resetsIn(w.resetsAt, manager.timezone)}`);
  }
  if (sub.extraUsage?.enabled) lines.push(`Extra usage: ${sub.extraUsage.usedCredits ?? 0}${sub.extraUsage.monthlyLimit ? ` of ${sub.extraUsage.monthlyLimit}` : ''} ${sub.extraUsage.currency ?? ''}`.trim());
  const connected = accounts.filter((a) => a.connected);
  if (connected.length) {
    lines.push('', '**Other providers**');
    for (const a of connected) {
      if (a.error) lines.push(`• ${a.name}: _couldn't read (${a.error})_`);
      else if (a.facts.length) lines.push(`• ${a.name}: ${a.facts.map((f) => `${f.label} **${f.value}**`).join(' · ')}`);
      else lines.push(`• ${a.name}: _no balance API with a normal key_`);
    }
  }
  return lines;
}

export function registerManageCommands(deps: CommandDeps): void {
  const { gateway, manager, providers } = deps;
  const app = (label: string, page: string): Button[] => (deps.appAvailable ? [{ label, app: page }] : []);

  const agentButtons = (prefix: string, views: AgentView[], show: (v: AgentView) => string) =>
    rows(
      views.map((v) => ({ label: `${v.isSunny ? '☀ ' : v.enabled ? '' : '⏸ '}${v.name} · ${show(v)}`, command: `${prefix} ${v.name}` })),
      2,
    );

  const agentCard = async (name: string): Promise<CommandReply> => {
    const v = await manager.view(name);
    const buttons: Button[][] = [
      [
        { label: '🧠 Model', command: `/model ${name}` },
        { label: '⚡ Effort', command: `/effort ${name}` },
      ],
    ];
    if (!v.isSunny) {
      buttons.push([v.enabled ? { label: '⏸ Pause', command: `/pause ${name}` } : { label: '▶ Resume', command: `/resume ${name}` }, { label: '🧪 Test', command: `/test ${name}` }]);
      buttons.push([
        { label: '🧹 Forget chats', command: `/reset ${name}` },
        { label: '📜 Runs', command: `/runs ${name}` },
      ]);
      buttons.push([{ label: '💬 Talk to it', command: `/use ${name}` }, ...app('⚙ Settings', `/agent/${name}`)]);
    } else {
      buttons.push([{ label: '🧪 Test', command: `/test ${name}` }, ...app('⚙ Open manager', '/')]);
    }
    buttons.push([{ label: '◀ All agents', command: '/agents' }]);
    return { text: card(v), buttons };
  };

  gateway.addCommand('manage', {
    usage: '',
    help: 'open the agent manager (Telegram app)',
    run: async () =>
      deps.appAvailable
        ? { text: '☀ **Agent manager**: models, effort, tools, schedules, guests, bots, providers and usage, all in one place.', buttons: [app('⚙ Open manager', '/')] }
        : 'The agent manager opens inside Telegram and needs Sunny’s public HTTPS address (SUNNY_PUBLIC_URL). Meanwhile use /agents, /model and /providers.',
  });

  gateway.addCommand('agent', {
    usage: '<agent>',
    help: "an agent's card: model, effort, schedules, guests, with buttons to change them",
    run: async (_c, arg) => {
      if (arg) return agentCard(arg.split(/\s+/)[0]!);
      const views = await manager.views();
      return { text: 'Pick an agent to manage:', buttons: agentButtons('/agent', views, (v) => v.modelRef) };
    },
  });

  gateway.addCommand('model', {
    usage: '[agent] [provider:model] [effort]',
    help: 'change the model of an agent (or Sunny); `/model default …` for new agents',
    run: async (_c, arg) => {
      const [who, ref, effortArg] = arg.split(/\s+/).filter(Boolean);
      const views = await manager.views();
      if (!who) {
        return {
          text: ['**Which agent?**', ...views.map((v) => `• **${v.name}**: \`${v.modelRef}\` · effort ${effortLabel(v.effort)}`)].join('\n'),
          buttons: [...agentButtons('/model', views, (v) => v.model), [{ label: '⭐ Default for new agents', command: '/model default' }]],
        };
      }
      const isDefault = who === 'default' && !views.some((v) => v.name === 'default');
      const effort = effortArg === 'default' ? null : effortArg && (EFFORTS as readonly string[]).includes(effortArg) ? (effortArg as Effort) : undefined;
      if (effortArg && effort === undefined) return `Unknown effort "${effortArg}". Use one of: ${EFFORTS.join(', ')}, default.`;

      if (ref && !isProviderId(ref.toLowerCase())) {
        const text = isDefault ? await manager.setDefaultModel(ref, effort) : await manager.setModel(who, ref, effort);
        return {
          text,
          buttons: isDefault
            ? [[{ label: '◀ Models', command: '/model' }]]
            : [
                [
                  { label: '🧪 Test it', command: `/test ${who}` },
                  { label: '⚡ Effort', command: `/effort ${who}` },
                ],
                [{ label: `◀ ${who}`, command: `/agent ${who}` }],
              ],
        };
      }

      const current = isDefault ? await manager.defaultModel() : undefined;
      const view = isDefault ? undefined : await manager.view(who);
      const currentRef = view?.modelRef ?? formatModelRef(current?.provider, current?.model);
      const target = isDefault ? 'new agents' : `**${who}**`;

      if (!ref) {
        const status = await providers.status();
        const buttons: Button[][] = rows(
          status.map((p): Button => (p.connected ? { label: providerLabel(p.id), command: `/model ${who} ${p.id}` } : { label: `➕ ${providerLabel(p.id)}`, command: `/connect ${p.id}` })),
          2,
        );
        if (!isDefault) buttons.push([...app('📋 All models', `/agent/${who}/model`), { label: `◀ ${who}`, command: `/agent ${who}` }]);
        return { text: `${isDefault ? 'New agents run' : `${target} runs`} on \`${currentRef}\`. Pick a provider (➕ connects one first):`, buttons };
      }

      const id = ref.toLowerCase() as ProviderId;
      if (!(await providers.connected(id))) {
        return { text: `${PROVIDERS[id].name} is not connected yet.`, buttons: [[{ label: `➕ Connect ${PROVIDERS[id].name}`, command: `/connect ${id}` }]] };
      }
      const models = await providers.suggestions(id, 10);
      const buttons = rows(
        models.map((m): Button => {
          const mref = formatModelRef(id, m.id);
          return { label: `${mref === currentRef ? '✓ ' : ''}${m.id}`, command: `/model ${who} ${id}:${m.id}` };
        }),
        id === 'openrouter' ? 1 : 2,
      );
      buttons.push([...app('📋 All models', isDefault ? '/settings' : `/agent/${who}/model`), { label: '◀ Providers', command: `/model ${who}` }]);
      return {
        text: `Pick a ${PROVIDERS[id].family} model for ${target}, or send \`/model ${who} ${id === 'claude' ? '' : `${id}:`}<model>\`. \`/models ${id}\` lists them all.`,
        buttons,
      };
    },
  });

  gateway.addCommand('effort', {
    usage: '[agent] [low|medium|high|xhigh|max|default]',
    help: 'how hard an agent thinks',
    run: async (_c, arg) => {
      const [who, level] = arg.split(/\s+/).filter(Boolean);
      if (!who) {
        const views = await manager.views();
        return { text: '**Which agent?**', buttons: agentButtons('/effort', views, (v) => effortLabel(v.effort)) };
      }
      if (level) {
        if (level !== 'default' && !(EFFORTS as readonly string[]).includes(level)) return `Unknown effort "${level}". Use one of: ${EFFORTS.join(', ')}, default.`;
        const text = await manager.setEffort(who, level === 'default' ? null : (level as Effort));
        return { text, buttons: [[{ label: '🧪 Test it', command: `/test ${who}` }, { label: `◀ ${who}`, command: `/agent ${who}` }]] };
      }
      const v = await manager.view(who);
      const pick = (e: Effort | 'default'): Button => ({ label: `${effortLabel(v.effort) === e ? '✓ ' : ''}${e}`, command: `/effort ${who} ${e}` });
      return {
        text: [
          `**${who}** thinks with effort **${effortLabel(v.effort)}** on \`${v.modelRef}\`.`,
          'Higher effort: better answers on hard work, slower and costlier. Models without some levels use the nearest one.',
        ].join('\n'),
        buttons: [[pick('low'), pick('medium'), pick('high')], [pick('xhigh'), pick('max'), pick('default')], [{ label: `◀ ${who}`, command: `/agent ${who}` }]],
      };
    },
  });

  gateway.addCommand('providers', {
    usage: '',
    help: 'model providers: which are connected and who uses them',
    run: async () => {
      const [status, views] = await Promise.all([providers.status(), manager.views()]);
      const lines = ['**Model providers**'];
      const buttons: Button[] = [];
      for (const p of status) {
        const users = views.filter((v) => v.provider === p.id).map((v) => v.name);
        const state = p.connected ? (p.id === 'claude' ? '✓' : `✓ connected ${p.updatedAt?.slice(0, 10) ?? ''}`) : '✕ not connected';
        lines.push(`${p.connected ? '🟢' : '⚪'} **${p.name}**: ${state}${users.length ? ` · used by ${users.join(', ')}` : ''}`);
        if (!p.connected) buttons.push({ label: `➕ ${p.name}`, command: `/connect ${p.id}` });
        else if (p.id !== 'claude') buttons.push({ label: `⚙ ${p.name}`, command: `/connect ${p.id}` });
      }
      lines.push('', 'Keys are entered on a secure page, checked with the provider and stored encrypted. Agents and chats never see them.');
      return { text: lines.join('\n'), buttons: [...rows(buttons, 2), app('⚙ Open manager', '/providers')] };
    },
  });

  gateway.addCommand('connect', {
    usage: '<provider>',
    help: 'connect a model provider (Claude API, OpenAI, Gemini, Kimi, OpenRouter) on a secure page',
    run: async (conversationId, arg) => {
      const [name, action] = arg.toLowerCase().split(/\s+/).filter(Boolean);
      const keyed = providers.list().filter((p) => p.protocol !== 'subscription');
      if (!name) return { text: 'Which provider?', buttons: rows(keyed.map((p) => ({ label: p.name, command: `/connect ${p.id}` })), 2) };
      if (!isProviderId(name) || PROVIDERS[name].protocol === 'subscription') return `Unknown provider "${name}". Choose one of: ${keyed.map((p) => p.id).join(', ')}.`;
      const p = PROVIDERS[name];
      const connected = await providers.connected(name);
      if (connected && action !== 'replace') {
        const users = (await manager.views()).filter((v) => v.provider === name).map((v) => v.name);
        return {
          text: `**${p.name}** is connected${users.length ? ` and used by ${users.join(', ')}` : ''}.`,
          buttons: [
            [
              { label: '📋 Models', command: `/models ${name}` },
              { label: '🔑 Replace key', command: `/connect ${name} replace` },
            ],
            [{ label: '🔌 Disconnect', command: `/disconnect ${name}` }, { label: '◀ Providers', command: '/providers' }],
          ],
        };
      }
      if (name === 'codex') {
        try {
          const login = await startCodexLogin();
          void login.done.then((ok) => gateway.send(conversationId, { type: 'notice', text: ok ? `✓ **${p.name}** is connected. Pick a model: \`/models codex\`.` : `✕ ${p.name}: sign-in did not finish.` }));
          return `Sign in to ChatGPT:\n1. Open ${login.url}\n2. Enter the code **${login.code}** (valid 15 minutes).`;
        } catch (err) {
          return `✕ ${(err as Error).message}`;
        }
      }
      gateway.sendAuthLink(
        conversationId,
        providers.keyFlow(name, () =>
          gateway.send(conversationId, {
            type: 'notice',
            text: `✓ **${p.name}** is connected. Agents can now run on ${p.family} models.`,
            buttons: [[{ label: '🧠 Pick a model for an agent', command: '/model' }]],
          }),
        ),
      );
      return `Open the secure page above to ${connected ? 'replace' : 'enter'} your ${p.name} key. ${p.keyHelp ?? ''}`;
    },
  });

  gateway.addCommand('disconnect', {
    usage: '<provider>',
    help: 'forget a provider’s key',
    hidden: true,
    run: async (_c, arg) => {
      const [name, confirm] = arg.toLowerCase().split(/\s+/).filter(Boolean);
      if (!name || !isProviderId(name) || PROVIDERS[name].protocol === 'subscription') return 'Usage: `/disconnect <provider>`';
      const users = (await manager.views()).filter((v) => v.provider === name).map((v) => v.name);
      if (confirm !== 'confirm') {
        return {
          text: `Forget the ${PROVIDERS[name].name} key?${users.length ? ` ⚠️ ${users.join(', ')} run on it and will fail until you switch their model.` : ''}`,
          buttons: [[{ label: '🔌 Yes, disconnect', command: `/disconnect ${name} confirm` }, { label: 'Cancel', command: '/providers' }]],
        };
      }
      const removed = await providers.disconnect(name);
      return { text: removed ? `Forgot the ${PROVIDERS[name].name} key.` : `${PROVIDERS[name].name} was not connected.`, buttons: [[{ label: '◀ Providers', command: '/providers' }]] };
    },
  });

  gateway.addCommand('models', {
    usage: '<provider> [search]',
    help: 'list a provider’s models',
    run: async (_c, arg) => {
      const [name, ...search] = arg.split(/\s+/).filter(Boolean);
      if (!name || !isProviderId(name.toLowerCase())) {
        return { text: 'Which provider?', buttons: rows(providers.list().map((p) => ({ label: p.name, command: `/models ${p.id}` })), 2) };
      }
      const id = name.toLowerCase() as ProviderId;
      const q = search.join(' ').toLowerCase();
      const all = await providers.listModels(id, true);
      const list = all.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
      const shown = list.slice(0, 40).map((m) => {
        const extra = [m.context ? `${tokens(m.context)} ctx` : '', m.pricing ? `${money(m.pricing.input)}/${money(m.pricing.output)} per M` : ''].filter(Boolean).join(' · ');
        return `${m.suggested ? '⭐ ' : ''}\`${formatModelRef(id, m.id)}\`${extra ? ` · ${extra}` : ''}`;
      });
      return [
        `**${PROVIDERS[id].name}**: ${list.length} model${list.length === 1 ? '' : 's'}${q ? ` matching "${q}"` : ''}${list.length > 40 ? ' (first 40; add a search word)' : ''}`,
        ...shown,
        '',
        'Set one with `/model <agent> <model>`.',
      ].join('\n');
    },
  });

  gateway.addCommand('test', {
    usage: '<agent> [provider:model]',
    help: 'send a one-line test through an agent’s model',
    run: async (conversationId, arg) => {
      const [who, ref] = arg.split(/\s+/).filter(Boolean);
      if (!who) return 'Usage: `/test <agent> [provider:model]`';
      const v = await manager.view(who);
      gateway.send(conversationId, { type: 'notice', text: `🧪 Testing **${who}** on \`${ref ?? v.modelRef}\`…` });
      const r = await manager.test(who, ref);
      const answer = r.text.trim().split('\n').slice(0, 4).join('\n');
      const stats = [`${(r.durationMs / 1000).toFixed(1)}s`, r.outputTokens !== undefined ? `${r.inputTokens ?? 0}→${r.outputTokens} tokens` : '', r.costUsd ? money(r.costUsd) : ''].filter(Boolean).join(' · ');
      return {
        text: r.isError ? `✕ \`${r.modelRef}\` failed after ${stats}:\n${answer}` : `✓ \`${r.modelRef}\` answered (${stats}):\n> ${answer.replace(/\n/g, '\n> ')}`,
        buttons: [[{ label: '🧠 Model', command: `/model ${who}` }, { label: `◀ ${who}`, command: `/agent ${who}` }]],
      };
    },
  });

  for (const [cmd, enabled] of [
    ['pause', false],
    ['resume', true],
  ] as const) {
    gateway.addCommand(cmd, {
      usage: '<agent>',
      help: enabled ? 'turn a paused agent back on' : 'pause an agent: no answers, schedules or events',
      run: async (_c, arg) => {
        const who = arg.split(/\s+/)[0];
        if (!who) return `Usage: \`/${cmd} <agent>\``;
        return { text: await manager.setEnabled(who, enabled), buttons: [[{ label: `◀ ${who}`, command: `/agent ${who}` }]] };
      },
    });
  }

  gateway.addCommand('reset', {
    usage: '<agent>',
    help: 'forget all of an agent’s conversations (notes stay)',
    run: async (_c, arg) => {
      const who = arg.split(/\s+/)[0];
      if (!who) return 'Usage: `/reset <agent>`';
      return { text: await manager.reset(who), buttons: [[{ label: `◀ ${who}`, command: `/agent ${who}` }]] };
    },
  });

  gateway.addCommand('runs', {
    usage: '<agent>',
    help: 'an agent’s latest runs',
    run: async (_c, arg) => {
      const who = arg.split(/\s+/)[0];
      if (!who) return 'Usage: `/runs <agent>`';
      manager.get(who);
      const runs = (await manager.recentRuns(who, 8)).reverse();
      if (!runs.length) return `No runs logged for **${who}** yet.`;
      const lines = runs.map((r) => {
        const head = `${r.isError ? '✕' : '✓'} ${ago(r.at)} · ${r.origin}${r.model ? ` · \`${r.model}\`` : ''} · ${(r.durationMs / 1000).toFixed(0)}s${r.costUsd ? ` · ${money(r.costUsd)}` : ''}`;
        const msg = r.message.replace(/\s+/g, ' ').slice(0, 80);
        return `${head}\n   ${msg}${r.message.length > 80 ? '…' : ''}`;
      });
      return { text: [`**${who}**: latest runs`, ...lines].join('\n'), buttons: [[{ label: `◀ ${who}`, command: `/agent ${who}` }]] };
    },
  });

  gateway.addCommand('usage', {
    usage: '[days]',
    help: 'runs, tokens and cost per agent (default 7 days)',
    run: async (_c, arg) => {
      if (!arg.trim()) {
        // Compact view: Claude windows (only when Claude is in use) and a one-line total.
        const [sub, claude, runs] = await Promise.all([manager.subscriptionUsage(false), manager.claudeAccounts().catch(() => []), manager.usage(1).catch(() => [])]);
        const lines: string[] = [];
        if (sub.ok || claude.length) {
          const using = claude.length > 1 ? claude.find((a) => a.active) : undefined;
          lines.push(`**Claude**${sub.plan ? ` ${sub.plan}` : ''}${using ? ` · ${using.label}` : ''}`);
          if (!sub.ok) lines.push('_limits unavailable_');
          for (const w of sub.windows) lines.push(`${w.label}: ${bar(w.percent)} **${Math.round(w.percent)}%**${w.percent >= 90 ? ' 🔴' : w.percent >= 75 ? ' 🟠' : ''} · ${resetsIn(w.resetsAt, manager.timezone)}`);
        }
        const n = runs.reduce((t, r) => t + r.runs, 0);
        const cost = runs.reduce((t, r) => t + r.costUsd, 0);
        lines.push(n ? `⚡ ${n} run${n > 1 ? 's' : ''} in 24 h · ${money(cost)}` : '⚡ no runs in 24 h');
        return {
          text: lines.join('\n'),
          buttons: [[{ label: '↻', command: '/usage' }, { label: '📋 Details', command: '/usage 7' }, ...(claude.length > 1 ? [{ label: '🔀 Next account', command: '/account switch next' }] : [])]],
        };
      }
      const days = Math.min(365, Math.max(1, Number(arg) || 7));
      const rowsByAgent = new Map<string, { runs: number; errors: number; cost: number; input: number; output: number; models: Set<string> }>();
      for (const r of await manager.usage(days)) {
        const a = rowsByAgent.get(r.agent) ?? { runs: 0, errors: 0, cost: 0, input: 0, output: 0, models: new Set<string>() };
        a.runs += r.runs;
        a.errors += r.errors;
        a.cost += r.costUsd;
        a.input += r.inputTokens;
        a.output += r.outputTokens;
        if (r.model) a.models.add(r.model);
        rowsByAgent.set(r.agent, a);
      }
      const account = await accountLines(manager);
      const buttons = [
        [
          { label: '1 day', command: '/usage 1' },
          { label: '7 days', command: '/usage 7' },
          { label: '30 days', command: '/usage 30' },
        ],
      ];
      if (!rowsByAgent.size) return { text: [...account, '', `No runs in the last ${days} days.`].join('\n'), buttons };
      const total = [...rowsByAgent.values()].reduce((s, a) => s + a.cost, 0);
      const byProvider = (await manager.providerSpend(days)).map((p) => `${p.name} ${money(p.costUsd)} (${p.runs})`).join(' · ');
      const lines = [...rowsByAgent.entries()]
        .sort((a, b) => b[1].cost - a[1].cost || b[1].runs - a[1].runs)
        .map(([name, a]) => `• **${name}**: ${a.runs} run${a.runs === 1 ? '' : 's'}${a.errors ? ` (${a.errors} failed)` : ''}${a.input + a.output ? ` · ${tokens(a.input)} in / ${tokens(a.output)} out` : ''} · ${money(a.cost)}${a.models.size ? ` · ${[...a.models].join(', ')}` : ''}`);
      return {
        text: [...account, '', `**Sunny's runs, last ${days} days** · ${money(total)}`, `_By provider: ${byProvider}_`, ...lines, '', '_Costs on the Claude subscription are what the API would charge; you pay the subscription._'].join('\n'),
        buttons,
      };
    },
  });

  gateway.addCommand('console', {
    usage: '[on|off|reset|all on|off|<agent> on|off]',
    help: 'live progress card while an agent works: this bot, everywhere (`all`), or one agent',
    run: async (conversationId, arg) => {
      const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const bot = /^telegram:([^:]+):/.exec(conversationId)?.[1] ?? 'sunny';
      const parseOn = (w?: string) => (w === 'on' ? true : w === 'off' ? false : w === 'reset' || w === 'default' ? null : undefined);
      const label = (v: boolean | null) => (v === null ? 'back to the global setting' : v ? 'on' : 'off');
      try {
        if (!words.length) {
          const s = manager.consoleState(bot);
          return {
            text: `**Console card** (${bot}): ${s.effective ? 'on 🟢' : 'off ⚪'}${s.own === undefined ? ' · follows global' : ''}\nGlobal: ${s.global ? 'on' : 'off'}`,
            buttons: [
              [
                { label: s.effective ? '⚪ Turn off here' : '🟢 Turn on here', command: `/console ${s.effective ? 'off' : 'on'}` },
                { label: s.global ? '⚪ Off everywhere' : '🟢 On everywhere', command: `/console all ${s.global ? 'off' : 'on'}` },
              ],
              ...(s.own !== undefined ? [[{ label: '↩ Follow global', command: '/console reset' }]] : []),
            ],
          };
        }
        let target: 'global' | string = bot;
        let value = parseOn(words[0]);
        if (value === undefined) {
          target = words[0] === 'all' ? 'global' : words[0]!;
          value = parseOn(words[1]);
        }
        if (value === undefined) return 'Usage: `/console on|off|reset`, `/console all on|off`, `/console <agent> on|off`';
        if (target === 'global') {
          await manager.setConsole(value ?? true);
          return `Console card: **${value === false ? 'off' : 'on'}** everywhere (agents with their own setting keep it).`;
        }
        await manager.setAgentPrefs(target, { console: value });
        return `Console card for **${target}**: ${label(value)}.`;
      } catch (err) {
        return `⚠️ ${(err as Error).message}`;
      }
    },
  });

  gateway.addCommand('limits', {
    usage: '',
    help: 'Claude subscription limits and provider balances',
    run: async () => {
      const many = (await manager.claudeAccounts().catch(() => [])).length > 1;
      return {
        text: (await accountLines(manager, true)).join('\n'),
        buttons: [[{ label: '↻ Refresh', command: '/limits' }, { label: 'Usage 7 days', command: '/usage 7' }], ...(many ? [[{ label: '🔀 Switch Claude account', command: '/account' }]] : [])],
      };
    },
  });

  const accountView = async (note?: string) => {
    const list = await manager.claudeAccounts();
    const lines = ['**Claude accounts**'];
    for (const a of list) lines.push(`${a.active ? '🟢' : '⚪'} **${a.label}**${a.plan ? ` · ${a.plan}` : ''}${a.email && a.email !== a.label ? ` · ${a.email}` : ''}${a.active ? ' · in use' : ''}`);
    if (list.length < 2) lines.push('', 'Add your other subscription to be able to switch when one runs out.');
    else lines.push('', 'Agents use the account in use from their next message. Conversations carry on.');
    if (note) lines.unshift(note, '');
    const buttons: Button[][] = [];
    for (const a of list.filter((x) => !x.active)) buttons.push([{ label: `🔀 Use ${a.label}`, command: `/account switch ${a.id}` }]);
    buttons.push([{ label: '➕ Add account', command: '/account add' }, { label: '📊 Limits', command: '/limits' }]);
    buttons.push(app('⚙ Open manager', '/providers'));
    return { text: lines.join('\n'), buttons };
  };

  gateway.addCommand('account', {
    usage: '[switch <name>|add|rename <name> <label>|remove <name>]',
    help: 'Claude subscriptions: see them, switch to the other one when a limit is reached, add one',
    run: async (conversationId, arg) => {
      const [action, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
      const name = rest.join(' ');
      try {
        if (!action) return await accountView();
        if (action === 'switch' || action === 'use') {
          const a = await manager.switchClaudeAccount(name || 'next');
          return await accountView(`✅ Switched to **${a.label}**.`);
        }
        if (action === 'add') {
          gateway.sendAuthLink(
            conversationId,
            providers.claude.loginFlow((a) =>
              gateway.send(conversationId, { type: 'notice', text: `✓ **${a.label}** is saved.`, buttons: [[{ label: `🔀 Use ${a.label}`, command: `/account switch ${a.id}` }]] }),
            ),
          );
          return 'Open the secure page above: sign in with your other Claude account, then paste the code Claude shows.';
        }
        if (action === 'rename') {
          const [from, ...label] = rest;
          if (!from || !label.length) return 'Usage: `/account rename <name> <new label>`';
          const a = await providers.claude.rename(from, label.join(' '));
          return await accountView(`Renamed to **${a.label}**.`);
        }
        if (action === 'remove') {
          if (!name) return 'Usage: `/account remove <name>`';
          await providers.claude.remove(name);
          return await accountView(`Removed ${name}.`);
        }
        return 'Usage: `/account`, `/account switch <name>`, `/account add`';
      } catch (err) {
        return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

}
