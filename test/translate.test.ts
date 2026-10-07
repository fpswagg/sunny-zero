import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  geminiSchema,
  SKIP_SIGNATURE,
  SseParser,
  StreamTranslator,
  toAnthropicResponse,
  toOpenAIRequest,
  upstreamMessage,
  type AnthropicRequest,
  type SignatureStore,
} from '../src/providers/translate.ts';
import { formatModelRef, parseModelRef, reasoningEffortCandidates } from '../src/providers/catalog.ts';

const store = (): SignatureStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: (id) => map.get(id), set: (id, s) => void map.set(id, s) };
};

/** Parses SSE text into [event, data] pairs. */
const events = (text: string) => new SseParser().feed(text).map((e) => [e.event, JSON.parse(e.data)] as const);

describe('model refs', () => {
  it('reads provider prefixes only when they name a provider', () => {
    expect(parseModelRef('opus')).toEqual({ provider: 'claude', model: 'opus' });
    expect(parseModelRef('openai:gpt-5.5')).toEqual({ provider: 'openai', model: 'gpt-5.5' });
    expect(parseModelRef('openrouter:deepseek/deepseek-r1:free')).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-r1:free' });
    expect(parseModelRef('weird:thing')).toEqual({ provider: 'claude', model: 'weird:thing' });
    expect(formatModelRef(undefined, 'sonnet')).toBe('sonnet');
    expect(formatModelRef('gemini', 'gemini-3.8-flash')).toBe('gemini:gemini-3.8-flash');
  });

  it('falls back to lower effort levels the provider may know', () => {
    expect(reasoningEffortCandidates('max')).toEqual(['max', 'xhigh', 'high']);
    expect(reasoningEffortCandidates('medium')[0]).toBe('medium');
  });
});

describe('Anthropic → Chat Completions', () => {
  const req: AnthropicRequest = {
    model: 'claude-sonnet',
    max_tokens: 32000,
    stream: true,
    system: [{ type: 'text', text: 'You are builder.' }, { type: 'text', text: 'Be brief.' }],
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } },
      { name: 'web_search', type: 'web_search_20250305' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is in a.txt?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] }, { type: 'text', text: 'Thanks' }] },
    ],
  };

  it('maps system, images, tool calls and tool results', () => {
    const out = toOpenAIRequest(req, { dialect: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' });
    expect(out.model).toBe('gpt-5.5');
    expect(out.max_completion_tokens).toBe(32000);
    expect(out.reasoning_effort).toBe('high');
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.messages).toEqual([
      { role: 'system', content: 'You are builder.\n\nBe brief.' },
      { role: 'user', content: [{ type: 'text', text: 'What is in a.txt?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' },
      { role: 'user', content: 'Thanks' },
    ]);
    // Server tools (Claude's web search) cannot run elsewhere; $schema is dropped.
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.function.parameters).not.toHaveProperty('$schema');
  });

  it('keeps Gemini thought signatures and simplifies schemas for it', () => {
    const sigs = store();
    sigs.set('toolu_1', 'SIG');
    const out = toOpenAIRequest(req, { dialect: 'gemini', model: 'gemini-3.8-flash', maxOutput: 65536, signatures: sigs });
    expect(out.max_tokens).toBe(32000);
    const assistant = out.messages.find((m) => m.role === 'assistant') as { tool_calls: { extra_content?: unknown }[] };
    expect(assistant.tool_calls[0]!.extra_content).toEqual({ google: { thought_signature: 'SIG' } });
    expect(out.tools![0]!.function.parameters).toEqual({ type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] });
    // A lost signature gets Google's placeholder.
    const lost = toOpenAIRequest(req, { dialect: 'gemini', model: 'g', signatures: store() });
    expect((lost.messages.find((m) => m.role === 'assistant') as { tool_calls: { extra_content?: { google: { thought_signature: string } } }[] }).tool_calls[0]!.extra_content!.google.thought_signature).toBe(SKIP_SIGNATURE);
  });

  it('turns type arrays and const into what Gemini accepts', () => {
    expect(geminiSchema({ type: ['string', 'null'], const: 'a', format: 'uri', propertyNames: {} })).toEqual({ type: 'string', nullable: true, enum: ['a'] });
    expect(geminiSchema({ type: 'object' })).toEqual({ type: 'object', properties: {} });
  });

  it('moves images a tool returned into a user message after the tool results', () => {
    const out = toOpenAIRequest(
      { model: 'x', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BB' } }] }] }] },
      { dialect: 'openai', model: 'gpt' },
    );
    expect(out.messages[0]).toEqual({ role: 'tool', tool_call_id: 't1', content: '(see the attached file)' });
    expect(out.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] });
  });
});

describe('Chat Completions → Anthropic', () => {
  it('converts a full answer with a tool call', () => {
    const sigs = store();
    const msg = toAnthropicResponse(
      {
        choices: [{ message: { content: 'Let me look.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a"}' }, extra_content: { google: { thought_signature: 'S1' } } }] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
      },
      'gemini-x',
      sigs,
    );
    expect(msg.content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a' } },
    ]);
    // "stop" with a tool call still means Claude Code must run it.
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.usage).toEqual({ input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 });
    expect(sigs.map.get('call_1')).toBe('S1');
  });

  it('streams text and tool calls as Anthropic events', () => {
    const t = new StreamTranslator('gpt-5.5');
    let out = t.start();
    out += t.push({ choices: [{ delta: { content: 'Hel' } }] });
    out += t.push({ choices: [{ delta: { content: 'lo' } }] });
    out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'Bash', arguments: '{"comm' } }] } }] });
    out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, finish_reason: 'tool_calls' }] });
    out += t.push({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } });
    out += t.end();
    const ev = events(out);
    expect(ev.map(([e]) => e)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(ev[5]![1]).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'call_9', name: 'Bash' } });
    const json = ev.filter(([, d]) => d.delta?.type === 'input_json_delta').map(([, d]) => d.delta.partial_json).join('');
    expect(JSON.parse(json)).toEqual({ command: 'ls' });
    expect(ev[9]![1]).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7, input_tokens: 50 } });
  });

  it('still closes a message that never produced output', () => {
    const t = new StreamTranslator('m');
    expect(events(t.end()).map(([e]) => e)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });
});

describe('helpers', () => {
  it('parses SSE across chunk boundaries', () => {
    const p = new SseParser();
    expect(p.feed('event: a\ndata: {"x"')).toEqual([]);
    expect(p.feed(':1}\n\ndata: [DONE]\n\n')).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: '', data: '[DONE]' },
    ]);
  });

  it('reads error messages from any provider', () => {
    expect(upstreamMessage('{"error":{"message":"bad key"}}')).toBe('bad key');
    expect(upstreamMessage('[{"error":{"code":400,"message":"no"}}]')).toBe('no');
    expect(upstreamMessage('plain')).toBe('plain');
  });

  it('estimates tokens', () => {
    expect(estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })).toBeGreaterThan(90);
  });
});
