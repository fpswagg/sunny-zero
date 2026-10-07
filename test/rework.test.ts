import { describe, expect, it } from 'vitest';
import { isModelFailure } from '../src/runtime/runner.ts';
import { renderDone, renderLive, elapsed, iconOf } from '../src/telegram/console.ts';
import { Approvals } from '../src/gateway/approvals.ts';
import type { Outbound } from '../src/gateway/types.ts';

describe('isModelFailure', () => {
  it('spots provider failures', () => {
    for (const t of ["You've hit your limit · resets 5pm", 'API Error: 529 overloaded', 'rate limit exceeded', 'Invalid API key', 'fetch failed']) expect(isModelFailure(t)).toBe(true);
  });
  it('ignores ordinary agent errors', () => {
    expect(isModelFailure('The file does not exist.')).toBe(false);
  });
});

describe('console card', () => {
  const steps = [
    { agent: 'watcher', text: 'Read: /a/b.ts', kind: 'tool' as const },
    { agent: 'watcher', text: 'Bash: git status', kind: 'tool' as const },
  ];
  it('renders live and done', () => {
    const live = renderLive('watcher', steps, 0, 65_000);
    expect(live).toContain('1m05');
    expect(live).toContain('2 steps');
    expect(live).toContain('▸ 💻');
    expect(renderDone('watcher', steps, 0, true, 5000)).toContain('<blockquote expandable>');
    expect(elapsed(3_700_000)).toBe('1h01');
    expect(iconOf({ agent: 'x', text: 'vps.status', kind: 'tool' })).toBe('🖥');
  });
});

describe('approvals always', () => {
  it('remembers an always answer and skips the next ask', async () => {
    const keys = new Set<string>();
    const sent: Outbound[] = [];
    const a = new Approvals((_c, e) => sent.push(e), 60_000, { has: async (k) => keys.has(k), add: async (k) => void keys.add(k) });
    const req = { agent: 'a', tool: 'ask_agent', summary: 's', reason: 'r', alwaysKey: 'agent-call:a>b' };
    const p = a.ask('c1', req);
    await new Promise((r) => setTimeout(r, 0));
    const ev = sent.find((e) => e.type === 'approval') as Extract<Outbound, { type: 'approval' }>;
    expect(ev.always).toBe(true);
    a.answer('c1', ev.id, true, true);
    expect(await p).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(keys.has('agent-call:a>b')).toBe(true);
    expect(await a.ask('c1', req)).toBe(true);
    expect(sent.filter((e) => e.type === 'approval')).toHaveLength(1);
  });
});

import { Prefs } from '../src/manage/prefs.ts';
describe('Prefs', () => {
  it('resolves chat > agent > global', async () => {
    const store = new Map<string, unknown>();
    const settings = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))), delete: async () => {} };
    const p = await Prefs.of(settings as never).load();
    expect(p.consoleOn('c', 'watcher')).toBe(true);
    await p.setConsole({ global: true }, false);
    expect(p.consoleOn('c', 'watcher')).toBe(false);
    await p.setConsole({ agent: 'watcher' }, true);
    expect(p.consoleOn('c', 'watcher')).toBe(true);
    expect(p.consoleOn('c', 'builder')).toBe(false);
    await p.setConsole({ chat: 'c' }, false);
    expect(p.consoleOn('c', 'watcher')).toBe(false);
    await p.setConsole({ agent: 'watcher' }, null);
    expect(p.consoleAgent('watcher')).toBeUndefined();
    await p.setVoiceLight('sunny', false);
    expect(p.voiceLight('sunny')).toBe(false);
  });
});

describe('Budgets and quiet hours', () => {
  const mk = () => {
    const store = new Map<string, unknown>();
    return { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))), delete: async () => {} };
  };
  it('falls back to the default budget and clamps', async () => {
    const p = await Prefs.of(mk() as never).load();
    expect(p.budget('builder')).toBeUndefined();
    await p.setBudget('*', { dailyUsd: 5, block: false });
    expect(p.budget('builder')?.dailyUsd).toBe(5);
    await p.setBudget('builder', { dailyUsd: 20000, block: true });
    expect(p.budget('builder')).toEqual({ dailyUsd: 10000, block: true });
    await p.setBudget('builder', null);
    expect(p.budget('builder')?.dailyUsd).toBe(5);
  });
  it('quiet window crosses midnight', async () => {
    const p = await Prefs.of(mk() as never).load();
    expect(p.isQuiet('UTC', new Date('2026-01-01T23:00:00Z'))).toBe(false);
    await p.setQuiet({ enabled: true, from: '22:00', to: '07:00' });
    expect(p.isQuiet('UTC', new Date('2026-01-01T23:00:00Z'))).toBe(true);
    expect(p.isQuiet('UTC', new Date('2026-01-01T03:00:00Z'))).toBe(true);
    expect(p.isQuiet('UTC', new Date('2026-01-01T12:00:00Z'))).toBe(false);
    await expect(p.setQuiet({ from: '25:00' })).rejects.toThrow();
  });
});
