import { describe, expect, it } from 'vitest';
import type { Container, Pm2Process, SystemSample } from '../src/connectors/vps/collect.ts';
import { DEFAULT_CONFIG, emptyMemory, evaluate, step, type AlertState, type MonitorConfig, type Snapshot } from '../src/connectors/vps/rules.ts';

const system = (over: Partial<SystemSample> = {}): SystemSample => ({
  cpuPct: 10,
  cores: 4,
  load: [0.5, 0.5, 0.5],
  memTotalMb: 8000,
  memAvailableMb: 4000,
  memUsedPct: 50,
  swapTotalMb: 0,
  swapUsedPct: 0,
  uptimeHours: 100,
  disks: [{ mount: '/', device: '/dev/sda1', sizeGb: 100, usedPct: 50, inodesPct: 5 }],
  ...over,
});
const app = (over: Partial<Pm2Process> = {}): Pm2Process => ({ name: 'api', id: 0, status: 'online', restarts: 0, unstableRestarts: 0, uptimeMin: 10, cpuPct: 1, memoryMb: 100, ...over });
const box = (over: Partial<Container> = {}): Container => ({ name: 'db', image: 'postgres', state: 'running', status: 'Up', restarts: 0, exitCode: 0, ports: '', ...over });
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ at: Date.now(), system: system(), pm2: [app()], containers: [box()], http: [], tls: [], errors: {}, ...over });
const ids = (snapshot: Snapshot, memory = emptyMemory(), cfg: MonitorConfig = DEFAULT_CONFIG) => evaluate(snapshot, memory, cfg).map((f) => `${f.severity} ${f.id}`);

describe('evaluate', () => {
  it('is quiet when all is well', () => {
    expect(ids(snap())).toEqual([]);
  });

  it('checks disks, memory, swap and load against thresholds', () => {
    const s = system({
      disks: [
        { mount: '/', device: 'a', sizeGb: 100, usedPct: 96 },
        { mount: '/data', device: 'b', sizeGb: 100, usedPct: 86, inodesPct: 90 },
      ],
      memUsedPct: 96,
      memAvailableMb: 300,
      swapTotalMb: 2000,
      swapUsedPct: 70,
      load: [20, 13, 9],
    });
    expect(ids(snap({ system: s }))).toEqual(['critical disk:/', 'warn disk:/data', 'warn inodes:/data', 'critical memory', 'warn swap', 'critical load']);
  });

  it('needs sustained CPU', () => {
    const memory = emptyMemory();
    const hot = snap({ system: system({ cpuPct: 99 }) });
    for (let i = 0; i < 4; i++) expect(ids(hot, memory)).toEqual([]);
    expect(ids(hot, memory)).toEqual(['warn cpu']);
    expect(ids(snap(), memory)).toEqual([]);
  });

  it('alerts on apps and containers that went down, not those never up', () => {
    const memory = emptyMemory();
    expect(ids(snap({ pm2: [app({ name: 'idle', status: 'stopped' })], containers: [box({ name: 'old', state: 'exited', exitCode: 0 })] }), memory)).toEqual([]);
    ids(snap(), memory);
    expect(ids(snap({ pm2: [app({ status: 'errored' })], containers: [box({ state: 'exited', exitCode: 137 })] }), memory)).toEqual([
      'critical pm2:api:down',
      'critical docker:db:down',
    ]);
    expect(ids(snap({ containers: [box({ health: 'unhealthy' })] }), memory)).toEqual(['critical docker:db:health']);
  });

  it('spots crash loops from restart counts', () => {
    const memory = emptyMemory();
    const t0 = Date.now();
    ids(snap({ at: t0, pm2: [app({ restarts: 10 })] }), memory);
    expect(ids(snap({ at: t0 + 60_000, pm2: [app({ restarts: 12 })] }), memory)).toEqual([]);
    expect(ids(snap({ at: t0 + 120_000, pm2: [app({ restarts: 13 })] }), memory)).toEqual(['warn pm2:api:restarts']);
    // Outside the window the old count no longer counts.
    expect(ids(snap({ at: t0 + 40 * 60_000, pm2: [app({ restarts: 13 })] }), memory)).toEqual([]);
  });

  it('reports HTTP, certificates and collector problems, and honours ignore', () => {
    const s = snap({
      http: [{ name: 'site', url: 'https://x', ok: false, error: 'ECONNREFUSED' }],
      tls: [{ host: 'x.io', ok: true, daysLeft: 10 }, { host: 'y.io', ok: true, daysLeft: 2 }],
      errors: { pm2: 'spawn pm2 ENOENT' },
    });
    expect(ids(s)).toEqual(['critical http:site', 'warn tls:x.io', 'critical tls:y.io', 'warn collector:pm2']);
    expect(ids(s, emptyMemory(), { ...DEFAULT_CONFIG, ignore: ['tls:*', 'http:site'] })).toEqual(['warn collector:pm2']);
  });
});

describe('step', () => {
  const f = (severity: 'warn' | 'critical' = 'warn') => ({ id: 'disk:/', severity, title: 't', detail: 'd', target: 'disk:/' });
  const names = (t: ReturnType<typeof step>) => ({ opened: t.opened.length, escalated: t.escalated.length, resolved: t.resolved.length });

  it('opens after two checks, escalates, and resolves after three clear checks', () => {
    const states = new Map<string, AlertState>();
    const quiet = () => false;
    expect(names(step(states, [f()], 1, quiet))).toEqual({ opened: 0, escalated: 0, resolved: 0 });
    expect(names(step(states, [f()], 2, quiet))).toEqual({ opened: 1, escalated: 0, resolved: 0 });
    expect(names(step(states, [f()], 3, quiet))).toEqual({ opened: 0, escalated: 0, resolved: 0 });
    expect(names(step(states, [f('critical')], 4, quiet))).toEqual({ opened: 0, escalated: 1, resolved: 0 });
    expect(names(step(states, [f('warn')], 5, quiet))).toEqual({ opened: 0, escalated: 0, resolved: 0 });
    step(states, [], 6, quiet);
    step(states, [], 7, quiet);
    expect(names(step(states, [], 8, quiet))).toEqual({ opened: 0, escalated: 0, resolved: 1 });
    expect(states.size).toBe(0);
  });

  it('ignores a single bad sample and stays silent while muted', () => {
    const states = new Map<string, AlertState>();
    step(states, [f()], 1, () => false);
    expect(names(step(states, [], 2, () => false))).toEqual({ opened: 0, escalated: 0, resolved: 0 });
    expect(states.size).toBe(0);
    step(states, [f()], 3, () => true);
    expect(names(step(states, [f()], 4, () => true))).toEqual({ opened: 0, escalated: 0, resolved: 0 });
    for (const t of [5, 6]) step(states, [], t, () => true);
    expect(names(step(states, [], 7, () => true))).toEqual({ opened: 0, escalated: 0, resolved: 0 });
  });
});
