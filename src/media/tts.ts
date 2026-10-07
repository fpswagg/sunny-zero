import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDefinition } from '../agents/schema.ts';
import { log } from '../log.ts';
import type { Providers } from '../providers/providers.ts';
import type { SecretStore } from '../secrets/store.ts';

/** Where the ElevenLabs key is kept (collected with a secure form, never in chat). */
export const ELEVENLABS_SECRET_ID = 'tts:elevenlabs';

export type TtsProvider = 'elevenlabs' | 'gemini' | 'openai';

export interface Speech {
  audio: Buffer;
  /** "audio/mpeg" (mp3) or "audio/ogg" (Opus, what Telegram voice messages use). */
  mime: string;
  provider: TtsProvider;
}

const GEMINI_VOICES = ['Charon', 'Puck', 'Kore', 'Fenrir', 'Aoede', 'Orus', 'Leda', 'Zephyr', 'Iapetus', 'Algieba', 'Sadaltager', 'Achird'] as const;
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const;
/** ElevenLabs premade voices that speak French and English well (multilingual model). */
const ELEVEN_VOICES = ['JBFqnCBsd6RMkjVDRZzb', 'pNInz6obpgDQGcFmaJgB', 'EXAVITQu4vr4xnSDxMaL', 'onwK4e9ZLuTAKqWW03F9', 'XrExE9yKIg1WjnnlVkGX', 'cgSgspJ2msm6clMCkdW9'];

/** Text longer than this is cut at a sentence end before speaking. */
export const MAX_SPOKEN_CHARS = 1800;

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * Turns a chat reply into something worth hearing: no code blocks, links, tables or Markdown
 * symbols, and not too long.
 */
export function speakable(text: string, max = MAX_SPOKEN_CHARS): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]{1,60})`/g, '$1')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*|__|~~|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
    t = `${(end > max / 2 ? cut.slice(0, end + 1) : cut).trim()} …`;
  }
  return t;
}

export interface TtsDeps {
  secrets: SecretStore;
  providers: Providers;
  fetch?: typeof fetch;
}

/** Engines in the order they are tried when the agent names none. */
const ORDER: TtsProvider[] = ['elevenlabs', 'gemini', 'openai'];
/** An engine that failed (no credits, quota) is skipped this long before being tried again. */
const COOLDOWN_MS = 2 * 60_000;

type Raw = { audio: Buffer; format: 'mp3' | 'pcm24k' };

/**
 * Why a voice failed, in terms the app can explain: "quota" (no credits left), "auth" (bad key),
 * "voice" (that voice id is not usable), "busy" (rate limited), "network" (could not reach the
 * service), "empty" (nothing to say), "none" (no engine set up), "unknown".
 */
export type TtsFailure = 'quota' | 'auth' | 'voice' | 'busy' | 'network' | 'empty' | 'none' | 'unknown';

export class TtsError extends Error {
  constructor(
    message: string,
    readonly code: TtsFailure,
  ) {
    super(message);
  }
}

/** Reads an engine's error message ("ElevenLabs HTTP 402: {...}") into a failure kind. */
export function classifyTts(message: string): TtsFailure {
  const m = message.toLowerCase();
  if (/quota_exceeded|exceeded your current quota|no credits|insufficient|billing|credit/.test(m)) return 'quota';
  if (/http 401|invalid_api_key|unauthorized|api key/.test(m)) return 'auth';
  if (/voice_not_found|library voices|paid_plan_required|http 404|http 400.*voice|http 402/.test(m)) return 'voice';
  if (/http 429|rate.?limit|too many|concurrent/.test(m)) return 'busy';
  if (/timeout|timed out|fetch failed|econn|enotfound|network|abort|http 5\d\d/.test(m)) return 'network';
  return 'unknown';
}

/** Failures that say something about the account, not about one voice: worth pausing the engine. */
const ACCOUNT_LEVEL = new Set<TtsFailure>(['quota', 'auth']);

/**
 * Text to speech for voice replies and calls: ElevenLabs when its key is stored, Google Gemini
 * TTS or OpenAI (gpt-4o-mini-tts) with their provider keys. The first one that works speaks; one
 * that fails (no credits, quota) is skipped for a while.
 */
export class TtsService {
  private failedUntil = new Map<TtsProvider, number>();

  constructor(private readonly deps: TtsDeps) {}

  private get fetch() {
    return this.deps.fetch ?? globalThis.fetch;
  }

  /** Engines set up right now, in the order they would be tried for this agent. */
  async engines(def?: Pick<AgentDefinition, 'voice'>): Promise<TtsProvider[]> {
    const [eleven, gemini, openai] = await Promise.all([
      this.deps.secrets.has(ELEVENLABS_SECRET_ID),
      this.deps.providers.connected('gemini'),
      this.deps.providers.connected('openai'),
    ]);
    const ready: Record<TtsProvider, boolean> = { elevenlabs: eleven, gemini, openai };
    const wanted = def?.voice?.provider;
    const order = wanted ? [wanted, ...ORDER.filter((e) => e !== wanted)] : ORDER;
    return order.filter((e) => ready[e]);
  }

  /** Voices each engine offers: fixed lists for Gemini and OpenAI, the account's own for ElevenLabs. */
  async voices(): Promise<{ gemini: string[]; openai: string[]; elevenlabs: { id: string; name: string; hint?: string }[] }> {
    const out = { gemini: [...GEMINI_VOICES] as string[], openai: [...OPENAI_VOICES] as string[], elevenlabs: [] as { id: string; name: string; hint?: string }[] };
    const secret = await this.deps.secrets.get(ELEVENLABS_SECRET_ID).catch(() => undefined);
    if (secret?.apiKey) {
      try {
        const res = await this.fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': String(secret.apiKey) }, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string>; category?: string }[] };
          out.elevenlabs = (data.voices ?? []).slice(0, 100).map((v) => ({ id: v.voice_id, name: v.name, hint: [v.labels?.gender, v.labels?.accent, v.category].filter(Boolean).join(' · ') || undefined }));
        }
      } catch {
        /* the list is a convenience; ids can still be typed */
      }
    }
    return out;
  }

  /** The engine that would speak first, if any. */
  async engine(def?: Pick<AgentDefinition, 'voice'>): Promise<TtsProvider | undefined> {
    const all = await this.engines(def);
    return all.find((e) => (this.failedUntil.get(e) ?? 0) < Date.now()) ?? all[0];
  }

  /** Speaks `text` as the agent. `format` "ogg" gives Opus for Telegram voice messages. */
  async speak(text: string, agent: Pick<AgentDefinition, 'name' | 'description' | 'voice'>, format: 'mp3' | 'ogg' = 'mp3'): Promise<Speech> {
    const input = speakable(text);
    if (!input) throw new TtsError('nothing to say', 'empty');
    const all = await this.engines(agent);
    if (!all.length) throw new TtsError('No voice engine: add an ElevenLabs key, or connect Gemini or OpenAI.', 'none');
    // Engines that failed lately go last, never out: a pause must not turn into silence.
    const now = Date.now();
    const order = [...all.filter((e) => (this.failedUntil.get(e) ?? 0) < now), ...all.filter((e) => (this.failedUntil.get(e) ?? 0) >= now)];
    const errors: string[] = [];
    let first: TtsFailure | undefined;
    for (const engine of order) {
      const started = Date.now();
      // A flaky network or an overloaded service gets a second chance before moving on.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const raw = engine === 'elevenlabs' ? await this.eleven(input, agent) : engine === 'gemini' ? await this.gemini(input, agent) : await this.openai(input, agent);
          this.failedUntil.delete(engine);
          log.info({ agent: agent.name, engine, chars: input.length, ms: Date.now() - started }, 'tts: spoke');
          if (format === 'mp3' && raw.format === 'mp3') return { audio: raw.audio, mime: 'audio/mpeg', provider: engine };
          return { audio: await transcode(raw, format), mime: format === 'mp3' ? 'audio/mpeg' : 'audio/ogg', provider: engine };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const kind = classifyTts(message);
          if (attempt === 1 && (kind === 'network' || kind === 'busy')) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          // Only an account-level failure pauses the engine for every agent; a bad voice id must not.
          if (ACCOUNT_LEVEL.has(kind)) this.failedUntil.set(engine, Date.now() + COOLDOWN_MS);
          first ??= kind;
          log.warn({ agent: agent.name, engine, kind, err: message.slice(0, 200) }, 'tts: engine failed, trying the next');
          errors.push(`${engine}: ${message.slice(0, 120)}`);
          break;
        }
      }
    }
    throw new TtsError(`No voice engine worked (${errors.join('; ')})`, first ?? 'unknown');
  }

  /** Writes a Telegram-ready voice message (.ogg) into `dir` and returns its path. */
  async voiceFile(text: string, agent: Pick<AgentDefinition, 'name' | 'description' | 'voice'>, dir: string): Promise<string> {
    const { audio } = await this.speak(text, agent, 'ogg');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `voice-${Date.now()}.ogg`);
    await writeFile(path, audio, { mode: 0o600 });
    return path;
  }

  private async eleven(input: string, agent: Pick<AgentDefinition, 'name' | 'voice'>): Promise<Raw> {
    const secret = await this.deps.secrets.get(ELEVENLABS_SECRET_ID);
    const apiKey = secret?.apiKey;
    if (!apiKey) throw new Error('ElevenLabs key missing');
    const configured = agent.voice?.provider === 'elevenlabs' || !agent.voice?.provider ? agent.voice?.voice : undefined;
    const fallback = ELEVEN_VOICES[hash(agent.name) % ELEVEN_VOICES.length]!;
    const voice = configured || secret.voiceId || fallback;
    try {
      return await this.elevenOnce(input, voice, apiKey, secret.model);
    } catch (err) {
      // The agent's own voice is refused (removed, wrong id, not allowed on this plan): speak with a
      // stock voice rather than staying silent.
      const message = err instanceof Error ? err.message : String(err);
      if (voice !== fallback && classifyTts(message) === 'voice') {
        log.warn({ agent: agent.name, voice, err: message.slice(0, 120) }, 'tts: voice refused, using a stock voice');
        return await this.elevenOnce(input, fallback, apiKey, secret.model);
      }
      throw err;
    }
  }

  private async elevenOnce(input: string, voice: string, apiKey: string, model?: string): Promise<Raw> {
    let res: Response | undefined;
    // 409 "already_running": several sentences asked at once and ElevenLabs is still adding a library
    // voice to the account. It clears in seconds, so wait and retry instead of failing the sentence.
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await this.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: input, model_id: model || 'eleven_flash_v2_5' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status !== 409 || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (!res!.ok) throw new Error(`ElevenLabs HTTP ${res!.status}: ${(await res!.text()).slice(0, 200)}`);
    return { audio: Buffer.from(await res!.arrayBuffer()), format: 'mp3' };
  }

  private async gemini(input: string, agent: Pick<AgentDefinition, 'name' | 'voice'>): Promise<Raw> {
    const creds = await this.deps.providers.credentials('gemini');
    if (!creds) throw new Error('Gemini is not connected');
    const configured = agent.voice?.provider === 'gemini' || !agent.voice?.provider ? agent.voice?.voice : undefined;
    const voice = configured && /^[A-Z][a-z]+$/.test(configured) ? configured : GEMINI_VOICES[hash(agent.name) % GEMINI_VOICES.length]!;
    const style = agent.voice?.instructions ? `${agent.voice.instructions.replace(/[.:\s]+$/, '')}: ` : 'Say naturally, like a voice message to a friend: ';
    const res = await this.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': creds.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${style}${input}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`Gemini TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
    const b64 = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!b64) throw new Error('Gemini TTS returned no audio');
    return { audio: Buffer.from(b64, 'base64'), format: 'pcm24k' };
  }

  private async openai(input: string, agent: Pick<AgentDefinition, 'name' | 'description' | 'voice'>): Promise<Raw> {
    const creds = await this.deps.providers.credentials('openai');
    if (!creds) throw new Error('OpenAI is not connected');
    const configured = agent.voice?.provider === 'openai' || !agent.voice?.provider ? agent.voice?.voice : undefined;
    const voice = configured && (OPENAI_VOICES as readonly string[]).includes(configured) ? configured : OPENAI_VOICES[hash(agent.name) % OPENAI_VOICES.length]!;
    const instructions =
      agent.voice?.instructions ??
      `You are ${agent.name}. ${agent.description.split(/(?<=\.)\s/)[0] ?? ''} Speak naturally and conversationally, in the language of the text, like a voice message to a friend you work with.`;
    const res = await this.fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input, instructions, response_format: 'mp3' }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { audio: Buffer.from(await res.arrayBuffer()), format: 'mp3' };
  }
}

/** mp3 or raw 24 kHz PCM → mp3 or Ogg/Opus (Telegram voice messages need Opus to show as a voice bubble). */
export async function transcode(raw: Raw, to: 'mp3' | 'ogg'): Promise<Buffer> {
  const input = raw.format === 'pcm24k' ? ['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0'] : ['-i', 'pipe:0'];
  const output = to === 'ogg' ? ['-c:a', 'libopus', '-b:a', '48k', '-ac', '1', '-f', 'ogg'] : ['-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-f', 'mp3'];
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile('ffmpeg', ['-nostdin', '-loglevel', 'error', ...input, ...output, 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    child.stdin?.end(raw.audio);
  });
}

/** Converts any recorded audio (browser webm/ogg/mp4) to a file ffmpeg and Whisper read; returns the path. */
export async function saveRecording(audio: Buffer, dir: string, ext: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'webm'}`);
  await writeFile(path, audio, { mode: 0o600 });
  return path;
}

