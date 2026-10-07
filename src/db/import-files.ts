import { existsSync } from 'node:fs';
import { readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from './db.ts';
import { log } from '../log.ts';

/**
 * Before Postgres, state lived in JSON files under data/. On start, any such file still there is
 * imported (existing rows win) and renamed to *.imported, so this runs once per file.
 */
export async function importLegacyFiles(sql: Sql, dataDir: string): Promise<void> {
  const json = async <T>(name: string): Promise<T | undefined> => {
    const path = join(dataDir, name);
    return existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as T) : undefined;
  };
  const lines = async (path: string): Promise<Record<string, any>[]> =>
    (await readFile(path, 'utf8'))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
  const done: string[] = [];
  const counts: Record<string, number> = {};

  await sql.begin(async (tx) => {
    const sessions = await json<Record<string, { sessionId: string; cwd: string; updatedAt?: string }>>('sessions.json');
    if (sessions) {
      for (const [key, s] of Object.entries(sessions)) {
        await tx`insert into sessions (key, session_id, cwd, updated_at) values (${key}, ${s.sessionId}, ${s.cwd}, ${s.updatedAt ?? new Date().toISOString()}) on conflict do nothing`;
      }
      counts.sessions = Object.keys(sessions).length;
      done.push('sessions.json');
    }

    const conversations = await json<Record<string, { agent: string }>>('conversations.json');
    if (conversations) {
      for (const [id, c] of Object.entries(conversations)) await tx`insert into conversations (id, agent) values (${id}, ${c.agent}) on conflict do nothing`;
      counts.conversations = Object.keys(conversations).length;
      done.push('conversations.json');
    }

    // Copied still encrypted: the master key stays the same.
    const secrets = await json<Record<string, { id: string; kind: string; label?: string; fields: string[]; iv: string; tag: string; data: string; createdAt: string; updatedAt: string }>>('secrets.json');
    if (secrets) {
      for (const s of Object.values(secrets)) {
        await tx`
          insert into secrets (id, kind, label, fields, iv, tag, data, created_at, updated_at)
          values (${s.id}, ${s.kind}, ${s.label ?? null}, ${s.fields}, ${s.iv}, ${s.tag}, ${s.data}, ${s.createdAt}, ${s.updatedAt})
          on conflict do nothing`;
      }
      counts.secrets = Object.keys(secrets).length;
      done.push('secrets.json');
    }

    const telegram = await json<{ owners: { id: number; name: string; username?: string; pairedAt: string }[] }>('telegram.json');
    if (telegram) {
      for (const o of telegram.owners) {
        const label = `${o.name}${o.username ? ` (@${o.username})` : ''}`;
        await tx`insert into identities (channel, external_id, user_id, label, created_at) values ('telegram', ${String(o.id)}, 'owner', ${label}, ${o.pairedAt}) on conflict do nothing`;
        await tx`insert into telegram_chats (bot, chat_id, user_id, started_at) values ('sunny', ${o.id}, 'owner', ${o.pairedAt}) on conflict do nothing`;
      }
      counts.telegramOwners = telegram.owners.length;
      done.push('telegram.json');
    }

    const runsDir = join(dataDir, 'runs');
    if (existsSync(runsDir)) {
      for (const file of (await readdir(runsDir)).filter((f) => f.endsWith('.jsonl'))) {
        for (const r of await lines(join(runsDir, file))) {
          await tx`
            insert into runs (at, agent, conversation, origin, message, reply, is_error, cost_usd, duration_ms, session_id)
            values (${r.at}, ${r.agent}, ${r.conversation}, ${r.origin ?? 'message'}, ${r.message ?? ''}, ${r.reply ?? ''}, ${!!r.isError},
                    ${r.costUsd ?? null}, ${Math.round(r.durationMs ?? 0)}, ${r.sessionId ?? null})`;
          counts.runs = (counts.runs ?? 0) + 1;
        }
        done.push(join('runs', file));
      }
    }

    if (existsSync(join(dataDir, 'notifications.jsonl'))) {
      for (const n of await lines(join(dataDir, 'notifications.jsonl'))) {
        await tx`
          insert into notifications (at, agent, conversation, silent, delivered, text)
          values (${n.at}, ${n.agent}, ${n.conversation}, ${!!n.silent}, ${n.delivered ?? []}, ${n.text})`;
        counts.notifications = (counts.notifications ?? 0) + 1;
      }
      done.push('notifications.jsonl');
    }
  });

  for (const file of done) await rename(join(dataDir, file), join(dataDir, `${file}.imported`));
  if (done.length) log.info({ counts }, 'imported data/ files into Postgres (originals renamed *.imported)');
}
