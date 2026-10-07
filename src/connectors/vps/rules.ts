import type { Container, HttpResult, Pm2Process, SystemSample, TlsResult } from './collect.ts';

export type Severity = 'warn' | 'critical';

/** Monitor settings, stored in the database and changed by a monitoring agent (configure tool) or by hand. */
export interface MonitorConfig {
  intervalSec: number;
  disk: { warnPct: number; criticalPct: number };
  memory: { warnAvailablePct: number; criticalAvailablePct: number };
  swap: { warnPct: number };
  /** 5-minute load average per core. */
  load: { warnPerCore: number; criticalPerCore: number };
  /** CPU above this for `samples` checks in a row. */
  cpu: { warnPct: number; samples: number };
  /** Restarts of one app or container within `windowMin` minutes. */
  restarts: { warn: number; windowMin: number };
  tls: { warnDays: number; criticalDays: number };
  /** Extra URLs checked every interval. */
  http: { name: string; url: string }[];
  /** Also check the public HTTPS hosts Traefik routes, and their certificates. */
  discoverTraefik: boolean;
  /** Targets never alerted on, as globs: "pm2:worker", "docker:*-https", "disk:/boot*". */
  ignore: string[];
}

export const DEFAULT_CONFIG: MonitorConfig = {
  intervalSec: 60,
  disk: { warnPct: 85, criticalPct: 95 },
  memory: { warnAvailablePct: 10, criticalAvailablePct: 5 },
  swap: { warnPct: 60 },
  load: { warnPerCore: 1.5, criticalPerCore: 3 },
  cpu: { warnPct: 90, samples: 5 },
  restarts: { warn: 3, windowMin: 15 },
  tls: { warnDays: 14, criticalDays: 3 },
  http: [],
  discoverTraefik: true,
  ignore: [],
};

export interface Snapshot {
  at: number;
  system?: SystemSample;
  pm2?: Pm2Process[];
  containers?: Container[];
  http: HttpResult[];
  tls: TlsResult[];
  /** Collectors that failed this time, e.g. { pm2: "spawn pm2 ENOENT" }. */
  errors: Record<string, string>;
}

export interface Finding {
  /** Stable id: the same problem keeps the same id across checks. */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** What it is about, matched by `ignore` and mutes: "pm2:api", "disk:/". */
  target: string;
}

interface Seen {
  status: string;
  /** Was it ever running while watched? Things that were never up are not alerted on. */
  wasUp: boolean;
  restarts: { at: number; count: number }[];
}

/** What evaluation remembers between checks (persisted, so a restart keeps it). */
export interface Memory {
  pm2: Record<string, Seen>;
  docker: Record<string, Seen>;
  cpuHigh: number;
}

export const emptyMemory = (): Memory => ({ pm2: {}, docker: {}, cpuHigh: 0 });

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
export const targetMatches = (patterns: string[], target: string) => patterns.some((p) => glob(p).test(target));

/** Restarts within the window, tracking counts over time (a reset count means the app was recreated). */
function restartBurst(seen: Seen, count: number, now: number, windowMin: number): number {
  const last = seen.restarts.at(-1);
  if (last && count < last.count) seen.restarts = [];
  seen.restarts.push({ at: now, count });
  seen.restarts = seen.restarts.filter((r) => now - r.at <= windowMin * 60_000);
  return count - seen.restarts[0]!.count;
}

/** Turns one snapshot into findings. Updates `memory`. */
export function evaluate(snap: Snapshot, memory: Memory, cfg: MonitorConfig): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => {
    if (!targetMatches(cfg.ignore, f.target)) out.push(f);
  };
  const s = snap.system;

  if (s) {
    for (const d of s.disks) {
      const sev = d.usedPct >= cfg.disk.criticalPct ? 'critical' : d.usedPct >= cfg.disk.warnPct ? 'warn' : undefined;
      if (sev) add({ id: `disk:${d.mount}`, severity: sev, target: `disk:${d.mount}`, title: `Disk ${d.mount} is ${d.usedPct}% full`, detail: `${d.device}, ${d.sizeGb} GB` });
      const isev = (d.inodesPct ?? 0) >= cfg.disk.criticalPct ? 'critical' : (d.inodesPct ?? 0) >= cfg.disk.warnPct ? 'warn' : undefined;
      if (isev) add({ id: `inodes:${d.mount}`, severity: isev, target: `disk:${d.mount}`, title: `Disk ${d.mount} has used ${d.inodesPct}% of its inodes`, detail: 'Too many small files; new files will fail when it reaches 100%.' });
    }
    const available = 100 - s.memUsedPct;
    const msev = available < cfg.memory.criticalAvailablePct ? 'critical' : available < cfg.memory.warnAvailablePct ? 'warn' : undefined;
    if (msev) add({ id: 'memory', severity: msev, target: 'system:memory', title: `Memory is low: ${s.memAvailableMb} MB available (${available.toFixed(1)}%)`, detail: `${s.memTotalMb} MB in total` });
    if (s.swapTotalMb > 0 && s.swapUsedPct >= cfg.swap.warnPct) {
      add({ id: 'swap', severity: 'warn', target: 'system:swap', title: `Swap is ${s.swapUsedPct}% used`, detail: `${s.swapTotalMb} MB of swap; the server is short on memory` });
    }
    const perCore = s.load[1] / s.cores;
    const lsev = perCore >= cfg.load.criticalPerCore ? 'critical' : perCore >= cfg.load.warnPerCore ? 'warn' : undefined;
    if (lsev) add({ id: 'load', severity: lsev, target: 'system:load', title: `Load is high: ${s.load[1]} over 5 min on ${s.cores} cores`, detail: `1/5/15 min: ${s.load.join(' / ')}` });
    memory.cpuHigh = s.cpuPct !== null && s.cpuPct >= cfg.cpu.warnPct ? memory.cpuHigh + 1 : 0;
    if (memory.cpuHigh >= cfg.cpu.samples) {
      add({ id: 'cpu', severity: 'warn', target: 'system:cpu', title: `CPU has been above ${cfg.cpu.warnPct}% for ${memory.cpuHigh} checks`, detail: `now ${s.cpuPct}%` });
    }
  }

  if (snap.pm2) {
    for (const p of snap.pm2) {
      const seen = (memory.pm2[p.name] ??= { status: p.status, wasUp: false, restarts: [] });
      const up = p.status === 'online';
      if (up) seen.wasUp = true;
      seen.status = p.status;
      const target = `pm2:${p.name}`;
      if (!up && seen.wasUp) {
        add({ id: `${target}:down`, severity: p.status === 'stopped' ? 'warn' : 'critical', target, title: `pm2 app ${p.name} is ${p.status}`, detail: `${p.restarts} restarts in total${p.cwd ? `, in ${p.cwd}` : ''}` });
      }
      const burst = restartBurst(seen, p.restarts, snap.at, cfg.restarts.windowMin);
      if (burst >= cfg.restarts.warn) {
        add({ id: `${target}:restarts`, severity: 'warn', target, title: `pm2 app ${p.name} restarted ${burst} times in ${cfg.restarts.windowMin} min`, detail: `It may be crash-looping. Status now: ${p.status}.` });
      }
    }
    for (const name of Object.keys(memory.pm2)) if (!snap.pm2.some((p) => p.name === name)) delete memory.pm2[name];
  }

  if (snap.containers) {
    for (const c of snap.containers) {
      const seen = (memory.docker[c.name] ??= { status: c.state, wasUp: false, restarts: [] });
      const up = c.state === 'running';
      if (up) seen.wasUp = true;
      seen.status = c.state;
      const target = `docker:${c.name}`;
      if (c.state === 'restarting') {
        add({ id: `${target}:down`, severity: 'critical', target, title: `Container ${c.name} keeps restarting`, detail: `${c.status}; last exit code ${c.exitCode}` });
      } else if (!up && seen.wasUp) {
        add({ id: `${target}:down`, severity: c.exitCode === 0 ? 'warn' : 'critical', target, title: `Container ${c.name} is ${c.state}`, detail: `${c.status}; exit code ${c.exitCode}; image ${c.image}` });
      }
      if (up && c.health === 'unhealthy') add({ id: `${target}:health`, severity: 'critical', target, title: `Container ${c.name} is unhealthy`, detail: c.status });
      const burst = restartBurst(seen, c.restarts, snap.at, cfg.restarts.windowMin);
      if (burst >= cfg.restarts.warn) {
        add({ id: `${target}:restarts`, severity: 'warn', target, title: `Container ${c.name} restarted ${burst} times in ${cfg.restarts.windowMin} min`, detail: c.status });
      }
    }
    for (const name of Object.keys(memory.docker)) if (!snap.containers.some((c) => c.name === name)) delete memory.docker[name];
  }

  for (const h of snap.http) {
    if (!h.ok) add({ id: `http:${h.name}`, severity: 'critical', target: `http:${h.name}`, title: `${h.name} is not responding`, detail: `${h.url}: ${h.status ? `HTTP ${h.status}` : (h.error ?? 'no answer')}` });
  }

  for (const t of snap.tls) {
    if (t.daysLeft === undefined) continue; // unreachable hosts are reported by the HTTP checks
    const sev = t.daysLeft <= cfg.tls.criticalDays ? 'critical' : t.daysLeft <= cfg.tls.warnDays ? 'warn' : undefined;
    if (sev) add({ id: `tls:${t.host}`, severity: sev, target: `tls:${t.host}`, title: `Certificate for ${t.host} expires in ${t.daysLeft} days`, detail: `valid until ${t.validTo}, issuer ${t.issuer ?? 'unknown'}` });
    else if (!t.ok && t.error) add({ id: `tls:${t.host}`, severity: 'critical', target: `tls:${t.host}`, title: `Certificate problem on ${t.host}`, detail: t.error });
  }


  for (const [collector, error] of Object.entries(snap.errors)) {
    add({ id: `collector:${collector}`, severity: 'warn', target: `collector:${collector}`, title: `Cannot read ${collector}`, detail: error });
  }
  return out;
}

export interface AlertState extends Finding {
  /** Checks in a row it was found / not found. */
  seen: number;
  missing: number;
  open: boolean;
  openedAt?: number;
  /** Highest severity the owner was told about (unset while muted). */
  notified?: Severity;
}

export interface Transitions {
  opened: AlertState[];
  escalated: AlertState[];
  resolved: AlertState[];
}

/**
 * Moves alerts along: a finding opens an alert after `openAfter` checks in a row and closes
 * after `closeAfter` checks without it, so one bad sample neither alerts nor resolves.
 */
export function step(
  states: Map<string, AlertState>,
  findings: Finding[],
  now: number,
  muted: (f: Finding) => boolean,
  opts = { openAfter: 2, closeAfter: 3 },
): Transitions {
  const t: Transitions = { opened: [], escalated: [], resolved: [] };
  const found = new Set<string>();
  for (const f of findings) {
    found.add(f.id);
    const s = states.get(f.id) ?? { ...f, seen: 0, missing: 0, open: false };
    Object.assign(s, f, { seen: s.seen + 1, missing: 0 });
    states.set(f.id, s);
    const quiet = muted(f);
    if (!s.open && s.seen >= opts.openAfter) {
      s.open = true;
      s.openedAt = now;
      if (!quiet) {
        s.notified = s.severity;
        t.opened.push(s);
      }
    } else if (s.open && !quiet && s.notified !== s.severity && (s.notified === undefined || s.severity === 'critical')) {
      s.notified = s.severity;
      t.escalated.push(s);
    }
  }
  for (const [id, s] of states) {
    if (found.has(id)) continue;
    s.seen = 0;
    s.missing++;
    if (!s.open) states.delete(id);
    else if (s.missing >= opts.closeAfter) {
      states.delete(id);
      if (s.notified) t.resolved.push(s);
    }
  }
  return t;
}
