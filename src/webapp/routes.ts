import { orderByPref, resolveMain } from '../manage/hub-prefs.ts';
import { randomBytes } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Agent } from '../agents/schema.ts';
import type { AgentRegistry } from '../agents/registry.ts';
import { ICON_FILE, readIcon, renderIcon, SUNNY_ICON } from '../agents/icons.ts';
import type { Gateway } from '../gateway/gateway.ts';
import type { Outbound } from '../gateway/types.ts';
import { log } from '../log.ts';
import { verifyInitData } from '../miniapp/auth.ts';
import { saveRecording, TtsError, type TtsService } from '../media/tts.ts';
import type { TranscribeHints } from '../media/transcribe.ts';
import { accentOf, inkOn } from '../agents/theme.ts';
import type { RunLog } from '../runtime/run-log.ts';
import { getProvider, parseModelRef } from '../providers/catalog.ts';
import { spendByProvider, type ProviderAccount, type SubscriptionUsage } from '../providers/usage.ts';
import type { SecretStore } from '../secrets/store.ts';
import { botSecretId } from '../telegram/setup.ts';
import type { User, UserStore } from '../users/users.ts';
import type { WebSessions } from './sessions.ts';

export interface WebAppDeps {
  gateway: Gateway;
  registry: AgentRegistry;
  sunny: Agent;
  users: UserStore;
  secrets: SecretStore;
  sql: Sql;
  runs: RunLog;
  sessions: WebSessions;
  tts?: TtsService;
  /** Account-side limits: Claude subscription windows, API provider balances (cached for a minute). */
  limits?: { subscription(force?: boolean): Promise<SubscriptionUsage>; accounts(force?: boolean): Promise<ProviderAccount[]> };
  transcribe?: (file: string, hints?: TranscribeHints) => Promise<{ text: string; language: string; engine?: string }>;
  /** Where browser recordings wait for Whisper (agents cannot read it). */
  stagingDir: string;
  publicUrl: string;
}

const COOKIE = 'sunny_app';
/** Put before what the user says in a voice call. Starts with "[" so history views can strip it. */
export const CALL_HINT =
  '[Voice call: your reply is read aloud. Answer like you talk: short spoken sentences, no Markdown, lists, tables, code or links. Before a long task, say in a few words what you are doing.]';
const STATIC_DIR = join(import.meta.dirname, 'static');
const AGENT = /^[a-z][a-z0-9-]{1,39}$/;

const PAGE_HEADERS = {
  'cache-control': 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'microphone=(self)',
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://telegram.org",
  ].join('; '),
};

/** What the app is told when a voice cannot be produced (it shows its own translated words by code). */
const SPEAK_FAILURES: Record<string, string> = {
  quota: 'The voice has no credits left.',
  auth: 'The voice service refused the key.',
  voice: "This agent's voice is not available.",
  busy: 'The voice service is busy. Try again.',
  network: 'Could not reach the voice service.',
  none: 'No voice is set up.',
  empty: 'Nothing to say.',
  unknown: 'The voice failed.',
};

const SKIN_TYPES: Record<string, string> = {
  css: 'text/css',
  js: 'text/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function cookieValue(req: FastifyRequest, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Events the app shows, without server paths. */
function forApp(event: Outbound, fileUrl: (path: string) => string | undefined): Record<string, unknown> | undefined {
  switch (event.type) {
    case 'file': {
      const url = fileUrl(event.path);
      return url ? { type: 'file', agent: event.agent, name: event.name, kind: event.kind, caption: event.caption, url } : undefined;
    }
    case 'text':
    case 'tool':
    case 'status':
    case 'reply':
    case 'approval':
    case 'approval_closed':
    case 'auth_link':
    case 'notify':
    case 'notice':
    case 'error':
      return event as unknown as Record<string, unknown>;
    default:
      return undefined;
  }
}

/**
 * One installable web app per agent at /a/<agent>/: chat and voice call on the same thread as the
 * agent's Telegram bot. Opened from Telegram (signed launch data) or in a browser (a one-time
 * sign-in link from Telegram sets a session cookie for /a/, so every agent app is signed in).
 */
/**
 * Home-screen version of a round icon: the background fills the whole square (no transparent corners)
 * and the artwork sits inside the safe zone, so any launcher mask looks right.
 */
export function fullBleed(svg: string): string {
  const open = /<svg[^>]*>/i.exec(svg);
  const close = svg.lastIndexOf('</svg>');
  if (!open || close < 0) return svg;
  const fill = /<circle[^>]*\sr="(?:24\d|25\d)"[^>]*\sfill="(url\(#[^)]+\)|#[0-9a-fA-F]{3,8})"/.exec(svg)?.[1] ?? '#1c1c24';
  const inner = svg.slice(open.index + open[0].length, close);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${fill}"/><g transform="translate(256 256) scale(.84) translate(-256 -256)">${inner}</g></svg>`;
}

export function registerWebApps(app: FastifyInstance, deps: WebAppDeps): void {
  const agentOf = (name: string): Agent => {
    if (!AGENT.test(name)) throw new HttpError(404, 'No such agent.');
    const agent = name === 'sunny' ? deps.sunny : deps.registry.get(name);
    if (!agent) throw new HttpError(404, 'No such agent.');
    return agent;
  };

  /** The agent's colour: set in its definition, else read from its icon. */
  const accentFor = async (agent: Agent): Promise<string> => agent.def.color ?? (await accentOf((await readIcon(agent.def.name === 'sunny' ? SUNNY_ICON : join(agent.dir, ICON_FILE))) ?? (await readIcon(SUNNY_ICON))!));

  /**
   * An agent can wear its own look: a skin/ folder next to its definition with skin.css (and
   * optionally skin.js and images or fonts) restyles its app. Returns the tags to put in the page.
   */
  const skinOf = async (agent: Agent): Promise<string> => {
    if (agent.def.name === 'sunny') return '';
    const dir = join(agent.dir, 'skin');
    const tags: string[] = [];
    for (const [file, tag] of [
      ['skin.css', (v: string) => `<link rel="stylesheet" href="/a/${agent.def.name}/skin/skin.css?v=${v}">`],
      ['skin.js', (v: string) => `<script src="/a/${agent.def.name}/skin/skin.js?v=${v}" defer></script>`],
    ] as const) {
      const st = await stat(join(dir, file)).catch(() => undefined);
      if (st?.isFile()) tags.push(tag(String(Math.floor(st.mtimeMs / 1000))));
    }
    return tags.join('\n');
  };

  const readPrefs = async (userId: string): Promise<Record<string, unknown>> => {
    const [row] = await deps.sql<{ value: Record<string, unknown> }[]>`select value from settings where key = ${`webprefs:${userId}`}`;
    return row?.value ?? {};
  };

  /** The bot that talks for this agent: its own, else Sunny's. */
  const botOf = async (agent: string): Promise<string> => (agent !== 'sunny' && (await deps.secrets.has(botSecretId(agent))) ? agent : 'sunny');

  /** The user's thread with the agent: the Telegram chat with its bot when there is one, else an app-only thread. */
  const conversationFor = async (user: User, agent: string): Promise<{ id: string; pinned?: string; telegram: boolean }> => {
    const bot = await botOf(agent);
    const [chat] = await deps.sql<{ chat_id: string }[]>`select chat_id::text from telegram_chats where bot = ${bot} and user_id = ${user.id} limit 1`;
    if (chat) return { id: `telegram:${bot}:${chat.chat_id}`, pinned: agent, telegram: true };
    return { id: `app:${user.id}:${agent}`, pinned: agent, telegram: false };
  };

  const userFrom = async (req: FastifyRequest): Promise<User | undefined> => {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const id = await deps.sessions.verify(bearer ?? cookieValue(req, COOKIE));
    return id ? deps.users.get(id) : undefined;
  };

  const requireUser = async (req: FastifyRequest, agent: string): Promise<User> => {
    const user = await userFrom(req);
    if (!user) throw new HttpError(401, 'Sign in from Telegram first.');
    if (!(await deps.users.canUse(user, agent))) throw new HttpError(403, `You don't have access to ${agent}.`);
    return user;
  };

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/a/; Max-Age=${Math.floor(deps.sessions.ttlMs / 1000)}; HttpOnly; Secure; SameSite=Lax`);

  const handle =
    <T>(fn: (req: FastifyRequest<{ Params: { agent: string } }>, reply: FastifyReply) => Promise<T>) =>
    async (req: FastifyRequest<{ Params: { agent: string } }>, reply: FastifyReply) => {
      try {
        const out = await fn(req, reply);
        if (!reply.sent) reply.header('cache-control', 'no-store');
        return out;
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
        log.error({ err, url: req.url }, 'webapp: request failed');
        return reply.code(500).send({ error: 'Something went wrong.' });
      }
    };

  /** Files an agent sent in this thread, served by an opaque id (never by path). */
  const files = new Map<string, { path: string; agent: string; expiresAt: number }>();
  const fileUrl = (agent: Agent) => (path: string) => {
    const full = resolve(path);
    if (!full.startsWith(resolve(agent.dir) + sep)) return undefined;
    for (const [k, f] of files) if (f.expiresAt < Date.now()) files.delete(k);
    const id = randomBytes(16).toString('base64url');
    files.set(id, { path: full, agent: agent.def.name, expiresAt: Date.now() + 24 * 3600_000 });
    return `/a/${agent.def.name}/api/file/${id}`;
  };

  app.register(async (scope) => {
    scope.addContentTypeParser(/^(audio\/.*|video\/webm|application\/octet-stream)$/, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    // --- pages and PWA files -------------------------------------------------

    // --- the hub: one installable app that opens every agent ----------------
    const hubHeaders = {
      ...PAGE_HEADERS,
      'content-security-policy': PAGE_HEADERS['content-security-policy'].replace("default-src 'none'", "default-src 'none'; frame-src 'self'").replace(/frame-ancestors [^;]+$/, "frame-ancestors 'none'"),
      'permissions-policy': 'microphone=(self)',
    };
    scope.get('/a/', async (req, reply) => {
      const html = (await readFile(join(STATIC_DIR, 'hub.html'), 'utf8')).replaceAll('__LANG__', /^fr\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'fr' : 'en');
      return reply.headers(hubHeaders).type('text/html').send(html);
    });
    for (const [file, type] of [
      ['hub.js', 'text/javascript'],
      ['hub.css', 'text/css'],
    ] as const) {
      scope.get(`/a/${file}`, async (_req, reply) => reply.headers({ 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }).type(type).send(await readFile(join(STATIC_DIR, file))));
    }
    scope.get('/a/hub-sw.js', async (_req, reply) =>
      reply.headers({ 'cache-control': 'no-cache', 'service-worker-allowed': '/a/' }).type('text/javascript').send(await readFile(join(STATIC_DIR, 'hub-sw.js'))),
    );
    scope.get('/a/hub.webmanifest', async (_req, reply) =>
      reply.type('application/manifest+json').send({
        name: 'Sunny Agents',
        short_name: 'Agents',
        description: 'All your agents in one place: chat, call, open side by side.',
        id: '/a/',
        start_url: '/a/',
        scope: '/a/',
        display: 'standalone',
        background_color: '#0b0b0f',
        theme_color: '#0b0b0f',
        icons: [
          { src: '/a/hub-icon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: '/a/hub-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/a/hub-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        shortcuts: [...deps.registry.list().map((a) => a.def.name), 'sunny'].map((n) => ({ name: title(n), url: `/a/${n}/`, icons: [{ src: `/a/${n}/icon-192.png`, sizes: '192x192', type: 'image/png' }] })),
      }),
    );
    scope.get('/a/hub-icon.svg', async (_req, reply) => reply.headers({ 'cache-control': 'public, max-age=3600', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }).type('image/svg+xml').send((await readIcon(SUNNY_ICON))!));
    scope.get<{ Params: { size: string } }>('/a/hub-icon-:size.png', async (req, reply) => {
      const size = Number(req.params.size);
      if (![180, 192, 512].includes(size)) return reply.code(404).send();
      try {
        return reply.headers({ 'cache-control': 'public, max-age=3600' }).type('image/png').send(await renderIcon(fullBleed((await readIcon(SUNNY_ICON))!), size, 'png'));
      } catch {
        return reply.code(404).send();
      }
    });
    const readSetting = async <T>(key: string): Promise<T | undefined> => (await deps.sql<{ value: T }[]>`select value from settings where key = ${key}`)[0]?.value;
    /** The agents this user may open, with their colour and what the hub needs to start a chat or a call. */
    scope.get('/a/api/agents', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const user = await userFrom(req);
      if (!user) return reply.code(401).send({ error: 'Sign in first.' });
      const out = [];
      for (const agent of [deps.sunny, ...deps.registry.list()]) {
        const name = agent.def.name;
        if (!(await deps.users.canUse(user, name))) continue;
        const accent = await accentFor(agent);
        out.push({ name, title: title(name), description: agent.def.description ?? '', accent, ink: inkOn(accent), icon: `/a/${name}/icon.svg`, pages: [{ id: 'chat', url: `/a/${name}/` }, { id: 'call', url: `/a/${name}/?call=1` }] });
      }
      const [order, main] = await Promise.all([readSetting<string[]>('hub_order'), readSetting<string>('hub_main')]);
      const agents = orderByPref(out, order);
      return { user: { name: user.name ?? '' }, agents, main: resolveMain(agents.map((a) => a.name), main) ?? null, canCall: !!deps.transcribe };
    });
    scope.get<{ Params: { agent: string } }>('/a/:agent', async (req, reply) => reply.redirect(`/a/${encodeURIComponent(req.params.agent)}/`));

    scope.get<{ Params: { agent: string } }>(
      '/a/:agent/',
      handle(async (req, reply) => {
        const agent = agentOf(req.params.agent);
        const accent = await accentFor(agent);
        const skin = await skinOf(agent);
        const html = (await readFile(join(STATIC_DIR, 'index.html'), 'utf8'))
          .replace('<html ', `<html ${skin ? `data-skin="${agent.def.name}" ` : ''}`)
          .replace('</head>', `${skin}</head>`)
          .replaceAll('__AGENT__', agent.def.name)
          .replaceAll('__TITLE__', title(agent.def.name))
          .replaceAll('__ACCENT__', accent)
          .replaceAll('__INK__', inkOn(accent))
          .replaceAll('__LANG__', /^fr\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'fr' : 'en');
        return reply.headers(PAGE_HEADERS).type('text/html').send(html);
      }),
    );

    for (const [file, type] of [
      ['app.js', 'text/javascript'],
      ['app.css', 'text/css'],
      ['voice.js', 'text/javascript'],
      ['capture-worklet.js', 'text/javascript'],
    ] as const) {
      scope.get(`/a/:agent/${file}`, async (_req, reply) => reply.headers({ 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }).type(type).send(await readFile(join(STATIC_DIR, file))));
    }

    // Skin files: stylesheet, script, images and fonts of an agent's own look (never anything else).
    scope.get<{ Params: { agent: string; file: string } }>(
      '/a/:agent/skin/:file',
      handle(async (req, reply) => {
        const agent = agentOf(req.params.agent);
        const file = (req.params as unknown as { file: string }).file;
        const type = SKIN_TYPES[file.split('.').pop()?.toLowerCase() ?? ''];
        if (!/^[\w-]+\.[a-z0-9]+$/i.test(file) || !type) throw new HttpError(404, 'Not found.');
        const body = await readFile(join(agent.dir, 'skin', file)).catch(() => undefined);
        if (!body) throw new HttpError(404, 'Not found.');
        return reply.headers({ 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' }).type(type).send(body);
      }),
    );

    scope.get<{ Params: { agent: string } }>(
      '/a/:agent/sw.js',
      handle(async (req, reply) => {
        agentOf(req.params.agent);
        return reply.headers({ 'cache-control': 'no-cache', 'service-worker-allowed': `/a/${req.params.agent}/` }).type('text/javascript').send(await readFile(join(STATIC_DIR, 'sw.js')));
      }),
    );

    scope.get<{ Params: { agent: string } }>(
      '/a/:agent/manifest.webmanifest',
      handle(async (req, reply) => {
        const agent = agentOf(req.params.agent);
        const base = `/a/${agent.def.name}/`;
        return reply.type('application/manifest+json').send({
          name: title(agent.def.name),
          short_name: title(agent.def.name),
          description: agent.def.description,
          id: base,
          start_url: base,
          scope: base,
          display: 'standalone',
          background_color: '#0b0b0f',
          theme_color: '#0b0b0f',
          icons: [
            { src: `${base}icon.svg`, sizes: 'any', type: 'image/svg+xml' },
            { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
            { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        });
      }),
    );

    const iconSvg = async (agent: Agent) => (await readIcon(agent.def.name === 'sunny' ? SUNNY_ICON : join(agent.dir, ICON_FILE))) ?? (await readIcon(SUNNY_ICON))!;
    scope.get<{ Params: { agent: string } }>(
      '/a/:agent/icon.svg',
      handle(async (req, reply) => reply.headers({ 'cache-control': 'public, max-age=3600', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }).type('image/svg+xml').send(await iconSvg(agentOf(req.params.agent)))),
    );
    scope.get<{ Params: { agent: string; size: string } }>('/a/:agent/icon-:size.png', async (req, reply) => {
      const size = Number(req.params.size);
      if (![180, 192, 512].includes(size)) return reply.code(404).send();
      try {
        return reply.headers({ 'cache-control': 'public, max-age=3600' }).type('image/png').send(await renderIcon(fullBleed(await iconSvg(agentOf(req.params.agent))), size, 'png'));
      } catch {
        return reply.code(404).send();
      }
    });

    // --- sign-in -------------------------------------------------------------
    /** Telegram launch: the signed initData of the agent's bot (or Sunny's) opens a session. */
    scope.post<{ Params: { agent: string } }>(
      '/a/:agent/api/session',
      handle(async (req, reply) => {
        const agent = agentOf(req.params.agent);
        const { initData } = z.object({ initData: z.string().min(10).max(8000) }).parse(req.body);
        let user: User | undefined;
        for (const bot of [...new Set([await botOf(agent.def.name), 'sunny'])]) {
          const token = (await deps.secrets.get(botSecretId(bot)))?.token;
          if (!token) continue;
          const result = verifyInitData(initData, token);
          if ('error' in result) continue;
          user = await deps.users.byIdentity('telegram', String(result.user.id));
          break;
        }
        if (!user) throw new HttpError(401, 'Could not verify Telegram.');
        if (!(await deps.users.canUse(user, agent.def.name))) throw new HttpError(403, `You don't have access to ${agent.def.name}.`);
        const token = await deps.sessions.create(user.id, String(req.headers['user-agent'] ?? ''));
        setCookie(reply, token);
        return { token };
      }),
    );

    /** One-time sign-in link for a browser outside Telegram. */
    scope.get<{ Params: { agent: string; token: string } }>('/a/:agent/login/:token', async (req, reply) => {
      const name = req.params.agent;
      const userId = AGENT.test(name) ? deps.sessions.consumeLink(req.params.token, name) : undefined;
      reply.headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      if (!userId) return reply.code(410).type('text/html').send('<!doctype html><meta name="viewport" content="width=device-width"><p style="font-family:system-ui;padding:24px">This sign-in link was used or has expired. Ask for a new one with /app in Telegram.</p>');
      setCookie(reply, await deps.sessions.create(userId, String(req.headers['user-agent'] ?? '')));
      return reply.redirect(`/a/${name}/`);
    });

    scope.post<{ Params: { agent: string } }>(
      '/a/:agent/api/browser-link',
      handle(async (req) => {
        const agent = agentOf(req.params.agent);
        const user = await requireUser(req, agent.def.name);
        return { url: `${deps.publicUrl}/a/${agent.def.name}/login/${deps.sessions.link(user.id, agent.def.name)}` };
      }),
    );

    scope.post<{ Params: { agent: string } }>(
      '/a/:agent/api/logout',
      handle(async (req, reply) => {
        const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? cookieValue(req, COOKIE);
        if (token) await deps.sessions.revoke(token);
        reply.header('set-cookie', `${COOKIE}=; Path=/a/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
        return { ok: true };
      }),
    );

    // --- data ----------------------------------------------------------------
    scope.get<{ Params: { agent: string } }>(
      '/a/:agent/api/me',
      handle(async (req) => {
        const agent = agentOf(req.params.agent);
        const user = await requireUser(req, agent.def.name);
        const conv = await conversationFor(user, agent.def.name);
        const engine = await deps.tts?.engine(agent.def);
        return {
          user: { name: user.name, role: user.role },
          agent: { name: agent.def.name, title: title(agent.def.name), description: agent.def.description, accent: await accentFor(agent) },
          sharedWithTelegram: conv.telegram,
          voice: { speak: !!engine, engine: engine ?? null, listen: !!deps.transcribe },
          prefs: await readPrefs(user.id),
        };
      }),
    );

    // The app's settings follow the person across browsers and devices (one set for all agent apps).
    scope.post<{ Params: { agent: string } }>(
      '/a/:agent/api/prefs',
      handle(async (req) => {
        const agent = agentOf(req.params.agent);
        const user = await requireUser(req, agent.def.name);
        const prefs = z
          .object({
            mode: z.string().max(16).optional(),
            lang: z.string().max(8).optional(),
            pause: z.string().max(16).optional(),
            bargeIn: z.boolean().optional(),
            readAloud: z.boolean().optional(),
            theme: z.string().max(16).optional(),
          })
          .parse(req.body);
        await deps.sql`
          insert into settings (key, value) values (${`webprefs:${user.id}`}, ${deps.sql.json({ ...(await readPrefs(user.id)), ...prefs } as never)})
          on conflict (key) do update set value = excluded.value, updated_at = now()`;
        return { ok: true };
      }),
    );

    scope.get<{ Params: { agent: string } }>(
      '/a/:agent/api/history',
      handle(async (req) => {
        const agent = agentOf(req.params.agent);
        const user = await requireUser(req, agent.def.name);
        const conv = await conversationFor(user, agent.def.name);
        const rows = await deps.runs.thread(agent.def.name, conv.id, 40);
        return { items: rows.filter((r) => r.origin === 'message' || r.origin === 'app').map((r) => ({ at: r.at, message: r.message, reply: r.reply, isError: r.isError })) };
      }),
    );

    // What is left to spend on the agent's model: subscription session and week, or the API provider's balance, plus this agent's own spend.
    scope.get<{ Params: { agent: string } }>(
      '/a/:agent/api/limits',
      handle(async (req) => {
        const agent = agentOf(req.params.agent);
        await requireUser(req, agent.def.name);
        const force = (req.query as { refresh?: string }).refresh === '1';
        const provider = getProvider(agent.def.provider).id;
        const info = getProvider(provider);
        const spendOf = async (days: number) => {
          const rows = (await deps.runs.usage(days, agent.def.name)).filter((r) => (r.model ? parseModelRef(r.model).provider : 'claude') === provider);
          return spendByProvider(rows)[0] ?? { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
        };
        const [day, week] = await Promise.all([spendOf(1), spendOf(7)]);
        const spend = {
          day: { runs: day.runs, costUsd: day.costUsd, tokens: day.inputTokens + day.outputTokens },
          week: { runs: week.runs, costUsd: week.costUsd, tokens: week.inputTokens + week.outputTokens },
        };
        const base = { agent: agent.def.name, provider, providerName: info.name, model: agent.def.model ?? null, spend };
        if (info.protocol === 'subscription') {
          if (!deps.limits) return { ...base, kind: 'unknown' as const };
          return { ...base, kind: 'subscription' as const, subscription: await deps.limits.subscription(force) };
        }
        const account = deps.limits ? (await deps.limits.accounts(force)).find((a) => a.id === provider) : undefined;
        return { ...base, kind: 'api' as const, account: account ?? null };
      }),
    );

    scope.get<{ Params: { agent: string; id: string } }>(
      '/a/:agent/api/file/:id',
      handle(async (req, reply) => {
        const agent = agentOf(req.params.agent);
        await requireUser(req, agent.def.name);
        const f = files.get((req.params as { id?: string }).id ?? "");
        if (!f || f.agent !== agent.def.name || f.expiresAt < Date.now()) throw new HttpError(404, 'Gone.');
        const ext = f.path.split('.').pop()?.toLowerCase();
        const type = ext === 'ogg' ? 'audio/ogg' : ext === 'mp3' ? 'audio/mpeg' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
        return reply.headers({ 'cache-control': 'private, max-age=3600', 'content-disposition': 'inline' }).type(type).send(await readFile(f.path));
      }),
    );

    // --- voice ---------------------------------------------------------------
    /** Speech → text (ElevenLabs Scribe, else OpenAI, else Whisper on this server). The app then sends the text as a message. */
    scope.post<{ Params: { agent: string }; Querystring: { lang?: string } }>(
      '/a/:agent/api/listen',
      handle(async (req) => {
        const agent = agentOf(req.params.agent);
        await requireUser(req, agent.def.name);
        if (!deps.transcribe) throw new HttpError(503, 'Speech-to-text is not available.', 'stt-none');
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length < 1000) throw new HttpError(400, 'No audio.');
        const type = String(req.headers['content-type']);
        const ext = /wav/.test(type) ? 'wav' : /webm/.test(type) ? 'webm' : /mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
        const lang = String((req.query as { lang?: string }).lang ?? '');
        const path = await saveRecording(body, join(deps.stagingDir, 'calls'), ext);
        const started = Date.now();
        try {
          const t = await deps.transcribe(path, { language: /^[a-z]{2}$/.test(lang) ? lang : undefined, keyterms: [title(agent.def.name)] });
          return { text: t.text, language: t.language, engine: t.engine, ms: Date.now() - started };
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'webapp: transcription failed');
          throw new HttpError(503, "Couldn't transcribe that. Try again.", 'stt');
        } finally {
          await rm(path, { force: true });
        }
      }),
    );

    /** Text → speech in the agent's voice (mp3). */
    scope.post<{ Params: { agent: string } }>(
      '/a/:agent/api/speak',
      handle(async (req, reply) => {
        const agent = agentOf(req.params.agent);
        await requireUser(req, agent.def.name);
        if (!deps.tts) throw new HttpError(503, 'Voice is not available.');
        const { text } = z.object({ text: z.string().min(1).max(20_000) }).parse(req.body);
        try {
          const speech = await deps.tts.speak(text, agent.def, 'mp3');
          return reply.headers({ 'cache-control': 'no-store', 'x-voice-engine': speech.provider }).type(speech.mime).send(speech.audio);
        } catch (err) {
          const code = err instanceof TtsError ? err.code : 'unknown';
          log.warn({ agent: agent.def.name, code, err: (err as Error).message.slice(0, 200) }, 'webapp: speak failed');
          throw new HttpError(503, SPEAK_FAILURES[code] ?? SPEAK_FAILURES.unknown!, code);
        }
      }),
    );

    // --- live thread -----------------------------------------------------------
    scope.get<{ Params: { agent: string } }>('/a/:agent/ws', { websocket: true }, (socket: WebSocket, req) => {
      void (async () => {
        const name = (req.params as { agent: string }).agent;
        let agent: Agent;
        try {
          agent = agentOf(name);
        } catch {
          return socket.close(4004, 'no such agent');
        }
        let user = await userFrom(req);
        let stop: (() => void) | undefined;
        let conv: { id: string; pinned?: string; telegram: boolean } | undefined;
        const send = (msg: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
        const start = async () => {
          if (!user || !(await deps.users.canUse(user, agent.def.name))) return false;
          conv = await conversationFor(user, agent.def.name);
          const toUrl = fileUrl(agent);
          stop = deps.gateway.watch(conv.id, (event) => {
            const out = forApp(event, toUrl);
            if (out) send({ type: 'event', event: out });
          });
          send({ type: 'ready', shared: conv.telegram, running: deps.gateway.isRunning(conv.id) });
          return true;
        };
        const timer = setTimeout(() => !conv && socket.close(4001, 'sign in first'), 10_000);
        if (user) await start();
        socket.on('close', () => {
          clearTimeout(timer);
          stop?.();
        });
        socket.on('message', async (data) => {
          let msg: { type: string; token?: string; text?: string; id?: string; allow?: boolean; always?: boolean; spoken?: boolean; call?: boolean };
          try {
            msg = JSON.parse(String(data));
          } catch {
            return;
          }
          if (msg.type === 'hello' && !conv) {
            const id = await deps.sessions.verify(msg.token);
            user = id ? await deps.users.get(id) : undefined;
            if (!(await start())) socket.close(4003, 'not allowed');
            return;
          }
          if (msg.type === 'ping') return void send({ type: 'pong' });
          if (!conv || !user) return;
          if (msg.type === 'message' && typeof msg.text === 'string' && msg.text.trim()) {
            const text = msg.text.slice(0, 100_000);
            // Keep the Telegram chat readable: show what was said in the app.
            if (conv.telegram) deps.gateway.echo(conv.id, { type: 'notice', text: `${msg.spoken ? '🎙' : '📱'} ${text.length > 600 ? `${text.slice(0, 600)}…` : text}` });
            // In a call the reply is read aloud: ask for speech, not a document. The app hides this prefix.
            const prompt = msg.call ? `${CALL_HINT} ${text}` : text;
            deps.gateway.handleMessage(conv.id, prompt, { speaker: user, pinnedAgent: conv.pinned, noVoice: true, spoken: !!(msg.call || msg.spoken) }).catch((err) => {
              log.error({ err }, 'webapp: message failed');
              // Never leave the app waiting for a reply that will not come.
              send({ type: 'event', event: { type: 'error', text: 'Something went wrong on my side. Try again.' } });
            });
          } else if (msg.type === 'approve' && typeof msg.id === 'string') {
            deps.gateway.answerApproval(conv.id, msg.id, !!msg.allow, msg.always === true);
          }
        });
      })().catch((err) => {
        log.error({ err }, 'webapp: socket failed');
        socket.close(1011, 'error');
      });
    });
  });
}

const title = (name: string) => name.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
