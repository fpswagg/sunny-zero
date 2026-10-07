import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentSchema } from '../src/agents/schema.ts';
import { problems } from '../src/sunny/tools.ts';

const dir = join(import.meta.dirname, '..', 'agents');
const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

describe('agents checked into the repo', () => {
  it.each(names)('%s has a valid definition, a prompt and an icon', (name) => {
    const def = agentSchema.parse(JSON.parse(readFileSync(join(dir, name, 'agent.json'), 'utf8')));
    expect(def.name).toBe(name);
    // Folders that only exist on the production server are not this test's business.
    expect(problems(def, 'UTC').filter((p) => !p.endsWith('does not exist'))).toEqual([]);
    expect(readFileSync(join(dir, name, 'prompt.md'), 'utf8').length).toBeGreaterThan(200);
    expect(existsSync(join(dir, name, 'icon.svg'))).toBe(true);
  });
});
