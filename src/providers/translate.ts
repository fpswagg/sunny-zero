import { randomBytes } from 'node:crypto';

/**
 * Anthropic Messages API ⇄ OpenAI Chat Completions, for models that only speak the latter
 * (GPT, Gemini). Claude Code sends Anthropic requests; the proxy turns them into Chat
 * Completions and turns the answers, streamed or not, back into Anthropic messages and events.
 */

// ── Anthropic shapes (the parts Claude Code uses) ────────────────────────────────

type AnthropicSource = { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | { type: 'text'; media_type?: string; data: string };

export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicSource }
  | { type: 'document'; source: AnthropicSource; title?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  /** Server tools (web_search_20250305...) carry a type; custom tools have none or "custom". */
  type?: string;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | { type: 'text'; text: string }[];
  max_tokens?: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  thinking?: { type: string; budget_tokens?: number };
  output_config?: { effort?: string };
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

// ── OpenAI shapes ───────────────────────────────────────────────────────────────

type OpenAIPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  extra_content?: { google?: { thought_signature?: string } };
}

export type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  reasoning_effort?: string;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

export interface OpenAIResponse {
  id?: string;
  model?: string;
  choices: { message: { content?: string | null; tool_calls?: OpenAIToolCall[]; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: OpenAIUsage;
}

export interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: OpenAIToolCall['extra_content'] }[];
      refusal?: string | null;
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage | null;
}

/** Gemini 3 needs the signature it put on a tool call sent back with that call; Claude Code drops unknown fields. */
export interface SignatureStore {
  get(toolCallId: string): string | undefined;
  set(toolCallId: string, signature: string): void;
}

export interface TranslateOptions {
  /** gemini: keeps thought signatures and simplifies tool schemas; openai: max_completion_tokens. */
  dialect: 'openai' | 'gemini';
  model: string;
  reasoningEffort?: string;
  maxOutput?: number;
  signatures?: SignatureStore;
}

/** Gemini's documented placeholder when a tool call's signature is lost. */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

const blocksOf = (content: string | AnthropicBlock[] | undefined): AnthropicBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);

const textOf = (blocks: AnthropicBlock[]) =>
  blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n');

function mediaPart(block: AnthropicBlock): OpenAIPart | undefined {
  if (block.type !== 'image' && block.type !== 'document') return undefined;
  const source = (block as { source: AnthropicSource }).source;
  if (source.type === 'text') return { type: 'text', text: source.data };
  if (block.type === 'image') return { type: 'image_url', image_url: { url: source.type === 'url' ? source.url : `data:${source.media_type};base64,${source.data}` } };
  if (source.type === 'url') return { type: 'text', text: `[Document: ${source.url}]` };
  const title = (block as { title?: string }).title ?? 'document.pdf';
  return { type: 'file', file: { filename: title, file_data: `data:${source.media_type};base64,${source.data}` } };
}

/** User content as OpenAI parts; plain text collapses to a string. */
function userContent(blocks: AnthropicBlock[]): string | OpenAIPart[] {
  const parts: OpenAIPart[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: (b as { text: string }).text });
    else {
      const media = mediaPart(b);
      if (media) parts.push(media);
    }
  }
  return parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts;
}

function systemText(system: AnthropicRequest['system']): string {
  if (!system) return '';
  return typeof system === 'string' ? system : system.map((s) => s.text).join('\n\n');
}

// JSON Schema keys Gemini's function declarations understand; the rest is dropped.
const GEMINI_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'anyOf', 'title', 'default']);

/** Simplifies a JSON Schema to what Gemini accepts: no $schema/additionalProperties/const, no type arrays. */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Record<string, unknown>) };
  if ('const' in s && !('enum' in s)) s.enum = [s.const];
  if (Array.isArray(s.type)) {
    const types = (s.type as string[]).filter((t) => t !== 'null');
    if (types.length < (s.type as string[]).length) s.nullable = true;
    s.type = types.length === 1 ? types[0] : undefined;
    if (types.length > 1) s.anyOf = types.map((t) => ({ type: t }));
  }
  if (s.format !== undefined && s.format !== 'enum' && s.format !== 'date-time') delete s.format;
  if (Array.isArray(s.enum)) s.enum = s.enum.map(String);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    if (!GEMINI_SCHEMA_KEYS.has(key) || value === undefined) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, geminiSchema(v)]));
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = geminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

function stripSchemaMeta(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const { $schema: _, ...rest } = schema ?? { type: 'object', properties: {} };
  return rest;
}

/** An Anthropic request as a Chat Completions request. */
export function toOpenAIRequest(req: AnthropicRequest, opts: TranslateOptions): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  const system = systemText(req.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const msg of req.messages) {
    const blocks = blocksOf(msg.content);
    if (msg.role === 'assistant') {
      const text = textOf(blocks);
      const calls = blocks.filter((b) => b.type === 'tool_use') as { id: string; name: string; input: unknown }[];
      const tool_calls = calls.map((c, i): OpenAIToolCall => {
        const call: OpenAIToolCall = { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } };
        if (opts.dialect === 'gemini') {
          const signature = opts.signatures?.get(c.id) ?? (i === 0 ? SKIP_SIGNATURE : undefined);
          if (signature) call.extra_content = { google: { thought_signature: signature } };
        }
        return call;
      });
      if (!text && !tool_calls.length) continue;
      messages.push({ role: 'assistant', content: text || null, ...(tool_calls.length ? { tool_calls } : {}) });
      continue;
    }
    // Tool results become tool messages, which must come right after the assistant's calls;
    // the rest of the user's content (and images a tool returned) follows as a user message.
    const extra: AnthropicBlock[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool_result') {
        extra.push(b);
        continue;
      }
      const r = b as { tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean };
      const inner = blocksOf(r.content);
      const text = textOf(inner);
      const media = inner.filter((x) => x.type === 'image' || x.type === 'document');
      messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: `${r.is_error ? 'Error: ' : ''}${text || (media.length ? '(see the attached file)' : '(no output)')}` });
      if (media.length) extra.unshift({ type: 'text', text: `Files returned by tool call ${r.tool_use_id}:` }, ...media);
    }
    if (extra.length) {
      const content = userContent(extra);
      if (typeof content !== 'string' || content.trim()) messages.push({ role: 'user', content });
    }
  }

  const out: OpenAIRequest = { model: opts.model, messages };
  const tools = (req.tools ?? []).filter((t) => !t.type || t.type === 'custom');
  if (tools.length) {
    out.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: opts.dialect === 'gemini' ? (geminiSchema(stripSchemaMeta(t.input_schema)) as Record<string, unknown>) : stripSchemaMeta(t.input_schema),
      },
    }));
    const choice = req.tool_choice;
    if (choice?.type === 'any') out.tool_choice = 'required';
    else if (choice?.type === 'none') out.tool_choice = 'none';
    else if (choice?.type === 'tool') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (req.max_tokens) {
    const max = opts.maxOutput ? Math.min(req.max_tokens, opts.maxOutput) : req.max_tokens;
    if (opts.dialect === 'openai') out.max_completion_tokens = max;
    else out.max_tokens = max;
  }
  if (req.stop_sequences?.length) out.stop = req.stop_sequences.slice(0, 4);
  if (opts.reasoningEffort) out.reasoning_effort = opts.reasoningEffort;
  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

export function stopReason(finish: string | null | undefined): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal' {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function toAnthropicUsage(usage: OpenAIUsage | null | undefined): AnthropicUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

export const newMessageId = () => `msg_${randomBytes(12).toString('hex')}`;
const newToolId = () => `toolu_${randomBytes(12).toString('hex')}`;

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _unparsed_arguments: raw };
  }
}

/** A Chat Completions answer as an Anthropic message. */
export function toAnthropicResponse(res: OpenAIResponse, model: string, signatures?: SignatureStore) {
  const choice = res.choices[0];
  const content: AnthropicBlock[] = [];
  const text = choice?.message.content ?? choice?.message.refusal;
  if (text) content.push({ type: 'text', text });
  let sawTool = false;
  for (const call of choice?.message.tool_calls ?? []) {
    const id = call.id || newToolId();
    const signature = call.extra_content?.google?.thought_signature;
    if (signature) signatures?.set(id, signature);
    content.push({ type: 'tool_use', id, name: call.function.name, input: parseArguments(call.function.arguments) });
    sawTool = true;
  }
  const reason = stopReason(choice?.finish_reason);
  return {
    id: newMessageId(),
    type: 'message' as const,
    role: 'assistant' as const,
    model,
    content,
    // Some providers end a tool call with "stop"; Claude Code needs tool_use to run it.
    stop_reason: sawTool && reason === 'end_turn' ? 'tool_use' : reason,
    stop_sequence: null,
    usage: toAnthropicUsage(res.usage),
  };
}

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Turns streamed Chat Completions chunks into Anthropic stream events. Feed it each chunk,
 * then call finish(); both return the SSE text to send.
 */
export class StreamTranslator {
  readonly id = newMessageId();
  private started = false;
  private index = -1;
  private open: 'text' | 'tool' | undefined;
  /** OpenAI tool call index → Anthropic block index. */
  private tools = new Map<number, number>();
  private finish: string | null | undefined;
  private sawTool = false;
  usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  /** Cost the provider reported (OpenRouter), in USD. */
  cost?: number;

  constructor(
    private readonly model: string,
    private readonly signatures?: SignatureStore,
  ) {}

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

  push(chunk: OpenAIChunk): string {
    let out = this.start();
    if (chunk.usage) {
      this.usage = toAnthropicUsage(chunk.usage);
      if (typeof chunk.usage.cost === 'number') this.cost = chunk.usage.cost;
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      const text = delta.content ?? delta.refusal;
      if (text) {
        if (this.open !== 'text') {
          out += this.close();
          this.index++;
          this.open = 'text';
          out += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } });
        }
        out += sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text } });
      }
      for (const call of delta.tool_calls ?? []) {
        let block = this.tools.get(call.index);
        if (block === undefined) {
          out += this.close();
          this.index++;
          block = this.index;
          this.tools.set(call.index, block);
          this.open = 'tool';
          this.sawTool = true;
          const id = call.id || newToolId();
          const signature = call.extra_content?.google?.thought_signature;
          if (signature) this.signatures?.set(id, signature);
          out += sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'tool_use', id, name: call.function?.name ?? '', input: {} } });
        } else if (block !== this.index) {
          // Interleaved arguments for an earlier call: Anthropic streams one block at a time, so they are dropped.
          continue;
        }
        if (call.function?.arguments) out += sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'input_json_delta', partial_json: call.function.arguments } });
      }
      if (choice.finish_reason) this.finish = choice.finish_reason;
    }
    return out;
  }

  /** Closes the message. */
  end(): string {
    let out = this.start() + this.close();
    const reason = stopReason(this.finish);
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.sawTool && reason === 'end_turn' ? 'tool_use' : reason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens, input_tokens: this.usage.input_tokens, ...(this.usage.cache_read_input_tokens ? { cache_read_input_tokens: this.usage.cache_read_input_tokens } : {}) },
    });
    return out + sse('message_stop', { type: 'message_stop' });
  }
}

/** Splits an SSE byte stream into `data:` payloads (one per event). Keeps partial lines between calls. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';

  /** Returns completed events as { event, data }. */
  feed(text: string): { event: string; data: string }[] {
    this.buffer += text;
    const out: { event: string; data: string }[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') });
        this.data = [];
        this.event = '';
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('event:')) {
        this.event = line.slice(6).trim();
      }
    }
    return out;
  }
}

/** Rough token count (about 4 characters a token) for count_tokens on providers without one. */
export function estimateTokens(req: Pick<AnthropicRequest, 'messages' | 'system' | 'tools'>): number {
  let chars = systemText(req.system).length + JSON.stringify(req.tools ?? []).length;
  for (const m of req.messages ?? []) {
    for (const b of blocksOf(m.content)) {
      if (b.type === 'image') chars += 6_000; // ~1500 tokens an image
      else if (b.type === 'document') chars += JSON.stringify(b).length / 3;
      else chars += JSON.stringify(b).length;
    }
  }
  return Math.ceil(chars / 4);
}

/** Anthropic's error type for an HTTP status, so Claude Code retries what it should. */
export function errorType(status: number): string {
  if (status === 400 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529 || status === 503) return 'overloaded_error';
  return 'api_error';
}

export const anthropicError = (status: number, message: string) => ({ type: 'error', error: { type: errorType(status), message } });

/** The message inside an upstream error body (OpenAI, Gemini and Anthropic shapes), or the raw text. */
export function upstreamMessage(body: string): string {
  try {
    const json = JSON.parse(body) as unknown;
    const first = Array.isArray(json) ? json[0] : json;
    const err = (first as { error?: { message?: string } | string })?.error;
    if (typeof err === 'string') return err;
    if (err?.message) return err.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 500) || 'no details';
}
