import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import type { AuthManager } from '../auth/manager.ts';
import { renderExpired, renderScreen } from '../auth/pages.ts';
import type { ConnectorEvent } from '../connectors/types.ts';
import type { Gateway } from '../gateway/gateway.ts';
import { handleSocket, SocketChannel } from './socket-channel.ts';

export interface HttpDeps {
  auth: AuthManager;
  gateway: Gateway;
  adminToken: string;
  /** Secret other apps send (x-sunny-secret header) to POST events to /events/<source>. */
  eventsSecret?: string;
  /** Emits an external event so agents with matching triggers handle it. */
  emitExternalEvent?: (event: ConnectorEvent) => void;
  /** More routes: the model proxy, the Telegram app. */
  routes?: ((app: FastifyInstance) => void)[];
}

const PAGE_HEADERS = {
  'cache-control': 'no-store',
  // The token is in the URL: never leak it through Referer to the provider or linked consoles.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createHttpServer(deps: HttpDeps): Promise<{ app: FastifyInstance; channels: Record<'cli' | 'web', SocketChannel> }> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  const channels = { cli: new SocketChannel('cli'), web: new SocketChannel('web') };
  deps.gateway.addChannel(channels.cli);
  deps.gateway.addChannel(channels.web);

  app.get('/health', async () => ({ ok: true }));

  // OAuth providers redirect here with ?state=<link token>&code=...
  app.get<{ Querystring: Record<string, string> }>('/auth/oauth/callback', async (req, reply) => {
    const params = new URLSearchParams(req.query);
    const state = params.get('state') ?? '';
    const screen = await deps.auth.callback(state, params);
    if (!screen) return reply.code(410).headers(PAGE_HEADERS).type('text/html').send(renderExpired());
    // Drop the code from the address bar by moving to the link's own page.
    return reply.code(303).header('location', `/auth/${encodeURIComponent(state)}`).send();
  });

  app.get<{ Params: { token: string } }>('/auth/:token', async (req, reply) => {
    const screen = await deps.auth.view(req.params.token);
    reply.headers(PAGE_HEADERS).type('text/html');
    if (!screen) return reply.code(410).send(renderExpired());
    return reply.send(renderScreen(screen, `/auth/${req.params.token}`, deps.auth.expiry(req.params.token)));
  });

  app.post<{ Params: { token: string }; Body: Record<string, string | string[]> }>('/auth/:token', async (req, reply) => {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) values[k] = Array.isArray(v) ? (v[0] ?? '') : String(v);
    const screen = await deps.auth.submit(req.params.token, values);
    if (!screen) return reply.code(410).headers(PAGE_HEADERS).type('text/html').send(renderExpired());
    // Post/redirect/get: a refresh never re-submits credentials.
    return reply.code(303).header('location', `/auth/${req.params.token}`).send();
  });

  for (const add of deps.routes ?? []) add(app);

  if (deps.emitExternalEvent) {
    app.post<{ Params: { source: string }; Body: { name?: string; summary?: string; data?: Record<string, unknown> } }>(
      '/events/:source',
      async (req, reply) => {
        if (!deps.eventsSecret) return reply.code(503).send({ error: 'event reception not configured' });
        const given = req.headers['x-sunny-secret'];
        if (typeof given !== 'string' || !tokenMatches(deps.eventsSecret, given)) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
        const source = req.params.source;
        const { name, summary, data } = req.body ?? {};
        if (!name || !summary) return reply.code(400).send({ error: 'name and summary are required' });
        deps.emitExternalEvent!({ source, name, summary, data: data ?? {} });
        return { ok: true };
      },
    );
  }

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => {
      handleSocket(socket, deps.gateway, channels, (token) => tokenMatches(deps.adminToken, token));
    });
  });

  return { app, channels };
}
