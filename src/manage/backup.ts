import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SettingsStore } from './settings.ts';
import { log } from '../log.ts';

const run = promisify(execFile);
const KEEP = 14;
const NAME = /^agents-(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?\.tar\.gz$/;

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  at: Date;
}

/**
 * Daily snapshot of the agents (definitions, prompts, icons, notes) and Sunny's settings, kept
 * for two weeks in <data>/backups. Secrets and conversation data are not included.
 */
export class AgentBackups {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly deps: { agentsDir: string; dataDir: string; settings: SettingsStore; timezone: string },
  ) {}

  private get dir() {
    return join(this.deps.dataDir, 'backups');
  }

  start(): void {
    const tick = () => void this.ensureToday().catch((err) => log.warn({ err: (err as Error).message }, 'agent backup failed'));
    setTimeout(tick, 60_000).unref();
    this.timer = setInterval(tick, 3_600_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async list(): Promise<BackupInfo[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: BackupInfo[] = [];
    for (const name of names.filter((n) => NAME.test(n))) {
      const s = await stat(join(this.dir, name));
      out.push({ name, path: join(this.dir, name), size: s.size, at: s.mtime });
    }
    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.deps.timezone }).format(new Date());
  }

  /** Makes today's backup unless there already is one. */
  async ensureToday(): Promise<BackupInfo | undefined> {
    const have = (await this.list()).find((b) => b.name.startsWith(`agents-${this.today()}`));
    return have ?? this.now();
  }

  /** Backs up now (a second one the same day gets its own file). */
  async now(): Promise<BackupInfo> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const existing = (await this.list()).filter((b) => b.name.startsWith(`agents-${this.today()}`)).length;
    const stamp = existing ? `${this.today()}-${new Date().toLocaleTimeString('en-GB', { timeZone: this.deps.timezone, hour: '2-digit', minute: '2-digit' }).replace(':', '')}` : this.today();
    const name = `agents-${stamp}.tar.gz`;
    const path = join(this.dir, name);
    // Sunny's own settings (models, switches, always-allow answers) travel along as JSON.
    const rows = await this.deps.settings.dump();
    const settingsFile = join(this.deps.agentsDir, '.settings-backup.json');
    await writeFile(settingsFile, JSON.stringify(rows, null, 2), { mode: 0o600 });
    try {
      await run('tar', ['-czf', path, '-C', this.deps.agentsDir, '--exclude=workspace', '--exclude=inbox', '--exclude=outbox', '--exclude=node_modules', '--exclude=.git', '.']);
    } finally {
      await rm(settingsFile, { force: true });
    }
    for (const old of (await this.list()).slice(KEEP)) await rm(old.path, { force: true });
    const s = await stat(path);
    return { name, path, size: s.size, at: s.mtime };
  }
}
