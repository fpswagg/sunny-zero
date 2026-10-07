import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.ts';
import { privilegedReasons, agentSchema } from '../src/agents/schema.ts';
import { SessionStore } from '../src/runtime/sessions.ts';

describe('AgentRegistry', () => {
  it('saves, reloads, and trashes agents', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sunny-reg-'));
    const reg = new AgentRegistry(join(base, 'agents'), join(base, 'trash'));
    await reg.load();
    const a = await reg.save({ name: 'mail-digest', description: 'Summarizes mail', memory: { notes: true } }, 'You summarize mail.');
    expect(a.def.access.profile).toBe('restricted');
    expect(a.def.triggers).toEqual([{ type: 'manual' }]);
    expect(existsSync(join(a.dir, 'memory'))).toBe(true);
    expect(readFileSync(join(a.dir, 'prompt.md'), 'utf8')).toBe('You summarize mail.\n');

    const fresh = new AgentRegistry(join(base, 'agents'), join(base, 'trash'));
    await fresh.load();
    expect(fresh.get('mail-digest')?.prompt).toBe('You summarize mail.\n');

    await fresh.delete('mail-digest');
    expect(fresh.get('mail-digest')).toBeUndefined();
    expect(existsSync(join(base, 'agents', 'mail-digest'))).toBe(false);
  });

  it('refuses reserved names and skips invalid folders', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sunny-reg-'));
    const reg = new AgentRegistry(join(base, 'agents'), join(base, 'trash'));
    await reg.load();
    await expect(reg.save({ name: 'sunny', description: 'x' }, 'x')).rejects.toThrow(/reserved/);
    mkdirSync(join(base, 'agents', 'broken'));
    writeFileSync(join(base, 'agents', 'broken', 'agent.json'), '{"name":"broken"}');
    await reg.load();
    expect(reg.list()).toEqual([]);
  });
});

describe('privilegedReasons', () => {
  it('flags only access beyond restricted', () => {
    expect(privilegedReasons(agentSchema.parse({ name: 'ab', description: 'x' }))).toEqual([]);
    expect(privilegedReasons(agentSchema.parse({ name: 'ab', description: 'x', access: { profile: 'workspace', workdir: '/p' } }))).toEqual(['access to /p']);
    expect(privilegedReasons(agentSchema.parse({ name: 'ab', description: 'x', access: { autoApprove: ['Bash'] } }))).toHaveLength(1);
  });
});

describe('SessionStore.key', () => {
  it('follows the memory mode', () => {
    const def = (session: 'none' | 'conversation' | 'shared') => agentSchema.parse({ name: 'ab', description: 'x', memory: { session } });
    expect(SessionStore.key(def('none'), 'cli:x')).toBeUndefined();
    expect(SessionStore.key(def('conversation'), 'cli:x')).toBe('ab::cli:x');
    expect(SessionStore.key(def('shared'), 'cli:x')).toBe('ab::*');
  });
});
