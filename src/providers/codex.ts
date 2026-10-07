import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  newMessageId,
  sse,
  type AnthropicBlock,
  type AnthropicRequest,
  type AnthropicUsage,
} from './translate.ts';

/**
 * ChatGPT / Codex as a model provider. The Codex CLI signs in with a ChatGPT account (device code)
 * and keeps its tokens in ~/.codex/auth.json; Sunny reads them (refreshing when they run out) and
 * talks to the same backend the CLI uses, in the Responses API dialect. The account's own Codex
 * allowance pays for it, not an API key.
 */

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
/** The public client id of the Codex CLI (it is in every access token it issues). */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export interface CodexAuth {
  accessToken: string;
  accountId: string;
  plan?: string;
  expiresAt: number;
}

const authPath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');

function jwtClaims(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

interface AuthFile {
  auth_mode?: string;
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string };
  last_refresh?: string;
  [key: string]: unknown;
}

async function readAuthFile(): Promise<AuthFile | undefined> {
  try {
    const file = JSON.parse(await readFile(authPath(), 'utf8')) as AuthFile;
    return file.tokens?.access_token && file.tokens.refresh_token ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the Codex CLI is signed in with a ChatGPT account on this machine. */
export async function codexConnected(): Promise<boolean> {
  return !!(await readAuthFile());
}

let refreshing: Promise<AuthFile> | undefined;

async function refresh(file: AuthFile, doFetch: typeof fetch): Promise<AuthFile> {
  const res = await doFetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: file.tokens!.refresh_token, scope: 'openid profile email' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ChatGPT sign-in expired (${res.status}). Run "codex login --device-auth" again.`);
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!data.access_token) throw new Error('ChatGPT sign-in could not be refreshed.');
  const next: AuthFile = {
    ...file,
    tokens: { ...file.tokens, access_token: data.access_token, refresh_token: data.refresh_token ?? file.tokens!.refresh_token, id_token: data.id_token ?? file.tokens!.id_token },
    last_refresh: new Date().toISOString(),
  };
  const tmp = `${authPath()}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, authPath());
  return next;
}

/** The current ChatGPT access token, refreshed when it expires within five minutes. */
export async function codexAuth(doFetch: typeof fetch = fetch): Promise<CodexAuth | undefined> {
  let file = await readAuthFile();
  if (!file) return undefined;
  let claims = jwtClaims(file.tokens!.access_token!);
  if ((claims.exp ?? 0) * 1000 < Date.now() + 5 * 60_000) {
    refreshing ??= refresh(file, doFetch).finally(() => (refreshing = undefined));
    file = await refreshing;
    claims = jwtClaims(file.tokens!.access_token!);
  }
  const auth = claims['https://api.openai.com/auth'] ?? {};
  const accountId = file.tokens!.account_id || auth.chatgpt_account_id;
  if (!accountId) throw new Error('ChatGPT account id missing: sign in again with "codex login --device-auth".');
  return { accessToken: file.tokens!.access_token!, accountId, plan: auth.chatgpt_plan_type, expiresAt: (claims.exp ?? 0) * 1000 };
}

/** Models the account may use, from the CLI's own cache; a short list when it is not there. */
export async function codexModels(): Promise<{ id: string; name?: string; context?: number; efforts?: string[] }[]> {
  try {
    const cache = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8')) as {
      models?: { slug: string; display_name?: string; visibility?: string; context_window?: number; supported_reasoning_levels?: { effort: string }[] }[];
    };
    const list = (cache.models ?? []).filter((m) => m.visibility === 'list').map((m) => ({ id: m.slug, name: m.display_name, context: m.context_window, efforts: m.supported_reasoning_levels?.map((l) => l.effort) }));
    if (list.length) return list;
  } catch {
    // no cache yet
  }
  return CODEX_SUGGESTED.map((id) => ({ id }));
}

export const CODEX_SUGGESTED = ['gpt-5.6-terra', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5'];

// ── Request: Anthropic Messages → Responses ─────────────────────────────────────

type Part = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string } | { type: 'output_text'; text: string };
type Item =
  | { type: 'message'; role: 'user' | 'assistant'; content: Part[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: Item[];
  tools?: { type: 'function'; name: string; description: string; parameters: unknown; strict: boolean }[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string };
  parallel_tool_calls: boolean;
  reasoning?: { effort: string; summary: 'auto' };
  store: false;
  stream: true;
  include: string[];
}

const blocksOf = (c: string | AnthropicBlock[] | undefined): AnthropicBlock[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : (c ?? []));

function resultText(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((b) => (b.type === 'text' ? String((b as { text: string }).text) : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function mediaPart(b: AnthropicBlock): Part | undefined {
  const source = (b as { source?: { type: string; media_type?: string; data?: string; url?: string } }).source;
  if (!source) return undefined;
  if (b.type === 'image') return { type: 'input_image', image_url: source.type === 'url' ? source.url! : `data:${source.media_type};base64,${source.data}` };
  if (b.type === 'document') return { type: 'input_text', text: source.type === 'text' ? source.data! : `[Document: ${(b as { title?: string }).title ?? 'attached file'} (not readable by this model)]` };
  return undefined;
}

export function codexEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === 'max' ? 'xhigh' : effort;
}

export function toResponsesRequest(req: AnthropicRequest, model: string, effort?: string): ResponsesRequest {
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((s) => s.text).join('\n\n');
  const input: Item[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      let parts: Part[] = [];
      const flush = () => {
        if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
        parts = [];
      };
      for (const b of blocksOf(m.content)) {
        if (b.type === 'text' && (b as { text: string }).text) parts.push({ type: 'output_text', text: (b as { text: string }).text });
        else if (b.type === 'tool_use') {
          flush();
          const t = b as { id: string; name: string; input: unknown };
          input.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: JSON.stringify(t.input ?? {}) });
        }
      }
      flush();
    } else {
      let parts: Part[] = [];
      const flush = () => {
        if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
        parts = [];
      };
      for (const b of blocksOf(m.content)) {
        if (b.type === 'tool_result') {
          flush();
          const r = b as { tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean };
          input.push({ type: 'function_call_output', call_id: r.tool_use_id, output: (r.is_error ? 'Error: ' : '') + resultText(r.content) });
        } else if (b.type === 'text') {
          if ((b as { text: string }).text) parts.push({ type: 'input_text', text: (b as { text: string }).text });
        } else {
          const media = mediaPart(b);
          if (media) parts.push(media);
        }
      }
      flush();
    }
  }
  const tools = (req.tools ?? [])
    .filter((t) => !t.type || t.type === 'custom')
    .map((t) => ({ type: 'function' as const, name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} }, strict: false }));
  const choice = req.tool_choice;
  return {
    model,
    instructions: system || 'You are a helpful assistant.',
    input,
    ...(tools.length ? { tools } : {}),
    ...(tools.length && choice ? { tool_choice: choice.type === 'any' ? ('required' as const) : choice.type === 'none' ? ('none' as const) : choice.type === 'tool' ? { type: 'function' as const, name: (choice as { name: string }).name } : ('auto' as const) } : {}),
    parallel_tool_calls: true,
    ...(effort ? { reasoning: { effort, summary: 'auto' as const } } : {}),
    store: false,
    stream: true,
    include: [],
  };
}

// ── Response: Responses events → Anthropic ──────────────────────────────────────

interface ResponseEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  response?: { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; error?: { message?: string }; incomplete_details?: { reason?: string } | null; status?: string };
  error?: { message?: string };
  message?: string;
}

/**
 * Feeds on Responses stream events and yields Anthropic stream events. Text and tool calls become
 * content blocks; reasoning summaries are dropped (Claude Code does not need them).
 */
export class ResponsesTranslator {
  readonly id = newMessageId();
  private started = false;
  private index = -1;
  private open: 'text' | 'tool' | undefined;
  /** Responses output index → Anthropic block index, for function calls. */
  private tools = new Map<number, number>();
  private sawTool = false;
  private stop: 'end_turn' | 'max_tokens' = 'end_turn';
  usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

  constructor(private readonly model: string) {}

  start(): string {
    if (this.started) return '';
    this.started = true;
    return sse('message_start', {
      type: 'message_start',
      message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  private close(): string {
    if (!this.open) return '';
    this.open = undefined;
    return sse('content_block_stop', { type: 'content_block_stop', index: this.index });
  }

  push(ev: ResponseEvent): string {
    let out = this.start();
    switch (ev.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (!ev.delta) break;
        if (this.open !== 'text') {
          out += this.close();
          this.index++;
          this.open = 'text';
          out += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } });
        }
        out += sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: ev.delta } });
        break;
      }
      case 'response.output_item.added': {
        if (ev.item?.type !== 'function_call') break;
        out += this.close();
        this.index++;
        this.open = 'tool';
        this.sawTool = true;
        this.tools.set(ev.output_index ?? this.index, this.index);
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: this.index,
          content_block: { type: 'tool_use', id: ev.item.call_id || `toolu_${randomBytes(12).toString('hex')}`, name: ev.item.name ?? '', input: {} },
        });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const block = this.tools.get(ev.output_index ?? -1);
        // Anthropic streams one block at a time; calls are sequential in practice.
        if (block === this.index && ev.delta) out += sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'input_json_delta', partial_json: ev.delta } });
        break;
      }
      case 'response.output_item.done': {
        if (ev.item?.type === 'function_call') out += this.close();
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const u = ev.response?.usage;
        if (u) this.usage = { input_tokens: Math.max(0, (u.input_tokens ?? 0) - (u.input_tokens_details?.cached_tokens ?? 0)), output_tokens: u.output_tokens ?? 0, ...(u.input_tokens_details?.cached_tokens ? { cache_read_input_tokens: u.input_tokens_details.cached_tokens } : {}) };
        if (ev.response?.incomplete_details?.reason === 'max_output_tokens') this.stop = 'max_tokens';
        break;
      }
      case 'response.failed':
        throw new Error(ev.response?.error?.message ?? 'the model failed');
      case 'error':
        throw new Error(ev.error?.message ?? ev.message ?? 'stream error');
    }
    return out;
  }

  end(): string {
    const out = this.start() + this.close();
    return (
      out +
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: this.sawTool && this.stop === 'end_turn' ? 'tool_use' : this.stop, stop_sequence: null },
        usage: { output_tokens: this.usage.output_tokens, input_tokens: this.usage.input_tokens, ...(this.usage.cache_read_input_tokens ? { cache_read_input_tokens: this.usage.cache_read_input_tokens } : {}) },
      }) +
      sse('message_stop', { type: 'message_stop' })
    );
  }
}

/** Folds a finished Anthropic SSE text into one non-streaming message. */
export function messageFromSse(text: string, model: string, id: string): { id: string; type: 'message'; role: 'assistant'; model: string; content: unknown[]; stop_reason: string; stop_sequence: null; usage: AnthropicUsage } {
  const content: any[] = [];
  const json = new Map<number, string>();
  let stop = 'end_turn';
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  for (const block of text.split('\n\n')) {
    const data = block.split('\n').find((l) => l.startsWith('data: '));
    if (!data) continue;
    const ev = JSON.parse(data.slice(6));
    if (ev.type === 'content_block_start') content[ev.index] = { ...ev.content_block };
    else if (ev.type === 'content_block_delta') {
      if (ev.delta.type === 'text_delta') content[ev.index].text += ev.delta.text;
      else if (ev.delta.type === 'input_json_delta') json.set(ev.index, (json.get(ev.index) ?? '') + ev.delta.partial_json);
    } else if (ev.type === 'message_delta') {
      stop = ev.delta.stop_reason;
      usage = ev.usage;
    }
  }
  for (const [i, raw] of json) {
    try {
      content[i].input = raw ? JSON.parse(raw) : {};
    } catch {
      content[i].input = {};
    }
  }
  return { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage };
}

// ── Signing in ──────────────────────────────────────────────────────────────────

const codexBin = () => [join(homedir(), '.local/bin/codex'), join(homedir(), '.local/share/pnpm/bin/codex')].find((p) => existsSync(p)) ?? 'codex';

export interface CodexLogin {
  url: string;
  code: string;
  /** Resolves true when the owner finished signing in (the CLI exits, within about 15 minutes). */
  done: Promise<boolean>;
}

/** Starts the Codex CLI's device-code sign-in and returns the page and code the owner must use. */
export function startCodexLogin(): Promise<CodexLogin> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin(), ['login', '--device-auth'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let settled = false;
    const done = new Promise<boolean>((fin) => child.on('close', (code) => fin(code === 0)));
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
        reject(new Error('The Codex CLI did not give a sign-in code.'));
      }
    }, 20_000);
    const read = (chunk: Buffer) => {
      out += chunk.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
      const url = /https:\/\/\S*auth\.openai\.com\S*/.exec(out)?.[0];
      const code = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/.exec(out)?.[0];
      if (url && code && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url, code, done });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Codex CLI is not installed (${err.message}).`));
    });
    child.unref();
  });
}
