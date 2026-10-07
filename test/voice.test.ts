import { describe, expect, it } from 'vitest';
import { cleanTranscript, FallbackTranscriber, type TranscriberBackend } from '../src/media/transcribe.ts';
import { accentOf, inkOn, DEFAULT_ACCENT } from '../src/agents/theme.ts';

describe('cleanTranscript', () => {
  it('drops sound tags and keeps speech', () => {
    expect(cleanTranscript('[background noise]')).toBe('');
    expect(cleanTranscript('(birds chirping)')).toBe('');
    expect(cleanTranscript('Salut (rires) Operator, ça va ?')).toBe('Salut Operator, ça va ?');
  });
  it('drops the lines Whisper invents on silence', () => {
    expect(cleanTranscript('Sous-titres réalisés par la communauté d\'Amara.org')).toBe('');
    expect(cleanTranscript('Merci.')).toBe('');
    expect(cleanTranscript('Merci, tu peux relancer Rex ?')).toBe('Merci, tu peux relancer Rex ?');
    expect(cleanTranscript('  ...  ')).toBe('');
  });
});

describe('FallbackTranscriber', () => {
  const ok = (engine: string): TranscriberBackend => ({ transcribe: async (_f, hints) => ({ text: (hints?.keyterms ?? []).join(','), language: 'fr', seconds: 1, truncated: false, engine }) });
  it('falls back, skips a failed engine for a while, and adds keyterms', async () => {
    let calls = 0;
    const bad: TranscriberBackend = { transcribe: async () => (calls++, Promise.reject(new Error('no credits'))) };
    const t = new FallbackTranscriber([bad, ok('b')], () => ['Operator']);
    expect(await t.transcribe('x', { keyterms: ['Watcher'] })).toMatchObject({ engine: 'b', text: 'Watcher,Operator' });
    await t.transcribe('x');
    expect(calls).toBe(1);
  });
});

describe('agent colours', () => {
  it('reads the main colour of an icon', async () => {
    const red = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#d0202a"/></svg>';
    const c = await accentOf(red);
    const n = parseInt(c.slice(1), 16);
    expect((n >> 16) & 255).toBeGreaterThan(180);
    expect(n & 255).toBeLessThan(110);
  });
  it('falls back for grey icons', async () => {
    expect(await accentOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#777"/></svg>')).toBe(DEFAULT_ACCENT);
  });
  it('gives differently coloured icons distinct accents', async () => {
    const icon = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;
    const colours = await Promise.all(['#e13c46', '#2f80ed', '#27ae60', '#f2994a'].map((c) => accentOf(icon(c))));
    expect(new Set(colours).size).toBe(4);
  });
  it('picks readable text on the accent', () => {
    expect(inkOn('#f6b255')).toBe('#15151a');
    expect(inkOn('#4b66d2')).toBe('#ffffff');
  });
});

describe('TtsService resilience', () => {
  const secrets = { has: async () => true, get: async () => ({ apiKey: 'k' }) } as never;
  const providers = { connected: async () => false } as never;
  const agent = (name: string, voice?: string) => ({ name, description: 'x', voice: voice ? { provider: 'elevenlabs' as const, voice, reply: 'auto' as const } : undefined });
  const mp3 = () => new Response(Buffer.from('ID3fake'), { status: 200 });

  it('classifies failures', async () => {
    const { classifyTts } = await import('../src/media/tts.ts');
    expect(classifyTts('ElevenLabs HTTP 402: payment_required paid_plan_required')).toBe('voice');
    expect(classifyTts('ElevenLabs HTTP 401: invalid_api_key')).toBe('auth');
    expect(classifyTts('ElevenLabs HTTP 400: quota_exceeded')).toBe('quota');
    expect(classifyTts('Gemini TTS HTTP 429: You exceeded your current quota')).toBe('quota');
    expect(classifyTts('OpenAI TTS HTTP 429: You have no credits remaining')).toBe('quota');
    expect(classifyTts('ElevenLabs HTTP 429: too_many_concurrent_requests')).toBe('busy');
    expect(classifyTts('fetch failed')).toBe('network');
  });

  it('speaks with a stock voice when the agent voice is refused, without silencing other agents', async () => {
    const { TtsService } = await import('../src/media/tts.ts');
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return url.includes('/BADVOICE') ? new Response('{"detail":{"code":"voice_not_found"}}', { status: 404 }) : mp3();
    }) as never;
    const tts = new TtsService({ secrets, providers, fetch });
    const a = await tts.speak('Salut tout le monde.', agent('watcher', 'BADVOICE'), 'mp3');
    expect(a.provider).toBe('elevenlabs');
    const b = await tts.speak('Bonjour.', agent('operator', 'GOODVOICE'), 'mp3');
    expect(b.provider).toBe('elevenlabs');
    expect(urls.some((u) => u.includes('/GOODVOICE'))).toBe(true);
  });

  it('still tries an engine that is paused when nothing else is left, and reports why it failed', async () => {
    const { TtsService, TtsError } = await import('../src/media/tts.ts');
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 });
    }) as never;
    const tts = new TtsService({ secrets, providers, fetch });
    const err = await tts.speak('Hello there.', agent('builder', 'V'), 'mp3').catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    const again = await tts.speak('Hello again.', agent('builder', 'V'), 'mp3').catch((e) => e);
    expect(again).toBeInstanceOf(TtsError);
    expect(calls).toBe(2); // the paused engine was still tried
  });
});
