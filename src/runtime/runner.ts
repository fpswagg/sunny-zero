import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { query, type McpServerConfig, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Agent } from '../agents/schema.ts';
import type { ConnectorRegistry } from '../connectors/types.ts';
import type { SettingsStore } from '../manage/settings.ts';
import { Prefs } from '../manage/prefs.ts';
import { SessionStore } from './sessions.ts';
import type { RunLog } from './run-log.ts';
import { dataDenyRules, decide, describeCall, secretDenyRules } from './policy.ts';
import type { Speaker } from '../users/users.ts';
import { agentEnv } from './env.ts';
import { KeyedMutex } from '../util/mutex.ts';
import { log } from '../log.ts';
import { config } from '../config.ts';
import type { FileKind } from '../gateway/types.ts';
import type { ImageInput } from '../media/images.ts';
import { chatServer } from './chat-tools.ts';
import { CLAUDE_MAIN_KEY, SubscriptionFallback } from '../providers/claude-fallback.ts';
import { routeModel, type ModelChoice, type ModelRoute, type RouteDeps } from '../providers/route.ts';
import { formatModelRef, getProvider, parseModelRef, type Effort } from '../providers/catalog.ts';

export type AgentEvent =
  | { type: 'text'; agent: string; text: string }
  | { type: 'file'; agent: string; path: string; name: string; kind: FileKind; caption?: string }
  | { type: 'tool'; agent: string; summary: string }
  | { type: 'status'; agent: string; text: string };

export interface ApprovalRequest {
  agent: string;
  tool: string;
  summary: string;
  reason: string;
  /** When set, the owner may answer "always": later requests with the same key pass without asking. */
  alwaysKey?: string;
}

export interface RunHooks {
  onEvent(event: AgentEvent): void;
  /** Ask the user; resolves false when denied or unanswered. */
  approve(request: ApprovalRequest): Promise<boolean>;
  /** Speaks text as a voice message in the chat. Absent when the agent cannot answer by voice here. */
  speak?(text: string, only?: boolean): Promise<void>;
}

export interface RunRequest {
  agent: Agent;
  message: string;
  /** Images shown to the model with the message (photos the user sent). */
  images?: ImageInput[];
  /** The person spoke: run on the provider's light model. */
  spoken?: boolean;
  conversationId: string;
  /** Who the turn runs for: decides memory, approvals and what the agent is told. */
  speaker: Speaker;
  hooks: RunHooks;
  /** Extra in-process MCP servers for this run (Sunny's management tools). */
  extraServers?: Record<string, McpServerConfig>;
  /** Overrides the working directory (Sunny works in the agents folder). */
  cwd?: string;
  /** What started the run, for the logs. */
  origin?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  text: string;
  isError: boolean;
  sessionId?: string;
  costUsd?: number;
  durationMs: number;
  /** "openai:gpt-5.5", or the bare Claude model on the subscription. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export class Runner {
  private locks = new KeyedMutex();
  private fallbackSvc?: SubscriptionFallback;

  /** Automatic switch between the two Claude subscriptions (needs saved accounts and settings). */
  private get fallback(): SubscriptionFallback | undefined {
    const accounts = this.models.providers?.claude;
    if (!accounts || !this.settings) return undefined;
    const settings = this.settings;
    return (this.fallbackSvc ??= new SubscriptionFallback(
      accounts,
      settings,
      async () => (await settings.get<string>(CLAUDE_MAIN_KEY)) ?? config.SUNNY_CLAUDE_MAIN,
      Date.now,
      (text) => {
        void this.runs.activity('fallback', 'claude-subscription', text, { ok: !text.startsWith('⚠️') }).catch(() => {});
        this.notifyOwner?.(text);
      },
    ));
  }

  /** Where to tell the owner that agents moved to another Claude account (set by the daemon). */
  notifyOwner?: (text: string) => void;

  constructor(
    private readonly sessions: SessionStore,
    private readonly connectors: ConnectorRegistry,
    private readonly runs: RunLog,
    /** Model providers beyond the subscription (keys, proxy). */
    private readonly models: RouteDeps = { defaultModel: config.SUNNY_AGENT_DEFAULT_MODEL },
    private readonly settings?: SettingsStore,
  ) {}

  /**
   * What decides whether a run could work now: the Claude account in use and the agent's models. A run parked on a
   * limit is worth another try as soon as this changes.
   */
  async routeSignature(def: Agent['def']): Promise<string> {
    let account = '';
    try {
      account = (await this.models.providers?.claude?.list())?.find((a) => a.active)?.id ?? '';
    } catch {
      /* unknown: treated as no account */
    }
    return JSON.stringify([account, def.provider, def.model, def.fallbackModels]);
  }

  /** Runs one turn. Turns on the same session wait for each other. */
  run(req: RunRequest): Promise<RunResult> {
    const key = SessionStore.key(req.agent.def, req.conversationId, req.speaker.role);
    return this.locks.run(key ?? `${req.agent.def.name}::${crypto.randomUUID()}`, () => this.turn(req, key));
  }

  private async turn(req: RunRequest, key: string | undefined): Promise<RunResult> {
    const { def } = req.agent;
    const started = Date.now();
    const cwd = req.cwd ?? (def.access.profile === 'restricted' ? join(req.agent.dir, 'workspace') : def.access.workdir ?? join(req.agent.dir, 'workspace'));
    if (!existsSync(cwd)) await mkdir(cwd, { recursive: true });
    const notesDir = join(req.agent.dir, 'memory');
    // Files people send in chat land in inbox/ (see Inbox).
    const inboxDir = join(req.agent.dir, 'inbox');
    if (!existsSync(inboxDir)) await mkdir(inboxDir, { recursive: true });
    const writableDirs = [...(def.memory.notes ? [notesDir] : []), inboxDir, ...(def.access.profile === 'restricted' ? [] : def.access.extraDirs)];
    const readRoots = def.access.readOnlyDirs;
    const roots = [cwd, ...writableDirs];
    const member = req.speaker.role === 'member';
    const bypass = def.access.profile === 'full' && !member;

    // A turn on another provider holds a proxy lease until it ends (released below).
    // Spoken turns are short: use the provider's light model (same Claude history, so context is kept).
    const globalLight = (await this.settings?.get<boolean>('voice_light')) ?? config.SUNNY_VOICE_LIGHT;
    const lightOn = req.spoken ? ((this.settings ? Prefs.of(this.settings).voiceLight(def.name) : undefined) ?? globalLight) : false;
    const light = lightOn ? getProvider(def.provider).lightModel : undefined;
    const chain: ModelChoice[] = [
      { name: def.name, provider: def.provider, model: light ?? def.model, effort: light ? 'low' : def.effort },
      ...def.fallbackModels.map((ref) => {
        const m = parseModelRef(ref);
        return { name: def.name, provider: m.provider, model: m.model, effort: def.effort };
      }),
    ];
    const ctx = { cwd, notesDir, inboxDir, writableDirs, readRoots, roots, member, bypass, started };
    let accountSwitched = false;
    for (let i = 0; ; i++) {
      const last = i === chain.length - 1;
      const choice = chain[i]!;
      let failure: string;
      let route: ModelRoute | undefined;
      try {
        route = await routeModel(choice, agentEnv(), this.models);
        const onSubscription = route.provider.protocol === 'subscription';
        if (onSubscription && !accountSwitched) await this.fallback?.beforeRun();
        const result = await this.turnOn(req, key, route, ctx);
        if (onSubscription && this.fallback) {
          if (!result.isError) void this.fallback.onSuccess();
          else if (!accountSwitched && !req.signal?.aborted && (await this.fallback.onFailure(result.text))) {
            // The login of the account in use is dead: the other one is live now, run the same model again.
            accountSwitched = true;
            i--;
            continue;
          }
        }
        if (last || !result.isError || req.signal?.aborted || !isModelFailure(result.text)) return result;
        failure = result.text;
      } catch (err) {
        if (!accountSwitched && !req.signal?.aborted && route?.provider.protocol === 'subscription' && (await this.fallback?.onFailure((err as Error).message))) {
          accountSwitched = true;
          i--;
          continue;
        }
        if (last || req.signal?.aborted) throw err;
        failure = (err as Error).message;
      } finally {
        if (route?.lease) this.models.proxy?.release(route.lease.token);
      }
      const next = chain[i + 1]!;
      log.warn({ agent: def.name, from: formatModelRef(choice.provider, choice.model), to: formatModelRef(next.provider, next.model), failure: failure.slice(0, 300) }, 'model failed, trying the fallback');
      void this.runs.activity('fallback', def.name, `${failure.split('\n')[0]!.slice(0, 300)}`, { other: `${formatModelRef(choice.provider, choice.model)} → ${formatModelRef(next.provider, next.model)}`, ok: false }).catch(() => {});
      req.hooks.onEvent({ type: 'status', agent: def.name, text: `${formatModelRef(choice.provider, choice.model)} unavailable (${failure.split('\n')[0]!.slice(0, 120)}); switching to ${formatModelRef(next.provider, next.model)}` });
    }
  }

  private async turnOn(
    req: RunRequest,
    key: string | undefined,
    route: ModelRoute,
    ctx: { cwd: string; notesDir: string; inboxDir: string; writableDirs: string[]; readRoots: string[]; roots: string[]; member: boolean; bypass: boolean; started: number },
  ): Promise<RunResult> {
    const { def } = req.agent;
    const { cwd, notesDir, inboxDir, writableDirs, readRoots, roots, bypass, started } = ctx;
    const { servers, missing } = this.connectors.serversFor({ agent: def, conversationId: req.conversationId, speaker: req.speaker });
    if (missing.length) req.hooks.onEvent({ type: 'status', agent: def.name, text: `connectors not available yet: ${missing.join(', ')}` });

    // A history belongs to its model family: another provider cannot resume a transcript with Claude's signed thinking, and back.
    const ns = sessionNamespace(route);
    const resume = key ? await this.sessions.get(key, cwd, ns) : undefined;
    const abort = new AbortController();
    req.signal?.addEventListener('abort', () => abort.abort(), { once: true });

    const options: Options = {
      cwd,
      additionalDirectories: [...writableDirs, ...readRoots],
      model: route.model,
      effort: route.effort,
      maxTurns: def.maxTurns,
      // WebSearch runs on Anthropic's servers; translated models (GPT, Gemini) cannot use it.
      tools: route.provider.protocol === 'openai' ? def.tools.filter((t) => t !== 'WebSearch') : def.tools,
      mcpServers: {
        chat: chatServer({ cwd, roots, readRoots, dataDir: config.dataDir, send: (file) => req.hooks.onEvent({ type: 'file', agent: def.name, ...file }), speak: req.hooks.speak }),
        ...servers,
        ...req.extraServers,
      },
      strictMcpConfig: true,
      settingSources: [],
      // Messages reach the model as written: a leading "/" is not a Claude Code command and
      // "@path" does not pull a file into the prompt (people, including guests, type these).
      verbatimPrompts: true,
      systemPrompt: buildSystemPrompt(req.agent, { cwd, inboxDir, notesDir: def.memory.notes ? notesDir : undefined, readRoots, speaker: req.speaker, origin: req.origin }),
      // Secret files (.env, keys, tokens) stay unreadable in every folder the agent can read, Grep and Glob included.
      // So does Sunny's data folder, which a read-only folder such as ~/projects can contain.
      settings: {
        ...(config.SUNNY_COMPACT_TOKENS > 0 ? { autoCompactWindow: config.SUNNY_COMPACT_TOKENS } : {}),
        ...(bypass ? {} : { permissions: { deny: [...secretDenyRules([...roots, ...readRoots]), ...dataDenyRules(config.dataDir, [...roots, ...readRoots])] } }),
      },
      includePartialMessages: true,
      env: route.env,
      abortController: abort,
      stderr: (data) => log.debug({ agent: def.name, stderr: data.trim() }, 'claude stderr'),
      ...(bypass ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true } : { permissionMode: 'default' }),
      // With bypassed permissions the SDK never calls it (and warns on every run), so it is only set otherwise.
      ...(bypass ? {} : { canUseTool: async (tool, input, { blockedPath }) => {
          const decision = decide(tool, input, {
            def,
            cwd,
            roots,
            readRoots,
            blockedPath,
            speaker: req.speaker.role,
            isMutating: (t) => this.connectors.isMutating(t),
          });
          const summary = describeCall(tool, input);
          if (decision.kind === 'allow') return { behavior: 'allow', updatedInput: input };
          if (decision.kind === 'deny') return { behavior: 'deny', message: decision.reason };
          // "Always allow" remembers the tool for this agent (for shell commands, the program: `git`, `pm2`...).
          const program = tool === 'Bash' ? String((input as { command?: unknown }).command ?? '').trim().split(/\s+/)[0]?.replace(/[^\w./-]/g, '') : '';
          const alwaysKey = `tool:${def.name}:${tool}${program ? `:${program}` : ''}`;
          const ok = await req.hooks.approve({ agent: def.name, tool, summary, reason: decision.reason, alwaysKey });
          return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this action.' };
        } }),
    };

    let result: RunResult;
    try {
      result = await this.consume(req, options, resume, started, route);
    } catch (err) {
      if (!resume || abort.signal.aborted) throw err;
      // A session that cannot be resumed (deleted transcript, other machine) restarts fresh.
      log.warn({ err, agent: def.name, resume }, 'resume failed, starting a new session');
      req.hooks.onEvent({ type: 'status', agent: def.name, text: 'previous session could not be resumed; starting fresh' });
      result = await this.consume(req, options, undefined, started, route);
    }

    if (key && result.sessionId) await this.sessions.set(key, result.sessionId, cwd, ns);
    await this.logRun(req, result);
    return result;
  }

  private async consume(req: RunRequest, options: Options, resume: string | undefined, started: number, route: ModelRoute): Promise<RunResult> {
    const name = req.agent.def.name;
    const q = query({ prompt: single(req.message, req.images), options: { ...options, resume } });
    let sessionId: string | undefined;
    let streamed = '';
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if ('session_id' in msg && msg.session_id) sessionId = msg.session_id;
      switch (msg.type) {
        case 'stream_event': {
          if (msg.parent_tool_use_id) break;
          const ev = msg.event;
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            streamed += ev.delta.text;
            req.hooks.onEvent({ type: 'text', agent: name, text: ev.delta.text });
          }
          break;
        }
        case 'assistant': {
          if (msg.parent_tool_use_id) break;
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              req.hooks.onEvent({ type: 'tool', agent: name, summary: describeCall(block.name, (block.input ?? {}) as Record<string, unknown>) });
            }
          }
          break;
        }
        case 'result': {
          const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n') || msg.subtype;
          return {
            text: text || streamed,
            isError: msg.is_error,
            sessionId,
            ...runCost(route, msg.total_cost_usd, msg.usage),
            durationMs: Date.now() - started,
          };
        }
      }
    }
    return { text: streamed, isError: true, sessionId, durationMs: Date.now() - started, ...runCost(route) };
  }

  /**
   * Sends one tiny prompt through the whole chain (Claude Code, proxy, provider) with no tools,
   * to check a model works before an agent is moved to it.
   */
  async probe(name: string, provider: string | undefined, model: string | undefined, effort?: Effort): Promise<RunResult> {
    const started = Date.now();
    const route = await routeModel({ name, provider, model, effort }, agentEnv(), this.models);
    const cwd = join(config.dataDir, 'probe');
    if (!existsSync(cwd)) await mkdir(cwd, { recursive: true });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    try {
      const q = query({
        prompt: 'Reply with one short sentence: say hello and name the model you are.',
        options: {
          cwd,
          model: route.model,
          effort: route.effort,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          verbatimPrompts: true,
          maxTurns: 1,
          persistSession: false,
          env: route.env,
          abortController: abort,
          permissionMode: 'default',
          canUseTool: async () => ({ behavior: 'deny', message: 'no tools in a probe' }),
          stderr: (data) => log.debug({ probe: name, stderr: data.trim() }, 'claude stderr'),
        },
      });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type !== 'result') continue;
        const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n') || msg.subtype;
        return { text, isError: msg.is_error, durationMs: Date.now() - started, ...runCost(route, msg.total_cost_usd, msg.usage) };
      }
      return { text: 'no answer', isError: true, durationMs: Date.now() - started, ...runCost(route) };
    } catch (err) {
      return { text: abort.signal.aborted ? 'no answer within 2 minutes' : (err as Error).message, isError: true, durationMs: Date.now() - started, ...runCost(route) };
    } finally {
      clearTimeout(timer);
      if (route.lease) this.models.proxy?.release(route.lease.token);
    }
  }

  private async logRun(req: RunRequest, result: RunResult): Promise<void> {
    await this.runs
      .append({
        agent: req.agent.def.name,
        conversation: req.conversationId,
        origin: req.origin ?? 'message',
        message: req.message,
        reply: result.text,
        isError: result.isError,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })
      // A logging failure must not turn a finished turn into an error.
      .catch((err) => log.error({ err, agent: req.agent.def.name }, 'could not log the run'));
  }

}

/** Errors where another model may succeed: limits, quotas, keys, overload, network. Not the agent's own mistakes. */
export function isModelFailure(text: string): boolean {
  return /session limit|usage limit|weekly limit|hit your (\w+ )?limit|limit reached|rate.?limit|overloaded|too many requests|credit balance|insufficient|quota|billing|invalid api key|login.*expired|subscription.{0,20}expired|authentication|unauthori[sz]ed|forbidden|api error|\b(401|402|403|429|500|502|503|504|529)\b|econnre|etimedout|fetch failed|socket hang up|network|model .*not (found|available)|no endpoints/i.test(text);
}

/** Claude on the subscription and on the API share histories; any other model keeps its own. */
export const sessionNamespace = (route: Pick<ModelRoute, 'provider' | 'model'>) => (route.provider.family === 'Claude' ? 'claude' : `${route.provider.id}:${route.model}`);

/**
 * Model, tokens and cost of a run. Claude Code prices Claude models itself; for other
 * providers its price would be a guess, so the proxy's count (provider-reported or from the
 * provider's price list) is used, or none.
 */
function runCost(route: ModelRoute, cliCost?: number, usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): Pick<RunResult, 'model' | 'costUsd' | 'inputTokens' | 'outputTokens'> {
  const claude = route.provider.family === 'Claude';
  const lease = route.lease?.usage;
  const input = usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : lease ? lease.inputTokens + lease.cacheReadTokens : undefined;
  return {
    model: formatModelRef(route.provider.id, route.model),
    costUsd: claude ? cliCost : lease?.costUsd,
    inputTokens: input,
    outputTokens: usage?.output_tokens ?? lease?.outputTokens,
  };
}

/** The user's message as content blocks: images first, then the text. */
async function* single(text: string, images: ImageInput[] = []): AsyncIterable<SDKUserMessage> {
  const content = [
    ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
    { type: 'text' as const, text },
  ];
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

function buildSystemPrompt(agent: Agent, ctx: { cwd: string; inboxDir: string; notesDir?: string; readRoots: string[]; speaker: Speaker; origin?: string }): string {
  const { def } = agent;
  const parts = [agent.prompt.trim() || `You are ${def.name}. ${def.description}`];
  const runtime = [
    `# Runtime`,
    `- You are the agent "${def.name}" in Sunny, the user's personal agent system. Your purpose: ${def.description}`,
    `- Today is ${new Date().toISOString().slice(0, 10)}. Your working directory is ${ctx.cwd}.`,
    `- The user reads your replies in chat (terminal, web or Telegram): keep them concise and use simple Markdown.`,
    `- Some actions need the owner's approval; if one is denied, do not retry it — explain what you needed instead.`,
    `- The user can send photos, files, voice messages and more. Photos are shown to you with the message, speech arrives transcribed, and every file is saved in ${ctx.inboxDir}/<date>/ (use Read to open documents). To send the user a file (a chart, an export, an image), write it to disk and call the chat tool send_file.`,
  ];
  if (ctx.readRoots.length) runtime.push(`- You can read (not change) these folders: ${ctx.readRoots.join(', ')}. Secret files such as .env are blocked.`);
  if (ctx.readRoots.length && def.access.writableFiles.length) {
    runtime.push(`- Exception: you may create and edit files named ${def.access.writableFiles.join(', ')} in those folders. Other changes there need the owner's approval.`);
  }
  if (ctx.speaker.role === 'owner') {
    runtime.push(`- You are talking with ${ctx.speaker.name}, the owner of this system.`);
  } else if (ctx.speaker.role === 'member') {
    runtime.push(
      `- You are talking with ${ctx.speaker.name}, a guest the owner gave access to you. Help them with your job, but do not share the owner's private information or notes beyond what that needs. Actions that change things go to the owner for approval.`,
    );
  } else {
    runtime.push(
      def.connectors.includes('notify')
        ? `- This is a background run (${ctx.origin ?? 'scheduled'}). Nobody reads this chat: reach the owner with the notify tool when something deserves it. Your final reply is only logged.`
        : `- This is a background run (${ctx.origin ?? 'scheduled'}). Nobody reads this chat; your final reply is sent to the owner as a notification, so make it self-contained.`,
    );
  }
  if (ctx.notesDir) {
    runtime.push(
      `- Your persistent notes live in ${ctx.notesDir}. Read ${ctx.notesDir}/MEMORY.md at the start of a task if it exists, and record durable facts, preferences and progress there (one short line per fact; create topic files for longer notes and link them from MEMORY.md).`,
    );
  }
  parts.push(runtime.join('\n'));
  return parts.join('\n\n');
}
