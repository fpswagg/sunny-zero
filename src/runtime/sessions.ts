import type { Sql } from '../db/db.ts';
import type { AgentDefinition } from '../agents/schema.ts';
import type { Speaker } from '../users/users.ts';

/** Maps (agent, conversation) to the Claude Code session that holds its history. */
export class SessionStore {
  constructor(private readonly sql: Sql) {}

  /**
   * The store key for this agent and conversation, or undefined when the turn starts fresh.
   * Background runs (task:*) are not a chat, so "conversation" memory starts them fresh; a
   * member never joins the owner's "shared" history and gets one per conversation instead.
   */
  static key(def: Pick<AgentDefinition, 'name' | 'memory'>, conversationId: string, role: Speaker['role'] = 'owner'): string | undefined {
    switch (def.memory.session) {
      case 'none':
        return undefined;
      case 'shared':
        return role === 'member' ? `${def.name}::${conversationId}` : `${def.name}::*`;
      case 'conversation':
        return conversationId.startsWith('task:') ? undefined : `${def.name}::${conversationId}`;
    }
  }

  /** `ns` is the model family the history was written with (see sessionNamespace). */
  async get(key: string, cwd: string, ns = 'claude'): Promise<string | undefined> {
    const [row] = await this.sql<{ session_id: string; cwd: string; ns: string }[]>`select session_id, cwd, ns from sessions where key = ${key}`;
    // Sessions are stored per working directory, so a moved workdir cannot be resumed; nor can another model family's.
    return row && row.cwd === cwd && row.ns === ns ? row.session_id : undefined;
  }

  async set(key: string, sessionId: string, cwd: string, ns = 'claude'): Promise<void> {
    await this.sql`
      insert into sessions (key, session_id, cwd, ns) values (${key}, ${sessionId}, ${cwd}, ${ns})
      on conflict (key) do update set session_id = excluded.session_id, cwd = excluded.cwd, ns = excluded.ns, updated_at = now()`;
  }

  async clear(key: string): Promise<void> {
    await this.sql`delete from sessions where key = ${key}`;
  }

  /** Forget every session of an agent (e.g. after it is deleted). */
  async clearAgent(name: string): Promise<void> {
    await this.sql`delete from sessions where starts_with(key, ${`${name}::`})`;
  }
}
