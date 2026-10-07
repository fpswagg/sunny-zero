import { execFile } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { connect as tlsConnect } from 'node:tls';
import { cpus, loadavg, uptime } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Runs a fixed command without a shell. */
export async function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await exec(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return stdout;
}

export interface DiskUsage {
  mount: string;
  device: string;
  sizeGb: number;
  usedPct: number;
  inodesPct?: number;
}

export interface SystemSample {
  cpuPct: number | null;
  cores: number;
  load: [number, number, number];
  memTotalMb: number;
  memAvailableMb: number;
  memUsedPct: number;
  swapTotalMb: number;
  swapUsedPct: number;
  uptimeHours: number;
  disks: DiskUsage[];
}

export interface Pm2Process {
  name: string;
  id: number;
  status: string;
  restarts: number;
  unstableRestarts: number;
  uptimeMin: number | null;
  cpuPct: number;
  memoryMb: number;
  cwd?: string;
  outLog?: string;
  errLog?: string;
}

export interface Container {
  name: string;
  image: string;
  state: string;
  status: string;
  health?: string;
  restarts: number;
  exitCode: number;
  ports: string;
  cpuPct?: number;
  memoryMb?: number;
}

export interface HttpResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
}

export interface TlsResult {
  host: string;
  ok: boolean;
  daysLeft?: number;
  validTo?: string;
  issuer?: string;
  error?: string;
}

let lastCpu: { idle: number; total: number } | undefined;

async function cpuPct(): Promise<number | null> {
  const line = (await readFile('/proc/stat', 'utf8')).split('\n')[0]!;
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = nums[3]! + (nums[4] ?? 0);
  const total = nums.reduce((a, b) => a + b, 0);
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev || total === prev.total) return null;
  return Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 1000) / 10;
}

async function meminfo(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const line of (await readFile('/proc/meminfo', 'utf8')).split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) out[m[1]!] = Number(m[2]) / 1024;
  }
  return out;
}

const DF_SKIP = ['-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs', '-x', 'efivarfs', '-x', 'nsfs'];

async function disks(): Promise<DiskUsage[]> {
  const parse = (out: string) =>
    out
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 6 && f[0]!.startsWith('/'));
  const [blocks, inodes] = await Promise.all([run('df', ['-P', '-k', ...DF_SKIP]), run('df', ['-P', '-i', ...DF_SKIP]).catch(() => '')]);
  const inodePct = new Map(parse(inodes).map((f) => [f[5]!, Number(f[4]!.replace('%', ''))]));
  const seen = new Set<string>();
  return parse(blocks)
    .filter((f) => !seen.has(f[0]!) && seen.add(f[0]!))
    .map((f) => ({
      device: f[0]!,
      mount: f[5]!,
      sizeGb: Math.round((Number(f[1]) / 1024 / 1024) * 10) / 10,
      usedPct: Number(f[4]!.replace('%', '')),
      inodesPct: Number.isFinite(inodePct.get(f[5]!)) ? inodePct.get(f[5]!) : undefined,
    }));
}

export async function system(): Promise<SystemSample> {
  const [cpu, mem, disk] = await Promise.all([cpuPct(), meminfo(), disks()]);
  const total = mem.MemTotal ?? 0;
  const available = mem.MemAvailable ?? 0;
  const swapTotal = mem.SwapTotal ?? 0;
  const [l1, l5, l15] = loadavg();
  return {
    cpuPct: cpu,
    cores: cpus().length,
    load: [l1!, l5!, l15!].map((n) => Math.round(n * 100) / 100) as [number, number, number],
    memTotalMb: Math.round(total),
    memAvailableMb: Math.round(available),
    memUsedPct: total ? Math.round((1 - available / total) * 1000) / 10 : 0,
    swapTotalMb: Math.round(swapTotal),
    swapUsedPct: swapTotal ? Math.round((1 - (mem.SwapFree ?? 0) / swapTotal) * 1000) / 10 : 0,
    uptimeHours: Math.round((uptime() / 3600) * 10) / 10,
    disks: disk,
  };
}

/** pm2 processes. Only these fields are kept: `pm2 jlist` also carries every process's environment (secrets). */
export async function pm2(): Promise<Pm2Process[]> {
  const raw = JSON.parse(await run('pm2', ['jlist'], 30_000)) as {
    name: string;
    pm_id: number;
    monit?: { cpu?: number; memory?: number };
    pm2_env?: { status?: string; restart_time?: number; unstable_restarts?: number; pm_uptime?: number; pm_cwd?: string; pm_out_log_path?: string; pm_err_log_path?: string };
  }[];
  return raw.map((p) => {
    const env = p.pm2_env ?? {};
    const online = env.status === 'online';
    return {
      name: p.name,
      id: p.pm_id,
      status: env.status ?? 'unknown',
      restarts: env.restart_time ?? 0,
      unstableRestarts: env.unstable_restarts ?? 0,
      uptimeMin: online && env.pm_uptime ? Math.round((Date.now() - env.pm_uptime) / 60_000) : null,
      cpuPct: p.monit?.cpu ?? 0,
      memoryMb: Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
      cwd: env.pm_cwd,
      outLog: env.pm_out_log_path,
      errLog: env.pm_err_log_path,
    };
  });
}

/** Docker containers with health and restart counts (no environment, no labels). */
export async function containers(withStats = false): Promise<Container[]> {
  const ids = (await run('docker', ['ps', '-aq'])).trim().split('\n').filter(Boolean);
  if (!ids.length) return [];
  const format = '{{.Name}}\t{{.Config.Image}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.RestartCount}}\t{{.State.ExitCode}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}';
  const ps = new Map(
    (await run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}']))
      .trim()
      .split('\n')
      .map((l) => l.split('\t'))
      .map((f) => [f[0]!, { status: f[1] ?? '', ports: f[2] ?? '' }]),
  );
  const list: Container[] = (await run('docker', ['inspect', '--format', format, ...ids]))
    .trim()
    .split('\n')
    .map((l) => l.split('\t'))
    .map((f) => {
      const name = f[0]!.replace(/^\//, '');
      return {
        name,
        image: f[1]!,
        state: f[2]!,
        health: f[3] || undefined,
        restarts: Number(f[4]),
        exitCode: Number(f[5]),
        status: ps.get(name)?.status ?? f[2]!,
        ports: ps.get(name)?.ports ?? '',
      };
    });
  if (withStats) {
    const stats = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'], 60_000).catch(() => '');
    const units: Record<string, number> = { B: 1 / 1024 / 1024, KiB: 1 / 1024, kB: 1 / 1000, MiB: 1, MB: 1, GiB: 1024, GB: 1000 };
    for (const line of stats.trim().split('\n')) {
      const [name, cpu, mem] = line.split('\t');
      const c = list.find((x) => x.name === name);
      const m = /([\d.]+)\s*([A-Za-z]+)/.exec(mem ?? '');
      if (!c) continue;
      c.cpuPct = Number.parseFloat(cpu ?? '') || 0;
      if (m) c.memoryMb = Math.round(Number(m[1]) * (units[m[2]!] ?? 1));
    }
  }
  return list;
}

/** Public hosts Traefik routes (from container labels), for TLS and HTTPS checks. */
export async function traefikHosts(): Promise<string[]> {
  const ids = (await run('docker', ['ps', '-q'])).trim().split('\n').filter(Boolean);
  if (!ids.length) return [];
  const out = await run('docker', ['inspect', '--format', '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}\n{{end}}', ...ids]);
  const hosts = new Set<string>();
  for (const line of out.split('\n')) {
    if (!/^traefik\.http\.routers\.[^.]+\.rule=/.test(line)) continue;
    for (const m of line.matchAll(/Host\(`([^`]+)`\)/g)) hosts.add(m[1]!);
  }
  return [...hosts].sort();
}

export async function httpCheck(name: string, url: string, timeoutMs = 10_000): Promise<HttpResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: { 'user-agent': 'sunny-monitor/0.1' } });
    await res.body?.cancel();
    return { name, url, ok: res.status < 500, status: res.status, ms: Date.now() - started };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    return { name, url, ok: false, ms: Date.now() - started, error: e.cause?.code ?? e.cause?.message ?? e.message };
  }
}

export function tlsCheck(host: string, timeoutMs = 10_000): Promise<TlsResult> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      socket.end();
      if (!cert?.valid_to) return resolve({ host, ok: false, error: 'no certificate' });
      const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      resolve({
        host,
        ok: authorized && daysLeft > 0,
        daysLeft,
        validTo: new Date(cert.valid_to).toISOString(),
        issuer: typeof cert.issuer?.O === 'string' ? cert.issuer.O : undefined,
        error: authorized ? undefined : String(socket.authorizationError ?? 'not trusted'),
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ host, ok: false, error: 'timeout' });
    });
    socket.on('error', (err) => resolve({ host, ok: false, error: (err as NodeJS.ErrnoException).code ?? err.message }));
  });
}

/** Processes using the most CPU and memory (command names only: full command lines can carry secrets). */
export async function topProcesses(limit = 12): Promise<{ byCpu: string; byMemory: string }> {
  const fields = ['-eo', 'pid,user,pcpu,pmem,rss,etime,comm'];
  const [byCpu, byMemory] = await Promise.all([run('ps', [...fields, '--sort=-pcpu']), run('ps', [...fields, '--sort=-rss'])]);
  const head = (s: string) => s.split('\n').slice(0, limit + 1).join('\n');
  return { byCpu: head(byCpu), byMemory: head(byMemory) };
}

/** Last lines of a file, without reading all of it. */
export async function tailFile(path: string, lines: number): Promise<string> {
  const size = (await stat(path)).size;
  const chunk = Math.min(size, Math.max(64 * 1024, lines * 400));
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(chunk);
    await handle.read(buf, 0, chunk, size - chunk);
    return buf.toString('utf8').split('\n').slice(-lines - 1).join('\n');
  } finally {
    await handle.close();
  }
}

export async function dockerLogs(container: string, lines: number): Promise<string> {
  const { stdout, stderr } = await exec('docker', ['logs', '--tail', String(lines), '--timestamps', container], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  return [stdout, stderr].filter(Boolean).join('\n');
}

/** Sizes of the folders directly under `path` on the same filesystem, largest first. */
export async function diskUsage(path: string): Promise<string> {
  const out = await run('du', ['-x', '-d', '1', '-k', path], 120_000).catch((err: { stdout?: string }) => err.stdout ?? '');
  return out
    .trim()
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f.length === 2)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, 25)
    .map(([kb, p]) => `${(Number(kb) / 1024 / 1024).toFixed(2).padStart(8)} GB  ${p}`)
    .join('\n');
}
