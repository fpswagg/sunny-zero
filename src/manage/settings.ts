import type { Sql } from '../db/db.ts';

/** Owner answers "always allow" (approval alwaysKey values, e.g. "agent-call:watcher>builder"). */
export const ALWAYS_ALLOW_KEY = 'always_allow';
/** Seconds between two calls from one agent to the same other agent. */
export const AGENT_CALL_COOLDOWN_KEY = 'agent_call_cooldown_sec';
export const AGENT_CALL_COOLDOWN_DEFAULT = 30;

/** Daemon settings changed at runtime (Sunny's model, defaults for new agents), as JSON by key. */
export class SettingsStore {
  constructor(private readonly sql: Sql) {}

  async get<T>(key: string): Promise<T | undefined> {
    const [row] = await this.sql<{ value: T }[]>`select value from settings where key = ${key}`;
    return row?.value;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.sql`
      insert into settings (key, value) values (${key}, ${this.sql.json(value as never)})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }

  /** Every setting, for backups. */
  async dump(): Promise<Record<string, unknown>> {
    const rows = await this.sql<{ key: string; value: unknown }[]>`select key, value from settings order by key`;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async delete(key: string): Promise<void> {
    await this.sql`delete from settings where key = ${key}`;
  }
}
