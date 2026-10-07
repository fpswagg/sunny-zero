import { Cron } from 'croner';
import type { AgentRegistry } from '../agents/registry.ts';
import { log } from '../log.ts';

/** Scheduled runs more often than this cost too much: use an event trigger instead. */
const MIN_INTERVAL_MS = 5 * 60_000;

/** Why a cron expression cannot be used, or undefined when it is fine. */
export function cronProblem(schedule: string, timezone?: string): string | undefined {
  let runs: Date[];
  try {
    const job = new Cron(schedule, { paused: true, timezone });
    // A bad timezone only fails when the next runs are computed.
    runs = job.nextRuns(3);
    job.stop();
  } catch (err) {
    return `invalid schedule "${schedule}"${timezone ? ` in ${timezone}` : ''}: ${(err as Error).message.split('.')[0]}`;
  }
  const [a, b, c] = runs;
  if (!a) return `"${schedule}" never runs`;
  if (b && c && Math.min(b.getTime() - a.getTime(), c.getTime() - b.getTime()) < MIN_INTERVAL_MS) {
    return `"${schedule}" runs more often than every 5 minutes; use an event trigger for frequent checks`;
  }
  return undefined;
}

interface Job {
  key: string;
  cron: Cron;
}

/**
 * Runs agents' cron triggers. Follows the registry: jobs are added, changed and removed as
 * agents are. A run that is still going when its next time comes is skipped.
 */
export class Scheduler {
  private jobs = new Map<string, Job>();
  private busy = new Set<string>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly run: (agent: string, prompt: string, origin: string) => Promise<unknown>,
    private readonly timezone: string,
  ) {
    registry.on('changed', () => this.sync());
  }

  sync(): void {
    const wanted = new Map<string, { key: string; agent: string; schedule: string; timezone: string; prompt: string }>();
    for (const { def } of this.registry.list()) {
      if (!def.enabled) continue;
      def.triggers.forEach((t, i) => {
        if (t.type !== 'cron') return;
        const timezone = t.timezone ?? this.timezone;
        wanted.set(`${def.name}#${i}`, { key: JSON.stringify([t.schedule, timezone, t.prompt]), agent: def.name, schedule: t.schedule, timezone, prompt: t.prompt });
      });
    }
    for (const [id, job] of this.jobs) {
      if (wanted.get(id)?.key === job.key) continue;
      job.cron.stop();
      this.jobs.delete(id);
    }
    for (const [id, w] of wanted) {
      if (this.jobs.has(id)) continue;
      try {
        const cron = new Cron(w.schedule, { timezone: w.timezone, name: id }, () => this.fire(id, w.agent, w.prompt, w.schedule));
        this.jobs.set(id, { key: w.key, cron });
        log.info({ agent: w.agent, schedule: w.schedule, timezone: w.timezone, next: cron.nextRun()?.toISOString() }, 'schedule set');
      } catch (err) {
        log.warn({ agent: w.agent, schedule: w.schedule, err: (err as Error).message }, 'invalid schedule ignored');
      }
    }
  }

  private fire(id: string, agent: string, prompt: string, schedule: string): void {
    if (this.busy.has(id)) {
      log.warn({ agent, schedule }, 'previous scheduled run still going, skipped');
      return;
    }
    this.busy.add(id);
    log.info({ agent, schedule }, 'scheduled run');
    this.run(agent, prompt, `cron ${schedule}`)
      .catch((err) => log.error({ err, agent }, 'scheduled run failed'))
      .finally(() => this.busy.delete(id));
  }

  /** Upcoming runs of an agent's schedules. */
  upcoming(agent: string): { schedule: string; next: Date | null }[] {
    return [...this.jobs.entries()].filter(([id]) => id.startsWith(`${agent}#`)).map(([, job]) => ({ schedule: job.cron.getPattern() ?? '', next: job.cron.nextRun() }));
  }

  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }
}
