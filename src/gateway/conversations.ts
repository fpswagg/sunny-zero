import type { Sql } from '../db/db.ts';

/** Per-conversation chat state: which agent receives plain messages ("sunny" when unset). */
export class ConversationStore {
  constructor(private readonly sql: Sql) {}

  async agent(conversationId: string): Promise<string | undefined> {
    const [row] = await this.sql<{ agent: string }[]>`select agent from conversations where id = ${conversationId}`;
    return row?.agent;
  }

  async setAgent(conversationId: string, agent: string): Promise<void> {
    await this.sql`
      insert into conversations (id, agent) values (${conversationId}, ${agent})
      on conflict (id) do update set agent = excluded.agent, updated_at = now()`;
  }
}
