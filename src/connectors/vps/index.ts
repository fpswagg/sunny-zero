import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Sql } from '../../db/db.ts';
import type { SecretStore } from '../../secrets/store.ts';
import { redact } from '../../util/redact.ts';
import type { Connector } from '../types.ts';
import * as collect from './collect.ts';
import { VpsMonitor } from './monitor.ts';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const guard =
  <A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };

/** Never restarted from chat: restarting the daemon would kill the run that asked. */
const PROTECTED = new Set(['sunny']);

export interface VpsConnectorDeps {
  sql: Sql;
  secrets: SecretStore;
}

/**
 * This server, for monitoring agents. Reading is free;
 * restarting, muting and changing the monitor are marked as changing things, so they ask the
 * owner unless the agent auto-approves them (and always ask when a guest is talking).
 */
export function vpsConnector(deps: VpsConnectorDeps): Connector & { monitor: VpsMonitor } {
  const monitor = new VpsMonitor(deps.sql);

  const pm2Process = async (name: string) => {
    const p = (await collect.pm2()).find((x) => x.name === name);
    if (!p) throw new Error(`No pm2 app named "${name}". Use processes to list them.`);
    return p;
  };
  const container = async (name: string) => {
    const c = (await collect.containers()).find((x) => x.name === name);
    if (!c) throw new Error(`No container named "${name}". Use containers to list them.`);
    return c;
  };
  const parseTarget = (target: string) => {
    const m = /^(pm2|docker):([\w.@-]+)$/.exec(target.trim());
    if (!m) throw new Error('target must look like "pm2:<app name>" or "docker:<container name>"');
    return { kind: m[1] as 'pm2' | 'docker', name: m[2]! };
  };

  return {
    name: 'vps',
    description: 'This server: CPU, memory, disks, pm2 apps, Docker containers, HTTP/TLS checks, metrics history and alerts.',
    mutatingTools: ['restart', 'mute', 'unmute', 'configure'],
    monitor,
    status: async () => {
      if (!monitor.last) return { ready: false, detail: 'the monitor has not run yet' };
      return { ready: true };
    },
    start: (runtime) => monitor.start(runtime),
    stop: () => monitor.stop(),
    server: () =>
      createSdkMcpServer({
        name: 'vps',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool(
            'status',
            'Current health of the server: CPU, load, memory, swap, disks, pm2 and Docker summaries, failing HTTP checks, certificates close to expiry and open alerts.',
            {},
            guard(async () => {
              const s = await monitor.snapshot();
              const sys = s.system;
              return ok({
                at: new Date(s.at).toISOString(),
                system: sys && {
                  cpuPct: sys.cpuPct,
                  load: `${sys.load.join(' / ')} (${sys.cores} cores)`,
                  memory: `${sys.memUsedPct}% used, ${sys.memAvailableMb} MB available of ${sys.memTotalMb} MB`,
                  swap: sys.swapTotalMb ? `${sys.swapUsedPct}% of ${sys.swapTotalMb} MB` : 'none',
                  uptimeHours: sys.uptimeHours,
                  disks: sys.disks.map((d) => `${d.mount}: ${d.usedPct}% of ${d.sizeGb} GB${d.inodesPct !== undefined ? `, inodes ${d.inodesPct}%` : ''}`),
                },
                pm2: s.pm2 && {
                  online: s.pm2.filter((p) => p.status === 'online').length,
                  total: s.pm2.length,
                  notOnline: s.pm2.filter((p) => p.status !== 'online').map((p) => `${p.name}: ${p.status}`),
                },
                docker: s.containers && {
                  running: s.containers.filter((c) => c.state === 'running').length,
                  total: s.containers.length,
                  notRunning: s.containers.filter((c) => c.state !== 'running').map((c) => `${c.name}: ${c.status}`),
                  unhealthy: s.containers.filter((c) => c.health === 'unhealthy').map((c) => c.name),
                },
                httpChecks: `${s.http.filter((h) => h.ok).length}/${s.http.length} ok`,
                httpFailing: s.http.filter((h) => !h.ok),
                certificates: s.tls.map((t) => `${t.host}: ${t.daysLeft ?? '?'} days${t.ok ? '' : ` (${t.error})`}`),
                collectorErrors: s.errors,
                openAlerts: monitor.openAlerts().map((a) => ({ id: a.id, severity: a.severity, title: a.title, detail: a.detail, since: a.openedAt && new Date(a.openedAt).toISOString(), muted: monitor.isMuted(a) })),
              });
            }),
          ),
          tool(
            'processes',
            'All pm2 apps with status, restarts, uptime, CPU and memory.',
            {},
            guard(async () => ok((await collect.pm2()).map(({ outLog: _o, errLog: _e, ...p }) => p))),
          ),
          tool(
            'containers',
            'All Docker containers with state, health, restarts, ports, CPU and memory.',
            {},
            guard(async () => ok(await collect.containers(true))),
          ),
          tool(
            'top',
            'The processes using the most CPU and the most memory right now.',
            {},
            guard(async () => ok(await collect.topProcesses())),
          ),
          tool(
            'logs',
            'Recent log lines of a pm2 app ("pm2:<name>", its error and output logs) or a Docker container ("docker:<name>"). Secrets are masked. Use `filter` to keep matching lines only.',
            {
              target: z.string().describe('"pm2:api" or "docker:postgres"'),
              lines: z.number().int().min(10).max(1000).default(150),
              filter: z.string().max(200).optional().describe('Case-insensitive text or regular expression'),
            },
            guard(async ({ target, lines, filter }) => {
              const t = parseTarget(target);
              let text: string;
              if (t.kind === 'pm2') {
                const p = await pm2Process(t.name);
                const parts: string[] = [];
                for (const [label, path] of [['error log', p.errLog], ['output log', p.outLog]] as const) {
                  if (path && existsSync(path)) parts.push(`── ${label} (${path})\n${await collect.tailFile(path, lines)}`);
                }
                text = parts.join('\n\n') || 'No log files.';
              } else {
                await container(t.name);
                text = await collect.dockerLogs(t.name, lines);
              }
              if (filter) {
                let re: RegExp;
                try {
                  re = new RegExp(filter, 'i');
                } catch {
                  re = new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                }
                text = text.split('\n').filter((l) => l.startsWith('──') || re.test(l)).join('\n');
              }
              return ok(redact(text).slice(-60_000));
            }),
          ),
          tool(
            'history',
            'Hourly averages and peaks of CPU, load, memory, swap and disk usage over the last hours (kept 30 days).',
            { hours: z.number().int().min(1).max(720).default(24) },
            guard(async ({ hours }) => ok(await monitor.history(hours))),
          ),
          tool(
            'alerts',
            'Open alerts, active mutes, and alert events of the last hours.',
            { hours: z.number().int().min(1).max(720).default(24) },
            guard(async ({ hours }) => {
              const events = await deps.sql`
                select at, name, summary from events where source = 'vps' and at > now() - make_interval(hours => ${hours}) order by at desc limit 100`;
              return ok({ open: monitor.openAlerts(), mutes: monitor.mutesList(), events });
            }),
          ),
          tool(
            'check_url',
            'Check a URL now: HTTP status and response time, plus the certificate for https.',
            { url: z.url() },
            guard(async ({ url }) => {
              const u = new URL(url);
              if (!/^https?:$/.test(u.protocol)) throw new Error('http or https only');
              const http = await collect.httpCheck(u.host, url);
              const tls = u.protocol === 'https:' ? await collect.tlsCheck(u.hostname) : undefined;
              return ok({ http, tls });
            }),
          ),
          tool(
            'disk_usage',
            'Sizes of the folders directly inside a folder (same disk), largest first. Use it to find what fills a disk.',
            { path: z.string().default('/') },
            guard(async ({ path }) => {
              if (!isAbsolute(path)) throw new Error('use an absolute path');
              return ok((await collect.diskUsage(path)) || 'Nothing readable there.');
            }),
          ),
          tool(
            'restart',
            'Restart a pm2 app ("pm2:<name>") or a Docker container ("docker:<name>"). Only when it is clearly stuck or down and a restart is the right fix. Always asks the owner.',
            { target: z.string(), reason: z.string().describe('Why, in one sentence, shown to the owner') },
            guard(async ({ target }) => {
              const t = parseTarget(target);
              if (PROTECTED.has(t.name)) throw new Error(`${t.name} runs Sunny itself; restart it from a terminal (pnpm pm2:start).`);
              if (t.kind === 'pm2') {
                await pm2Process(t.name);
                await collect.run('pm2', ['restart', t.name], 60_000);
              } else {
                await container(t.name);
                await collect.run('docker', ['restart', t.name], 120_000);
              }
              await new Promise((r) => setTimeout(r, 5000));
              const after = t.kind === 'pm2' ? await pm2Process(t.name).then(({ outLog: _o, errLog: _e, ...p }) => p) : await container(t.name);
              return ok({ restarted: target, now: after });
            }),
          ),
          tool(
            'mute',
            'Silence alerts for some hours: an alert id ("disk:/") or a target pattern ("pm2:worker", "docker:*-https"). Muted problems are still tracked and shown in status.',
            { pattern: z.string().min(2), hours: z.number().min(0.25).max(24 * 30) },
            guard(async ({ pattern, hours }) => ok(`Muted ${pattern} until ${await monitor.mute(pattern, hours)}.`)),
          ),
          tool(
            'unmute',
            'Remove a mute.',
            { pattern: z.string() },
            guard(async ({ pattern }) => ok((await monitor.unmute(pattern)) ? `Unmuted ${pattern}.` : `${pattern} was not muted.`)),
          ),
          tool(
            'configure',
            'Show or change the monitor settings: thresholds, extra HTTP checks, Traefik discovery and the ignore list. Pass only what changes; lists replace the old ones. Call without arguments to see the current settings.',
            {
              disk: z.object({ warnPct: z.number(), criticalPct: z.number() }).partial().optional(),
              memory: z.object({ warnAvailablePct: z.number(), criticalAvailablePct: z.number() }).partial().optional(),
              swap: z.object({ warnPct: z.number() }).partial().optional(),
              load: z.object({ warnPerCore: z.number(), criticalPerCore: z.number() }).partial().optional(),
              cpu: z.object({ warnPct: z.number(), samples: z.number().int() }).partial().optional(),
              restarts: z.object({ warn: z.number().int(), windowMin: z.number().int() }).partial().optional(),
              tls: z.object({ warnDays: z.number(), criticalDays: z.number() }).partial().optional(),
              http: z.array(z.object({ name: z.string(), url: z.url() })).optional(),
              discoverTraefik: z.boolean().optional(),
              ignore: z.array(z.string()).optional(),
              intervalSec: z.number().int().optional(),
            },
            guard(async (changes) => {
              const clean = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
              return ok(Object.keys(clean).length ? await monitor.configure(clean) : monitor.config);
            }),
          ),
        ],
      }),
  };
}
