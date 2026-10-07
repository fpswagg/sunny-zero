import type { Agent } from '../agents/schema.ts';
import type { AgentRegistry } from '../agents/registry.ts';
import type { AuthManager } from '../auth/manager.ts';
import type { AuthFlow } from '../auth/types.ts';
import { isModelFailure, type ApprovalRequest, type Runner, type RunResult } from '../runtime/runner.ts';
import { parseResetTime, type PendingTask, type PendingTasks } from '../triggers/pending.ts';
import type { RunLog } from '../runtime/run-log.ts';
import { Prefs } from '../manage/prefs.ts';
import type { SessionStore } from '../runtime/sessions.ts';
import { SessionStore as Sessions } from '../runtime/sessions.ts';
import { SYSTEM, type Speaker, type UserStore } from '../users/users.ts';
import type { SunnyDeps } from '../sunny/tools.ts';
import { sunnyServer } from '../sunny/tools.ts';
import { log } from '../log.ts';
import type { ImageInput } from '../media/images.ts';
import type { Inbox, StagedFile } from '../media/inbox.ts';
import type { TtsService } from '../media/tts.ts';
import { basename, join } from 'node:path';
import { Approvals } from './approvals.ts';
import { askAgentServer } from '../agents/ask-agent.ts';
import { AGENT_CALL_COOLDOWN_DEFAULT, AGENT_CALL_COOLDOWN_KEY, ALWAYS_ALLOW_KEY, type SettingsStore } from '../manage/settings.ts';
import type { ConversationStore } from './conversations.ts';
import { channelOf, resolveTargets, type Button, type Channel, type Outbound, type TelegramControl } from './types.ts';

/** What Sunny's tools get from the gateway, bound to the conversation Sunny is answering. */
export interface BoundSunnyContext {
  conversationId: string;
  approve(req: ApprovalRequest): Promise<boolean>;
  runAgent(name: string, message: string): Promise<RunResult>;
  sendAuthLink(flow: AuthFlow): void;
  notice(text: string): void;
}

export interface GatewayDeps {
  registry: AgentRegistry;
  runner: Runner;
  sessions: SessionStore;
  auth: AuthManager;
  conversations: ConversationStore;
  users: UserStore;
  sunny: Agent;
  /** Builds Sunny's tool dependencies for one conversation. */
  sunnyDeps(bound: BoundSunnyContext): SunnyDeps;
  approvalTimeoutMs: number;
  /** Takes files people send in chat. Without it, messages with files are refused. */
  inbox?: Inbox;
  /** Speaks replies (voice messages). Without it, replies stay text. */
  tts?: TtsService;
  /** Runtime settings: "always allow" answers, the agent-call cooldown. */
  settings?: SettingsStore;
  /** Run history: budgets read today's spend, agent calls are logged. */
  runs?: RunLog;
  /** The owner's time zone (budgets reset at its midnight, quiet hours follow its clock). */
  timezone?: string;
  /** Background runs that survive restarts and wait out limits. Without it they run once and fail as before. */
  pending?: PendingTasks;
}

/** A parked run is dropped after this long, or this many tries. */
const PENDING_MAX_AGE_MS = 24 * 3_600_000;
const PENDING_MAX_ATTEMPTS = 8;
/** A run cut off by a restart is only resumed if it started this recently. */
const INTERRUPTED_MAX_AGE_MS = 2 * 3_600_000;
/** When a limit message gives no reset time, look again this often. */
const PENDING_RETRY_MS = 30 * 60_000;
/** Check pending tasks every 15s, so a limit reset is detected and resumed quickly. */
const PENDING_TICK_MS = 15_000;
const CUT_TURN_NOTE =
  '[System: Sunny restarted while you were in the middle of your previous turn in this chat (maybe you restarted it yourself). It is back up now. In one or two lines, tell the owner Sunny is back and whether what you were doing is finished; finish it if something small is left. Do not restart Sunny again.]';
/** A chat turn cut by a restart is picked up only if it started this recently, and at most this many times in a row. */
const CUT_TURN_MAX_AGE_MS = 30 * 60_000;
const CUT_TURN_MAX_RESUMES = 1;
/** A chat whose turn ended this shortly before a shutdown is told when Sunny is back. */
const RESTART_NOTE_WINDOW_MS = 2 * 60_000;
const RESUME_NOTE = '[Sunny was restarted or a limit blocked the previous attempt of this task. If part of it was already done, check before repeating it.]\n\n';

/** How deep agents may call each other (a asks b, b asks c...). */
const MAX_CALL_CHAIN = 3;

/** Where a message comes from: who sent it, and the agent its bot is pinned to (agent bots). */
export interface MessageContext {
  speaker?: Speaker;
  pinnedAgent?: string;
  /** Files that came with the message, saved by the channel in the inbox staging folder. */
  files?: StagedFile[];
  /** The person spoke (a voice message): agents whose voice reply is "auto" answer with a voice message too. */
  spoken?: boolean;
  /** Never answer with a voice message (the agent web app speaks replies itself). */
  noVoice?: boolean;
}

const YES = /^(y|yes|ok|okay|approve|allow|sure|👍)$/i;
const NO = /^(n|no|deny|reject|stop|👎)$/i;

/** True for a message that answers an approval ("yes", "no", 👍...). */
export const isApprovalAnswer = (text: string) => YES.test(text.trim()) || NO.test(text.trim());

/** What a chat command answers: text, or text with buttons. */
export type CommandReply = string | { text: string; buttons?: Button[][] };

/** A chat command added by another part of the daemon (e.g. `/telegram`). Owner only. Returns the notice to show. */
export interface ExtraCommand {
  usage: string;
  help: string;
  /** Left out of /help (sub-steps of a menu). */
  hidden?: boolean;
  run(conversationId: string, arg: string): Promise<CommandReply>;
}

/** Routes messages from every channel to Sunny or an agent, and their events back. */
export class Gateway {
  private channels = new Map<string, Channel>();
  private running = new Map<string, { agent: string; abort: AbortController }[]>();
  private commands = new Map<string, ExtraCommand>();
  private telegram?: TelegramControl;
  private ownerSpeaker?: Speaker;
  readonly approvals: Approvals;

  constructor(private readonly deps: GatewayDeps) {
    const settings = deps.settings;
    this.approvals = new Approvals(
      (id, event) => this.send(id, event),
      deps.approvalTimeoutMs,
      settings && {
        has: async (key) => ((await settings.get<string[]>(ALWAYS_ALLOW_KEY)) ?? []).includes(key),
        add: async (key) => {
          const list = (await settings.get<string[]>(ALWAYS_ALLOW_KEY)) ?? [];
          if (!list.includes(key)) await settings.set(ALWAYS_ALLOW_KEY, [...list, key]);
        },
      },
    );
  }

  addChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
  }

  addCommand(name: string, command: ExtraCommand): void {
    this.commands.set(name, command);
  }

  setTelegram(control: TelegramControl): void {
    this.telegram = control;
  }

  /** True while an agent turn runs in the conversation. */
  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  /** Terminal and web clients authenticate with the admin token, so they speak as the owner. */
  async owner(): Promise<Speaker> {
    this.ownerSpeaker ??= await this.deps.users.owner();
    return this.ownerSpeaker;
  }

  send(conversationId: string, event: Outbound): void {
    if (conversationId.startsWith('task:')) return void this.taskEvent(conversationId.slice('task:'.length), event);
    const watchers = this.watchers.get(conversationId);
    for (const fn of watchers ?? []) {
      try {
        fn(event);
      } catch (err) {
        log.warn({ err: (err as Error).message, conversationId }, 'conversation watcher failed');
      }
    }
    const channel = this.channels.get(channelOf(conversationId));
    if (!channel) {
      if (!watchers?.size) log.warn({ conversationId, type: event.type }, 'no channel for conversation');
      return;
    }
    channel.send(conversationId, event);
  }

  private watchers = new Map<string, Set<(event: Outbound) => void>>();

  /**
   * Also delivers a conversation's events to `fn` (the agent web app follows the same thread as
   * Telegram). Returns the function that stops it.
   */
  watch(conversationId: string, fn: (event: Outbound) => void): () => void {
    const set = this.watchers.get(conversationId) ?? new Set();
    set.add(fn);
    this.watchers.set(conversationId, set);
    return () => {
      set.delete(fn);
      if (!set.size && this.watchers.get(conversationId) === set) this.watchers.delete(conversationId);
    };
  }

  /** Shows a note in the conversation's own channel only (not to watchers), e.g. a message typed in the app. */
  echo(conversationId: string, event: Outbound): void {
    this.channels.get(channelOf(conversationId))?.send(conversationId, event);
  }

  /** The owner's conversations for an agent (see resolveTargets). */
  async targets(agent: string, entries: string[] = []): Promise<string[]> {
    const homes = new Map<string, string[]>();
    for (const [id, channel] of this.channels) homes.set(id, (await channel.homes?.(agent)) ?? []);
    return resolveTargets(entries, homes);
  }

  /** Delivers an agent's notification and returns where it went. */
  async notify(agent: string, entries: string[], text: string, silent: boolean): Promise<string[]> {
    const targets = await this.targets(agent, entries);
    // Quiet hours: still delivered, just without sound.
    const quiet = !!this.deps.settings && Prefs.of(this.deps.settings).isQuiet(this.deps.timezone ?? 'UTC');
    for (const target of targets) this.send(target, { type: 'notify', agent, text, silent: silent || quiet });
    return targets;
  }

  /** `sunny setup telegram`: the token arrives over the authenticated socket, never through chat. */
  async setTelegramToken(conversationId: string, token: string, bot = 'sunny'): Promise<void> {
    if (!this.telegram) return this.send(conversationId, { type: 'error', text: 'Telegram is not available in this daemon.' });
    try {
      await this.telegram.setToken(conversationId, token, bot);
    } catch (err) {
      this.send(conversationId, { type: 'error', text: (err as Error).message });
    }
  }

  /** The agent plain messages go to. Members default to their first granted agent. */
  async currentAgent(conversationId: string, speaker?: Speaker): Promise<string> {
    const who = speaker ?? (await this.owner());
    const stored = await this.deps.conversations.agent(conversationId);
    const usable = async (name: string | undefined) =>
      !!name && (name === 'sunny' || !!this.deps.registry.get(name)) && (await this.deps.users.canUse(who, name));
    if (await usable(stored)) return stored!;
    if (who.role !== 'member') return 'sunny';
    for (const name of await this.deps.users.agentsOf(who.id)) if (await usable(name)) return name;
    return 'sunny';
  }

  answerApproval(conversationId: string, id: string, allowed: boolean, always = false): void {
    if (!this.approvals.answer(conversationId, id, allowed, always)) this.send(conversationId, { type: 'notice', text: 'That approval is no longer open.' });
  }

  /** Entry point for a chat message from any channel. */
  async handleMessage(conversationId: string, raw: string, ctx: MessageContext = {}): Promise<void> {
    const files = ctx.files ?? [];
    try {
      await this.route(conversationId, raw.trim(), files, ctx);
    } finally {
      // Files the message did not reach an agent with (no access, unknown agent...). Accepted ones were moved already.
      if (files.length) await this.deps.inbox?.discard(files);
    }
  }

  private async route(conversationId: string, text: string, files: StagedFile[], ctx: MessageContext): Promise<void> {
    if (!text && !files.length) return;
    const speaker = ctx.speaker ?? (await this.owner());

    if (speaker.role === 'owner' && !files.length) {
      const pending = this.approvals.latest(conversationId);
      if (pending && (YES.test(text) || NO.test(text))) {
        this.approvals.answer(conversationId, pending, YES.test(text));
        return;
      }
    }

    if (text.startsWith('/') && !files.length) return this.command(conversationId, text, speaker, ctx.pinnedAgent);

    // "@agent message", or a bare "@agent" as the caption of a photo or file.
    const mention = (files.length ? /^@([a-z][a-z0-9-]{1,39})(?:\s+([\s\S]+))?$/ : /^@([a-z][a-z0-9-]{1,39})\s+([\s\S]+)$/).exec(text);
    let agentName: string;
    let message = text;
    if (ctx.pinnedAgent) {
      agentName = ctx.pinnedAgent;
      if (mention && mention[1] !== agentName) {
        this.send(conversationId, { type: 'error', text: `This bot only talks to ${agentName}.` });
        return;
      }
      if (mention) message = mention[2] ?? '';
    } else {
      agentName = mention ? mention[1]! : await this.currentAgent(conversationId, speaker);
      if (mention) message = mention[2] ?? '';
    }

    if (agentName !== 'sunny' && !this.deps.registry.get(agentName)) {
      this.send(conversationId, { type: 'error', text: `No agent named "${agentName}".${speaker.role === 'member' ? '' : ' Try /agents.'}` });
      return;
    }
    if (!(await this.deps.users.canUse(speaker, agentName))) {
      const granted = await this.deps.users.agentsOf(speaker.id);
      this.send(conversationId, {
        type: 'error',
        text: granted.length ? `You don't have access to ${agentName}. Your agents: ${granted.join(', ')}.` : 'You have not been given access to any agent yet.',
      });
      return;
    }
    let images: ImageInput[] = [];
    if (files.length) {
      if (!this.deps.inbox) return this.send(conversationId, { type: 'error', text: 'Files are not supported here.' });
      const agent = agentName === 'sunny' ? this.deps.sunny : this.deps.registry.get(agentName)!;
      try {
        ({ message, images } = await this.deps.inbox.accept(agent.dir, message, files, (t) => this.send(conversationId, { type: 'status', agent: agentName, text: t })));
      } catch (err) {
        log.error({ err, conversationId, agent: agentName }, 'could not take the files');
        return this.send(conversationId, { type: 'error', text: `Could not take the files: ${(err as Error).message}` });
      }
    }
    let result: RunResult;
    try {
      this.voiceOnly.delete(`${conversationId}|${agentName}`);
      result = await this.trackedTurn(conversationId, agentName, speaker, 0, () => this.turn(conversationId, agentName, message, 'message', 'all', speaker, { images, spoken: ctx.spoken, noVoice: ctx.noVoice }));
    } catch (err) {
      log.error({ err, conversationId, agent: agentName }, 'turn failed');
      this.send(conversationId, { type: 'error', text: `${agentName} failed: ${(err as Error).message}` });
      return;
    }
    await this.voiceReply(conversationId, agentName, result, ctx);
  }

  /**
   * The send_voice tool's sender. On "auto" (the default) the agent decides when a voice note
   * fits; "always" speaks every reply instead (voiceReply), "off" never.
   */
  private speaker(conversationId: string, agentName: string, agent: Agent, noVoice?: boolean): ((text: string, only?: boolean) => Promise<void>) | undefined {
    const tts = this.deps.tts;
    if (!tts || noVoice || (agent.def.voice?.reply ?? 'auto') !== 'auto') return undefined;
    return async (text, only) => {
      const path = await tts.voiceFile(text, agent.def, join(agent.dir, 'outbox'));
      this.send(conversationId, { type: 'file', agent: agentName, path, name: basename(path), kind: 'voice' });
      if (only) this.voiceOnly.add(`${conversationId}|${agentName}`);
    };
  }

  /**
   * Agents that answered with a voice-only note (send_voice only=true): their text in this chat is
   * held back until the user writes again, so "answer by voice only" really means no text.
   */
  private voiceOnly = new Set<string>();

  /** On "always", every reply also comes as a voice message. */
  private async voiceReply(conversationId: string, agentName: string, result: RunResult, ctx: MessageContext): Promise<void> {
    const tts = this.deps.tts;
    if (!tts || ctx.noVoice || result.isError || !result.text?.trim()) return;
    const agent = agentName === 'sunny' ? this.deps.sunny : this.deps.registry.get(agentName);
    if (!agent) return;
    const mode = agent.def.voice?.reply ?? 'auto';
    if (mode !== 'always') return;
    try {
      this.send(conversationId, { type: 'status', agent: agentName, text: '🔊 recording a voice reply…' });
      const path = await tts.voiceFile(result.text, agent.def, join(agent.dir, 'outbox'));
      this.send(conversationId, { type: 'file', agent: agentName, path, name: basename(path), kind: 'voice' });
    } catch (err) {
      log.warn({ err: (err as Error).message, agent: agentName }, 'voice reply failed');
      this.send(conversationId, { type: 'status', agent: agentName, text: '🔇 no voice reply (text above)' });
    }
  }

  /**
   * Runs an agent with nobody chatting: schedules and events. The run is recorded until it ends: a restart resumes it,
   * and when every model is at its limit it waits for the reset (or for another model / Claude account) and runs
   * again. Other problems reach the owner as notifications.
   */
  async runTask(agentName: string, message: string, origin: string, resume?: PendingTask): Promise<RunResult | undefined> {
    const agent = this.deps.registry.get(agentName);
    if (!agent?.def.enabled) {
      if (resume) await this.deps.pending?.finish(resume.id).catch(() => {});
      return undefined;
    }
    const pending = this.deps.pending;
    let id = resume?.id;
    try {
      if (pending && id === undefined) id = await pending.begin(agentName, message, origin);
    } catch (err) {
      log.warn({ err }, 'could not record the background run; running it without a safety net');
    }
    const attempts = resume ? resume.attempts + 1 : 1;
    const park = async (reason: string): Promise<boolean> => {
      if (!pending || id === undefined) return false;
      const now = new Date();
      const reset = parseResetTime(reason, now, this.deps.timezone ?? 'UTC');
      const age = resume ? now.getTime() - resume.createdAt.getTime() : 0;
      if (attempts >= PENDING_MAX_ATTEMPTS || age > PENDING_MAX_AGE_MS) {
        await pending.finish(id).catch(() => {});
        return false;
      }
      const resumeAfter = new Date((reset?.getTime() ?? now.getTime() + PENDING_RETRY_MS) + (reset ? 60_000 : 0));
      await pending.wait(id, { resumeAfter, signature: await this.deps.runner.routeSignature(agent.def), reason });
      const when = reset ? `after ${resumeAfter.toISOString().slice(11, 16)} UTC` : 'later';
      if (!resume) {
        await this.notify(agentName, agent.def.notify, `⏳ ${agentName}: background run (${origin}) is waiting, every model is at its limit. It will run again ${when}, or as soon as a model or Claude account changes.`, true).catch(() => {});
      } else {
        await this.notify(agentName, agent.def.notify, `⏳ ${agentName}: still waiting, limit will reset ${when}.`, true).catch(() => {});
      }
      return true;
    };
    try {
      const result = await this.turn(`task:${agentName}`, agentName, resume ? RESUME_NOTE + message : message, origin, 'all', SYSTEM);
      if (result.isError && isModelFailure(result.text) && (await park(result.text))) return result;
      if (id !== undefined) await pending?.finish(id).catch(() => {});
      return result;
    } catch (err) {
      const text = (err as Error).message;
      if (isModelFailure(text) && (await park(text))) return undefined;
      if (id !== undefined) await pending?.finish(id).catch(() => {});
      log.error({ err, agent: agentName, origin }, 'background run failed');
      await this.notify(agentName, agent.def.notify, `⚠️ Background run (${origin}) failed: ${text}`, false);
      return undefined;
    }
  }

  /** A turn is running or a resumed background run is in flight. */
  isBusy(): boolean {
    return this.running.size > 0 || this.inFlight.size > 0;
  }

  private resuming = false;
  private pendingTimer?: NodeJS.Timeout;

  /** Starts the loop that resumes runs cut off by a restart now, and parked runs when they can work again. */
  startPendingResume(): void {
    const pending = this.deps.pending;
    if (!pending || this.pendingTimer) return;
    const tick = () => void this.resumePending().catch((err) => log.warn({ err }, 'resuming background runs failed'));
    // Start immediately: background runs blocked by limits need to restart ASAP after a restart.
    tick();
    setTimeout(() => void this.resumeCutTurns().catch((err) => log.warn({ err }, 'picking up cut turns failed')), 500);
    this.pendingTimer = setInterval(tick, PENDING_TICK_MS);
  }

  stopPendingResume(): void {
    clearInterval(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  /** Runs a chat turn while remembering it is open, so a restart in the middle can pick it up. */
  private async trackedTurn<T>(conversationId: string, agent: string, speaker: Speaker, resumes: number, run: () => Promise<T>): Promise<T> {
    const pending = this.deps.pending;
    const id = pending ? await pending.openTurn(conversationId, agent, speaker, resumes).catch(() => undefined) : undefined;
    try {
      return await run();
    } finally {
      if (id !== undefined) await pending!.closeTurn(id).catch(() => {});
      this.recentEnds.set(conversationId, { agent, speaker, at: Date.now() });
    }
  }

  /** Chat turns that ended lately: if Sunny stops soon after (an agent restarted it), they hear when it is back. */
  private recentEnds = new Map<string, { agent: string; speaker: Speaker; at: number }>();

  /** On shutdown: chats whose turn just ended get a "Sunny is back up" when it starts again. */
  async noteRestart(): Promise<void> {
    const pending = this.deps.pending;
    if (!pending) return;
    for (const [conv, e] of this.recentEnds) {
      if (Date.now() - e.at > RESTART_NOTE_WINDOW_MS || this.running.has(conv)) continue;
      await pending.openTurn(conv, e.agent, e.speaker, -1).catch(() => {});
    }
  }

  private cutTurnsDone = false;

  /** Once after startup: chat turns that a restart cut off get a short follow-up, so the agent says Sunny is back. */
  async resumeCutTurns(): Promise<void> {
    const pending = this.deps.pending;
    if (!pending || this.cutTurnsDone) return;
    this.cutTurnsDone = true;
    const cut = (await pending.takeCutTurns(new Date(this.startedAt))).sort((a, b) => b.resumes - a.resumes);
    const seen = new Set<string>();
    for (const t of cut) {
      const key = `${t.conversationId}|${t.agent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const agent = t.agent === 'sunny' ? this.deps.sunny : this.deps.registry.get(t.agent);
      if (!agent?.def.enabled) continue;
      if (Date.now() - t.startedAt.getTime() > CUT_TURN_MAX_AGE_MS) continue;
      if (t.resumes < 0) {
        this.send(t.conversationId, { type: 'notice', text: '☀ Sunny is back up.' });
        continue;
      }
      if (t.resumes >= CUT_TURN_MAX_RESUMES) {
        this.send(t.conversationId, { type: 'notice', text: `☀ Sunny is back up. ${t.agent}'s last turn was cut by the restart.` });
        continue;
      }
      const speaker = t.speaker as Speaker;
      log.info({ agent: t.agent, conversationId: t.conversationId }, 'picking up a chat turn cut by a restart');
      void this.trackedTurn(t.conversationId, t.agent, speaker, t.resumes + 1, () => this.turn(t.conversationId, t.agent, CUT_TURN_NOTE, 'message', 'all', speaker)).catch((err) => {
        log.warn({ err: (err as Error).message, agent: t.agent }, 'could not pick up a cut turn');
        this.send(t.conversationId, { type: 'notice', text: `☀ Sunny is back up. ${t.agent} could not pick up where it left off; send your message again.` });
      });
    }
  }

  /** One pass: runs that were running when Sunny stopped, then parked runs whose reset passed or whose models changed. */
  async resumePending(): Promise<void> {
    const pending = this.deps.pending;
    if (!pending || this.resuming) return;
    this.resuming = true;
    try {
      const now = Date.now();
      for (const task of await pending.list()) {
        const agent = this.deps.registry.get(task.agent);
        const stale = now - task.createdAt.getTime() > (task.status === 'running' ? INTERRUPTED_MAX_AGE_MS : PENDING_MAX_AGE_MS);
        if (!agent?.def.enabled || stale || task.attempts >= PENDING_MAX_ATTEMPTS) {
          await pending.finish(task.id);
          if (agent?.def.enabled) await this.notify(task.agent, agent.def.notify, `⚠️ ${task.agent}: dropped an unfinished background run (${task.origin}), too old to resume.`, true).catch(() => {});
          continue;
        }
        if (task.status === 'running') {
          // Only rows left from before this process started: a run in flight now is still recorded as running.
          if (this.inFlight.has(task.id) || task.createdAt.getTime() > this.startedAt) continue;
        } else {
          const due = !task.resumeAfter || task.resumeAfter.getTime() <= now;
          const changed = task.signature !== null && task.signature !== (await this.deps.runner.routeSignature(agent.def));
          if (!due && !changed) continue;
        }
        if (!(await pending.restart(task.id))) continue;
        this.inFlight.add(task.id);
        try {
          log.info({ agent: task.agent, origin: task.origin, attempts: task.attempts + 1, was: task.status }, 'resuming background run');
          // Notify if resuming a limit-blocked task (status was 'waiting').
          if (task.status === 'waiting' && this.deps.registry.get(task.agent)?.def.notify) {
            await this.notify(task.agent, this.deps.registry.get(task.agent)!.def.notify, `✓ ${task.agent}: resuming (${task.origin}), limit reset or model changed.`, true).catch(() => {});
          }
          await this.runTask(task.agent, task.message, task.origin, task);
        } finally {
          this.inFlight.delete(task.id);
        }
      }
    } finally {
      this.resuming = false;
    }
  }

  private readonly inFlight = new Set<number>();
  private readonly startedAt = Date.now();

  /** Background runs have no chat: errors always reach the owner, the reply only when the agent cannot notify. */
  private taskEvent(agentName: string, event: Outbound): void {
    const def = this.deps.registry.get(agentName)?.def;
    if (!def) return;
    const tell = (text: string) => void this.notify(agentName, def.notify, text, false).catch((err) => log.error({ err }, 'notify failed'));
    if (event.type === 'file') {
      void this.targets(agentName, def.notify).then((targets) => targets.forEach((t) => this.send(t, event)));
      return;
    }
    if (event.type === 'error') tell(`⚠️ ${event.text}`);
    else if (event.type === 'reply' && event.isError) {
      // Limits are handled by runTask (it waits and retries, and tells the owner once).
      if (!(this.deps.pending && isModelFailure(event.text))) tell(`⚠️ Background run failed: ${event.text}`);
    }
    else if (event.type === 'reply' && !def.connectors.includes('notify') && event.text.trim()) tell(event.text);
  }

  /**
   * Runs one turn of an agent in a conversation, streaming its events there. `forward`
   * limits which events reach the user (delegated runs only show their tool use).
   */
  async turn(
    conversationId: string,
    agentName: string,
    message: string,
    origin: string,
    forward: 'all' | 'tools' = 'all',
    speaker?: Speaker,
    extra: { images?: ImageInput[]; spoken?: boolean; chain?: string[]; noVoice?: boolean } = {},
  ): Promise<RunResult> {
    const who = speaker ?? (await this.owner());
    const isSunny = agentName === 'sunny';
    const agent = isSunny ? this.deps.sunny : this.deps.registry.get(agentName);
    if (!agent) throw new Error(`no agent named "${agentName}"`);
    if (!agent.def.enabled) throw new Error(`${agentName} is disabled`);
    if (isSunny && who.role !== 'owner') throw new Error('only the owner can talk to Sunny');

    await this.checkBudget(agentName);

    const abort = new AbortController();
    const runs = this.running.get(conversationId) ?? [];
    runs.push({ agent: agentName, abort });
    this.running.set(conversationId, runs);
    try {
      this.channels.get(channelOf(conversationId))?.working?.(conversationId);
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'working indicator failed');
    }

    const started = Date.now();
    try {
      const result = await this.deps.runner
        .run({
          agent,
          message,
          images: extra.images,
          spoken: extra.spoken,
          conversationId,
          speaker: who,
          origin,
          signal: abort.signal,
          cwd: isSunny ? this.deps.registry.dir : undefined,
          extraServers: isSunny
            ? { sunny: sunnyServer(this.sunnyDeps(conversationId)) }
            : who.role === 'owner'
              ? {
                  // Operators (full machine access) manage Sunny like Sunny does: setup links, providers, agents.
                  ...(agent.def.access.profile === 'full' && origin !== 'agent' ? { sunny: sunnyServer(this.sunnyDeps(conversationId)) } : {}),
                  ...((extra.chain?.length ?? 0) < MAX_CALL_CHAIN ? { agents: this.agentCallServer(conversationId, agentName, who, [...(extra.chain ?? []), agentName]) } : {}),
                }
              : undefined,
          hooks: {
            onEvent: (event) => {
              if (event.type === 'text' && this.voiceOnly.has(`${conversationId}|${agentName}`)) return;
              if (forward === 'all' || event.type !== 'text') this.send(conversationId, event);
            },
            approve: (req) => this.requestApproval(conversationId, who, req),
            speak: this.speaker(conversationId, agentName, agent, extra.noVoice),
          },
        })
        .catch((err: unknown): RunResult => {
          // A /stop is an answer, not a failure.
          if (abort.signal.aborted) return { text: 'Stopped.', isError: true, durationMs: Date.now() - started };
          throw err;
        });
      const silent = !result.isError && this.voiceOnly.has(`${conversationId}|${agentName}`);
      if (forward === 'all') this.send(conversationId, { type: 'reply', agent: agentName, text: silent ? '' : result.text, isError: result.isError, costUsd: result.costUsd, durationMs: result.durationMs });
      void this.budgetAlert(agentName).catch((err) => log.debug({ err: (err as Error).message }, 'budget alert failed'));
      return result;
    } finally {
      const left = (this.running.get(conversationId) ?? []).filter((r) => r.abort !== abort);
      if (left.length) this.running.set(conversationId, left);
      else this.running.delete(conversationId);
    }
  }

  /**
   * Lets an agent ask another one. The owner approves (or said "always" for that pair); the
   * other agent answers in its own chat, and the reply comes back to the caller as the tool result.
   * Agents already in the chain cannot be asked again (they are busy waiting), and each pair
   * has a cooldown so two agents cannot ping-pong.
   */
  private agentCallServer(conversationId: string, from: string, who: Speaker, chain: string[]) {
    return askAgentServer({
      from,
      others: () =>
        this.deps.registry
          .list()
          .filter((a) => a.def.enabled && !chain.includes(a.def.name))
          .map((a) => ({ name: a.def.name, description: a.def.description })),
      approve: (req) => this.approvals.ask(conversationId, req),
      run: (name, message) => this.callAgent(conversationId, from, name, message, who, chain),
    });
  }

  private lastCalls = new Map<string, number>();

  private async callAgent(fromConv: string, from: string, to: string, message: string, who: Speaker, chain: string[]): Promise<RunResult> {
    const pair = `${from}>${to}`;
    const cooldownSec = (await this.deps.settings?.get<number>(AGENT_CALL_COOLDOWN_KEY)) ?? AGENT_CALL_COOLDOWN_DEFAULT;
    const wait = (this.lastCalls.get(pair) ?? 0) + cooldownSec * 1000 - Date.now();
    if (wait > 0) {
      this.send(fromConv, { type: 'status', agent: from, text: `⏳ cooldown: asking ${to} again in ${Math.ceil(wait / 1000)}s` });
      await new Promise((r) => setTimeout(r, wait));
    }
    this.lastCalls.set(pair, Date.now());

    const home = (await this.targets(to))[0] ?? fromConv;
    const preview = message.length > 1500 ? `${message.slice(0, 1500)}…` : message;
    if (home !== fromConv) this.send(fromConv, { type: 'notice', text: `📨 **${from}** → **${to}** · the conversation continues in ${to}'s chat` });
    this.send(home, { type: 'notice', text: `📨 **${from}** asks **${to}**:\n${preview}` });
    let result: RunResult;
    try {
      result = await this.turn(home, to, `[Message from the agent "${from}", approved by the owner. Your reply goes back to ${from}.]\n${message}`, 'agent', 'all', who, { chain });
    } catch (err) {
      void this.deps.runs?.activity('agent_call', from, `${preview.slice(0, 400)}\n→ failed: ${(err as Error).message}`, { other: to, ok: false }).catch(() => {});
      throw err;
    }
    void this.deps.runs?.activity('agent_call', from, `${preview.slice(0, 400)}\n→ ${result.text.slice(0, 600)}`, { other: to, ok: !result.isError }).catch(() => {});
    if (home !== fromConv) this.send(fromConv, { type: 'status', agent: from, text: result.isError ? `✕ ${to} failed` : `✓ ${to} replied` });
    return result;
  }

  private budgetAlerts = new Set<string>();

  private spentToday(agent: string): Promise<number> {
    return this.deps.runs?.spentToday(agent, this.deps.timezone ?? 'UTC') ?? Promise.resolve(0);
  }

  /** Refuses a run when the agent's daily budget is reached and set to block. */
  private async checkBudget(agent: string): Promise<void> {
    const budget = this.deps.settings && Prefs.of(this.deps.settings).budget(agent);
    if (!budget?.block) return;
    const spent = await this.spentToday(agent);
    if (spent >= budget.dailyUsd) {
      throw new Error(`${agent} reached its daily budget ($${spent.toFixed(2)} of $${budget.dailyUsd.toFixed(2)}). It runs again tomorrow, or raise it: /budget ${agent} <amount>.`);
    }
  }

  /** Tells the owner once a day when an agent passes 80% and 100% of its budget. */
  private async budgetAlert(agent: string): Promise<void> {
    const budget = this.deps.settings && Prefs.of(this.deps.settings).budget(agent);
    if (!budget) return;
    const spent = await this.spentToday(agent);
    const pct = (spent / budget.dailyUsd) * 100;
    const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
    if (!level) return;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.deps.timezone ?? 'UTC' }).format(new Date());
    const key = `${agent}:${day}:${level}`;
    if (this.budgetAlerts.has(key)) return;
    this.budgetAlerts.add(key);
    const line = `$${spent.toFixed(2)} of $${budget.dailyUsd.toFixed(2)} today`;
    await this.notify(
      agent,
      [],
      level === 100
        ? `💸 **${agent}** reached its daily budget (${line}).${budget.block ? ' It is paused until tomorrow.' : ''}`
        : `💸 **${agent}** is at ${Math.round(pct)}% of its daily budget (${line}).`,
      false,
    );
  }

  /** The owner answers their own turns in place; a guest's or a background turn asks the owner where they are. */
  private async requestApproval(conversationId: string, speaker: Speaker, req: ApprovalRequest): Promise<boolean> {
    if (speaker.role === 'owner') return this.approvals.ask(conversationId, req);
    const targets = await this.targets(req.agent);
    const tellGuest = (text: string) => speaker.role === 'member' && this.send(conversationId, { type: 'notice', text });
    if (!targets.length) {
      tellGuest(`${req.agent} needed the owner's approval, but the owner cannot be reached right now.`);
      return false;
    }
    tellGuest(`⏳ Waiting for the owner to approve: ${req.summary}`);
    const allowed = await this.approvals.ask(conversationId, { ...req, reason: `${req.reason} · for ${speaker.role === 'member' ? speaker.name : 'a background run'}` }, targets);
    tellGuest(allowed ? '✓ The owner approved.' : '✕ The owner did not approve.');
    return allowed;
  }

  private sunnyDeps(conversationId: string): SunnyDeps {
    return this.deps.sunnyDeps({
      conversationId,
      approve: (req) => this.approvals.ask(conversationId, req),
      runAgent: (name, message) => {
        if (name === 'sunny') throw new Error('Sunny cannot delegate to itself');
        return this.turn(conversationId, name, message, 'sunny', 'tools');
      },
      sendAuthLink: (flow) => this.sendAuthLink(conversationId, flow),
      notice: (text) => this.send(conversationId, { type: 'notice', text }),
    });
  }

  /** Sends a one-time auth link to a conversation and reports back when the flow ends. */
  sendAuthLink(conversationId: string, flow: AuthFlow): { url: string; expiresAt: number } {
    const link = this.deps.auth.create(flow, (ok, screen) => {
      this.send(conversationId, { type: 'notice', text: ok ? `✓ ${flow.title}: done.` : `✕ ${flow.title}: ${screen.kind === 'failed' ? screen.message : 'not completed'}` });
    });
    this.send(conversationId, { type: 'auth_link', title: link.title, url: link.url, expiresAt: link.expiresAt });
    return { url: link.url, expiresAt: link.expiresAt };
  }

  private stopRuns(conversationId: string): string[] {
    const runs = this.running.get(conversationId) ?? [];
    this.approvals.cancelAll(conversationId);
    for (const r of runs) r.abort.abort();
    return runs.map((r) => r.agent);
  }

  private async command(conversationId: string, text: string, speaker: Speaker, pinned?: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const notice = (t: string) => this.send(conversationId, { type: 'notice', text: t });
    const owner = speaker.role === 'owner';
    const switching = !pinned;

    switch (cmd?.toLowerCase()) {
      case 'help':
      case 'start': {
        const lines = ['**Commands**'];
        if (switching) {
          lines.push('`/agents`: list agents', `\`/use <agent>\`: talk to an agent directly${owner ? ' (`/use sunny` to go back)' : ''}`, '`@agent message`: send one message to an agent');
        }
        lines.push('`/new`: start a fresh conversation', '`/stop`: stop the current run', '`/status`: what is running');
        if (owner) {
          lines.push('`/stop <agent>`: stop an agent running in the background');
          for (const [name, c] of this.commands) if (!c.hidden) lines.push(`\`/${name}${c.usage ? ` ${c.usage}` : ''}\`: ${c.help}`);
          lines.push('Reply `yes` / `no` to an approval request.');
        }
        if (pinned) lines.unshift(`You are talking to **${pinned}**: ${this.deps.registry.get(pinned)?.def.description ?? ''}`);
        return notice(lines.join('\n'));
      }
      case 'agents': {
        if (!switching) return notice(`This bot only talks to **${pinned}**.`);
        const current = await this.currentAgent(conversationId, speaker);
        const visible = [];
        for (const a of this.deps.registry.list()) if (await this.deps.users.canUse(speaker, a.def.name)) visible.push(a);
        const lines = [
          ...(owner ? [`${current === 'sunny' ? '▸' : '•'} **sunny**: ${this.deps.sunny.def.description}`] : []),
          ...visible.map((a) => `${current === a.def.name ? '▸' : '•'} **${a.def.name}**: ${a.def.description}${a.def.enabled ? '' : ' (disabled)'}`),
        ];
        if (!lines.length) return notice('You have not been given access to any agent yet.');
        // The owner gets a button per agent that opens its card (/agent), when the manager commands are there.
        if (owner && this.commands.has('agent')) {
          const names = ['sunny', ...visible.map((a) => a.def.name)];
          const buttons: Button[][] = [];
          for (let i = 0; i < names.length; i += 3) buttons.push(names.slice(i, i + 3).map((n) => ({ label: n === 'sunny' ? '☀ sunny' : n, command: `/agent ${n}` })));
          return this.send(conversationId, { type: 'notice', text: `${lines.join('\n')}\n\nTap an agent to manage it.`, buttons });
        }
        return notice(lines.join('\n'));
      }
      case 'use': {
        if (!switching) return notice(`This bot only talks to **${pinned}**.`);
        const name = arg || (owner ? 'sunny' : '');
        if (!name) return notice('Usage: `/use <agent>`');
        if ((name !== 'sunny' && !this.deps.registry.get(name)) || !(await this.deps.users.canUse(speaker, name))) {
          return notice(`No agent named "${name}" that you can use. Try /agents.`);
        }
        await this.deps.conversations.setAgent(conversationId, name);
        return notice(`Now talking to **${name}**.${name === 'sunny' || !owner ? '' : ' Use `/use sunny` to go back.'}`);
      }
      case 'new': {
        const name = pinned ?? (arg || (await this.currentAgent(conversationId, speaker)));
        const agent = name === 'sunny' ? this.deps.sunny : this.deps.registry.get(name);
        if (!agent || !(await this.deps.users.canUse(speaker, name))) return notice(`No agent named "${name}".`);
        const key = Sessions.key(agent.def, conversationId, speaker.role);
        if (key) await this.deps.sessions.clear(key);
        return notice(`Started a fresh conversation with **${name}**.`);
      }
      case 'stop': {
        if (arg && owner) {
          const stopped = this.stopRuns(`task:${arg}`);
          return notice(stopped.length ? `Stopped ${arg}'s background run.` : `${arg} has nothing running in the background.`);
        }
        const stopped = this.stopRuns(conversationId);
        return notice(stopped.length ? `Stopped ${stopped.join(', ')}.` : 'Nothing is running.');
      }
      case 'status': {
        const runs = this.running.get(conversationId) ?? [];
        const current = pinned ?? (await this.currentAgent(conversationId, speaker));
        const lines = [`Talking to **${current}**. ${runs.length ? `Running: ${runs.map((r) => r.agent).join(', ')}.` : 'Nothing running here.'}`];
        if (owner) {
          const background = [...this.running.keys()].filter((k) => k.startsWith('task:')).map((k) => k.slice('task:'.length));
          if (background.length) lines.push(`In the background: ${background.join(', ')}.`);
        }
        return notice(lines.join('\n'));
      }
      default: {
        const extra = owner && cmd ? this.commands.get(cmd.toLowerCase()) : undefined;
        if (!extra) return notice(`Unknown command /${cmd}. Try /help.`);
        try {
          const reply = await extra.run(conversationId, arg);
          return this.send(conversationId, typeof reply === 'string' ? { type: 'notice', text: reply } : { type: 'notice', ...reply });
        } catch (err) {
          return this.send(conversationId, { type: 'error', text: (err as Error).message });
        }
      }
    }
  }
}
