import { startCodexLogin } from '../providers/codex.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BUILTIN_TOOLS, triggerSchema } from '../agents/schema.ts';
import { ICON_FILE, readIcon, SUNNY_ICON } from '../agents/icons.ts';
import type { ConnectorRegistry } from '../connectors/types.ts';
import type { Gateway } from '../gateway/gateway.ts';
import type { TelegramControl } from '../gateway/types.ts';
import { EFFORTS, isProviderId, PROVIDERS, type ProviderId } from '../providers/catalog.ts';
import type { Providers } from '../providers/providers.ts';
import type { SecretStore } from '../secrets/store.ts';
import { botSecretId } from '../telegram/setup.ts';
import { conversationOf } from '../telegram/hub.ts';
import type { UserStore } from '../users/users.ts';
import { log } from '../log.ts';
import { ManageError, type AgentManager } from '../manage/manager.ts';
import { ELEVENLABS_SECRET_ID, type TtsService } from '../media/tts.ts';
import { verifyInitData } from './auth.ts';

export interface AppDeps {
  manager: AgentManager;
  providers: Providers;
  connectors: ConnectorRegistry;
  users: UserStore;
  secrets: SecretStore;
  gateway: Gateway;
  telegram(): TelegramControl | undefined;
  timezone: string;
  tts?: TtsService;
}

const STATIC_DIR = import.meta.dirname;

/** The app is framed by Telegram's web clients; everything it loads comes from here or telegram.org. */
const PAGE_HEADERS = {
  'cache-control': 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    'frame-ancestors https://web.telegram.org https://*.telegram.org https://telegram.org',
  ].join('; '),
};

const effortValue = z.union([z.enum(EFFORTS), z.literal('default'), z.null()]).optional();
const toEffort = (e: z.infer<typeof effortValue>) => (e === 'default' || e === null ? null : e);

/** Errors the owner should read (validation, refusals) come back as 400 with the message. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * The agent manager inside Telegram: a Mini App opened from Sunny's bot. Every API call carries
 * Telegram's signed launch data; only the owner's linked Telegram accounts get in.
 */
export function registerMiniApp(app: FastifyInstance, deps: AppDeps): void {
  const { manager, providers } = deps;

  const owner = async (req: FastifyRequest): Promise<{ chatId: number; conversationId: string }> => {
    const raw = /^tma (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!raw) throw new HttpError(401, 'Open this page from Sunny’s Telegram bot.');
    const token = (await deps.secrets.get(botSecretId('sunny')))?.token;
    if (!token) throw new HttpError(503, 'Sunny’s Telegram bot is not set up.');
    const result = verifyInitData(raw, token);
    if ('error' in result) throw new HttpError(401, `Could not verify Telegram: ${result.error}.`);
    const user = await deps.users.byIdentity('telegram', String(result.user.id));
    if (user?.role !== 'owner') throw new HttpError(403, 'Only the owner can manage agents.');
    // A private chat's id is the user's id: auth links and notices go to the owner's chat with Sunny.
    return { chatId: result.user.id, conversationId: conversationOf('sunny', result.user.id) };
  };

  type Handler = (req: FastifyRequest, ctx: { conversationId: string }) => Promise<unknown>;
  const handle = (fn: Handler) => async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    try {
      const ctx = await owner(req);
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...err.extra });
      if (err instanceof ManageError || err instanceof z.ZodError) return reply.code(400).send({ error: err instanceof z.ZodError ? z.prettifyError(err) : err.message });
      log.error({ err, url: req.url }, 'app: request failed');
      return reply.code(500).send({ error: (err as Error).message });
    }
  };
  const name = (req: FastifyRequest) => (req.params as { name: string }).name;
  const provider = (req: FastifyRequest): ProviderId => {
    const id = (req.params as { id: string }).id;
    if (!isProviderId(id)) throw new HttpError(404, `No provider "${id}".`);
    return id;
  };
  const body = <T extends z.ZodType>(req: FastifyRequest, schema: T): z.infer<T> => schema.parse(req.body ?? {});
  /** The app confirms new privileges with the owner itself, then repeats the call with confirm: true. */
  const confirmWith = (confirmed: boolean | undefined) => async (summary: string, reasons: string[]) => {
    if (confirmed) return true;
    throw new HttpError(409, summary, { confirm: reasons });
  };

  // ── Page ───────────────────────────────────────────────────────────────────────

  const serve = (file: string, type: string) => async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.headers(PAGE_HEADERS).type(type).send(await readFile(join(STATIC_DIR, file)));
  app.get('/app', serve('app.html', 'text/html; charset=utf-8'));
  app.get('/app/app.js', serve('app.js', 'text/javascript; charset=utf-8'));
  app.get('/app/app.css', serve('app.css', 'text/css; charset=utf-8'));

  const extrasState = () => manager.budgets();
  const backupState = () => manager.backupState();

  // ── API ────────────────────────────────────────────────────────────────────────

  app.get(
    '/app/api/bootstrap',
    handle(async () => {
      const [agents, status, defaults, users] = await Promise.all([manager.views(), providers.status(), manager.defaultModel(), deps.users.list()]);
      const connectors = await Promise.all(deps.connectors.list().map(async (c) => ({ name: c.name, description: c.description, ready: (await c.status()).ready })));
      return {
        agents,
        providers: status.map((p) => ({ ...p, protocol: PROVIDERS[p.id].protocol, keyHelp: PROVIDERS[p.id].keyHelp })),
        defaults,
        hub: await manager.hubPrefs(),
        voiceLight: await manager.voiceLight(),
        consoleGlobal: manager.consoleGlobal(),
        agentCalls: await manager.agentCalls(),
        budgets: await extrasState(),
        quiet: manager.quiet(),
        backup: await backupState(),
        efforts: EFFORTS,
        tools: BUILTIN_TOOLS,
        connectors,
        guests: users.filter((u) => u.role === 'member').map((u) => ({ id: u.id, name: u.name, agents: u.agents, linked: u.identities.length > 0 })),
        timezone: deps.timezone,
        voiceEngines: (await deps.tts?.engines()) ?? [],
      };
    }),
  );

  app.get(
    '/app/api/agents/:name',
    handle(async (req) => {
      const view = await manager.view(name(req), true);
      const [runs, usage] = await Promise.all([manager.recentRuns(view.name, 15), manager.usage(30, view.name)]);
      return { agent: view, runs: runs.reverse(), usage };
    }),
  );

  app.get('/app/api/agents/:name/icon', async (req, reply) => {
    try {
      await owner(req);
    } catch (err) {
      return reply.code(err instanceof HttpError ? err.status : 401).send();
    }
    const n = name(req);
    const agent = n === 'sunny' ? undefined : manager.get(n);
    const svg = await readIcon(agent ? join(agent.dir, ICON_FILE) : SUNNY_ICON).catch(() => undefined);
    if (!svg) return reply.code(404).send();
    // Served as an image (never as a document), so a script inside could not run.
    return reply.headers({ 'cache-control': 'private, max-age=300', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }).type('image/svg+xml').send(svg);
  });

  app.post(
    '/app/api/agents/:name/icon',
    handle(async (req) => {
      const b = body(req, z.object({ svg: z.string().max(60_000).optional(), image: z.string().max(60_000).optional() }));
      const message = await manager.setIcon(name(req), b);
      return { message, agent: await manager.view(name(req)) };
    }),
  );

  app.post(
    '/app/api/agents/:name/model',
    handle(async (req) => {
      const b = body(req, z.object({ model: z.string().min(1), effort: effortValue }));
      return { message: await manager.setModel(name(req), b.model, b.effort === undefined ? undefined : toEffort(b.effort)), agent: await manager.view(name(req)) };
    }),
  );

  app.post(
    '/app/api/agents/:name/fallbacks',
    handle(async (req) => {
      const b = body(req, z.object({ models: z.array(z.string().min(1).max(120)).max(5) }));
      return { message: await manager.setFallbacks(name(req), b.models), agent: await manager.view(name(req)) };
    }),
  );

  app.post(
    '/app/api/agents/:name/effort',
    handle(async (req) => {
      const b = body(req, z.object({ effort: effortValue }));
      return { message: await manager.setEffort(name(req), toEffort(b.effort ?? null) ?? null), agent: await manager.view(name(req)) };
    }),
  );

  app.post(
    '/app/api/agents/:name/enabled',
    handle(async (req) => {
      const b = body(req, z.object({ enabled: z.boolean() }));
      return { message: await manager.setEnabled(name(req), b.enabled), agent: await manager.view(name(req)) };
    }),
  );

  const changesSchema = z
    .object({
      description: z.string().min(1).max(500),
      tools: z.array(z.enum(BUILTIN_TOOLS)),
      connectors: z.array(z.string()),
      triggers: z.array(triggerSchema),
      notify: z.array(z.string()),
      maxTurns: z.number().int().positive().nullable(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
      memory: z.object({ session: z.enum(['none', 'conversation', 'shared']), notes: z.boolean() }).partial(),
      voice: z
        .object({
          provider: z.enum(['elevenlabs', 'gemini', 'openai']).optional(),
          voice: z.string().max(80).optional(),
          instructions: z.string().max(500).optional(),
          reply: z.enum(['auto', 'always', 'off']),
        })
        .nullable(),
    })
    .partial();

  app.patch(
    '/app/api/agents/:name',
    handle(async (req) => {
      const b = body(req, z.object({ changes: changesSchema.optional(), prompt: z.string().min(1).max(100_000).optional(), confirm: z.boolean().optional() }));
      const { maxTurns, voice, color, ...rest } = b.changes ?? {};
      const changes = { ...rest, ...(maxTurns !== undefined ? { maxTurns: maxTurns ?? undefined } : {}), ...(voice !== undefined ? { voice: voice ?? undefined } : {}), ...(color !== undefined ? { color: color ?? undefined } : {}) };
      await manager.update(name(req), changes, b.prompt, confirmWith(b.confirm));
      return { agent: await manager.view(name(req), true) };
    }),
  );

  app.post(
    '/app/api/agents/:name/reset',
    handle(async (req) => ({ message: await manager.reset(name(req)) })),
  );

  app.post(
    '/app/api/agents/:name/test',
    handle(async (req) => {
      const b = body(req, z.object({ model: z.string().optional() }));
      return manager.test(name(req), b.model);
    }),
  );

  app.delete(
    '/app/api/agents/:name',
    handle(async (req) => {
      const b = body(req, z.object({ confirm: z.boolean().optional() }));
      await manager.delete(name(req), confirmWith(b.confirm));
      return { ok: true };
    }),
  );

  app.post(
    '/app/api/agents/:name/guests',
    handle(async (req) => {
      const b = body(req, z.object({ user: z.string(), confirm: z.boolean().optional() }));
      const agent = await manager.view(name(req));
      if (agent.isSunny) throw new HttpError(400, 'Guests never talk to Sunny.');
      const user = await deps.users.get(b.user);
      if (!user || user.role !== 'member') throw new HttpError(404, `No guest "${b.user}".`);
      await confirmWith(b.confirm)(`Let ${user.name} use ${agent.name}`, agent.privileges.length ? agent.privileges : [`${agent.name} is a restricted agent`]);
      await deps.users.grant(user.id, agent.name);
      return { agent: await manager.view(agent.name) };
    }),
  );

  app.delete(
    '/app/api/agents/:name/guests/:user',
    handle(async (req) => {
      await deps.users.revoke((req.params as { user: string }).user, name(req));
      return { agent: await manager.view(name(req)) };
    }),
  );

  app.post(
    '/app/api/agents/:name/bot',
    handle(async (req, ctx) => {
      const telegram = deps.telegram();
      if (!telegram) throw new HttpError(503, 'Telegram is not available.');
      manager.get(name(req));
      return { message: await telegram.setup(ctx.conversationId, name(req)) };
    }),
  );

  app.delete(
    '/app/api/agents/:name/bot',
    handle(async (req) => {
      const removed = await deps.telegram()?.removeBot(name(req));
      return { removed: !!removed, agent: await manager.view(name(req)) };
    }),
  );

  app.get(
    '/app/api/providers/:id/models',
    handle(async (req) => {
      const refresh = (req.query as { refresh?: string }).refresh === '1';
      return { models: await providers.listModels(provider(req), refresh) };
    }),
  );

  app.post(
    '/app/api/providers/:id/connect',
    handle(async (req, ctx) => {
      const id = provider(req);
      if (PROVIDERS[id].protocol === 'subscription') throw new HttpError(400, 'The subscription needs no key.');
      if (id === 'codex') {
        const login = await startCodexLogin().catch((e: Error) => {
          throw new HttpError(502, e.message);
        });
        void login.done.then((ok) => deps.gateway.send(ctx.conversationId, { type: 'notice', text: ok ? '✓ **ChatGPT (Codex)** is connected.' : '✕ ChatGPT sign-in did not finish.' }));
        deps.gateway.send(ctx.conversationId, { type: 'notice', text: `Sign in to ChatGPT: open ${login.url} and enter the code **${login.code}** (valid 15 minutes).` });
        return { url: login.url, code: login.code, expiresAt: Date.now() + 15 * 60_000 };
      }
      const link = deps.gateway.sendAuthLink(
        ctx.conversationId,
        providers.keyFlow(id, () => deps.gateway.send(ctx.conversationId, { type: 'notice', text: `✓ **${PROVIDERS[id].name}** is connected.` })),
      );
      return { url: link.url, expiresAt: link.expiresAt };
    }),
  );

  app.delete(
    '/app/api/providers/:id',
    handle(async (req) => ({ removed: await providers.disconnect(provider(req)) })),
  );

  // ── Hub: order of the agents and the main one (shared by the hub PWA and this app) ──

  app.get('/app/api/hub', handle(async () => manager.hubPrefs()));

  app.put(
    '/app/api/hub',
    handle(async (req) => {
      const b = body(req, z.object({ order: z.array(z.string()).max(200).optional(), main: z.string().nullable().optional() }));
      return manager.setHubPrefs(b);
    }),
  );

  // ── Claude subscriptions (switch to the other one when a limit is reached) ──────

  app.get(
    '/app/api/claude-accounts',
    handle(async () => ({ accounts: await manager.claudeAccounts() })),
  );

  app.post(
    '/app/api/claude-accounts/switch',
    handle(async (req) => {
      const b = body(req, z.object({ account: z.string().min(1) }));
      try {
        const account = await manager.switchClaudeAccount(b.account);
        return { account, accounts: await manager.claudeAccounts() };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  app.post(
    '/app/api/claude-accounts/main',
    handle(async (req) => {
      const b = body(req, z.object({ account: z.string().min(1) }));
      return { accounts: await manager.setClaudeMain(b.account) };
    }),
  );

  app.post(
    '/app/api/claude-accounts/add',
    handle(async (_req, ctx) => {
      const link = deps.gateway.sendAuthLink(
        ctx.conversationId,
        providers.claude.loginFlow((a) =>
          deps.gateway.send(ctx.conversationId, { type: 'notice', text: `✓ **${a.label}** is saved.`, buttons: [[{ label: `🔀 Use ${a.label}`, command: `/account switch ${a.id}` }]] }),
        ),
      );
      return { url: link.url, expiresAt: link.expiresAt };
    }),
  );

  app.delete(
    '/app/api/claude-accounts/:id',
    handle(async (req) => {
      try {
        await providers.claude.remove(String((req.params as { id: string }).id));
        return { accounts: await manager.claudeAccounts() };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  app.post(
    '/app/api/agent-calls',
    handle(async (req) => {
      const b = body(req, z.object({ revoke: z.string().regex(/^[a-z][a-z0-9-]*>[a-z][a-z0-9-]*$/).optional(), cooldownSec: z.number().int().min(0).max(3600).optional() }));
      if (b.revoke) await manager.revokeAgentCall(b.revoke);
      if (b.cooldownSec !== undefined) await manager.setAgentCallCooldown(b.cooldownSec);
      return { agentCalls: await manager.agentCalls() };
    }),
  );

  app.post(
    '/app/api/budget',
    handle(async (req) => {
      const b = body(req, z.object({ agent: z.string().min(1).max(40), dailyUsd: z.number().min(0.01).max(10000).nullable(), block: z.boolean().default(false) }));
      const message = await manager.setBudget(b.agent, b.dailyUsd, b.block);
      return { message, budgets: await extrasState() };
    }),
  );

  app.post(
    '/app/api/quiet',
    handle(async (req) => {
      const b = body(req, z.object({ enabled: z.boolean().optional(), from: z.string().optional(), to: z.string().optional() }));
      return { quiet: await manager.setQuiet(b) };
    }),
  );

  app.post(
    '/app/api/backup',
    handle(async () => {
      await manager.backupNow();
      return { backup: await backupState() };
    }),
  );

  app.get(
    '/app/api/activity',
    handle(async (req) => {
      const q = req.query as { kind?: string };
      const kind = q.kind === 'fallback' || q.kind === 'agent_call' ? q.kind : undefined;
      return { activity: await manager.activity({ kind, limit: 60 }) };
    }),
  );

  app.post(
    '/app/api/console',
    handle(async (req) => {
      const b = body(req, z.object({ on: z.boolean() }));
      await manager.setConsole(b.on);
      return { consoleGlobal: b.on };
    }),
  );

  app.post(
    '/app/api/agents/:name/prefs',
    handle(async (req) => {
      const b = body(req, z.object({ console: z.boolean().nullable().optional(), voiceLight: z.boolean().nullable().optional() }));
      await manager.setAgentPrefs(name(req), b);
      return { agent: await manager.view(name(req)) };
    }),
  );

  app.post(
    '/app/api/voice-light',
    handle(async (req) => {
      const b = body(req, z.object({ on: z.boolean() }));
      await manager.setVoiceLight(b.on);
      return { voiceLight: b.on };
    }),
  );

  app.post(
    '/app/api/defaults',
    handle(async (req) => {
      const b = body(req, z.object({ model: z.string().min(1), effort: effortValue }));
      return { message: await manager.setDefaultModel(b.model, b.effort === undefined ? undefined : toEffort(b.effort)), defaults: await manager.defaultModel() };
    }),
  );

  app.get(
    '/app/api/usage',
    handle(async (req) => {
      const days = Math.min(365, Math.max(1, Number((req.query as { days?: string }).days) || 7));
      return { days, rows: await manager.usage(days), providers: await manager.providerSpend(days) };
    }),
  );

  app.get(
    '/app/api/usage/hours',
    handle(async (req) => {
      const q = req.query as { hours?: string; agent?: string };
      const hours = Math.min(168, Math.max(1, Number(q.hours) || 24));
      const [buckets, rows] = await Promise.all([manager.usageHourly(hours, q.agent || undefined), manager.usage(hours / 24, q.agent || undefined)]);
      return { hours, buckets, rows };
    }),
  );

  // ── Connectors ───────────────────────────────────────────────────────────────

  app.get(
    '/app/api/connectors',
    handle(async () => ({
      connectors: await Promise.all(
        deps.connectors.list().map(async (c) => {
          const st = await c.status().catch((e: Error) => ({ ready: false, detail: e.message }));
          return { name: c.name, description: c.description, ready: st.ready, detail: st.detail ?? '', setup: !!c.setup, mutating: c.mutatingTools ?? [], agents: manager.names().filter((n) => manager.get(n).def.connectors?.includes(c.name)) };
        }),
      ),
    })),
  );

  app.post(
    '/app/api/connectors/:name/setup',
    handle(async (req, ctx) => {
      const c = deps.connectors.get((req.params as { name: string }).name);
      if (!c) throw new HttpError(404, 'No such connector.');
      if (!c.setup) throw new HttpError(400, `${c.name} needs no setup.`);
      const link = deps.gateway.sendAuthLink(ctx.conversationId, await c.setup());
      return { url: link.url, expiresAt: link.expiresAt };
    }),
  );

  app.get(
    '/app/api/voice/voices',
    handle(async () => (deps.tts ? deps.tts.voices() : { gemini: [], openai: [], elevenlabs: [] })),
  );

  app.get(
    '/app/api/limits',
    handle(async (req) => {
      const force = (req.query as { refresh?: string }).refresh === '1';
      const [subscription, accounts] = await Promise.all([manager.subscriptionUsage(force), manager.providerAccounts(force)]);
      return { subscription, accounts: accounts.filter((a) => a.connected) };
    }),
  );

  // ── Voice providers ──────────────────────────────────────────────────────────

  app.get(
    '/app/api/voice',
    handle(async () => {
      const [eleven, geminiConnected, openaiConnected] = await Promise.all([
        deps.secrets.get(ELEVENLABS_SECRET_ID).catch(() => undefined),
        deps.providers.connected('gemini'),
        deps.providers.connected('openai'),
      ]);
      return {
        engines: (await deps.tts?.engines()) ?? [],
        providers: {
          elevenlabs: { connected: !!eleven?.apiKey, voiceId: String(eleven?.voiceId ?? ''), model: String(eleven?.model ?? '') },
          gemini: { connected: geminiConnected },
          openai: { connected: openaiConnected },
        },
      };
    }),
  );

  app.post(
    '/app/api/voice/elevenlabs',
    handle(async (req) => {
      const b = body(req, z.object({ apiKey: z.string().min(1), voiceId: z.string().max(80).optional(), model: z.string().max(80).optional() }));
      const check = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': b.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!check.ok) throw new HttpError(400, 'ElevenLabs rejected this key.');
      await deps.secrets.set(
        ELEVENLABS_SECRET_ID,
        { apiKey: b.apiKey, ...(b.voiceId ? { voiceId: b.voiceId } : {}), ...(b.model ? { model: b.model } : {}) },
        { kind: 'form', label: 'ElevenLabs TTS' },
      );
      return { ok: true };
    }),
  );

  app.delete(
    '/app/api/voice/elevenlabs',
    handle(async () => {
      await deps.secrets.delete(ELEVENLABS_SECRET_ID);
      return { ok: true };
    }),
  );
}
