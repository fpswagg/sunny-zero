import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { log } from '../log.ts';
import { effortFromBudget, EFFORTS, reasoningEffortCandidates, upstreamModel, type Effort, type Provider } from './catalog.ts';
import { CODEX_BASE_URL, codexAuth, codexEffort, messageFromSse, ResponsesTranslator, toResponsesRequest } from './codex.ts';
import { apiUrl, authHeaders, type Providers } from './providers.ts';
import {
  anthropicError,
  estimateTokens,
  SseParser,
  sse,
  StreamTranslator,
  toAnthropicResponse,
  toOpenAIRequest,
  upstreamMessage,
  type AnthropicRequest,
  type OpenAIChunk,
  type OpenAIResponse,
  type SignatureStore,
} from './translate.ts';

export interface Usage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** USD, when the provider reported it or its price is known. */
  costUsd?: number;
}

/** One run's access to a provider through the proxy. The token is what the agent's CLI holds; it dies with the run. */
export interface Lease {
  token: string;
  provider: Provider;
  model: string;
  effort?: Effort;
  agent: string;
  usage: Usage;
  /** USD per million tokens, to price usage the provider does not price itself. */
  pricing?: { input: number; output: number };
  expiresAt: number;
}

const LEASE_TTL_MS = 12 * 3_600_000;
const PING_MS = 10_000;
const SIGNATURES_MAX = 5_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Thought signatures by tool call id, oldest dropped first. */
class SignatureCache implements SignatureStore {
  private map = new Map<string, string>();
  get(id: string) {
    return this.map.get(id);
  }
  set(id: string, signature: string) {
    this.map.set(id, signature);
    if (this.map.size > SIGNATURES_MAX) this.map.delete(this.map.keys().next().value!);
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The local endpoint agents' Claude Code processes call when their model is not on the
 * subscription. It speaks Anthropic's Messages API to the CLI, holds the real keys, and either
 * forwards (Claude API, Kimi, OpenRouter) or translates (OpenAI, Gemini). It only answers
 * loopback requests carrying a live lease token.
 */
export class LlmProxy {
  private leases = new Map<string, Lease>();
  private signatures = new SignatureCache();
  /** reasoning_effort value that worked, per provider, model and effort. */
  private effortMemo = new Map<string, string | null>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly providers: Providers,
    /** Base URL of the proxy as the CLI reaches it, e.g. http://127.0.0.1:3210/llm */
    readonly localUrl: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [token, lease] of this.leases) if (lease.expiresAt < now) this.leases.delete(token);
    }, 60_000);
    this.sweeper.unref();
  }

  lease(provider: Provider, model: string, effort: Effort | undefined, agent: string, pricing?: Lease['pricing']): Lease {
    const lease: Lease = {
      token: `sunny-${randomBytes(24).toString('base64url')}`,
      provider,
      model,
      effort,
      agent,
      pricing,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      expiresAt: Date.now() + LEASE_TTL_MS,
    };
    this.leases.set(lease.token, lease);
    return lease;
  }

  release(token: string): void {
    this.leases.delete(token);
  }

  private find(headers: Record<string, string | string[] | undefined>): Lease | undefined {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ''))?.[1];
    const token = bearer ?? (typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : undefined);
    const lease = token ? this.leases.get(token.trim()) : undefined;
    return lease && lease.expiresAt > Date.now() ? lease : undefined;
  }

  private account(lease: Lease, input: number, output: number, cacheRead: number, cost?: number): void {
    const u = lease.usage;
    u.requests++;
    u.inputTokens += input;
    u.outputTokens += output;
    u.cacheReadTokens += cacheRead;
    const priced = cost ?? (lease.pricing ? ((input + cacheRead) * lease.pricing.input + output * lease.pricing.output) / 1e6 : undefined);
    if (priced !== undefined) u.costUsd = (u.costUsd ?? 0) + priced;
  }

  /** Fastify routes under /llm. */
  register(app: FastifyInstance): void {
    const guard = (req: FastifyRequest): Lease | Response => {
      // Never through the public HTTPS route: only the agents' CLIs on this machine.
      if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || req.headers['x-forwarded-for']) return json(403, anthropicError(403, 'local only'));
      return this.find(req.headers) ?? json(401, anthropicError(401, 'unknown or expired run token'));
    };
    const send = async (reply: import('fastify').FastifyReply, res: Response) => {
      reply.code(res.status);
      res.headers.forEach((v, k) => void reply.header(k, v));
      if (!res.body) return reply.send();
      return reply.send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream));
    };

    app.register(async (scope) => {
      // Requests carry whole conversations, images and PDFs.
      const opts = { bodyLimit: 64 * 1024 * 1024 };
      scope.post('/llm/v1/messages', opts, async (req, reply) => {
        const lease = guard(req);
        if (lease instanceof Response) return send(reply, lease);
        const abort = new AbortController();
        reply.raw.on('close', () => abort.abort());
        return send(reply, await this.messages(lease, req.body as AnthropicRequest, req.headers, abort.signal));
      });
      scope.post('/llm/v1/messages/count_tokens', opts, async (req, reply) => {
        const lease = guard(req);
        if (lease instanceof Response) return send(reply, lease);
        return send(reply, await this.countTokens(lease, req.body as AnthropicRequest, req.headers));
      });
      scope.all('/llm/*', async (_req, reply) => send(reply, json(404, anthropicError(404, 'not supported by Sunny’s proxy'))));
    });
  }

  /** Handles one Messages request for a lease. */
  async messages(lease: Lease, body: AnthropicRequest, headers: Record<string, string | string[] | undefined> = {}, signal?: AbortSignal): Promise<Response> {
    if (lease.provider.protocol === 'responses') {
      try {
        return await this.codex(lease, body, signal);
      } catch (err) {
        if (signal?.aborted) return json(499, anthropicError(499, 'client went away'));
        log.warn({ err: (err as Error).message, provider: lease.provider.id, agent: lease.agent }, 'llm proxy: codex failed');
        return json(502, anthropicError(502, `${lease.provider.name}: ${(err as Error).message}`));
      }
    }
    const creds = await this.providers.credentials(lease.provider.id);
    if (!creds) return json(401, anthropicError(401, `${lease.provider.name} is not connected. Ask Sunny to connect it (or pick another model).`));
    try {
      return lease.provider.protocol === 'openai'
        ? await this.translated(lease, body, creds.baseUrl, creds.apiKey, signal)
        : await this.forwarded(lease, body, headers, creds.baseUrl, creds.apiKey, signal);
    } catch (err) {
      if (signal?.aborted) return json(499, anthropicError(499, 'client went away'));
      log.warn({ err: (err as Error).message, provider: lease.provider.id, agent: lease.agent }, 'llm proxy: upstream failed');
      return json(502, anthropicError(502, `${lease.provider.name} could not be reached: ${(err as Error).message}`));
    }
  }

  /** ChatGPT / Codex: Messages in, Responses out, with the Codex CLI's sign-in. */
  private async codex(lease: Lease, body: AnthropicRequest, signal?: AbortSignal): Promise<Response> {
    const auth = await codexAuth(this.doFetch);
    if (!auth) return json(401, anthropicError(401, 'ChatGPT is not connected. Run "codex login --device-auth" on the server, or pick another model.'));
    const model = upstreamModel(lease.model);
    const requested = body.output_config?.effort;
    const effort = codexEffort(lease.effort ?? ((EFFORTS as readonly string[]).includes(requested ?? '') ? requested : effortFromBudget(body.thinking?.budget_tokens)));
    const post = (reasoning: string | undefined) =>
      this.doFetch(`${CODEX_BASE_URL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.accessToken}`, 'chatgpt-account-id': auth.accountId, 'content-type': 'application/json', accept: 'text/event-stream', 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' },
        body: JSON.stringify(toResponsesRequest(body, model, reasoning)),
        signal,
      });
    let res = await post(effort);
    if (!res.ok && effort) {
      const text = await res.clone().text().catch(() => '');
      // A model that does not know this reasoning level: try without.
      if (res.status === 400 && /reasoning|effort/i.test(text)) res = await post(undefined);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return json(res.status, anthropicError(res.status, `${lease.provider.name}: ${upstreamMessage(text)}`));
    }
    if (!res.body) return json(502, anthropicError(502, 'empty answer'));

    const translator = new ResponsesTranslator(lease.model);
    const upstream = res.body;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const run = async (put: (t: string) => void) => {
      const reader = upstream.getReader();
      put(translator.start());
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
            let data: unknown;
            try {
              data = JSON.parse(ev.data);
            } catch {
              continue;
            }
            put(translator.push(data as Parameters<ResponsesTranslator['push']>[0]));
          }
        }
        put(translator.end());
      } finally {
        this.account(lease, translator.usage.input_tokens, translator.usage.output_tokens, translator.usage.cache_read_input_tokens ?? 0, 0);
        await reader.cancel().catch(() => {});
      }
    };

    if (!body.stream) {
      let text = '';
      await run((t) => (text += t));
      return json(200, messageFromSse(text, lease.model, translator.id));
    }
    let ping: NodeJS.Timeout | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const put = (text: string) => text && controller.enqueue(encoder.encode(text));
        ping = setInterval(() => put(sse('ping', { type: 'ping' })), PING_MS);
        try {
          await run(put);
        } catch (err) {
          if (!signal?.aborted) put(sse('error', anthropicError(502, `${lease.provider.name}: ${(err as Error).message}`)));
        } finally {
          clearInterval(ping);
          try {
            controller.close();
          } catch {
            // closed by a cancel
          }
        }
      },
      cancel: () => clearInterval(ping),
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }

  private async forwarded(lease: Lease, body: AnthropicRequest, headers: Record<string, string | string[] | undefined>, baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<Response> {
    const { provider } = lease;
    const payload: AnthropicRequest = { ...body };
    if (provider.forceModel) payload.model = upstreamModel(lease.model);
    if (provider.effort === 'output_config' && lease.effort && !payload.output_config?.effort) payload.output_config = { ...payload.output_config, effort: lease.effort };
    const res = await this.doFetch(apiUrl(baseUrl, '/v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': String(headers['anthropic-version'] ?? '2023-06-01'),
        ...(headers['anthropic-beta'] ? { 'anthropic-beta': String(headers['anthropic-beta']) } : {}),
        ...authHeaders(provider, apiKey),
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return json(res.status, anthropicError(res.status, `${provider.name}: ${upstreamMessage(text)}`));
    }
    if (!payload.stream || !res.body) {
      const message = (await res.json()) as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cost?: number } };
      const u = message.usage ?? {};
      this.account(lease, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cost);
      return json(200, message);
    }
    // Pass the stream through untouched, reading usage on the way.
    const parser = new SseParser();
    const decoder = new TextDecoder();
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cost: number | undefined;
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
        for (const ev of parser.feed(decoder.decode(chunk, { stream: true }))) {
          if (!ev.data.includes('usage')) continue;
          try {
            const data = JSON.parse(ev.data) as { message?: { usage?: Record<string, number> }; usage?: Record<string, number> };
            const u = data.message?.usage ?? data.usage;
            if (!u) continue;
            if (u.input_tokens) input = u.input_tokens;
            if (u.cache_read_input_tokens) cacheRead = u.cache_read_input_tokens;
            if (u.output_tokens) output = u.output_tokens;
            if (typeof u.cost === 'number') cost = u.cost;
          } catch {
            // not JSON: ignore
          }
        }
      },
      flush: () => this.account(lease, input, output, cacheRead, cost),
    });
    return new Response(res.body.pipeThrough(tap), { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }

  private async translated(lease: Lease, body: AnthropicRequest, baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<Response> {
    const { provider } = lease;
    const model = upstreamModel(lease.model);
    const requested = body.output_config?.effort;
    const effort = lease.effort ?? ((EFFORTS as readonly string[]).includes(requested ?? '') ? (requested as Effort) : effortFromBudget(body.thinking?.budget_tokens));
    const memoKey = `${provider.id}:${model}:${effort}`;
    const remembered = this.effortMemo.get(memoKey);
    const candidates: (string | undefined)[] = remembered !== undefined ? [remembered ?? undefined] : effort ? [...reasoningEffortCandidates(effort), undefined] : [undefined];

    let res: Response | undefined;
    for (const [i, reasoningEffort] of candidates.entries()) {
      const request = toOpenAIRequest(body, { dialect: provider.id === 'gemini' ? 'gemini' : 'openai', model, reasoningEffort, maxOutput: provider.maxOutput, signatures: this.signatures });
      res = await this.doFetch(apiUrl(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
        body: JSON.stringify(request),
        signal,
      });
      if (res.ok) {
        this.effortMemo.set(memoKey, reasoningEffort ?? null);
        break;
      }
      const text = await res.text().catch(() => '');
      // A refused effort level (or a model without reasoning) falls back to the next one.
      if (res.status === 400 && /reasoning|effort|thinking/i.test(text) && i < candidates.length - 1) {
        log.info({ provider: provider.id, model, tried: reasoningEffort }, 'llm proxy: effort level refused, trying the next');
        continue;
      }
      return json(res.status, anthropicError(res.status, `${provider.name}: ${upstreamMessage(text)}`));
    }
    if (!res) return json(502, anthropicError(502, 'no request was made'));

    if (!body.stream || !res.body) {
      const message = toAnthropicResponse((await res.json()) as OpenAIResponse, lease.model, this.signatures);
      this.account(lease, message.usage.input_tokens, message.usage.output_tokens, message.usage.cache_read_input_tokens ?? 0);
      return json(200, message);
    }

    const upstream = res.body;
    const translator = new StreamTranslator(lease.model, this.signatures);
    const encoder = new TextEncoder();
    let ping: NodeJS.Timeout | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const put = (text: string) => text && controller.enqueue(encoder.encode(text));
        put(translator.start());
        // Reasoning models can think for minutes before their first token; keep the connection warm.
        ping = setInterval(() => put(sse('ping', { type: 'ping' })), PING_MS);
        const parser = new SseParser();
        const decoder = new TextDecoder();
        reader = upstream.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
              if (ev.data === '[DONE]') continue;
              let chunk: OpenAIChunk & { error?: { message?: string } };
              try {
                chunk = JSON.parse(ev.data);
              } catch {
                continue;
              }
              if (chunk.error) throw new Error(chunk.error.message ?? 'stream error');
              put(translator.push(chunk));
            }
          }
          put(translator.end());
        } catch (err) {
          if (!signal?.aborted) put(sse('error', anthropicError(502, `${provider.name}: ${(err as Error).message}`)));
        } finally {
          clearInterval(ping);
          this.account(lease, translator.usage.input_tokens, translator.usage.output_tokens, translator.usage.cache_read_input_tokens ?? 0, translator.cost);
          try {
            controller.close();
          } catch {
            // already closed by a cancel
          }
        }
      },
      cancel: async () => {
        clearInterval(ping);
        await reader?.cancel().catch(() => {});
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }

  async countTokens(lease: Lease, body: AnthropicRequest, headers: Record<string, string | string[] | undefined> = {}): Promise<Response> {
    const creds = await this.providers.credentials(lease.provider.id);
    if (creds && lease.provider.protocol === 'anthropic') {
      try {
        const res = await this.doFetch(apiUrl(creds.baseUrl, '/v1/messages/count_tokens'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': String(headers['anthropic-version'] ?? '2023-06-01'), ...authHeaders(lease.provider, creds.apiKey) },
          body: JSON.stringify({ ...body, model: lease.provider.forceModel ? upstreamModel(lease.model) : body.model }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) return json(200, await res.json());
      } catch {
        // fall back to the estimate
      }
    }
    return json(200, { input_tokens: estimateTokens(body) });
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
