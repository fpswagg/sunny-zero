import { config } from '../config.ts';
import { accessSchema, memorySchema, privilegedReasons, type Agent, type AgentDefinition, type AgentInput } from '../agents/schema.ts';
import { join } from 'node:path';
import { accentOf } from '../agents/theme.ts';
import { ICON_FILE, readIcon, saveIcon, SUNNY_ICON } from '../agents/icons.ts';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import type { AgentBackups } from './backup.ts';
import type { AgentRegistry } from '../agents/registry.ts';
import { ensureDirs, problems } from '../agents/validate.ts';
import { formatModelRef, getProvider, parseModelRef, PROVIDERS, upstreamModel, type Effort, type ProviderId } from '../providers/catalog.ts';
import type { Providers } from '../providers/providers.ts';
import { spendByProvider, UsageService } from '../providers/usage.ts';
import type { RunLog } from '../runtime/run-log.ts';
import type { RunResult } from '../runtime/runner.ts';
import type { SessionStore } from '../runtime/sessions.ts';
import type { TelegramControl } from '../gateway/types.ts';
import type { UserStore } from '../users/users.ts';
import { Prefs } from './prefs.ts';
import { CLAUDE_MAIN_KEY, FALLBACK_KEY, type FallbackState } from '../providers/claude-fallback.ts';
import { cleanOrder, HUB_MAIN_KEY, HUB_ORDER_KEY, orderByPref, resolveMain } from './hub-prefs.ts';
import { AGENT_CALL_COOLDOWN_DEFAULT, AGENT_CALL_COOLDOWN_KEY, ALWAYS_ALLOW_KEY, type SettingsStore } from './settings.ts';
import type { z } from 'zod';

/** A refusal meant for the person asking: shown as is. */
export class ManageError extends Error {}

export interface ModelSetting {
  provider?: ProviderId;
  model?: string;
  effort?: Effort;
}

/** Asks the owner to confirm new privileges. Resolves false when they refuse. */
export type Confirm = (summary: string, reasons: string[]) => Promise<boolean>;

export interface ManagerDeps {
  registry: AgentRegistry;
  providers: Providers;
  /** Account usage (subscription limits, provider balances); built from `providers` when absent. */
  usage?: UsageService;
  runs: RunLog;
  sessions: SessionStore;
  settings: SettingsStore;
  users: UserStore;
  /** Sunny itself: only its model and effort can change. */
  sunny: Agent;
  timezone: string;
  /** Claude models used when none is set. */
  defaults: { sunny: string; agents: string };
  probe(name: string, provider: string | undefined, model: string | undefined, effort?: Effort): Promise<RunResult>;
  upcoming(agent: string): { schedule: string; next: Date | null }[];
  telegram(): TelegramControl | undefined;
}

export type Changes = Partial<Omit<AgentInput, 'name' | 'access' | 'memory' | 'createdAt' | 'updatedAt'>> & {
  access?: Partial<z.input<typeof accessSchema>>;
  memory?: Partial<z.input<typeof memorySchema>>;
};

/** What the app and the commands show about an agent. */
export interface AgentView {
  name: string;
  description: string;
  isSunny: boolean;
  provider: ProviderId;
  providerName: string;
  model: string;
  /** "openai:gpt-5.5", or the Claude model. */
  modelRef: string;
  /** True when the model is the daemon default (none set). */
  modelDefault: boolean;
  /** Live console card in Telegram: the agent's own switch (undefined: follows the global one). */
  consoleOwn?: boolean;
  /** Light model for voice: the agent's own switch (undefined: follows the global one). */
  voiceLightOwn?: boolean;
  fallbackModels: string[];
  effort?: Effort;
  enabled: boolean;
  tools: string[];
  connectors: string[];
  triggers: AgentDefinition['triggers'];
  next: { schedule: string; next: string | null }[];
  memory: AgentDefinition['memory'];
  access: AgentDefinition['access'];
  privileges: string[];
  notify: string[];
  voice?: AgentDefinition['voice'];
  /** The agent's colour (set, or read from its icon). */
  accent: string;
  maxTurns?: number;
  bot: { username?: string; stored: boolean };
  guests: { id: string; name: string }[];
  /** False when the agent's provider is not connected: its runs would fail. */
  ready: boolean;
  prompt?: string;
  updatedAt?: string;
}

const SUNNY_MODEL_KEY = 'sunny.model';
const DEFAULT_MODEL_KEY = 'agents.defaultModel';

/**
 * Managing agents, shared by Sunny's tools, the chat commands and the Telegram app, so they
 * check and ask the same way: models and effort, settings, privileges, sessions, tests and usage.
 */
export class AgentManager {
  constructor(private readonly deps: ManagerDeps) {}

  /** Applies Sunny's saved model. */
  async init(): Promise<void> {
    const saved = await this.deps.settings.get<ModelSetting>(SUNNY_MODEL_KEY);
    if (saved) this.applySunny(saved);
  }

  private applySunny(s: ModelSetting): void {
    const def = this.deps.sunny.def;
    def.provider = s.provider && s.provider !== 'claude' ? s.provider : undefined;
    def.model = s.model ?? this.deps.defaults.sunny;
    def.effort = s.effort;
  }

  get(name: string): Agent {
    const agent = name === 'sunny' ? this.deps.sunny : this.deps.registry.get(name);
    if (!agent) throw new ManageError(`No agent named "${name}".`);
    return agent;
  }

  names(): string[] {
    return ['sunny', ...this.deps.registry.list().map((a) => a.def.name)];
  }

  // ── Models ──────────────────────────────────────────────────────────────────────

  /**
   * Checks "provider:model" against what the provider offers: it must be connected, and the
   * model must be in its list (case and unique partial matches are corrected).
   */
  async resolveModel(ref: string): Promise<{ provider: ProviderId; model: string; note?: string }> {
    const { provider, model } = parseModelRef(ref);
    const p = PROVIDERS[provider];
    if (!model) throw new ManageError('Name a model, e.g. `sonnet`, `openai:gpt-5.5` or `openrouter:moonshotai/kimi-k3`.');
    if (!(await this.deps.providers.connected(provider))) throw new ManageError(`${p.name} is not connected yet. Connect it first: /connect ${provider}`);
    if (p.protocol === 'subscription') {
      if (!/^[\w.[\]-]+$/.test(model)) throw new ManageError(`"${model}" is not a Claude model name.`);
      return { provider, model };
    }
    let list;
    try {
      list = await this.deps.providers.listModels(provider);
    } catch (err) {
      return { provider, model, note: `Could not check ${p.name}'s model list (${(err as Error).message}); saved as given.` };
    }
    const bare = upstreamModel(model).toLowerCase();
    const exact = list.find((m) => m.id.toLowerCase() === bare);
    if (exact) return { provider, model: model === upstreamModel(model) ? exact.id : model };
    const close = list.filter((m) => m.id.toLowerCase().includes(bare));
    if (close.length === 1) return { provider, model: close[0]!.id, note: `Using ${close[0]!.id}.` };
    throw new ManageError(
      `${p.name} has no model "${model}".${close.length ? ` Did you mean: ${close.slice(0, 8).map((m) => m.id).join(', ')}?` : ` See /models ${provider}.`}`,
    );
  }

  /** Sets an agent's (or Sunny's) model; `effort` undefined keeps it, null clears it. */
  async setModel(name: string, ref: string, effort?: Effort | null): Promise<string> {
    const agent = this.get(name);
    const { provider, model, note } = await this.resolveModel(ref);
    const nextEffort = effort === null ? undefined : (effort ?? agent.def.effort);
    if (name === 'sunny') {
      const setting: ModelSetting = { provider, model, effort: nextEffort };
      await this.deps.settings.set(SUNNY_MODEL_KEY, setting);
      this.applySunny(setting);
    } else {
      await this.save(agent, { ...agent.def, provider: provider === 'claude' ? undefined : provider, model, effort: nextEffort });
    }
    const warn = name === 'sunny' && getProvider(provider).family !== 'Claude' ? ' Sunny is tuned for Claude; tools may work less well on other models.' : '';
    return `**${name}** now runs on \`${formatModelRef(provider, model)}\`${nextEffort ? ` · effort ${nextEffort}` : ''}.${note ? ` ${note}` : ''}${warn}`;
  }

  async setEffort(name: string, effort: Effort | null): Promise<string> {
    const agent = this.get(name);
    if (name === 'sunny') {
      const setting: ModelSetting = { provider: agent.def.provider, model: agent.def.model, effort: effort ?? undefined };
      await this.deps.settings.set(SUNNY_MODEL_KEY, setting);
      this.applySunny(setting);
    } else {
      await this.save(agent, { ...agent.def, effort: effort ?? undefined });
    }
    return effort ? `**${name}** now thinks with effort **${effort}**.` : `**${name}** uses its model's default effort.`;
  }

  /** Model for agents created without one. */
  async defaultModel(): Promise<ModelSetting> {
    return (await this.savedDefaultModel()) ?? { provider: 'claude', model: this.deps.defaults.agents };
  }

  /** The default the owner chose, if any (otherwise agents follow SUNNY_AGENT_DEFAULT_MODEL). */
  savedDefaultModel(): Promise<ModelSetting | undefined> {
    return this.deps.settings.get<ModelSetting>(DEFAULT_MODEL_KEY);
  }

  /** Spoken turns on the provider's light model (owner's switch; falls back to SUNNY_VOICE_LIGHT). */
  /** Agent-to-agent calls: pairs the owner always allows, and the cooldown between two calls of a pair. */
  async agentCalls(): Promise<{ always: string[]; cooldownSec: number }> {
    const keys = (await this.deps.settings.get<string[]>(ALWAYS_ALLOW_KEY)) ?? [];
    return {
      always: keys.filter((k) => k.startsWith('agent-call:')).map((k) => k.slice('agent-call:'.length)),
      cooldownSec: (await this.deps.settings.get<number>(AGENT_CALL_COOLDOWN_KEY)) ?? AGENT_CALL_COOLDOWN_DEFAULT,
    };
  }

  async revokeAgentCall(pair: string): Promise<void> {
    const keys = (await this.deps.settings.get<string[]>(ALWAYS_ALLOW_KEY)) ?? [];
    await this.deps.settings.set(ALWAYS_ALLOW_KEY, keys.filter((k) => k !== `agent-call:${pair}`));
  }

  async setAgentCallCooldown(sec: number): Promise<void> {
    await this.deps.settings.set(AGENT_CALL_COOLDOWN_KEY, Math.max(0, Math.min(3600, Math.round(sec))));
  }

  consoleGlobal(): boolean {
    return Prefs.of(this.deps.settings).consoleGlobal();
  }

  async setConsole(on: boolean): Promise<void> {
    await Prefs.of(this.deps.settings).setConsole({ global: true }, on);
  }

  /** `null` = follow the global switch again. */
  async setAgentPrefs(name: string, prefs: { console?: boolean | null; voiceLight?: boolean | null }): Promise<void> {
    this.get(name);
    const p = Prefs.of(this.deps.settings);
    if (prefs.console !== undefined) await p.setConsole({ agent: name }, prefs.console);
    if (prefs.voiceLight !== undefined) await p.setVoiceLight(name, prefs.voiceLight);
  }

  /** Where each level of the console switch stands: the global one and the agent's own. */
  consoleState(agent: string): { global: boolean; own: boolean | undefined; effective: boolean } {
    const p = Prefs.of(this.deps.settings);
    return { global: p.consoleGlobal(), own: p.consoleAgent(agent), effective: p.consoleAgent(agent) ?? p.consoleGlobal() };
  }

  /** Replaces an agent's fallback models (tried in order when its model fails). Checked like any model. */
  async setFallbacks(name: string, refs: string[]): Promise<string> {
    const agent = this.editable(name);
    const out: string[] = [];
    for (const ref of refs) {
      const r = await this.resolveModel(ref);
      const formatted = formatModelRef(r.provider, r.model);
      if (formatted === formatModelRef(agent.def.provider, agent.def.model)) throw new ManageError(`${formatted} is already ${name}'s main model.`);
      if (!out.includes(formatted)) out.push(formatted);
    }
    if (out.length > 5) throw new ManageError('At most 5 fallbacks.');
    await this.save(agent, { ...agent.def, fallbackModels: out });
    return out.length ? `**${name}** falls back to ${out.map((o) => `\`${o}\``).join(' → ')}.` : `**${name}** has no fallback model.`;
  }

  async voiceLight(): Promise<boolean> {
    return (await this.deps.settings.get<boolean>('voice_light')) ?? config.SUNNY_VOICE_LIGHT;
  }

  async setVoiceLight(on: boolean): Promise<void> {
    await this.deps.settings.set('voice_light', on);
  }

  async setDefaultModel(ref: string, effort?: Effort | null): Promise<string> {
    const { provider, model, note } = await this.resolveModel(ref);
    const current = await this.defaultModel();
    const setting: ModelSetting = { provider, model, effort: effort === null ? undefined : (effort ?? current.effort) };
    await this.deps.settings.set(DEFAULT_MODEL_KEY, setting);
    return `New agents will run on \`${formatModelRef(provider, model)}\`${setting.effort ? ` · effort ${setting.effort}` : ''}.${note ? ` ${note}` : ''}`;
  }

  /** Runs a one-line prompt on the agent's model (or another one) through the whole chain. */
  async test(name: string, ref?: string, effort?: Effort): Promise<RunResult & { modelRef: string }> {
    const agent = this.get(name);
    const target = ref ? await this.resolveModel(ref) : { provider: agent.def.provider ?? 'claude', model: agent.def.model ?? (name === 'sunny' ? this.deps.defaults.sunny : this.deps.defaults.agents) };
    const result = await this.deps.probe(name, target.provider, target.model, effort ?? agent.def.effort);
    return { ...result, modelRef: formatModelRef(target.provider, target.model) };
  }

  // ── Settings ────────────────────────────────────────────────────────────────────

  private async save(agent: Agent, def: AgentDefinition, prompt?: string): Promise<Agent> {
    const issues = problems(def, this.deps.timezone);
    if (issues.length) throw new ManageError(issues.join('\n'));
    return this.deps.registry.save(def, prompt ?? agent.prompt);
  }

  private editable(name: string): Agent {
    if (name === 'sunny') throw new ManageError('Sunny is built in: only its model and effort can change.');
    return this.get(name);
  }

  /**
   * Merges changes into an agent (access and memory are merged too). New privileges need
   * `confirm`; sessions are forgotten when their meaning changes.
   */
  async update(name: string, changes: Changes = {}, prompt: string | undefined, confirm: Confirm): Promise<Agent> {
    const agent = this.editable(name);
    const before = agent.def;
    let def: AgentDefinition;
    try {
      def = this.deps.registry.parse({
        ...before,
        ...changes,
        name,
        access: { ...before.access, ...changes.access },
        memory: { ...before.memory, ...changes.memory },
      } as AgentInput);
    } catch (err) {
      throw new ManageError(`Invalid change: ${(err as Error).message}`);
    }
    const issues = problems(def, this.deps.timezone);
    if (issues.length) throw new ManageError(issues.join('\n'));
    const had = new Set(privilegedReasons(before));
    const added = privilegedReasons(def).filter((r) => !had.has(r));
    if (added.length && !(await confirm(`Give "${name}" more access`, added))) throw new ManageError('The new access was not approved. Nothing was changed.');
    await ensureDirs(def);
    const saved = await this.deps.registry.save(def, prompt ?? agent.prompt);
    if (before.memory.session !== saved.def.memory.session || before.access.workdir !== saved.def.access.workdir) await this.deps.sessions.clearAgent(name);
    return saved;
  }

  async setEnabled(name: string, enabled: boolean): Promise<string> {
    const agent = this.editable(name);
    await this.save(agent, { ...agent.def, enabled });
    return enabled ? `**${name}** is on: it answers and its schedules run.` : `**${name}** is paused: it does not answer and its schedules and events do not run.`;
  }

  /** Forgets every conversation history of the agent. */
  async reset(name: string): Promise<string> {
    this.get(name);
    await this.deps.sessions.clearAgent(name);
    return `Forgot **${name}**'s conversations: the next message starts fresh. Its notes are kept.`;
  }

  async delete(name: string, confirm: Confirm): Promise<void> {
    this.editable(name);
    if (!(await confirm(`Delete agent "${name}"`, ['removes the agent, its bot and its guests’ access (files kept in data/trash)']))) throw new ManageError('The agent was kept.');
    await this.deps.telegram()?.removeBot(name);
    await this.deps.users.revokeAgent(name);
    await this.deps.registry.delete(name);
    await this.deps.sessions.clearAgent(name);
  }

  // ── Views ───────────────────────────────────────────────────────────────────────

  async view(name: string, withPrompt = false): Promise<AgentView> {
    const agent = this.get(name);
    const { def } = agent;
    const isSunny = name === 'sunny';
    const provider = getProvider(def.provider);
    const model = def.model ?? (isSunny ? this.deps.defaults.sunny : this.deps.defaults.agents);
    const users = isSunny ? [] : await this.deps.users.list();
    return {
      name,
      description: def.description,
      isSunny,
      provider: provider.id,
      providerName: provider.name,
      model,
      modelRef: formatModelRef(provider.id, model),
      modelDefault: !def.model,
      consoleOwn: Prefs.of(this.deps.settings).consoleAgent(name),
      voiceLightOwn: Prefs.of(this.deps.settings).voiceLight(name),
      fallbackModels: def.fallbackModels,
      effort: def.effort,
      enabled: def.enabled,
      tools: def.tools,
      connectors: def.connectors,
      triggers: def.triggers,
      next: isSunny ? [] : this.deps.upcoming(name).map((u) => ({ schedule: u.schedule, next: u.next?.toISOString() ?? null })),
      memory: def.memory,
      access: def.access,
      privileges: privilegedReasons(def),
      notify: def.notify,
      voice: def.voice,
      accent: def.color ?? (await accentOf((await readIcon(isSunny ? SUNNY_ICON : join(agent.dir, ICON_FILE))) ?? '')),
      maxTurns: def.maxTurns,
      bot: (await this.deps.telegram()?.botStatus(name)) ?? { stored: false },
      guests: users.filter((u) => u.role === 'member' && u.agents.includes(name)).map((u) => ({ id: u.id, name: u.name })),
      ready: await this.deps.providers.connected(provider.id),
      prompt: withPrompt ? agent.prompt : undefined,
      updatedAt: def.updatedAt,
    };
  }

  async views(): Promise<AgentView[]> {
    return Promise.all(this.names().map((n) => this.view(n)));
  }

  usage(days: number, agent?: string) {
    return this.deps.runs.usage(days, agent);
  }

  usageHourly(hours: number, agent?: string) {
    return this.deps.runs.usageHourly(hours, agent);
  }

  private usageService?: UsageService;
  private get accountUsage(): UsageService {
    return (this.usageService ??= this.deps.usage ?? new UsageService(this.deps.providers));
  }

  get timezone(): string {
    return this.deps.timezone;
  }

  /** The Claude subscription's limits (session and weekly windows). */
  subscriptionUsage(force = false) {
    return this.accountUsage.subscription(force);
  }

  /** Agents in the order chosen for the hub and Mini App, and the main one (the hub opens on it). */
  async hubPrefs(): Promise<{ order: string[]; main: string | null }> {
    const names = ['sunny', ...this.names()];
    const order = orderByPref(names.map((name) => ({ name })), await this.deps.settings.get<string[]>(HUB_ORDER_KEY)).map((x) => x.name);
    return { order, main: resolveMain(names, await this.deps.settings.get<string>(HUB_MAIN_KEY)) ?? null };
  }

  async setHubPrefs(change: { order?: string[]; main?: string | null }): Promise<{ order: string[]; main: string | null }> {
    const names = ['sunny', ...this.names()];
    if (change.order) await this.deps.settings.set(HUB_ORDER_KEY, cleanOrder(names, change.order));
    if (change.main !== undefined) {
      if (change.main === null) await this.deps.settings.delete(HUB_MAIN_KEY);
      else if (names.includes(change.main)) await this.deps.settings.set(HUB_MAIN_KEY, change.main);
      else throw new ManageError(`No agent named "${change.main}".`);
    }
    return this.hubPrefs();
  }

  /** The Claude subscriptions saved on this server. */
  async claudeAccounts() {
    const [list, main, state] = await Promise.all([this.deps.providers.claude.list(), this.claudeMainRef(), this.deps.settings.get<FallbackState>(FALLBACK_KEY)]);
    const mainId = list.find((a) => [a.id, a.label, a.email].some((v) => v && v.toLowerCase() === main.toLowerCase()))?.id ?? list.find((a) => a.email?.toLowerCase().startsWith(main.toLowerCase()))?.id;
    return list.map((a) => ({ ...a, main: a.id === mainId, health: state?.accounts[a.id] }));
  }

  private async claudeMainRef(): Promise<string> {
    return (await this.deps.settings.get<string>(CLAUDE_MAIN_KEY)) ?? config.SUNNY_CLAUDE_MAIN;
  }

  /** Which Claude account is MAIN: agents go back to it whenever it works. The other one is the automatic backup. */
  async setClaudeMain(which: string) {
    const list = await this.deps.providers.claude.list();
    const q = which.trim().toLowerCase();
    const entry = list.find((a) => a.id === q || a.label.toLowerCase() === q || a.email?.toLowerCase() === q) ?? list.find((a) => a.label.toLowerCase().startsWith(q) || a.email?.toLowerCase().startsWith(q));
    if (!entry) throw new ManageError(`No Claude account matches "${which}".`);
    await this.deps.settings.set(CLAUDE_MAIN_KEY, entry.id);
    return this.claudeAccounts();
  }

  /** Use another saved Claude subscription from the next run on. */
  switchClaudeAccount(which: string) {
    return this.deps.providers.claude.switchTo(which);
  }

  /** What each API provider reports to its key (balance, credits, limits). */
  providerAccounts(force = false) {
    return this.accountUsage.accounts(force);
  }

  /** Sunny's own runs, tokens and cost per provider over the last days. */
  async providerSpend(days: number) {
    return spendByProvider(await this.deps.runs.usage(days));
  }

  // ── Budgets, quiet hours, backups, activity ─────────────────────────────────────

  /** Daily budgets: "*" is the default, then one per agent, each with what was spent today. */
  async budgets(): Promise<Record<string, { dailyUsd: number; block: boolean; spent: number } | null>> {
    const p = Prefs.of(this.deps.settings);
    const out: Record<string, { dailyUsd: number; block: boolean; spent: number } | null> = {};
    const star = p.budgetOwn('*');
    out['*'] = star ? { ...star, spent: 0 } : null;
    for (const n of this.names()) {
      const b = p.budgetOwn(n);
      const spent = await this.deps.runs.spentToday(n, this.deps.timezone);
      out[n] = b ? { ...b, spent } : spent > 0 ? { dailyUsd: 0, block: false, spent } : null;
    }
    return out;
  }

  /** `dailyUsd` null removes the budget. "*" (or "all") is the default for agents without their own. */
  async setBudget(agent: string, dailyUsd: number | null, block = false): Promise<string> {
    const key = agent === 'all' ? '*' : agent;
    if (key !== '*') this.get(key);
    if (dailyUsd !== null && !(dailyUsd > 0)) throw new ManageError('The budget must be above 0.');
    await Prefs.of(this.deps.settings).setBudget(key, dailyUsd === null ? null : { dailyUsd, block });
    return dailyUsd === null ? `Budget for ${key === '*' ? 'all agents' : key} removed.` : `${key === '*' ? 'Default budget' : `${key}'s budget`}: $${dailyUsd}/day, ${block ? 'blocks at the limit' : 'alerts only'}.`;
  }

  quiet() {
    return Prefs.of(this.deps.settings).quiet();
  }

  async setQuiet(q: { enabled?: boolean; from?: string; to?: string }) {
    try {
      await Prefs.of(this.deps.settings).setQuiet(q);
    } catch (err) {
      throw new ManageError((err as Error).message);
    }
    return this.quiet();
  }

  private backups?: AgentBackups;
  attachBackups(b: AgentBackups): void {
    this.backups = b;
  }

  async backupState(): Promise<{ last: { name: string; at: Date; size: number } | null; count: number }> {
    const list = (await this.backups?.list()) ?? [];
    return { last: list[0] ? { name: list[0].name, at: list[0].at, size: list[0].size } : null, count: list.length };
  }

  async backupNow() {
    if (!this.backups) throw new ManageError('Backups are not running.');
    return this.backups.now();
  }

  activity(opts: { kind?: 'fallback' | 'agent_call'; agent?: string; limit?: number } = {}) {
    return this.deps.runs.activities(opts);
  }

  /**
   * An agent's icon: a square SVG, or a photo (resized and wrapped in an SVG made here, never taken as is).
   * Updates its Telegram bot picture too.
   */
  async setIcon(name: string, input: { svg?: string; image?: string }): Promise<string> {
    const agent = this.editable(name);
    if (input.image) {
      const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(input.image);
      if (!m) throw new ManageError('Send a PNG, JPEG or WebP image.');
      let jpeg: Buffer;
      try {
        jpeg = await sharp(Buffer.from(m[1]!, 'base64')).resize(384, 384, { fit: 'cover' }).jpeg({ quality: 86 }).toBuffer();
      } catch {
        throw new ManageError('That image could not be read.');
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 384 384"><image width="384" height="384" xlink:href="data:image/jpeg;base64,${jpeg.toString('base64')}"/></svg>\n`;
      await writeFile(join(agent.dir, ICON_FILE), svg);
    } else if (input.svg) {
      const problem = await saveIcon(agent.dir, input.svg);
      if (problem) throw new ManageError(`Icon not saved: ${problem}`);
    } else throw new ManageError('Send an SVG or an image.');
    await this.deps.telegram()?.refreshProfile(name).catch(() => {});
    return `Saved ${name}'s icon.`;
  }

  recentRuns(agent: string, limit: number) {
    return this.deps.runs.recent(agent, limit);
  }
}
