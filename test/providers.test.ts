import { createServer, type Server } from 'node:http';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDERS, providerSecretId } from '../src/providers/catalog.ts';
import { apiUrl, Providers } from '../src/providers/providers.ts';
import { LlmProxy } from '../src/providers/proxy.ts';
import { routeModel } from '../src/providers/route.ts';
import { SseParser } from '../src/providers/translate.ts';
import { SecretStore } from '../src/secrets/store.ts';
import { testDb } from './helpers/db.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: Awaited<ReturnType<typeof testDb>>;

/** A fake OpenAI (/v1) and Anthropic-compatible (/anthropic) API that records requests. */
class FakeUpstream {
  requests: { path: string; headers: Record<string, unknown>; body: any }[] = [];
  private server!: Server;
  url = '';

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        this.requests.push({ path: req.url!, headers: req.headers, body });
        const auth = String(req.headers.authorization ?? '');
        if (!auth.endsWith('sk-good')) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Incorrect API key"}}');
        if (req.url === '/v1/models') {
          return res.end(JSON.stringify({ data: [{ id: 'gpt-5.5', created: 2 }, { id: 'gpt-5-mini', created: 1 }, { id: 'text-embedding-3-large', created: 3 }, { id: 'whisper-1', created: 4 }] }));
        }
        if (req.url === '/v1/chat/completions') {
          if (body.reasoning_effort === 'max') return res.writeHead(400).end('{"error":{"message":"Unsupported value: \'reasoning_effort\' does not support \'max\'"}}');
          if (!body.stream) {
            return res.end(JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          send({ choices: [{ delta: { content: 'po' } }] });
          send({ choices: [{ delta: { content: 'ng' }, finish_reason: 'stop' }] });
          send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
          return res.end('data: [DONE]\n\n');
        }
        if (req.url === '/anthropic/v1/messages') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 1 } } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}\n\n`);
          return res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        }
        res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  close(): void {
    this.server.close();
  }
}

const upstream = new FakeUpstream();
let secrets: SecretStore;
let providers: Providers;
let proxy: LlmProxy;
const savedUrls = { openai: PROVIDERS.openai.baseUrls, kimi: PROVIDERS.kimi.baseUrls };

beforeAll(async () => {
  db = await testDb();
  await upstream.listen();
  secrets = new SecretStore(db.sql, mkdtempSync(join(tmpdir(), 'sunny-prov-')));
  providers = new Providers(secrets);
  proxy = new LlmProxy(providers, 'http://127.0.0.1:1/llm');
  // Kimi's first platform is down; the key works on the second.
  PROVIDERS.openai.baseUrls = [`${upstream.url}/v1`];
  PROVIDERS.kimi.baseUrls = ['http://127.0.0.1:9/anthropic', `${upstream.url}/anthropic`];
});
afterAll(async () => {
  Object.assign(PROVIDERS.openai, { baseUrls: savedUrls.openai });
  Object.assign(PROVIDERS.kimi, { baseUrls: savedUrls.kimi });
  proxy.close();
  upstream.close();
  await db.drop();
});
beforeEach(() => (upstream.requests.length = 0));

const sse = async (res: Response) => new SseParser().feed(await res.text()).map((e) => (e.data === '[DONE]' ? e.data : JSON.parse(e.data)));

describe('Providers', () => {
  it('resolves model list paths', () => {
    expect(apiUrl('https://api.openai.com/v1', '/models')).toBe('https://api.openai.com/v1/models');
    expect(apiUrl('https://api.moonshot.ai/anthropic', '../v1/models')).toBe('https://api.moonshot.ai/v1/models');
  });

  it('checks keys with the provider and stores them through the secure page', async () => {
    expect(await providers.checkKey('openai', 'sk-bad')).toEqual({ error: 'OpenAI rejected this key.' });
    const flow = providers.keyFlow('openai');
    const ctx = { token: 't', oauthRedirectUri: 'x' };
    expect(await flow.start(ctx)).toMatchObject({ kind: 'form', fields: [{ name: 'api_key', type: 'password' }] });
    expect(await flow.submit({ api_key: 'sk-bad' }, ctx)).toMatchObject({ kind: 'form', error: 'OpenAI rejected this key.' });
    expect(await flow.submit({ api_key: 'sk-good' }, ctx)).toMatchObject({ kind: 'done' });
    expect(await providers.connected('openai')).toBe(true);
    expect(await providers.credentials('openai')).toEqual({ apiKey: 'sk-good', baseUrl: `${upstream.url}/v1` });
  });

  it('remembers which platform took a Kimi key', async () => {
    const flow = providers.keyFlow('kimi');
    expect(await flow.submit({ api_key: 'sk-good' }, { token: 't', oauthRedirectUri: 'x' })).toMatchObject({ kind: 'done' });
    expect((await providers.credentials('kimi'))?.baseUrl).toBe(`${upstream.url}/anthropic`);
  });

  it('lists chat models only, suggested first', async () => {
    const models = await providers.listModels('openai', true);
    expect(models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5-mini']);
    expect(models[0]!.suggested).toBe(true);
    expect((await providers.listModels('claude')).map((m) => m.id)).toContain('opus');
  });
});

describe('LlmProxy', () => {
  it('translates a streamed OpenAI answer into Anthropic events and counts usage', async () => {
    const lease = proxy.lease(PROVIDERS.openai, 'gpt-5.5', 'high', 'builder');
    const res = await proxy.messages(lease, { model: 'claude-sonnet', max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'ping' }] });
    expect(res.status).toBe(200);
    const events = await sse(res);
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const sent = upstream.requests.find((r) => r.path === '/v1/chat/completions')!;
    expect(sent.body).toMatchObject({ model: 'gpt-5.5', reasoning_effort: 'high', max_completion_tokens: 1000, stream: true });
    expect(sent.headers.authorization).toBe('Bearer sk-good');
    expect(lease.usage).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 2 });
  });

  it('falls back when the model refuses an effort level, and remembers it', async () => {
    const lease = proxy.lease(PROVIDERS.openai, 'gpt-5-mini', 'max', 'builder');
    const res = await proxy.messages(lease, { model: 'x', max_tokens: 100, messages: [{ role: 'user', content: 'ping' }] });
    expect(await res.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 12, output_tokens: 3 } });
    expect(upstream.requests.map((r) => r.body?.reasoning_effort)).toEqual(['max', 'xhigh']);
    upstream.requests.length = 0;
    await (await proxy.messages(lease, { model: 'x', max_tokens: 100, messages: [{ role: 'user', content: 'again' }] })).json();
    expect(upstream.requests.map((r) => r.body?.reasoning_effort)).toEqual(['xhigh']);
  });

  it('forwards Anthropic-compatible providers with the real key and the agent’s model', async () => {
    const lease = proxy.lease(PROVIDERS.kimi, 'kimi-k3[1m]', 'high', 'atlas');
    const res = await proxy.messages(lease, { model: 'claude-opus', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'anthropic-version': '2023-06-01', authorization: `Bearer ${lease.token}` });
    expect((await sse(res)).map((e) => e.type)).toEqual(['message_start', 'content_block_delta', 'message_delta', 'message_stop']);
    const sent = upstream.requests.find((r) => r.path === '/anthropic/v1/messages')!;
    expect(sent.body).toMatchObject({ model: 'kimi-k3', output_config: { effort: 'high' } });
    expect(sent.headers.authorization).toBe('Bearer sk-good');
    expect(lease.usage).toMatchObject({ inputTokens: 30, outputTokens: 9 });
  });

  it('reports a provider without a key as an Anthropic auth error', async () => {
    const lease = proxy.lease(PROVIDERS.gemini, 'gemini-3.8-flash', undefined, 'x');
    const res = await proxy.messages(lease, { model: 'x', messages: [] });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error', message: expect.stringMatching(/not connected/) } });
  });

  it('only answers live run tokens from this machine', async () => {
    const app = Fastify();
    proxy.register(app);
    const lease = proxy.lease(PROVIDERS.openai, 'gpt-5.5', undefined, 'builder');
    const body = { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] };
    expect((await app.inject({ method: 'POST', url: '/llm/v1/messages', payload: body, headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/llm/v1/messages', payload: body, headers: { authorization: `Bearer ${lease.token}`, 'x-forwarded-for': '1.2.3.4' } })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/llm/v1/messages', payload: body, headers: { 'x-api-key': lease.token } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ content: [{ text: 'pong' }] });
    expect((await app.inject({ method: 'POST', url: '/llm/v1/messages/count_tokens', payload: body, headers: { 'x-api-key': lease.token } })).json().input_tokens).toBeGreaterThan(0);
    proxy.release(lease.token);
    expect((await app.inject({ method: 'POST', url: '/llm/v1/messages', payload: body, headers: { 'x-api-key': lease.token } })).statusCode).toBe(401);
    await app.close();
  });
});

describe('routeModel', () => {
  const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sub-token', ANTHROPIC_API_KEY: 'sk-ant' };

  it('leaves subscription runs as they were', async () => {
    const route = await routeModel({ name: 'a', model: 'opus' }, base, { defaultModel: 'sonnet', providers, proxy });
    expect(route).toMatchObject({ model: 'opus', env: base });
    expect((await routeModel({ name: 'a' }, base, { defaultModel: 'sonnet' })).model).toBe('sonnet');
  });

  it('points other providers at the proxy with a run token, never the real key or the subscription login', async () => {
    const route = await routeModel({ name: 'builder', provider: 'openai', model: 'gpt-5.5', effort: 'high' }, base, { defaultModel: 'sonnet', providers, proxy });
    expect(route.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(route.env.ANTHROPIC_API_KEY).toBe('');
    expect(route.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1/llm');
    expect(route.env.ANTHROPIC_AUTH_TOKEN).toBe(route.lease!.token);
    expect(route.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.5');
    expect(route.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
    expect(JSON.stringify(route.env)).not.toContain('sk-good');
    proxy.release(route.lease!.token);
  });

  it('explains what to do when the provider is not connected', async () => {
    await expect(routeModel({ name: 'builder', provider: 'gemini', model: 'gemini-3.8-flash' }, base, { defaultModel: 'sonnet', providers, proxy })).rejects.toThrow(/Gemini is not connected.*\/connect gemini/);
    await expect(routeModel({ name: 'builder', provider: 'openai' }, base, { defaultModel: 'sonnet', providers, proxy })).rejects.toThrow(/has no model/);
  });

  it('forgets a disconnected key', async () => {
    await secrets.set(providerSecretId('openrouter'), { api_key: 'k' }, { kind: 'form' });
    expect(await providers.disconnect('openrouter')).toBe(true);
    expect(await providers.connected('openrouter')).toBe(false);
  });
});
