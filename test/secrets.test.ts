import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets/store.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
beforeEach(() => db.reset());
afterAll(() => db.drop());

const keyDir = () => mkdtempSync(join(tmpdir(), 'sunny-secrets-'));

describe('SecretStore', () => {
  it('round-trips values and never stores them in clear', async () => {
    const dir = keyDir();
    const store = new SecretStore(db.sql, dir);
    await store.set('github:token', { token: 'ghp_supersecret' }, { kind: 'form', label: 'GitHub' });
    expect(await store.get('github:token')).toEqual({ token: 'ghp_supersecret' });
    const rows = await db.sql`select * from secrets`;
    expect(JSON.stringify(rows)).not.toContain('supersecret');
    expect(statSync(join(dir, 'master.key')).mode & 0o777).toBe(0o600);
    expect(await store.list()).toEqual([expect.objectContaining({ id: 'github:token', fields: ['token'], kind: 'form', label: 'GitHub' })]);
  });

  it('reads back with a fresh instance, patches and deletes', async () => {
    const dir = keyDir();
    await new SecretStore(db.sql, dir).set('a', { x: '1' }, { kind: 'form' });
    const again = new SecretStore(db.sql, dir);
    await again.patch('a', { y: '2' });
    expect(await again.get('a')).toEqual({ x: '1', y: '2' });
    expect(await again.has('a')).toBe(true);
    expect(await again.delete('a')).toBe(true);
    expect(await again.delete('a')).toBe(false);
    expect(await again.get('a')).toBeUndefined();
  });

  it('rejects another key and a row moved to another id', async () => {
    const store = new SecretStore(db.sql, keyDir());
    await store.set('a', { x: '1' }, { kind: 'form' });
    const other = new SecretStore(db.sql, keyDir(), Buffer.alloc(32, 7).toString('base64'));
    await expect(other.get('a')).rejects.toThrow();
    await db.sql`update secrets set id = 'b' where id = 'a'`;
    await expect(store.get('b')).rejects.toThrow();
  });
});
