import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Sql } from '../db/db.ts';

export type SecretValues = Record<string, string>;

export interface SecretInfo {
  id: string;
  /** form | oauth2 | steps — how it was collected. */
  kind: string;
  /** Field names stored, never their values. */
  fields: string[];
  label?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  kind: string;
  label: string | null;
  fields: string[];
  iv: string;
  tag: string;
  data: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Credentials encrypted with AES-256-GCM and stored in Postgres. The key never goes in the
 * database: it comes from SUNNY_MASTER_KEY or a data/master.key file created on first use
 * (mode 0600). Agents never read this store; only connectors and the auth flows do.
 */
export class SecretStore {
  private key: Buffer | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly dataDir: string,
    private readonly masterKey?: string,
  ) {}

  private async getKey(): Promise<Buffer> {
    if (this.key) return this.key;
    if (this.masterKey) {
      this.key = Buffer.from(this.masterKey, 'base64');
    } else {
      const path = join(this.dataDir, 'master.key');
      if (!existsSync(path)) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
      }
      this.key = Buffer.from((await readFile(path, 'utf8')).trim(), 'base64');
    }
    if (this.key.length !== 32) throw new Error('master key must be 32 bytes (base64)');
    return this.key;
  }

  async set(id: string, values: SecretValues, meta: { kind: string; label?: string }): Promise<void> {
    const key = await this.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    // Bound to the id, so a row copied under another id does not decrypt.
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    await this.sql`
      insert into secrets (id, kind, label, fields, iv, tag, data)
      values (${id}, ${meta.kind}, ${meta.label ?? null}, ${Object.keys(values)}, ${iv.toString('base64')}, ${cipher.getAuthTag().toString('base64')}, ${data.toString('base64')})
      on conflict (id) do update set kind = excluded.kind, label = excluded.label, fields = excluded.fields,
        iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = now()`;
  }

  async get(id: string): Promise<SecretValues | undefined> {
    const [row] = await this.sql<Row[]>`select * from secrets where id = ${id}`;
    if (!row) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', await this.getKey(), Buffer.from(row.iv, 'base64'));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(row.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as SecretValues;
  }

  /** Merge values into an existing secret (e.g. a refreshed OAuth access token). */
  async patch(id: string, values: SecretValues): Promise<void> {
    const current = await this.get(id);
    const [info] = await this.sql<Row[]>`select kind, label from secrets where id = ${id}`;
    if (!current || !info) throw new Error(`no secret "${id}"`);
    await this.set(id, { ...current, ...values }, { kind: info.kind, label: info.label ?? undefined });
  }

  async list(): Promise<SecretInfo[]> {
    const rows = await this.sql<Row[]>`select id, kind, label, fields, created_at, updated_at from secrets order by id`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label ?? undefined,
      fields: r.fields,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async has(id: string): Promise<boolean> {
    const [row] = await this.sql`select 1 from secrets where id = ${id}`;
    return !!row;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from secrets where id = ${id} returning id`;
    return rows.length > 0;
  }
}
