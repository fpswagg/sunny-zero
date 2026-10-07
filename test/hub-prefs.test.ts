import { describe, expect, it } from 'vitest';
import { cleanOrder, orderByPref, resolveMain } from '../src/manage/hub-prefs.ts';

const items = ['sunny', 'builder', 'atlas', 'watcher'].map((name) => ({ name }));
describe('hub prefs', () => {
  it('puts saved agents first, new ones after in their usual order, ignores deleted ones', () => {
    expect(orderByPref(items, ['watcher', 'gone', 'sunny']).map((x) => x.name)).toEqual(['watcher', 'sunny', 'builder', 'atlas']);
    expect(orderByPref(items, undefined).map((x) => x.name)).toEqual(['sunny', 'builder', 'atlas', 'watcher']);
  });
  it('main falls back to nothing (first agent) when it no longer exists', () => {
    expect(resolveMain(['sunny', 'builder'], 'builder')).toBe('builder');
    expect(resolveMain(['sunny', 'builder'], 'gone')).toBeUndefined();
    expect(resolveMain(['sunny'], null)).toBeUndefined();
  });
  it('cleans an order before saving', () => {
    expect(cleanOrder(['a', 'b', 'c'], ['c', 'x', 'c', 'a'])).toEqual(['c', 'a', 'b']);
  });
});
