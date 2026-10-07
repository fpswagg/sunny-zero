import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.ts';
import { agentSchema, type Agent } from '../src/agents/schema.ts';
import { AuthManager } from '../src/auth/manager.ts';
import { ConnectorRegistry } from '../src/connectors/types.ts';
import { ConversationStore } from '../src/gateway/conversations.ts';
import { Gateway } from '../src/gateway/gateway.ts';
import type { Outbound } from '../src/gateway/types.ts';
import { registerManageCommands } from '../src/manage/commands.ts';
import { AgentManager, ManageError } from '../src/manage/manager.ts';
import { SettingsStore } from '../src/manage/settings.ts';
import { registerMiniApp } from '../src/miniapp/api.ts';
import { signInitData, verifyInitData } from '../src/miniapp/auth.ts';
import { providerSecretId } from '../src/providers/catalog.ts';
import { Providers } from '../src/providers/providers.ts';
import { RunLog } from '../src/runtime/run-log.ts';
import type { RunRequest, RunResult, Runner } from '../src/runtime/runner.ts';
import { SessionStore } from '../src/runtime/sessions.ts';
import { SecretStore } from '../src/secrets/store.ts';
import { botSecretId } from '../src/telegram/setup.ts';
import { UserStore } from '../src/users/users.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
const BOT_TOKEN = '111111111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const OWNER_TG = 100;
const CHAT = 'telegram:sunny:100';

/** OpenAI's model list, for the providers' live checks. */
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5-mini' }, { id: 'gpt-5-nano' }] }));
  return new Response('{}', { status: 404 });
};

let registry: AgentRegistry;
let manager: AgentManager;
let gateway: Gateway;
let users: UserStore;
let secrets: SecretStore;
let sessions: SessionStore;
let sunny: Agent;
const probes: unknown[][] = [];
const sent: { to: string; event: Outbound }[] = [];
const notices = () => sent.filter((s) => s.event.type === 'notice').map((s) => s.event as Extract<Outbound, { type: 'notice' }>);
const lastNotice = () => notices().at(-1)!;

beforeAll(async () => {
  db = await testDb();
  const dir = mkdtempSync(join(tmpdir(), 'sunny-manage-'));
  registry = new AgentRegistry(join(dir, 'agents'), join(dir, 'trash'));
  await registry.load();
  await registry.save({ name: 'builder', description: 'builds apps', model: 'opus', effort: 'high' }, 'You are Builder.');
  await registry.save({ name: 'atlas', description: 'talks projects' }, 'You are Atlas.');
  secrets = new SecretStore(db.sql, dir);
  users = new UserStore(db.sql);
  sessions = new SessionStore(db.sql);
  sunny = { def: agentSchema.parse({ name: 'sunny', description: 'Sunny', model: 'opus' }), prompt: '', dir };
  const providers = new Providers(secrets, fakeFetch);
  manager = new AgentManager({
    registry,
    providers,
    runs: new RunLog(db.sql),
    sessions,
    settings: new SettingsStore(db.sql),
    users,
    sunny,
    timezone: 'UTC',
    defaults: { sunny: 'opus', agents: 'sonnet' },
    probe: async (...args) => {
      probes.push(args);
      return { text: 'Hello, I am a model.', isError: false, durationMs: 1200, inputTokens: 20, outputTokens: 8 };
    },
    upcoming: () => [],
    telegram: () => undefined,
  });
  await manager.init();
  gateway = new Gateway({
    registry,
    runner: { run: async (req: RunRequest): Promise<RunResult> => ({ text: `${req.agent.def.name} ok`, isError: false, durationMs: 1 }) } as unknown as Runner,
    sessions,
    auth: new AuthManager('https://sunny.test', 60_000),
    conversations: new ConversationStore(db.sql),
    users,
    sunny,
    sunnyDeps: () => {
      throw new Error('not used');
    },
    approvalTimeoutMs: 60_000,
  });
  gateway.addChannel({ id: 'telegram', send: (to, event) => sent.push({ to, event }), homes: async () => [CHAT] });
  registerManageCommands({ gateway, manager, providers, appAvailable: true });
});
afterAll(() => db.drop());
beforeEach(() => {
  sent.length = 0;
  probes.length = 0;
});

describe('AgentManager', () => {
  it('refuses a provider that is not connected, then checks models against its list', async () => {
    await expect(manager.setModel('builder', 'openai:gpt-5.5')).rejects.toThrow(/OpenAI is not connected yet.*\/connect openai/);
    await secrets.set(providerSecretId('openai'), { api_key: 'sk-x' }, { kind: 'form' });
    await expect(manager.setModel('builder', 'openai:gpt-9')).rejects.toThrow(ManageError);
    // A unique partial match is corrected; several are offered.
    expect(await manager.setModel('builder', 'openai:nano')).toMatch(/gpt-5-nano/);
    await expect(manager.setModel('builder', 'openai:gpt-5')).rejects.toThrow(/Did you mean: gpt-5.5, gpt-5-mini, gpt-5-nano/);
    expect(await manager.setModel('builder', 'openai:GPT-5.5')).toBe('**builder** now runs on `openai:gpt-5.5` · effort high.');
    expect(registry.get('builder')!.def).toMatchObject({ provider: 'openai', model: 'gpt-5.5', effort: 'high' });
    expect(await manager.setModel('builder', 'sonnet', null)).toMatch(/`sonnet`\.$/);
    expect(registry.get('builder')!.def.provider).toBeUndefined();
    expect(registry.get('builder')!.def.effort).toBeUndefined();
  });

  it("changes Sunny's model and effort, and keeps them across restarts", async () => {
    await manager.setModel('sunny', 'opus', 'max');
    expect(sunny.def).toMatchObject({ model: 'opus', effort: 'max' });
    sunny.def.effort = undefined;
    await manager.init();
    expect(sunny.def.effort).toBe('max');
    await expect(manager.setEnabled('sunny', false)).rejects.toThrow(/built in/);
    await manager.setEffort('sunny', null);
  });

  it('asks before granting new privileges, and forgets sessions when memory changes', async () => {
    const reasons: string[][] = [];
    await expect(
      manager.update('atlas', { access: { readOnlyDirs: ['/tmp'] } }, undefined, async (_s, r) => {
        reasons.push(r);
        return false;
      }),
    ).rejects.toThrow(/not approved/);
    expect(reasons).toEqual([['read access to /tmp']]);
    await sessions.set('atlas::cli:x', 's1', '/w');
    await manager.update('atlas', { memory: { session: 'shared' } }, undefined, async () => true);
    expect(await sessions.get('atlas::cli:x', '/w')).toBeUndefined();
  });

  it('keeps a default model for new agents', async () => {
    expect(await manager.savedDefaultModel()).toBeUndefined();
    expect((await manager.defaultModel()).model).toBe('sonnet');
    await manager.setDefaultModel('openai:gpt-5-mini', 'low');
    expect(await manager.defaultModel()).toEqual({ provider: 'openai', model: 'gpt-5-mini', effort: 'low' });
  });

  it('shows whether an agent can run', async () => {
    await registry.save({ ...registry.get('atlas')!.def, provider: 'gemini', model: 'gemini-3.8-flash' }, 'You are Atlas.');
    expect(await manager.view('atlas')).toMatchObject({ modelRef: 'gemini:gemini-3.8-flash', ready: false, providerName: 'Google Gemini' });
    await registry.save({ ...registry.get('atlas')!.def, provider: undefined, model: undefined }, 'You are Atlas.');
    expect(await manager.view('atlas')).toMatchObject({ modelRef: 'sonnet', modelDefault: true, ready: true });
  });
});

describe('management commands', () => {
  const owner = (text: string) => gateway.handleMessage(CHAT, text);

  it('walks from agent to provider to model with buttons', async () => {
    await owner('/model');
    expect(lastNotice().buttons!.flat().map((b) => b.command)).toEqual(expect.arrayContaining(['/model sunny', '/model builder', '/model atlas', '/model default']));
    await owner('/model builder');
    const providerButtons = lastNotice().buttons!.flat();
    expect(providerButtons).toEqual(expect.arrayContaining([{ label: 'GPT · OpenAI', command: '/model builder openai' }, { label: '➕ Gemini · Gemini', command: '/connect gemini' }]));
    await owner('/model builder openai');
    expect(lastNotice().buttons!.flat().map((b) => b.command)).toContain('/model builder openai:gpt-5.5');
    await owner('/model builder openai:gpt-5.5 xhigh');
    expect(lastNotice().text).toBe('**builder** now runs on `openai:gpt-5.5` · effort xhigh.');
    expect(lastNotice().buttons![0]![0]).toEqual({ label: '🧪 Test it', command: '/test builder' });
  });

  it('sets effort from its menu', async () => {
    await owner('/effort builder');
    expect(lastNotice().buttons!.flat().find((b) => b.label.startsWith('✓'))?.label).toBe('✓ xhigh');
    await owner('/effort builder default');
    expect(registry.get('builder')!.def.effort).toBeUndefined();
    await owner('/effort builder enormous');
    expect(lastNotice().text).toMatch(/Unknown effort/);
  });

  it('tests a model through the probe', async () => {
    await owner('/test builder');
    expect(probes).toEqual([['builder', 'openai', 'gpt-5.5', undefined]]);
    expect(notices().map((n) => n.text)).toEqual(['🧪 Testing **builder** on `openai:gpt-5.5`…', '✓ `openai:gpt-5.5` answered (1.2s · 20→8 tokens):\n> Hello, I am a model.']);
  });

  it('sends the secure key page for a provider', async () => {
    await owner('/connect gemini');
    expect(sent.map((s) => s.event.type)).toEqual(['auth_link', 'notice']);
    expect(sent[0]!.event).toMatchObject({ title: 'Connect Google Gemini' });
    await owner('/connect openai');
    expect(lastNotice().buttons!.flat().map((b) => b.command)).toContain('/disconnect openai');
  });

  it('pauses, lists and shows agent cards', async () => {
    await owner('/pause atlas');
    expect(registry.get('atlas')!.def.enabled).toBe(false);
    await owner('/agent atlas');
    expect(lastNotice().text).toMatch(/⏸ \*\*atlas\*\* · paused/);
    expect(lastNotice().buttons!.flat().map((b) => b.command ?? b.app)).toEqual(expect.arrayContaining(['/resume atlas', '/model atlas', '/agent/atlas']));
    await owner('/resume atlas');
    await owner('/agents');
    expect(lastNotice().buttons!.flat().map((b) => b.command)).toEqual(['/agent sunny', '/agent atlas', '/agent builder']);
  });

  it('keeps management commands to the owner', async () => {
    await users.create('alice', 'Alice');
    await users.grant('alice', 'atlas');
    await gateway.handleMessage('telegram:sunny:200', '/model builder sonnet', { speaker: { id: 'alice', name: 'Alice', role: 'member' } });
    expect(sent.at(-1)!.event).toMatchObject({ type: 'notice', text: expect.stringMatching(/Unknown command/) });
    expect(registry.get('builder')!.def.model).toBe('gpt-5.5');
  });
});

describe('Telegram app', () => {
  let app: FastifyInstance;
  const initData = (id: number, age = 0) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify({ id, first_name: 'PF' }), query_id: 'q' }, BOT_TOKEN);
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, id = OWNER_TG) =>
    app.inject({ method, url: `/app/api${url}`, payload, headers: { authorization: `tma ${initData(id)}` } });

  beforeAll(async () => {
    await secrets.set(botSecretId('sunny'), { token: BOT_TOKEN }, { kind: 'form' });
    await users.addIdentity('owner', { channel: 'telegram', externalId: String(OWNER_TG) });
    await users.addIdentity('alice', { channel: 'telegram', externalId: '200' });
    app = Fastify();
    registerMiniApp(app, { manager, providers: new Providers(secrets, fakeFetch), connectors: new ConnectorRegistry(), users, secrets, gateway, telegram: () => undefined, timezone: 'UTC' });
  });
  afterAll(() => app.close());

  it('verifies Telegram’s signature and age', () => {
    expect(verifyInitData(initData(1), BOT_TOKEN)).toEqual({ user: { id: 1, first_name: 'PF' } });
    expect(verifyInitData(initData(1), '999:other')).toEqual({ error: 'bad signature' });
    expect(verifyInitData(initData(1, 2 * 86400), BOT_TOKEN)).toMatchObject({ error: expect.stringMatching(/expired/) });
    expect(verifyInitData(initData(1).replace('PF', 'XX'), BOT_TOKEN)).toEqual({ error: 'bad signature' });
  });

  it('lets only the owner in', async () => {
    expect((await app.inject({ method: 'GET', url: '/app/api/bootstrap' })).statusCode).toBe(401);
    expect((await call('GET', '/bootstrap', undefined, 200)).statusCode).toBe(403);
    const res = await call('GET', '/bootstrap');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.map((a: { name: string }) => a.name)).toEqual(['sunny', 'atlas', 'builder']);
    expect(body.providers.find((p: { id: string }) => p.id === 'openai').connected).toBe(true);
    expect(body.guests).toEqual([{ id: 'alice', name: 'Alice', agents: ['atlas'], linked: true }]);
  });

  it('serves the page framable by Telegram only', async () => {
    const res = await app.inject({ method: 'GET', url: '/app' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors https:\/\/web\.telegram\.org/);
    expect(res.body).toContain('telegram-web-app.js');
    expect((await app.inject({ method: 'GET', url: '/app/app.js' })).statusCode).toBe(200);
  });

  it('changes model and effort, and validates them', async () => {
    const res = await call('POST', '/agents/atlas/model', { model: 'openai:gpt-5-mini', effort: 'low' });
    expect(res.json()).toMatchObject({ message: expect.stringMatching(/gpt-5-mini/), agent: { modelRef: 'openai:gpt-5-mini', effort: 'low' } });
    expect((await call('POST', '/agents/atlas/model', { model: 'openai:nope' })).json().error).toMatch(/has no model/);
    expect((await call('POST', '/agents/atlas/effort', { effort: 'default' })).json().agent.effort).toBeUndefined();
  });

  it('asks the app to confirm new privileges before granting a guest', async () => {
    await registry.save({ ...registry.get('builder')!.def, access: { ...registry.get('builder')!.def.access, profile: 'full' } }, 'You are Builder.');
    const first = await call('POST', '/agents/builder/guests', { user: 'alice' });
    expect(first.statusCode).toBe(409);
    expect(first.json()).toEqual({ error: 'Let Alice use builder', confirm: ['full machine access without approvals'] });
    expect(await users.agentsOf('alice')).toEqual(['atlas']);
    expect((await call('POST', '/agents/builder/guests', { user: 'alice', confirm: true })).statusCode).toBe(200);
    expect(await users.agentsOf('alice')).toEqual(['atlas', 'builder']);
    await call('DELETE', '/agents/builder/guests/alice');
    expect(await users.agentsOf('alice')).toEqual(['atlas']);
  });

  it('edits tools, schedules and prompt, refusing bad input', async () => {
    const res = await call('PATCH', '/agents/atlas', { changes: { tools: ['Read', 'Grep'], triggers: [{ type: 'manual' }, { type: 'cron', schedule: '0 8 * * *', prompt: 'Morning.' }] }, prompt: 'You are Atlas, v2.' });
    expect(res.statusCode).toBe(200);
    expect(registry.get('atlas')!.def.tools).toEqual(['Read', 'Grep']);
    expect(registry.get('atlas')!.prompt).toBe('You are Atlas, v2.');
    const bad = await call('PATCH', '/agents/atlas', { changes: { triggers: [{ type: 'cron', schedule: 'every day', prompt: 'x' }] } });
    expect(bad.statusCode).toBe(400);
    expect((await call('PATCH', '/agents/atlas', { changes: { tools: ['Teleport'] } })).statusCode).toBe(400);
    expect((await call('PATCH', '/agents/sunny', { prompt: 'x' })).json().error).toMatch(/built in/);
  });

  it('opens the secure key page from the app and sends it to the owner’s chat', async () => {
    sent.length = 0;
    const res = await call('POST', '/providers/kimi/connect');
    expect(res.json().url).toMatch(/^https:\/\/sunny\.test\/auth\//);
    expect(sent[0]).toMatchObject({ to: CHAT, event: { type: 'auth_link', title: 'Connect Moonshot Kimi' } });
  });
});
