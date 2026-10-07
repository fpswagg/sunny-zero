import { execFile, fork, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { KeyedMutex } from '../util/mutex.ts';
import { log } from '../log.ts';
import { probe } from './images.ts';

const run = promisify(execFile);
const RATE = 16_000;

export interface TranscriberOptions {
  /** Hugging Face model id, e.g. "onnx-community/whisper-small". */
  model: string;
  /** Where downloaded models are kept. */
  cacheDir: string;
  /** Languages to choose from ("fr", "en"...). Empty: any language Whisper knows. */
  languages: string[];
  /** Longer audio is cut to this many seconds. */
  maxSeconds: number;
  /** The model is unloaded after this long without use, to give the memory back. */
  idleMs: number;
}

/** Hints for one transcription. */
export interface TranscribeHints {
  /** Language the speaker uses ("fr", "en"). Unset: detected. */
  language?: string;
  /** Names and words to get right (agent names, product names...). */
  keyterms?: string[];
}

export interface Transcript {
  text: string;
  /** Detected language code, e.g. "fr". */
  language: string;
  /** Seconds of audio transcribed. */
  seconds: number;
  /** True when the audio was longer than maxSeconds and was cut. */
  truncated: boolean;
  /** Which engine transcribed it. */
  engine?: string;
}

/** Decodes any audio or video file ffmpeg reads to 16 kHz mono samples. */
export async function decodeAudio(file: string, maxSeconds: number): Promise<{ audio: Float32Array; truncated: boolean }> {
  const { stdout } = await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', file, '-t', String(maxSeconds + 1), '-vn', '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'], {
    encoding: 'buffer',
    maxBuffer: (maxSeconds + 2) * RATE * 4,
  });
  const copy = new Float32Array(stdout.byteLength / 4);
  copy.set(new Float32Array(stdout.buffer, stdout.byteOffset, copy.length));
  const limit = maxSeconds * RATE;
  return copy.length > limit ? { audio: copy.subarray(0, limit), truncated: true } : { audio: copy, truncated: false };
}

/**
 * Speech to text on this machine with Whisper (ONNX, CPU). No audio leaves the server. The
 * model loads on first use (and downloads once into cacheDir), and is unloaded when idle.
 */
export class Transcriber {
  private asr?: Promise<AutomaticSpeechRecognitionPipeline>;
  private idle?: NodeJS.Timeout;
  private lock = new KeyedMutex();

  constructor(private readonly opts: TranscriberOptions) {}

  transcribe(file: string, hints: TranscribeHints = {}): Promise<Transcript> {
    return this.lock.run('whisper', async () => {
      clearTimeout(this.idle);
      try {
        const { audio, truncated } = await decodeAudio(file, this.opts.maxSeconds);
        const seconds = Math.round(audio.length / RATE);
        if (audio.length < RATE / 4) return { text: '', language: '', seconds, truncated };
        const asr = await this.load();
        const language = hints.language && /^[a-z]{2}$/.test(hints.language) ? hints.language : await this.detect(asr, audio);
        const out = await asr(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
        const text = cleanTranscript(Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text);
        return { text, language, seconds, truncated, engine: 'whisper' };
      } finally {
        this.idle = setTimeout(() => void this.unload(), this.opts.idleMs);
        this.idle.unref();
      }
    });
  }

  private load(): Promise<AutomaticSpeechRecognitionPipeline> {
    if (!this.asr) {
      env.cacheDir = this.opts.cacheDir;
      const started = Date.now();
      this.asr = (pipeline('automatic-speech-recognition', this.opts.model, { dtype: 'q8' }) as Promise<AutomaticSpeechRecognitionPipeline>).then(
        (asr) => {
          log.info({ model: this.opts.model, ms: Date.now() - started }, 'whisper: model loaded');
          return asr;
        },
        (err) => {
          this.asr = undefined;
          throw err;
        },
      );
    }
    return this.asr;
  }

  private async unload(): Promise<void> {
    const asr = this.asr;
    this.asr = undefined;
    if (asr) await (await asr).dispose().catch(() => {});
  }

  /** Whisper's own language guess: the likeliest language token after <|startoftranscript|>, on the first 30 seconds. */
  private async detect(asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array): Promise<string> {
    const config = asr.model.generation_config as unknown as { lang_to_id?: Record<string, number>; decoder_start_token_id: number };
    const langs = Object.entries(config.lang_to_id ?? {}).filter(([token]) => !this.opts.languages.length || this.opts.languages.includes(token.slice(2, -2)));
    if (langs.length <= 1) return langs[0]?.[0].slice(2, -2) ?? 'en';
    const { input_features } = await asr.processor(audio.subarray(0, 30 * RATE));
    const start = new Tensor('int64', BigInt64Array.from([BigInt(config.decoder_start_token_id)]), [1, 1]);
    const { logits } = (await asr.model({ input_features, decoder_input_ids: start })) as { logits: Tensor };
    const scores = logits.data as Float32Array;
    let best = langs[0]!;
    for (const lang of langs) if (scores[lang[1]]! > scores[best[1]]!) best = lang;
    return best[0].slice(2, -2);
  }
}

type WorkerReply = { id: number; ok: true; transcript: Transcript } | { id: number; ok: false; error: string };

/**
 * Same as Transcriber, but Whisper runs in a child process (whisper-worker.ts). The daemon's memory
 * stays small, a crash in the model can't take the daemon down, and the memory is given back to the
 * system when the worker is stopped after `idleMs` without use.
 */
export class WorkerTranscriber {
  private child?: ChildProcess;
  private idle?: NodeJS.Timeout;
  private lock = new KeyedMutex();
  private nextId = 1;
  private pending = new Map<number, { resolve: (t: Transcript) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly opts: TranscriberOptions,
    private readonly workerPath: string = fileURLToPath(new URL('./whisper-worker.ts', import.meta.url)),
  ) {}

  transcribe(file: string, hints: TranscribeHints = {}): Promise<Transcript> {
    return this.lock.run('whisper', () => {
      clearTimeout(this.idle);
      const child = this.spawn();
      const id = this.nextId++;
      // Whisper small on CPU runs at roughly real time or faster; leave a wide margin plus model load.
      const timeoutMs = 120_000 + this.opts.maxSeconds * 2_000;
      return new Promise<Transcript>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`transcription timed out after ${Math.round(timeoutMs / 1000)}s`));
          this.stop();
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        child.send({ id, file, hints });
      }).finally(() => {
        this.idle = setTimeout(() => this.stop(), this.opts.idleMs);
        this.idle.unref();
      });
    });
  }

  /** Stops the worker (model memory goes back to the system). */
  stop(): void {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill();
  }

  private spawn(): ChildProcess {
    if (this.child && this.child.exitCode === null && this.child.connected) return this.child;
    const child = fork(this.workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    child.send({ type: 'init', options: this.opts });
    child.on('message', (msg: WorkerReply) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.transcript);
      else p.reject(new Error(msg.error));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (!this.pending.size) return;
      const why = new Error(`whisper worker exited (${signal ?? `code ${code}`})`);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(why);
        this.pending.delete(id);
      }
    });
    log.info({ pid: child.pid }, 'whisper: worker started');
    this.child = child;
    return child;
  }
}

/** Shared shape for every transcription backend. */
export interface TranscriberBackend {
  transcribe(file: string, hints?: TranscribeHints): Promise<Transcript>;
}

async function audioDuration(file: string, maxSeconds: number): Promise<{ seconds: number; truncated: boolean }> {
  const info = await probe(file).catch(() => undefined);
  const duration = info?.duration ?? 0;
  if (!duration) return { seconds: 0, truncated: false };
  return duration > maxSeconds ? { seconds: maxSeconds, truncated: true } : { seconds: Math.round(duration), truncated: false };
}

/** Lines speech models invent on silence or noise (Whisper learned them from subtitles). */
const HALLUCINATIONS = [
  /^(merci|thank you|thanks)( (beaucoup|very much|for watching|d'avoir regardé( cette vidéo)?))?[.!]?$/i,
  /sous-titr(es|age) (réalisés? )?(par|ST'?) /i,
  /amara\.org/i,
  /^(you|bye|\.+|…)$/i,
];

/**
 * Removes what is not speech: sound tags like "(laughter)" or "[background noise]", and lines speech
 * models make up on silence. Returns "" when nothing was said.
 */
export function cleanTranscript(text: string): string {
  const t = text
    .replace(/\[[^\]]{1,40}\]|\((?:[^()]{1,40})\)/g, (m) => (/^[[(]\s*[\p{L} '-]+\s*[\])]$/u.test(m) && m.split(' ').length <= 4 ? ' ' : m))
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  return HALLUCINATIONS.some((re) => re.test(t)) ? '' : t;
}

/** ElevenLabs keyterms: at most 50 characters and 5 words each. */
const keytermsFor = (hints: TranscribeHints) =>
  [...new Set((hints.keyterms ?? []).map((k) => k.trim()).filter((k) => k && k.length <= 50 && k.split(/\s+/).length <= 5))].slice(0, 50);

/** ElevenLabs Scribe: cloud STT, fast (under a second for a short phrase) and accurate in French and English. */
export class ElevenLabsTranscriber implements TranscriberBackend {
  constructor(
    private readonly getKey: () => Promise<string | undefined>,
    private readonly maxSeconds: number,
    private readonly model = 'scribe_v2',
  ) {}

  async transcribe(file: string, hints: TranscribeHints = {}): Promise<Transcript> {
    const key = await this.getKey();
    if (!key) throw new Error('ElevenLabs key not configured');
    const { seconds, truncated } = await audioDuration(file, this.maxSeconds);
    const form = new FormData();
    form.append('file', new Blob([await readFile(file)]), basename(file));
    form.append('model_id', this.model);
    form.append('tag_audio_events', 'false');
    form.append('timestamps_granularity', 'none');
    // Drops "euh", false starts and stutters: what an agent should read.
    if (this.model.startsWith('scribe_v2')) form.append('no_verbatim', 'true');
    if (hints.language) form.append('language_code', hints.language);
    for (const term of keytermsFor(hints)) form.append('keyterms', term);
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
      signal: AbortSignal.timeout(60_000 + seconds * 1000),
    });
    if (!res.ok) throw new Error(`ElevenLabs STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { text?: string; language_code?: string };
    return { text: cleanTranscript(data.text ?? ''), language: data.language_code ?? '', seconds, truncated, engine: 'elevenlabs' };
  }
}

/** OpenAI transcription API: cloud STT, needs an OpenAI key with credits. */
export class OpenAiTranscriber implements TranscriberBackend {
  constructor(
    private readonly getKey: () => Promise<string | undefined>,
    private readonly maxSeconds: number,
  ) {}

  async transcribe(file: string, hints: TranscribeHints = {}): Promise<Transcript> {
    const key = await this.getKey();
    if (!key) throw new Error('OpenAI key not configured');
    const { seconds, truncated } = await audioDuration(file, this.maxSeconds);
    const form = new FormData();
    form.append('file', new Blob([await readFile(file)]), basename(file));
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    if (hints.language && /^[a-z]{2}$/.test(hints.language)) form.append('language', hints.language);
    const terms = keytermsFor(hints);
    if (terms.length) form.append('prompt', terms.join(', '));
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`OpenAI STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { text?: string; language?: string; duration?: number };
    return {
      text: cleanTranscript(data.text ?? ''),
      language: data.language ?? '',
      seconds: data.duration ? Math.min(Math.round(data.duration), this.maxSeconds) : seconds,
      truncated,
      engine: 'openai',
    };
  }
}

/** A failed engine (no key, no credits) is skipped this long before it is tried again. */
const COOLDOWN_MS = 10 * 60_000;

/**
 * Tries several transcribers in order and falls back on failure. An engine that just failed is
 * skipped for a while, so one without credits does not slow every voice message down.
 */
export class FallbackTranscriber implements TranscriberBackend {
  private failedUntil = new Map<TranscriberBackend, number>();

  constructor(
    private readonly engines: TranscriberBackend[],
    /** Added to every request's keyterms (agent names...). */
    private readonly keyterms: () => string[] = () => [],
  ) {}

  async transcribe(file: string, hints: TranscribeHints = {}): Promise<Transcript> {
    const all = { ...hints, keyterms: [...(hints.keyterms ?? []), ...this.keyterms()] };
    const fresh = this.engines.filter((e) => (this.failedUntil.get(e) ?? 0) < Date.now());
    const errors: string[] = [];
    for (const engine of fresh.length ? fresh : this.engines) {
      const started = Date.now();
      try {
        const t = await engine.transcribe(file, all);
        this.failedUntil.delete(engine);
        log.info({ engine: t.engine ?? engine.constructor.name, ms: Date.now() - started, seconds: t.seconds, chars: t.text.length, language: t.language }, 'stt: transcribed');
        return t;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A missing key is not worth a cooldown log line each time, but still skip it.
        this.failedUntil.set(engine, Date.now() + COOLDOWN_MS);
        errors.push(`${engine.constructor.name}: ${message}`);
        log.warn({ engine: engine.constructor.name, err: message.slice(0, 200) }, 'stt: engine failed, trying the next');
      }
    }
    throw new Error(`All transcription engines failed: ${errors.join('; ')}`);
  }
}
