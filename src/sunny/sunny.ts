import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentSchema, type Agent } from '../agents/schema.ts';
import { config } from '../config.ts';

const PROMPT = readFileSync(join(import.meta.dirname, 'prompt.md'), 'utf8');

/**
 * Sunny is defined in code rather than in agents/, so it cannot edit or delete itself.
 * Its home (and notes) is data/sunny; it works in the agents folder.
 */
export function sunnyAgent(): Agent {
  const dir = join(config.dataDir, 'sunny');
  mkdirSync(join(dir, 'memory'), { recursive: true });
  return {
    dir,
    prompt: PROMPT,
    def: agentSchema.parse({
      name: 'sunny',
      description: 'Creates, manages and delegates to the user’s agents',
      model: config.SUNNY_MODEL,
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      access: { profile: 'restricted' },
      memory: { session: 'conversation', notes: true },
    }),
  };
}
