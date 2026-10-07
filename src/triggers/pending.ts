import type { Sql } from '../db/db.ts';

/** Where a background run stands. `running` rows left over at startup were cut off by a restart. */
export interface PendingTask {
  id: number;
  agent: string;
  message: string;
  origin: string;
  status: 'running' | 'waiting';
  createdAt: Date;
  /** When to try again, if the limit said when it resets. */
  resumeAfter: Date | null;
  /** What the models/accounts looked like when the run gave up: a change means another attempt is worth it. */
  signature: string | null;
  reason: string | null;
  attempts: number;
}

interface Row {
  id: number;
  agent: string;
  message: string;
  origin: string;
  status: 'running' | 'waiting';
  created_at: Date;
  resume_after: Date | null;
  signature: string | null;
  reason: string | null;
  attempts: number;
}

const toTask = (r: Row): PendingTask => ({ id: r.id, agent: r.agent, message: r.message, origin: r.origin, status: r.status, createdAt: r.created_at, resumeAfter: r.resume_after, signature: r.signature, reason: r.reason, attempts: r.attempts });

/**
 * Background runs (cron, events) that have not finished. A run is recorded when it starts and removed when it
 * ends. If Sunny restarts meanwhile, the row stays and the run starts again. If every model hit a limit, the row
 * is parked as `waiting` until the limit resets or the models / Claude account change.
 */
export class PendingTasks {
  constructor(private readonly sql: Sql) {}

  async begin(agent: string, message: string, origin: string): Promise<number> {
    const [row] = await this.sql<{ id: number }[]>`insert into pending_tasks (agent, message, origin) values (${agent}, ${message}, ${origin}) returning id`;
    return row!.id;
  }

  async finish(id: number): Promise<void> {
    await this.sql`delete from pending_tasks where id = ${id}`;
  }

  async wait(id: number, opts: { resumeAfter: Date | null; signature: string; reason: string }): Promise<void> {
    await this.sql`update pending_tasks set status = 'waiting', resume_after = ${opts.resumeAfter}, signature = ${opts.signature}, reason = ${opts.reason.slice(0, 500)} where id = ${id}`;
  }

  /** Marks a task as running again (one more attempt). Returns false if it vanished meanwhile. */
  async restart(id: number): Promise<boolean> {
    const rows = await this.sql`update pending_tasks set status = 'running', attempts = attempts + 1 where id = ${id} returning id`;
    return rows.length > 0;
  }

  /** A chat turn starts: remembered until it ends, so a restart can pick it up. */
  async openTurn(conversationId: string, agent: string, speaker: unknown, resumes: number): Promise<number> {
    const [row] = await this.sql<{ id: number }[]>`insert into open_turns (conversation_id, agent, speaker, resumes) values (${conversationId}, ${agent}, ${this.sql.json(speaker as never)}, ${resumes}) returning id`;
    return row!.id;
  }

  async closeTurn(id: number): Promise<void> {
    await this.sql`delete from open_turns where id = ${id}`;
  }

  /** Turns cut off by a restart (started before `before`), removed as they are returned. */
  async takeCutTurns(before: Date): Promise<{ conversationId: string; agent: string; speaker: unknown; resumes: number; startedAt: Date }[]> {
    const rows = await this.sql<{ conversation_id: string; agent: string; speaker: unknown; resumes: number; started_at: Date }[]>`
      delete from open_turns where started_at < ${before} returning conversation_id, agent, speaker, resumes, started_at`;
    return rows.map((r) => ({ conversationId: r.conversation_id, agent: r.agent, speaker: r.speaker, resumes: r.resumes, startedAt: r.started_at }));
  }

  async list(status?: 'running' | 'waiting'): Promise<PendingTask[]> {
    const rows = await this.sql<Row[]>`select * from pending_tasks ${status ? this.sql`where status = ${status}` : this.sql``} order by id`;
    return rows.map(toTask);
  }
}

/** Offset (ms) of `timeZone` from UTC at the instant `at`. */
function zoneOffset(at: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at / 1000) * 1000;
}

const validZone = (z: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

/**
 * When a limit message says the limit resets: "resets 4:20am (UTC)", "resets 3pm", "resets in 2 hours".
 * Clock times without a zone are read in `defaultZone`. Returns the next such moment, or undefined if the text
 * does not say.
 */
export function parseResetTime(text: string, now: Date, defaultZone: string): Date | undefined {
  const rel = text.match(/resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (rel && (rel[1] || rel[2])) return new Date(now.getTime() + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000);
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (!ampm && !m[2]) return undefined; // a bare number is not a time
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const zoneText = m[4]?.trim();
  const zone = zoneText && /^(utc|gmt)$/i.test(zoneText) ? 'UTC' : zoneText && validZone(zoneText) ? zoneText : defaultZone;
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number);
  const at = (dayShift: number): number => {
    const wall = Date.UTC(local[0]!, local[1]! - 1, local[2]! + dayShift, hour, minute);
    const first = wall - zoneOffset(wall, zone);
    return wall - zoneOffset(first, zone);
  };
  let t = at(0);
  if (t <= now.getTime()) t = at(1);
  return new Date(t);
}
