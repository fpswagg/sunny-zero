import { describe, expect, it } from 'vitest';
import type { ClaudeAccount } from '../src/providers/claude-accounts.ts';
import { FALLBACK_KEY, SubscriptionFallback, type AccountsLike, type FallbackState } from '../src/providers/claude-fallback.ts';
import { isModelFailure } from '../src/runtime/runner.ts';

function setup(opts: { mainProbe?: 'ok' | 'dead' | 'unknown' } = {}) {
  let active = 'main';
  let probe: 'ok' | 'dead' | 'unknown' = opts.mainProbe ?? 'dead';
  const acc = (id: string): ClaudeAccount => ({ id, label: `${id}@x.com`, email: `${id}@x.com`, active: active === id, addedAt: '' });
  const calls: string[] = [];
  const accounts: AccountsLike = {
    list: async () => [acc('main'), acc('backup')],
    switchTo: async (w) => {
      calls.push(`switch:${w}`);
      active = w;
      return acc(w);
    },
    probe: async () => {
      calls.push('probe');
      return probe;
    },
  };
  const store = new Map<string, unknown>();
  const settings = { get: async <T>(k: string) => store.get(k) as T | undefined, set: async (k: string, v: unknown) => void store.set(k, v) };
  let t = 1_000_000;
  let mainRef = 'main@x.com';
  const msgs: string[] = [];
  const fb = new SubscriptionFallback(accounts, settings, async () => mainRef, () => t, (m) => msgs.push(m));
  return { setMain: (m: string) => (mainRef = m), fb, calls, store, msgs, active: () => active, setProbe: (p: typeof probe) => (probe = p), tick: (ms: number) => (t += ms) };
}

describe('SubscriptionFallback', () => {
  it('switches to the other account on an auth failure and records it', async () => {
    const s = setup();
    expect(await s.fb.onFailure('API Error: 403 forbidden')).toBe(true);
    expect(s.active()).toBe('backup');
    const st = s.store.get(FALLBACK_KEY) as FallbackState;
    expect(st.current).toBe('backup');
    expect(st.accounts.main?.lastFail).toBeTruthy();
    expect(s.msgs[0]).toMatch(/main@x.com failed/);
  });

  it('also switches when the plan limit is reached, and keeps when it resets', async () => {
    const s = setup();
    expect(await s.fb.onFailure("You've hit your limit · resets 3pm")).toBe(true);
    const st = s.store.get(FALLBACK_KEY) as FallbackState;
    expect(st.accounts.main?.resetHint).toBe('3pm');
    expect(s.msgs[0]).toMatch(/resets 3pm/);
  });

  it('ignores errors that are not about the login', async () => {
    const s = setup();
    expect(await s.fb.onFailure('the agent made a mistake')).toBe(false);
    expect(s.active()).toBe('main');
  });

  it('does not flip-flop when both accounts fail', async () => {
    const s = setup();
    expect(await s.fb.onFailure('401 unauthorized')).toBe(true);
    expect(await s.fb.onFailure('401 unauthorized')).toBe(false);
    expect(s.active()).toBe('backup');
    s.tick(120_000);
    expect(await s.fb.onFailure('401 unauthorized')).toBe(true);
  });

  it('stays on the account it switched to: nothing is probed and there is no going back', async () => {
    const s = setup();
    await s.fb.onFailure('403 forbidden');
    s.setProbe('ok');
    s.tick(10 * 60_000);
    await s.fb.beforeRun();
    expect(s.active()).toBe('backup');
    expect(s.calls.filter((c) => c === 'probe')).toHaveLength(0);
  });

  it('keeps switching on to the next account when the new one fails later', async () => {
    const s = setup();
    await s.fb.onFailure('403 forbidden');
    s.tick(5 * 60_000);
    expect(await s.fb.onFailure('403 forbidden')).toBe(true);
    expect(s.active()).toBe('main');
  });
});

describe('real limit messages', () => {
  it.each([
    "You've hit your session limit · resets 3:40pm (UTC)",
    "You've hit your weekly limit · resets Oct 12",
    "You've hit your limit · resets 3pm",
    'Claude AI usage limit reached|1760000000',
    'The subscription login has expired',
  ])('switches account on: %s', (text) => {
    expect(SubscriptionFallback.isFailure(text)).toBe(true);
    expect(isModelFailure(text)).toBe(true);
  });
});
