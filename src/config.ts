import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const ROOT = resolve(import.meta.dirname, '..');

if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'));

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  SUNNY_PORT: z.coerce.number().int().default(3210),
  /** Keep 127.0.0.1 behind a reverse proxy on this machine (docs/HTTPS.md). */
  SUNNY_BIND: z.string().default('127.0.0.1'),
  /** Base URL the user's browser uses to reach the daemon (auth links, OAuth redirects). */
  SUNNY_PUBLIC_URL: z
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
  /** Postgres for runtime state. SUNNY_-prefixed so it never reaches an agent's environment. */
  SUNNY_DATABASE_URL: z.string().optional(),
  SUNNY_DATA_DIR: z.string().default(resolve(ROOT, 'data')),
  SUNNY_AGENTS_DIR: z.string().default(resolve(ROOT, 'agents')),
  /** base64 32-byte key for the secrets store; when unset, data/master.key is created and used. */
  SUNNY_MASTER_KEY: z.string().optional(),
  /** Timezone for cron schedules that do not name one. */
  SUNNY_TIMEZONE: z.string().default('UTC'),
  SUNNY_MODEL: z.string().default('opus'),
  /** Spoken turns (voice messages, calls) run on the provider's light model (Haiku on Claude). Off: the agent's own model. */
  /** The Claude account agents use normally; the other one is the automatic backup (id, label or e-mail). */
  SUNNY_CLAUDE_MAIN: z.string().default(''),
  SUNNY_VOICE_LIGHT: bool.default(true),
  SUNNY_AGENT_DEFAULT_MODEL: z.string().default('sonnet'),
  /** Keep ANTHROPIC_API_KEY in the agents' environment. Off by default so runs use the Claude subscription. */
  SUNNY_USE_API_KEY: bool.default(false),
  /**
   * Tokens at which an agent's long conversation is summarised (compacted). Every message re-reads the whole
   * history, so a conversation that grows to 1M tokens makes each reply cost (and count against the
   * subscription limits) as much as a 1M-token prompt. 0 = leave Claude Code's own threshold.
   */
  SUNNY_COMPACT_TOKENS: z.coerce.number().int().min(0).default(200_000),
  /** Minutes an approval request waits for an answer before it is denied. */
  SUNNY_APPROVAL_TIMEOUT_MIN: z.coerce.number().positive().default(10),
  /** Minutes an auth link stays valid. */
  SUNNY_AUTH_LINK_TTL_MIN: z.coerce.number().positive().default(15),
  /** Whisper model for voice messages, run on this machine (onnx-community/whisper-base is faster, less accurate). */
  SUNNY_WHISPER_MODEL: z.string().default('onnx-community/whisper-small'),
  /** Languages voice messages are expected in, e.g. "fr,en". Empty: Whisper picks among all it knows. */
  SUNNY_WHISPER_LANGUAGES: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)),
  /** Minutes of a voice message, audio or video that get transcribed; the rest is cut. */
  SUNNY_TRANSCRIBE_MAX_MIN: z.coerce.number().positive().default(15),
  /** Days files sent in chat stay in an agent's inbox/ folder. */
  SUNNY_INBOX_DAYS: z.coerce.number().positive().default(30),
  /** Shared secret other apps send (header x-sunny-secret) to POST events to /events/<source>. */
  SUNNY_EVENTS_SECRET: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  root: ROOT,
  publicUrl: parsed.SUNNY_PUBLIC_URL ?? `http://localhost:${parsed.SUNNY_PORT}`,
  dataDir: parsed.SUNNY_DATA_DIR,
  agentsDir: parsed.SUNNY_AGENTS_DIR,
};

export type Config = typeof config;
