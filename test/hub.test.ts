import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { testDb } from './helpers/db.ts';
import { registerWebApps, type WebAppDeps } from '../src/webapp/routes.ts';

const ICON = join(import.meta.dirname, '..', 'agents');
const agent = (name: string, color: string) => ({ def: { name, description: `${name} agent`, color }, prompt: '', dir: join(ICON, name) });

async function server(signedIn: boolean, sql?: unknown) {
  const deps = {
    sql: sql ?? (await testDb()).sql,
    registry: { list: () => [agent('builder', '#34d399'), agent('atlas', '#a78bfa')], get: () => undefined },
    sunny: agent('sunny', '#7c83ff'),
    users: { get: async () => ({ id: 'owner', name: 'Owner' }), canUse: async (_u: unknown, a: string) => a !== 'atlas' },
    sessions: { verify: async (t?: string) => (signedIn && t === 'ok' ? 'owner' : undefined), ttlMs: 1000 },
    transcribe: async () => ({ text: '', language: 'en' }),
  } as unknown as WebAppDeps;
  const app = Fastify();
  await app.register(async (a) => registerWebApps(a, deps));
  return app;
}

describe('agents hub', () => {
  it('serves the page, assets and manifest', async () => {
    const app = await server(true);
    const page = await app.inject('/a/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("frame-src 'self'");
    expect(page.body).toContain('/a/hub.webmanifest');
    expect(page.body).toContain('id="track"');
    expect(page.body).not.toMatch(/<h1/); // immersive: no title bar
    const js = (await app.inject('/a/hub.js')).body;
    expect(js).toContain('allow: \'microphone; autoplay');
    expect(js).toContain('call-start');
    // endless carousel; order and main agent come from the server
    for (const k of ['function recenter', 'function step', 'data.main']) expect(js).toContain(k);
    const appJs = (await app.inject('/a/builder/app.js')).body;
    expect(appJs).toContain('sunnyHub'); // the agent app listens to the hub
    expect(appJs).toContain("get('embed') === '1'");
    for (const [url, type] of [['/a/hub.js', 'javascript'], ['/a/hub.css', 'css'], ['/a/hub-sw.js', 'javascript']] as const) {
      const r = await app.inject(url);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain(type);
    }
    expect((await app.inject('/a/hub-sw.js')).headers['service-worker-allowed']).toBe('/a/');
    const m = (await app.inject('/a/hub.webmanifest')).json();
    expect(m).toMatchObject({ start_url: '/a/', scope: '/a/', display: 'standalone' });
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toContain('512x512');
    expect(m.shortcuts.map((s: { url: string }) => s.url)).toContain('/a/builder/');
    expect((await app.inject('/a/hub-icon-192.png')).headers['content-type']).toBe('image/png');
    expect((await app.inject('/a/hub-icon-99.png')).statusCode).toBe(404);
    await app.close();
  });

  it('lists only the agents the signed-in user may use', async () => {
    const app = await server(true);
    expect((await app.inject('/a/api/agents')).statusCode).toBe(401);
    const r = await app.inject({ url: '/a/api/agents', headers: { cookie: 'sunny_app=ok' } });
    expect(r.statusCode).toBe(200);
    const { agents, canCall } = r.json();
    expect(agents.map((a: { name: string }) => a.name)).toEqual(['sunny', 'builder']);
    expect(agents[1]).toMatchObject({ accent: '#34d399', icon: '/a/builder/icon.svg' });
    expect(canCall).toBe(true);
    await app.close();
  });

  it('follows the order and main agent saved on the server; a deleted main falls back', async () => {
    const db = await testDb();
    const app = await server(true, db.sql);
    const get = async () => (await app.inject({ url: '/a/api/agents', headers: { cookie: 'sunny_app=ok' } })).json();
    expect((await get()).main).toBeNull();
    await db.sql`insert into settings (key, value) values ('hub_order', ${db.sql.json(['builder', 'sunny'])}), ('hub_main', ${db.sql.json('builder')})`;
    const r = await get();
    expect(r.agents.map((a: { name: string }) => a.name)).toEqual(['builder', 'sunny']);
    expect(r.main).toBe('builder');
    await db.sql`update settings set value = ${db.sql.json('gone')} where key = 'hub_main'`;
    expect((await get()).main).toBeNull();
    await app.close();
    await db.drop();
  });
});
