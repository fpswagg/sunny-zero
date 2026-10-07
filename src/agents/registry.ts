import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { agentSchema, AGENT_NAME, type Agent, type AgentDefinition, type AgentInput } from './schema.ts';
import { readJson, writeJsonAtomic } from '../util/fs.ts';
import { log } from '../log.ts';

export const RESERVED_NAMES = new Set(['sunny', 'all', 'system']);

/**
 * Agents live on disk as agents/<name>/agent.json + prompt.md, so they can be read, edited
 * and versioned by hand as well as by Sunny.
 */
export class AgentRegistry extends EventEmitter<{ changed: [name: string] }> {
  private agents = new Map<string, Agent>();

  constructor(
    readonly dir: string,
    /** Deleted agents are moved here (with their memory) instead of being erased. */
    private readonly trashDir: string,
  ) {
    super();
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const agents = new Map<string, Agent>();
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !AGENT_NAME.test(entry.name) || RESERVED_NAMES.has(entry.name)) continue;
      try {
        const agent = await this.read(entry.name);
        if (agent) agents.set(agent.def.name, agent);
      } catch (err) {
        log.warn({ err: (err as Error).message, agent: entry.name }, 'skipping invalid agent');
      }
    }
    // Swap at once so lookups during a reload never see a half-loaded registry.
    this.agents = agents;
    log.debug({ count: agents.size }, 'agents loaded');
    this.emit('changed', '*');
  }

  private async read(name: string): Promise<Agent | undefined> {
    const dir = join(this.dir, name);
    const raw = await readJson<unknown>(join(dir, 'agent.json'), undefined);
    if (raw === undefined) return undefined;
    const def = agentSchema.parse(raw);
    if (def.name !== name) throw new Error(`agent.json name "${def.name}" does not match folder "${name}"`);
    const prompt = await readFile(join(dir, 'prompt.md'), 'utf8').catch(() => '');
    return { def, prompt, dir };
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  get(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  /** Validates without saving. */
  parse(input: AgentInput): AgentDefinition {
    return agentSchema.parse(input);
  }

  async save(input: AgentInput, prompt: string): Promise<Agent> {
    const existing = this.agents.get(input.name);
    if (!existing && RESERVED_NAMES.has(input.name)) throw new Error(`"${input.name}" is a reserved name`);
    const now = new Date().toISOString();
    const def = agentSchema.parse({ ...input, createdAt: existing?.def.createdAt ?? now, updatedAt: now });
    const dir = join(this.dir, def.name);
    await mkdir(join(dir, 'workspace'), { recursive: true });
    if (def.memory.notes) await mkdir(join(dir, 'memory'), { recursive: true });
    await writeJsonAtomic(join(dir, 'agent.json'), def);
    await writeFile(join(dir, 'prompt.md'), prompt.endsWith('\n') ? prompt : prompt + '\n');
    const agent = { def, prompt, dir };
    this.agents.set(def.name, agent);
    this.emit('changed', def.name);
    return agent;
  }

  async delete(name: string): Promise<void> {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`no agent named "${name}"`);
    await mkdir(this.trashDir, { recursive: true });
    await rename(agent.dir, join(this.trashDir, `${name}-${Date.now()}`));
    this.agents.delete(name);
    this.emit('changed', name);
  }
}
