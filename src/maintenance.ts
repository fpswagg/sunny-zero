import type { Sql } from './db/db.ts';
import { log } from './log.ts';

export const UPTIME_RESTART_MS = 24 * 3_600_000;
export const IDLE_BEFORE_RESTART_MS = 3_600_000;
export const SESSION_IDLE_DAYS = 7;

export interface MaintenanceDeps {
  sql: Sql;
  timezone: string;
  /** A turn or a background run is in progress. */
  busy: () => boolean;
  /** Ends the process cleanly; pm2 starts it again. */
  restart: () => void;
  /** Hour of the day (0-23, in `timezone`) from which a restart is allowed. */
  hour?: number;
  now?: () => Date;
  uptimeMs?: () => number;
}

/** The hour of `date` in `zone`. */
export function hourIn(date: Date, zone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: zone }).format(date));
}

/**
 * Daily housekeeping. Sessions nobody used for a week start fresh next time. Sunny restarts itself once, at the
 * set hour, when it has been up for 24 h and nothing has run for an hour (parked and interrupted runs resume).
 */
export class Maintenance {
  private timer?: NodeJS.Timeout;
  constructor(private readonly deps: MaintenanceDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick().catch((err) => log.warn({ err }, 'maintenance failed')), 5 * 60_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<'restart' | 'idle'> {
    const { sql, now = () => new Date(), uptimeMs = () => process.uptime() * 1000 } = this.deps;
    const dropped = await sql`delete from sessions where updated_at < ${new Date(now().getTime() - SESSION_IDLE_DAYS * 86_400_000)} returning key`;
    if (dropped.length) log.info({ count: dropped.length }, 'maintenance: sessions unused for a week start fresh');

    if (uptimeMs() < UPTIME_RESTART_MS || hourIn(now(), this.deps.timezone) !== (this.deps.hour ?? 4) || this.deps.busy()) return 'idle';
    const [last] = await sql<{ at: Date | null }[]>`select max(at) as at from runs`;
    if (last?.at && now().getTime() - last.at.getTime() < IDLE_BEFORE_RESTART_MS) return 'idle';
    log.info('maintenance: up for over 24 h and idle, restarting');
    this.deps.restart();
    return 'restart';
  }
}
