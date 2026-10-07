import type { Sql } from '../../db/db.ts';
import type { ConnectorRuntime } from '../types.ts';
import { log } from '../../log.ts';
import * as collect from './collect.ts';
import { DEFAULT_CONFIG, emptyMemory, evaluate, step, targetMatches, type AlertState, type Finding, type Memory, type MonitorConfig, type Snapshot } from './rules.ts';

const SLOW_EVERY_MS = 5 * 60_000; // docker stats
const TLS_EVERY_MS = 6 * 3600_000;
const RETENTION_DAYS = 30;

type Mutes = Record<string, number>;

/** Deep merge of stored settings over the defaults, so new settings get their default. */
function withDefaults(stored: Partial<MonitorConfig> | undefined): MonitorConfig {
  const out = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(stored ?? {})) {
    const d = out[k];
    out[k] = d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v) ? { ...d, ...v } : v;
  }
  return out as unknown as MonitorConfig;
}

/**
 * Watches the server without any LLM: every interval it samples the system, pm2, Docker and
 * HTTP checks (certificates less often), stores metrics, and turns problems into
 * alerts. Opening and resolving alerts emits "vps" events, which wake the agents listening to them.
 */
export class VpsMonitor {
  config: MonitorConfig = DEFAULT_CONFIG;
  last?: Snapshot;
  private states = new Map<string, AlertState>();
  private memory: Memory = emptyMemory();
  private mutes: Mutes = {};
  private timer?: NodeJS.Timeout;
  private running = false;
  private slowAt = 0;
  private tlsAt = 0;
  private purgeAt = 0;
  private hosts: string[] = [];
  private tlsCache: collect.TlsResult[] = [];
  private statsCache = new Map<string, { cpuPct?: number; memoryMb?: number }>();
  private runtime?: ConnectorRuntime;

  constructor(
    private readonly sql: Sql,
  ) {}

  private async load<T>(key: string): Promise<T | undefined> {
    const [row] = await this.sql<{ value: T }[]>`select value from connector_state where connector = 'vps' and key = ${key}`;
    return row?.value;
  }

  private async save(key: string, value: unknown): Promise<void> {
    await this.sql`
      insert into connector_state (connector, key, value) values ('vps', ${key}, ${this.sql.json(value as never)})
      on conflict (connector, key) do update set value = excluded.value, updated_at = now()`;
  }

  async start(runtime: ConnectorRuntime): Promise<void> {
    this.runtime = runtime;
    this.config = withDefaults(await this.load('config'));
    this.memory = { ...emptyMemory(), ...(await this.load<Memory>('memory')) };
    this.mutes = (await this.load<Mutes>('mutes')) ?? {};
    for (const s of (await this.load<AlertState[]>('alerts')) ?? []) this.states.set(s.id, s);
    const loop = async () => {
      await this.tick().catch((err) => log.error({ err }, 'vps: check failed'));
      if (this.runtime) this.timer = setTimeout(loop, this.config.intervalSec * 1000);
    };
    void loop();
    log.info({ intervalSec: this.config.intervalSec }, 'vps: monitor started');
  }

  async stop(): Promise<void> {
    this.runtime = undefined;
    clearTimeout(this.timer);
  }

  /** One check. Concurrent calls (a tool asking for fresh data) share the running one. */
  private pending?: Promise<Snapshot>;
  async tick(): Promise<Snapshot> {
    if (this.running && this.pending) return this.pending;
    this.running = true;
    this.pending = this.check().finally(() => (this.running = false));
    return this.pending;
  }

  /** The latest snapshot, taken now when older than `maxAgeMs`. */
  async snapshot(maxAgeMs = 30_000): Promise<Snapshot> {
    if (this.last && Date.now() - this.last.at < maxAgeMs) return this.last;
    return this.tick();
  }

  private async check(): Promise<Snapshot> {
    const now = Date.now();
    const errors: Record<string, string> = {};
    const attempt = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (err) {
        errors[name] = (err as Error).message.split('\n')[0]!.slice(0, 300);
        return undefined;
      }
    };
    const slow = now - this.slowAt >= SLOW_EVERY_MS;
    if (now - this.tlsAt >= TLS_EVERY_MS && this.config.discoverTraefik) {
      this.tlsAt = now;
      this.hosts = (await attempt('traefik', () => collect.traefikHosts())) ?? this.hosts;
      this.tlsCache = await Promise.all(this.hosts.map((h) => collect.tlsCheck(h)));
    }
    const checks = [...this.config.http, ...(this.config.discoverTraefik ? this.hosts.map((h) => ({ name: h, url: `https://${h}/` })) : [])];
    const [system, pm2, containers, http] = await Promise.all([
      attempt('system', () => collect.system()),
      attempt('pm2', () => collect.pm2()),
      attempt('docker', () => collect.containers(slow)),
      Promise.all(checks.map((c) => collect.httpCheck(c.name, c.url))),
    ]);
    if (slow) {
      this.slowAt = now;
      if (containers) this.statsCache = new Map(containers.map((c) => [c.name, { cpuPct: c.cpuPct, memoryMb: c.memoryMb }]));
    } else if (containers) {
      for (const c of containers) Object.assign(c, this.statsCache.get(c.name));
    }

    const snap: Snapshot = { at: now, system, pm2, containers, http, tls: this.tlsCache, errors };
    this.last = snap;
    await this.record(snap);

    const findings = evaluate(snap, this.memory, this.config);
    const transitions = step(this.states, findings, now, (f) => this.isMuted(f));
    for (const s of [...transitions.opened, ...transitions.escalated]) {
      const kind = transitions.opened.includes(s) ? 'opened' : 'escalated';
      this.runtime?.emit({ source: 'vps', name: 'alert', summary: `${s.severity}: ${s.title}`, data: { ...this.alertData(s), kind } });
    }
    for (const s of transitions.resolved) {
      const minutes = Math.round((now - (s.openedAt ?? now)) / 60_000);
      this.runtime?.emit({ source: 'vps', name: 'resolved', summary: `resolved after ${minutes} min: ${s.title}`, data: { ...this.alertData(s), minutes } });
    }
    await this.save('alerts', [...this.states.values()]);
    await this.save('memory', this.memory);
    return snap;
  }

  private alertData(s: AlertState) {
    return { id: s.id, severity: s.severity, title: s.title, detail: s.detail, target: s.target, openedAt: s.openedAt ? new Date(s.openedAt).toISOString() : undefined };
  }

  /** One metrics row per check; old rows are purged once an hour. */
  private async record(snap: Snapshot): Promise<void> {
    const s = snap.system;
    const data = {
      cpu: s?.cpuPct ?? null,
      load: s?.load ?? null,
      cores: s?.cores ?? null,
      mem: s?.memUsedPct ?? null,
      memAvailableMb: s?.memAvailableMb ?? null,
      swap: s?.swapUsedPct ?? null,
      disks: Object.fromEntries((s?.disks ?? []).map((d) => [d.mount, d.usedPct])),
      pm2: snap.pm2 ? { online: snap.pm2.filter((p) => p.status === 'online').length, total: snap.pm2.length, memoryMb: snap.pm2.reduce((a, p) => a + p.memoryMb, 0) } : null,
      docker: snap.containers ? { running: snap.containers.filter((c) => c.state === 'running').length, total: snap.containers.length } : null,
      httpFailing: snap.http.filter((h) => !h.ok).map((h) => h.name),
    };
    await this.sql`insert into metrics (at, data) values (${new Date(snap.at)}, ${this.sql.json(data)}) on conflict do nothing`;
    if (snap.at - this.purgeAt > 3600_000) {
      this.purgeAt = snap.at;
      await this.sql`delete from metrics where at < now() - make_interval(days => ${RETENTION_DAYS})`;
      await this.sql`delete from events where at < now() - make_interval(days => 90)`;
    }
  }

  // ── State for tools ────────────────────────────────────────────────────────────

  openAlerts(): AlertState[] {
    return [...this.states.values()].filter((s) => s.open).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  }

  isMuted(f: Pick<Finding, 'id' | 'target'>): boolean {
    const now = Date.now();
    return Object.entries(this.mutes).some(([pattern, until]) => until > now && (pattern === f.id || targetMatches([pattern], f.target)));
  }

  mutesList(): { pattern: string; until: string }[] {
    const now = Date.now();
    return Object.entries(this.mutes)
      .filter(([, until]) => until > now)
      .map(([pattern, until]) => ({ pattern, until: new Date(until).toISOString() }));
  }

  async mute(pattern: string, hours: number): Promise<string> {
    const until = Date.now() + hours * 3600_000;
    for (const [p, u] of Object.entries(this.mutes)) if (u <= Date.now()) delete this.mutes[p];
    this.mutes[pattern] = until;
    await this.save('mutes', this.mutes);
    return new Date(until).toISOString();
  }

  async unmute(pattern: string): Promise<boolean> {
    const had = pattern in this.mutes;
    delete this.mutes[pattern];
    await this.save('mutes', this.mutes);
    return had;
  }

  async configure(changes: Partial<MonitorConfig>): Promise<MonitorConfig> {
    const next = withDefaults({ ...this.config, ...changes } as Partial<MonitorConfig>);
    next.intervalSec = Math.min(Math.max(next.intervalSec, 30), 600);
    this.config = next;
    await this.save('config', next);
    // New HTTP hosts and certificate checks are picked up on the next check.
    this.tlsAt = 0;
    return next;
  }

  /** Hourly averages and peaks of the main metrics. */
  async history(hours: number): Promise<Record<string, unknown>[]> {
    return this.sql`
      select to_char(date_trunc('hour', at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:00"Z"') as hour,
        round(avg((data->>'cpu')::numeric), 1) as cpu_avg, round(max((data->>'cpu')::numeric), 1) as cpu_max,
        round(avg((data->'load'->>1)::numeric), 2) as load5_avg, round(max((data->'load'->>1)::numeric), 2) as load5_max,
        round(avg((data->>'mem')::numeric), 1) as mem_avg, round(max((data->>'mem')::numeric), 1) as mem_max,
        round(max((data->>'swap')::numeric), 1) as swap_max,
        (array_agg(data->'disks' order by at desc))[1] as disks,
        max(jsonb_array_length(coalesce(data->'httpFailing', '[]'::jsonb))) as http_failing_max
      from metrics where at > now() - make_interval(hours => ${hours})
      group by 1 order by 1`;
  }
}
