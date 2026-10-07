/** Sliding-window limits per key, e.g. at most 10 a minute and 60 an hour. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly longest: number;

  constructor(private readonly limits: { windowMs: number; max: number }[]) {
    this.longest = Math.max(...limits.map((l) => l.windowMs));
  }

  /** Records a hit and returns true, or returns false (recording nothing) when a limit is reached. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.longest);
    for (const { windowMs, max } of this.limits) {
      if (recent.filter((t) => now - t < windowMs).length >= max) {
        this.hits.set(key, recent);
        return false;
      }
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
