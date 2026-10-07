import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthFlow, Screen } from '../auth/types.ts';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { agentEnv } from '../runtime/env.ts';

/**
 * Several Claude subscriptions on one server. Claude Code logs in with `<config dir>/.credentials.json`;
 * every saved account keeps its own copy of that file (plus the `oauthAccount` entry of `~/.claude.json`),
 * and switching copies the chosen one over the live file. The sessions, projects and settings stay shared,
 * so a conversation carries on after a switch. The next agent run uses the new account; runs already in
 * flight finish on the old one.
 *
 * Tokens renew themselves in the live file while it is in use, so the live copy is saved back into the
 * active account's slot before every switch.
 */

interface Slot {
  credentials: { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; subscriptionType?: string }; organizationUuid?: string };
  oauthAccount?: Record<string, unknown>;
}

interface Entry {
  id: string;
  label: string;
  email?: string;
  addedAt: string;
}

interface Index {
  active?: string;
  accounts: Entry[];
}

export interface ClaudeAccount {
  id: string;
  label: string;
  email?: string;
  plan?: string;
  active: boolean;
  addedAt: string;
}

/** Claude Code / API answers that mean the login itself is dead (not a limit or an outage). */
export const LIMIT_REACHED = /session limit|usage limit|weekly limit|hit your (\w+ )?limit|limit reached|rate.?limit|too many requests|quota|\b429\b|credit balance/i;
export const AUTH_FAILURE = /\b(401|403)\b|authentication|authoriz[^a-z]|unauthori[sz]ed|forbidden|invalid[^.\n]{0,30}(token|credential|login)|token[^.\n]{0,30}(expired|revoked|invalid)|login.*expired|subscription.{0,20}expired|not logged in|please run \/login|oauth/i;

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'account';

export class ClaudeAccounts {
  private readonly dir: string;
  private readonly configDir: string;
  private readonly claudeJson: string;
  private listeners: Array<() => void> = [];
  /** Serialises everything that touches the files. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: { dataDir?: string; claudeConfigDir?: string; claudeJson?: string } = {}) {
    this.dir = join(opts.dataDir ?? config.dataDir, 'claude-accounts');
    this.configDir = opts.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    this.claudeJson = opts.claudeJson ?? (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'));
  }

  /** Called after the live login changed (switch or new account), e.g. to drop cached limits. */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private get liveFile() {
    return join(this.configDir, '.credentials.json');
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }

  private async index(): Promise<Index> {
    return (await this.readJson<Index>(join(this.dir, 'index.json'))) ?? { accounts: [] };
  }

  private saveIndex(index: Index): Promise<void> {
    return this.writeJson(join(this.dir, 'index.json'), index);
  }

  private slotFile(id: string) {
    return join(this.dir, `${id}.json`);
  }

  /** What is logged in right now (credentials and account profile), or undefined. */
  private async live(): Promise<Slot | undefined> {
    const credentials = await this.readJson<Slot['credentials']>(this.liveFile);
    if (!credentials?.claudeAiOauth?.accessToken) return undefined;
    const oauthAccount = (await this.readJson<{ oauthAccount?: Record<string, unknown> }>(this.claudeJson))?.oauthAccount;
    return { credentials, oauthAccount };
  }

  private sameAccount(a: Slot, b: Slot): boolean {
    const ao = a.credentials.organizationUuid ?? (a.oauthAccount?.organizationUuid as string | undefined);
    const bo = b.credentials.organizationUuid ?? (b.oauthAccount?.organizationUuid as string | undefined);
    const au = a.oauthAccount?.accountUuid;
    const bu = b.oauthAccount?.accountUuid;
    if (au && bu) return au === bu;
    return !!ao && ao === bo;
  }

  private uniqueId(index: Index, base: string): string {
    let id = slug(base);
    for (let n = 2; index.accounts.some((a) => a.id === id); n++) id = `${slug(base)}-${n}`;
    return id;
  }

  /** Saves the live login back into its slot, imports it when new, and returns the fresh index. */
  private async sync(): Promise<Index> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const index = await this.index();
    const live = await this.live();
    if (!live) return index;
    const email = typeof live.oauthAccount?.emailAddress === 'string' ? live.oauthAccount.emailAddress : undefined;
    let match: Entry | undefined;
    const activeEntry = index.accounts.find((a) => a.id === index.active);
    const candidates = activeEntry ? [activeEntry, ...index.accounts.filter((a) => a !== activeEntry)] : index.accounts;
    for (const entry of candidates) {
      const slot = await this.readJson<Slot>(this.slotFile(entry.id));
      if (slot && this.sameAccount(slot, live)) {
        match = entry;
        break;
      }
    }
    if (!match) {
      // A login this list does not know yet (the first run, or `claude login` done by hand): keep it as an account.
      const label = email ?? (index.accounts.length ? `Account ${index.accounts.length + 1}` : 'Account 1');
      match = { id: this.uniqueId(index, email?.split('@')[0] ?? label), label, email, addedAt: new Date().toISOString() };
      index.accounts.push(match);
    }
    await this.writeJson(this.slotFile(match.id), live);
    if (email && !match.email) match.email = email;
    index.active = match.id;
    await this.saveIndex(index);
    return index;
  }

  private toAccount(entry: Entry, slot: Slot | undefined, active: boolean): ClaudeAccount {
    return { id: entry.id, label: entry.label, email: entry.email, plan: slot?.credentials.claudeAiOauth?.subscriptionType, active, addedAt: entry.addedAt };
  }

  async list(): Promise<ClaudeAccount[]> {
    return this.locked(async () => {
      const index = await this.sync();
      const out: ClaudeAccount[] = [];
      for (const entry of index.accounts) out.push(this.toAccount(entry, await this.readJson<Slot>(this.slotFile(entry.id)), entry.id === index.active));
      return out;
    });
  }

  /** Makes `which` (id, label or e-mail, case-insensitive; "next" = the other one) the live login. */
  async switchTo(which: string): Promise<ClaudeAccount> {
    return this.locked(async () => {
      const index = await this.sync();
      const q = which.trim().toLowerCase();
      let entry: Entry | undefined;
      if (q === 'next' || q === '') {
        const at = index.accounts.findIndex((a) => a.id === index.active);
        entry = index.accounts.length > 1 ? index.accounts[(at + 1) % index.accounts.length] : undefined;
      } else {
        entry =
          index.accounts.find((a) => a.id === q || a.label.toLowerCase() === q || a.email?.toLowerCase() === q) ??
          index.accounts.find((a) => a.label.toLowerCase().startsWith(q) || a.email?.toLowerCase().startsWith(q) || a.id.startsWith(q));
      }
      if (!entry) throw new Error(index.accounts.length < 2 ? 'There is only one Claude account saved. Add the other one first.' : `No Claude account matches "${which}".`);
      const slot = await this.readJson<Slot>(this.slotFile(entry.id));
      if (!slot?.credentials.claudeAiOauth?.accessToken) throw new Error(`The saved login of ${entry.label} is missing. Add the account again.`);
      if (entry.id !== index.active) await this.apply(slot);
      index.active = entry.id;
      await this.saveIndex(index);
      log.info({ account: entry.id }, 'claude account switched');
      this.changed();
      return this.toAccount(entry, slot, true);
    });
  }

  /** Writes a slot over the live login. */
  private async apply(slot: Slot): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await this.writeJson(this.liveFile, slot.credentials);
    if (slot.oauthAccount) {
      // Only the account entry of ~/.claude.json changes; the rest of that file is Claude Code's own.
      const current = await this.readJson<Record<string, unknown>>(this.claudeJson);
      if (current) await this.writeJson(this.claudeJson, { ...current, oauthAccount: slot.oauthAccount });
    }
  }

  /**
   * Checks that a saved (not live) login still works, by asking Claude Code for one tiny answer in a scratch
   * config dir. The CLI renews an expired access token there; the renewed login is saved back into the slot,
   * so a rotating refresh token is never lost. 'unknown' = could not tell (network, limits): do not act on it.
   */
  async probe(which: string, opts: { timeoutMs?: number } = {}): Promise<'ok' | 'dead' | 'unknown'> {
    const slot = await this.locked(async () => {
      const index = await this.sync();
      const entry = index.accounts.find((a) => a.id === which);
      return entry ? { entry, slot: await this.readJson<Slot>(this.slotFile(entry.id)), live: entry.id === index.active } : undefined;
    });
    if (!slot?.slot?.credentials.claudeAiOauth?.accessToken) return 'dead';
    if (slot.live) return 'unknown';
    const scratch = await mkdtemp(join(tmpdir(), 'sunny-claude-probe-'));
    try {
      await this.writeJson(join(scratch, '.credentials.json'), slot.slot.credentials);
      await this.writeJson(join(scratch, '.claude.json'), { hasCompletedOnboarding: true, oauthAccount: slot.slot.oauthAccount });
      const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
        let text = '';
        const child = spawn('claude', ['-p', 'Reply with: ok', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json'], {
          cwd: scratch,
          env: { ...agentEnv(), CLAUDE_CONFIG_DIR: scratch },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 90_000);
        const collect = (b: Buffer) => (text += b.toString());
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', (err) => resolve({ code: -1, text: err.message }));
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, text });
        });
      });
      // Keep a renewed login (the refresh token may have rotated).
      const renewed = await this.readJson<Slot['credentials']>(join(scratch, '.credentials.json'));
      if (renewed?.claudeAiOauth?.accessToken && renewed.claudeAiOauth.accessToken !== slot.slot.credentials.claudeAiOauth.accessToken) {
        await this.locked(async () => {
          const index = await this.index();
          if (index.active !== slot.entry.id) await this.writeJson(this.slotFile(slot.entry.id), { ...slot.slot, credentials: renewed });
        });
      }
      if (output.code === 0 && !/"is_error":\s*true/.test(output.text)) return 'ok';
      return AUTH_FAILURE.test(output.text) || LIMIT_REACHED.test(output.text) ? 'dead' : 'unknown';
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async rename(which: string, label: string): Promise<ClaudeAccount> {
    return this.locked(async () => {
      const index = await this.sync();
      const entry = index.accounts.find((a) => a.id === which.toLowerCase() || a.label.toLowerCase() === which.toLowerCase());
      if (!entry) throw new Error(`No Claude account matches "${which}".`);
      entry.label = label.trim().slice(0, 40) || entry.label;
      await this.saveIndex(index);
      return this.toAccount(entry, await this.readJson<Slot>(this.slotFile(entry.id)), entry.id === index.active);
    });
  }

  /** Forgets a saved account (not the active one). */
  async remove(which: string): Promise<void> {
    return this.locked(async () => {
      const index = await this.sync();
      const entry = index.accounts.find((a) => a.id === which.toLowerCase() || a.label.toLowerCase() === which.toLowerCase());
      if (!entry) throw new Error(`No Claude account matches "${which}".`);
      if (entry.id === index.active) throw new Error('That account is the one in use. Switch to the other one first.');
      index.accounts = index.accounts.filter((a) => a !== entry);
      await this.saveIndex(index);
      await rm(this.slotFile(entry.id), { force: true });
    });
  }

  /**
   * Adds an account: runs `claude auth login` in a scratch config dir, shows its sign-in link on a secure page,
   * and takes the code the person pastes back. The live login is not touched until they switch.
   */
  loginFlow(onDone?: (account: ClaudeAccount) => void | Promise<void>): AuthFlow {
    let child: ReturnType<typeof spawn> | undefined;
    let scratch: string | undefined;
    let output = '';
    const cleanup = async () => {
      child?.kill();
      child = undefined;
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      scratch = undefined;
    };
    const waitFor = (test: () => boolean, ms: number) =>
      new Promise<boolean>((resolve) => {
        const started = Date.now();
        const tick = () => (test() ? resolve(true) : Date.now() - started > ms ? resolve(false) : setTimeout(tick, 150));
        tick();
      });
    const form = (url: string, error?: string): Screen => ({
      kind: 'form',
      title: 'Add a Claude account',
      description: 'Sign in with the Claude account you want to add (the other subscription), then copy the code Claude shows you and paste it below. The code is used once and never stored.',
      links: [{ label: '1. Sign in to Claude', url }],
      fields: [{ name: 'code', label: '2. Code from Claude', type: 'password' }],
      submitLabel: 'Add account',
      error,
    });
    return {
      title: 'Add a Claude account',
      start: async () => {
        await cleanup();
        output = '';
        scratch = await mkdtemp(join(tmpdir(), 'sunny-claude-login-'));
        child = spawn('claude', ['auth', 'login', '--claudeai'], { env: { ...agentEnv(), CLAUDE_CONFIG_DIR: scratch, BROWSER: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
        const collect = (b: Buffer) => (output += b.toString().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', (err) => (output += `\n${err.message}`));
        setTimeout(() => void cleanup(), LOGIN_TIMEOUT_MS).unref();
        const found = await waitFor(() => /https:\/\/\S+/.test(output), 15_000);
        const url = output.match(/https:\/\/\S+/)?.[0];
        if (!found || !url) {
          await cleanup();
          return { kind: 'failed', title: 'Add a Claude account', message: 'Claude Code did not give a sign-in link. Check that `claude` is installed on the server.' };
        }
        return form(url);
      },
      submit: async ({ code = '' }) => {
        const url = output.match(/https:\/\/\S+/)?.[0];
        if (!child || !scratch || !url) return { kind: 'failed', title: 'Add a Claude account', message: 'This sign-in expired. Ask for a new link.' };
        const dir = scratch;
        const credsFile = join(dir, '.credentials.json');
        child.stdin?.write(`${code.trim()}\n`);
        let exited = child.exitCode !== null;
        child.once('exit', () => (exited = true));
        const ok = await waitFor(() => existsSync(credsFile) && exited, 30_000);
        if (!ok) {
          // Wrong or expired code: the process is usually gone; a new link is needed.
          const dead = exited || child.exitCode !== null;
          if (dead) {
            await cleanup();
            return { kind: 'failed', title: 'Add a Claude account', message: 'Claude did not accept that code. Ask for a new link and try again.' };
          }
          return form(url, 'Claude did not accept that code. Check it and try again.');
        }
        const credentials = await this.readJson<Slot['credentials']>(credsFile);
        const oauthAccount = (await this.readJson<{ oauthAccount?: Record<string, unknown> }>(join(dir, '.claude.json')))?.oauthAccount;
        await cleanup();
        if (!credentials?.claudeAiOauth?.accessToken) return { kind: 'failed', title: 'Add a Claude account', message: 'Claude signed in but returned no login. Try again.' };
        try {
          const account = await this.locked(async () => {
            const index = await this.sync();
            const slot: Slot = { credentials, oauthAccount };
            const email = typeof oauthAccount?.emailAddress === 'string' ? oauthAccount.emailAddress : undefined;
            // The same account again: refresh its saved login instead of listing it twice.
            let entry: Entry | undefined;
            for (const e of index.accounts) {
              const saved = await this.readJson<Slot>(this.slotFile(e.id));
              if (saved && this.sameAccount(saved, slot)) entry = e;
            }
            if (!entry) {
              const label = email ?? `Account ${index.accounts.length + 1}`;
              entry = { id: this.uniqueId(index, email?.split('@')[0] ?? label), label, email, addedAt: new Date().toISOString() };
              index.accounts.push(entry);
            }
            if (entry.id === index.active) await this.apply(slot);
            await this.writeJson(this.slotFile(entry.id), slot);
            await this.saveIndex(index);
            return this.toAccount(entry, slot, entry.id === index.active);
          });
          await onDone?.(account);
          return { kind: 'done', title: 'Claude account added', message: `${account.label}${account.plan ? ` (${account.plan})` : ''} is saved. Switch to it from Sunny whenever you like.` };
        } catch (err) {
          return { kind: 'failed', title: 'Add a Claude account', message: err instanceof Error ? err.message : String(err) };
        }
      },
    };
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        log.warn({ err }, 'claude account listener failed');
      }
    }
  }
}
