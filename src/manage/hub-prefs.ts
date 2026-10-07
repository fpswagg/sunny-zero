/** Settings keys: the order of the agents in the hub and Mini App, and the one the hub opens on. */
export const HUB_ORDER_KEY = 'hub_order';
export const HUB_MAIN_KEY = 'hub_main';

/** Saved order first; agents it does not list (new ones) follow in their usual order; deleted ones are ignored. */
export function orderByPref<T extends { name: string }>(items: T[], order: string[] | undefined): T[] {
  const pos = new Map((order ?? []).map((n, i) => [n, i]));
  return items
    .map((item, i) => ({ item, key: pos.has(item.name) ? pos.get(item.name)! : 1e6 + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}

/** The main agent, or undefined when it is not set or no longer exists (then the hub opens on the first agent). */
export function resolveMain(names: string[], main: string | undefined | null): string | undefined {
  return main && names.includes(main) ? main : undefined;
}

/** A clean order for saving: only known names, no duplicates. */
export function cleanOrder(names: string[], order: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of order) if (names.includes(n) && !seen.has(n)) (seen.add(n), out.push(n));
  for (const n of names) if (!seen.has(n)) out.push(n);
  return out;
}
