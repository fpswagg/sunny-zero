import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import '../../src/config.ts'; // loads .env
import { connectDb, migrate, type Sql } from '../../src/db/db.ts';

/** The test database: SUNNY_TEST_DATABASE_URL, or a "sunny_test" database next to SUNNY_DATABASE_URL. */
function testUrl(): string {
  if (process.env.SUNNY_TEST_DATABASE_URL) return process.env.SUNNY_TEST_DATABASE_URL;
  const main = process.env.SUNNY_DATABASE_URL;
  if (!main) throw new Error('Tests need Postgres: set SUNNY_DATABASE_URL (or SUNNY_TEST_DATABASE_URL) in .env');
  const url = new URL(main);
  url.pathname = '/sunny_test';
  return url.toString();
}

async function ensureDatabase(url: string): Promise<void> {
  const admin = new URL(url);
  const name = admin.pathname.slice(1);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const [exists] = await sql`select 1 from pg_database where datname = ${name}`;
    if (!exists) await sql.unsafe(`create database "${name}"`).catch((err) => {
      if (err.code !== '42P04' && err.code !== '23505') throw err; // created meanwhile by another test file
    });
  } finally {
    await sql.end();
  }
}

/** A migrated, empty schema of its own; `reset()` empties it, `drop()` removes it. */
export async function testDb(migrateTo?: number): Promise<{ sql: Sql; reset(): Promise<void>; drop(): Promise<void> }> {
  const url = testUrl();
  await ensureDatabase(url);
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create schema ${schema}`);
  const sql = connectDb(url, { max: 3, connection: { search_path: schema } });
  await migrate(sql, migrateTo);
  return {
    sql,
    async reset() {
      await sql`truncate sessions, conversations, secrets, runs, notifications, identities, agent_access, telegram_chats, connector_state, metrics, events, settings, pending_tasks, open_turns`;
      await sql`delete from users where role <> 'owner'`;
    },
    async drop() {
      await sql.end();
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
