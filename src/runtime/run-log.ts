import type { Sql } from '../db/db.ts';

export interface RunEntry {
  agent: string;
  conversation: string;
  /** What started the run: "message", "sunny" (delegated), later "cron" and events. */
  origin: string;
  message: string;
  reply: string;
  isError: boolean;
  costUsd?: number;
  durationMs: number;
  sessionId?: string;
  /** "openai:gpt-5.5", or the Claude model on the subscription. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface UsageRow {
  agent: string;
  model: string | null;
  runs: number;
  errors: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  lastAt: Date;
}

/** One row per agent turn, for Sunny's agent_runs tool and later the web UI. */
export class RunLog {
  constructor(private readonly sql: Sql) {}

  async append(e: RunEntry): Promise<void> {
    await this.sql`
      insert into runs (agent, conversation, origin, message, reply, is_error, cost_usd, duration_ms, session_id, model, input_tokens, output_tokens)
      values (${e.agent}, ${e.conversation}, ${e.origin}, ${e.message.slice(0, 2000)}, ${e.reply.slice(0, 4000)}, ${e.isError},
              ${e.costUsd ?? null}, ${Math.round(e.durationMs)}, ${e.sessionId ?? null}, ${e.model ?? null}, ${e.inputTokens ?? null}, ${e.outputTokens ?? null})`;
  }

  /** Model fallbacks and agent calls, newest first in `activities`. */
  async activity(kind: 'fallback' | 'agent_call', agent: string, detail: string, opts: { other?: string; ok?: boolean } = {}): Promise<void> {
    await this.sql`insert into activity (kind, agent, other, detail, ok) values (${kind}, ${agent}, ${opts.other ?? null}, ${detail.slice(0, 1500)}, ${opts.ok ?? true})`;
  }

  async activities(opts: { kind?: string; agent?: string; limit?: number } = {}): Promise<{ at: Date; kind: string; agent: string; other: string | null; detail: string; ok: boolean }[]> {
    const rows = await this.sql<{ at: Date; kind: string; agent: string; other: string | null; detail: string; ok: boolean }[]>`
      select at, kind, agent, other, detail, ok from activity
      where true ${opts.kind ? this.sql`and kind = ${opts.kind}` : this.sql``} ${opts.agent ? this.sql`and (agent = ${opts.agent} or other = ${opts.agent})` : this.sql``}
      order by at desc, id desc limit ${opts.limit ?? 50}`;
    return rows;
  }

  /** What an agent cost since local midnight in `timezone` (API-equivalent on the subscription). */
  async spentToday(agent: string, timezone: string): Promise<number> {
    const [row] = await this.sql<{ cost: number | null }[]>`
      select sum(cost_usd) as cost from runs
      where agent = ${agent} and at >= (date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone})`;
    return row?.cost ?? 0;
  }

  /** Runs, errors, tokens and cost per agent and model over the last days. Cost on the subscription is what the API would have charged. */
  async usage(days: number, agent?: string): Promise<UsageRow[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.sql<{ agent: string; model: string | null; runs: number; errors: number; cost: number | null; input: number | null; output: number | null; last_at: Date }[]>`
      select agent, model, count(*)::int as runs, count(*) filter (where is_error)::int as errors, sum(cost_usd) as cost,
             sum(input_tokens)::bigint as input, sum(output_tokens)::bigint as output, max(at) as last_at
      from runs where at >= ${since} ${agent ? this.sql`and agent = ${agent}` : this.sql``}
      group by agent, model order by agent, max(at) desc`;
    return rows.map((r) => ({ agent: r.agent, model: r.model, runs: r.runs, errors: r.errors, costUsd: r.cost ?? 0, inputTokens: r.input ?? 0, outputTokens: r.output ?? 0, lastAt: r.last_at }));
  }

  /** Cost and tokens per hour over the last `hours` (oldest first); hours without runs are included as zeros. */
  async usageHourly(hours: number, agent?: string): Promise<{ hour: string; runs: number; costUsd: number; inputTokens: number; outputTokens: number }[]> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.sql<{ hour: Date; runs: number; cost: number | null; input: number | null; output: number | null }[]>`
      select date_trunc('hour', at) as hour, count(*)::int as runs, sum(cost_usd) as cost, sum(input_tokens)::bigint as input, sum(output_tokens)::bigint as output
      from runs where at >= ${since} ${agent ? this.sql`and agent = ${agent}` : this.sql``}
      group by 1 order by 1`;
    const byHour = new Map(rows.map((r) => [r.hour.getTime(), r]));
    const out: { hour: string; runs: number; costUsd: number; inputTokens: number; outputTokens: number }[] = [];
    const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    for (let t = end - (hours - 1) * 3_600_000; t <= end; t += 3_600_000) {
      const r = byHour.get(t);
      out.push({ hour: new Date(t).toISOString(), runs: r?.runs ?? 0, costUsd: r?.cost ?? 0, inputTokens: Number(r?.input ?? 0), outputTokens: Number(r?.output ?? 0) });
    }
    return out;
  }

  /** The latest exchanges of an agent in one conversation, oldest first (the web app's history). */
  async thread(agent: string, conversation: string, limit: number): Promise<{ at: Date; message: string; reply: string; isError: boolean; origin: string }[]> {
    const rows = await this.sql<{ at: Date; message: string; reply: string; is_error: boolean; origin: string }[]>`
      select at, message, reply, is_error, origin from runs
      where agent = ${agent} and conversation = ${conversation} order by at desc, id desc limit ${limit}`;
    return rows.reverse().map((r) => ({ at: r.at, message: r.message, reply: r.reply, isError: r.is_error, origin: r.origin }));
  }

  /** The latest runs of an agent, oldest first. */
  async recent(agent: string, limit: number): Promise<(RunEntry & { at: Date })[]> {
    const rows = await this.sql<{ at: Date; agent: string; conversation: string; origin: string; message: string; reply: string; is_error: boolean; cost_usd: number | null; duration_ms: number; session_id: string | null; model: string | null; input_tokens: number | null; output_tokens: number | null }[]>`
      select at, agent, conversation, origin, message, reply, is_error, cost_usd, duration_ms, session_id, model, input_tokens, output_tokens
      from runs where agent = ${agent} order by at desc, id desc limit ${limit}`;
    return rows.reverse().map((r) => ({
      at: r.at,
      agent: r.agent,
      conversation: r.conversation,
      origin: r.origin,
      message: r.message,
      reply: r.reply,
      isError: r.is_error,
      costUsd: r.cost_usd ?? undefined,
      durationMs: r.duration_ms,
      sessionId: r.session_id ?? undefined,
      model: r.model ?? undefined,
      inputTokens: r.input_tokens ?? undefined,
      outputTokens: r.output_tokens ?? undefined,
    }));
  }
}
