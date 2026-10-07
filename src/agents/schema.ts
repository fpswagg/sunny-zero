import { z } from 'zod';
import { EFFORTS, PROVIDER_IDS } from '../providers/catalog.ts';

export const AGENT_NAME = /^[a-z][a-z0-9-]{1,39}$/;

/** Built-in Claude Code tools an agent may be given. */
export const BUILTIN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
] as const;

export const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit']);
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('cron'),
    schedule: z.string().min(1).describe('Cron expression, e.g. "0 8 * * *"'),
    prompt: z.string().default('Run your scheduled task.'),
    timezone: z.string().optional().describe('IANA zone; defaults to SUNNY_TIMEZONE'),
  }),
  z.object({
    type: z.literal('event'),
    source: z.string().min(1).describe('Event source, e.g. "email"'),
    on: z.string().default('*').describe('Event name within the source, e.g. "alert" ("*" for all)'),
    filter: z.record(z.string(), z.string()).optional().describe('Event data fields that must match (glob, any case), e.g. {"severity": "critical"}'),
    prompt: z.string().optional().describe('What to do with the events; they are appended as data'),
  }),
]);

export const accessSchema = z.object({
  /**
   * restricted: only the agent's own folder.
   * workspace: also `workdir` and `extraDirs`.
   * full: everything on the machine, no approvals.
   */
  profile: z.enum(['restricted', 'workspace', 'full']).default('restricted'),
  /** Working directory for workspace agents (absolute path). Restricted agents work in their own workspace/. */
  workdir: z.string().optional(),
  extraDirs: z.array(z.string()).default([]),
  /** Folders the agent may read but not change (any profile), e.g. a project it monitors. Secret files stay unreadable. */
  readOnlyDirs: z.array(z.string()).default([]),
  /**
   * File names (globs over the name, e.g. "OVERVIEW.md") the agent may create or change inside
   * its read-only folders without asking, e.g. docs it keeps in a project. Guests still ask.
   */
  writableFiles: z.array(z.string()).default([]),
  /**
   * Shell commands that run without asking, as patterns over the whole command ("*" matches
   * anything): e.g. "df -h", "docker logs --tail * *". Pipelines need every part to match;
   * other shell syntax (; && $( ) > and so on) always asks.
   */
  commands: z.array(z.string()).default([]),
  /** Tools that run without asking even when the policy would ask (e.g. "Bash"). */
  autoApprove: z.array(z.string()).default([]),
  /** Tools that always ask first, even inside the allowed folders. */
  alwaysAsk: z.array(z.string()).default([]),
});

export const memorySchema = z.object({
  /**
   * none: every message starts fresh.
   * conversation: one resumable session per conversation (chat, Telegram chat...).
   * shared: one session for the agent across all conversations and triggers.
   */
  session: z.enum(['none', 'conversation', 'shared']).default('conversation'),
  /** Persistent notes folder (memory/) the agent reads and maintains. */
  notes: z.boolean().default(false),
});

export const agentSchema = z.object({
  name: z.string().regex(AGENT_NAME, 'lowercase letters, digits and dashes, 2-40 chars'),
  description: z.string().min(1),
  /**
   * Where the model runs: "claude" (the subscription, default), "anthropic" (Claude API key),
   * "openai", "gemini", "kimi" or "openrouter". Keys are connected through Sunny.
   */
  provider: z.enum(PROVIDER_IDS).optional(),
  /** Model id at that provider ("sonnet", "gpt-5.5", "moonshotai/kimi-k3"). */
  model: z.string().optional(),
  effort: z.enum(EFFORTS).optional(),
  /**
   * Models tried in order when the main one fails (usage limit, rate limit, provider down):
   * "sonnet", "kimi:kimi-k3", "openai:gpt-5.5"... A fallback on another model family starts
   * its own history.
   */
  fallbackModels: z.array(z.string().min(1).max(120)).max(5).default([]),
  tools: z.array(z.enum(BUILTIN_TOOLS)).default(['Read', 'Write', 'Edit', 'Glob', 'Grep']),
  connectors: z.array(z.string()).default([]),
  triggers: z.array(triggerSchema).default([{ type: 'manual' }]),
  access: accessSchema.default({ profile: 'restricted', extraDirs: [], readOnlyDirs: [], writableFiles: [], commands: [], autoApprove: [], alwaysAsk: [] }),
  memory: memorySchema.default({ session: 'conversation', notes: false }),
  /**
   * Where the notify connector delivers: channel names ("telegram", "cli", "web") or exact
   * conversation ids ("cli:default"). Empty: Telegram, or every open chat when it is not paired.
   */
  notify: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().optional(),
  /**
   * How the agent sounds in voice replies and calls. `reply`: "auto" lets the agent decide
   * when a voice note fits (its send_voice tool), "always" speaks every reply, "off" never (text only).
   */
  voice: z
    .object({
      provider: z.enum(['elevenlabs', 'gemini', 'openai']).optional(),
      /** ElevenLabs voice id, a Gemini voice ("Charon", "Kore"...) or an OpenAI voice ("onyx"...). */
      voice: z.string().max(80).optional(),
      /** Tone ("calm, laid back, a little teasing"), for Gemini and OpenAI voices. */
      instructions: z.string().max(500).optional(),
      reply: z.enum(['auto', 'always', 'off']).default('auto'),
    })
    .optional(),
  /** The agent's colour in its app ("#e13c46"). Unset: taken from its icon. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'a hex colour like #e13c46')
    .optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type AgentDefinition = z.output<typeof agentSchema>;
export type AgentInput = z.input<typeof agentSchema>;
export type Trigger = z.output<typeof triggerSchema>;

export interface Agent {
  def: AgentDefinition;
  prompt: string;
  /** agents/<name> */
  dir: string;
}

/** True when the definition grants more than a restricted, ask-first agent. Such changes need the user's approval. */
export function privilegedReasons(def: AgentDefinition): string[] {
  const reasons: string[] = [];
  if (def.access.profile === 'full') reasons.push('full machine access without approvals');
  if (def.access.profile === 'workspace') reasons.push(`access to ${[def.access.workdir, ...def.access.extraDirs].filter(Boolean).join(', ') || 'a workspace'}`);
  if (def.access.readOnlyDirs.length) reasons.push(`read access to ${def.access.readOnlyDirs.join(', ')}`);
  if (def.access.writableFiles.length) reasons.push(`writes ${def.access.writableFiles.join(', ')} in those folders without asking`);
  if (def.access.commands.length) reasons.push(`runs these commands without asking: ${def.access.commands.join(' · ')}`);
  if (def.access.autoApprove.length) reasons.push(`runs ${def.access.autoApprove.join(', ')} without asking`);
  return reasons;
}
