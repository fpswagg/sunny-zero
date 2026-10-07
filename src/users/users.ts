import type { Sql } from '../db/db.ts';

export type Role = 'owner' | 'member';

export interface User {
  id: string;
  name: string;
  role: Role;
}

/**
 * Who a turn runs for. Owners can do everything; members only use the agents granted to them
 * and never answer approvals; "system" is a background run (schedule, event).
 */
export interface Speaker {
  id: string;
  name: string;
  role: Role | 'system';
}

export const SYSTEM: Speaker = { id: 'system', name: 'Scheduled task', role: 'system' };
export const OWNER_ID = 'owner';
export const USER_ID = /^[a-z][a-z0-9-]{1,31}$/;

export interface Identity {
  channel: string;
  externalId: string;
  label?: string;
}

export interface UserDetails extends User {
  identities: Identity[];
  agents: string[];
}

/** People who may use Sunny, the accounts they use, and which agents members may talk to. */
export class UserStore {
  constructor(private readonly sql: Sql) {}

  async get(id: string): Promise<User | undefined> {
    const [row] = await this.sql<User[]>`select id, name, role from users where id = ${id}`;
    return row;
  }

  async owner(): Promise<User> {
    const user = await this.get(OWNER_ID);
    if (!user) throw new Error('the owner user is missing (database not migrated?)');
    return user;
  }

  async byIdentity(channel: string, externalId: string): Promise<User | undefined> {
    const [row] = await this.sql<User[]>`
      select u.id, u.name, u.role from identities i join users u on u.id = i.user_id
      where i.channel = ${channel} and i.external_id = ${externalId}`;
    return row;
  }

  async list(): Promise<UserDetails[]> {
    const users = await this.sql<User[]>`select id, name, role from users order by role = 'owner' desc, created_at`;
    const identities = await this.sql<{ user_id: string; channel: string; external_id: string; label: string | null }[]>`
      select user_id, channel, external_id, label from identities order by created_at`;
    const grants = await this.sql<{ user_id: string; agent: string }[]>`select user_id, agent from agent_access order by agent`;
    return users.map((u) => ({
      ...u,
      identities: identities.filter((i) => i.user_id === u.id).map((i) => ({ channel: i.channel, externalId: i.external_id, label: i.label ?? undefined })),
      agents: grants.filter((g) => g.user_id === u.id).map((g) => g.agent),
    }));
  }

  async create(id: string, name: string): Promise<User> {
    if (!USER_ID.test(id)) throw new Error('user ids are lowercase letters, digits and dashes (2-32 chars)');
    const [row] = await this.sql<User[]>`
      insert into users (id, name, role) values (${id}, ${name}, 'member') on conflict do nothing returning id, name, role`;
    if (!row) throw new Error(`a user "${id}" already exists`);
    return row;
  }

  async rename(id: string, name: string): Promise<boolean> {
    return (await this.sql`update users set name = ${name} where id = ${id} returning id`).length > 0;
  }

  async remove(id: string): Promise<boolean> {
    if (id === OWNER_ID) throw new Error('the owner cannot be removed');
    return (await this.sql`delete from users where id = ${id} returning id`).length > 0;
  }

  /** Links an account to a user. An account already linked to anyone stays where it is. */
  async addIdentity(userId: string, identity: Identity): Promise<'added' | 'exists'> {
    const rows = await this.sql`
      insert into identities (channel, external_id, user_id, label) values (${identity.channel}, ${identity.externalId}, ${userId}, ${identity.label ?? null})
      on conflict do nothing returning user_id`;
    return rows.length ? 'added' : 'exists';
  }

  async removeIdentity(channel: string, externalId: string): Promise<boolean> {
    return (await this.sql`delete from identities where channel = ${channel} and external_id = ${externalId} returning user_id`).length > 0;
  }

  async grant(userId: string, agent: string): Promise<void> {
    await this.sql`insert into agent_access (user_id, agent) values (${userId}, ${agent}) on conflict do nothing`;
  }

  async revoke(userId: string, agent: string): Promise<boolean> {
    return (await this.sql`delete from agent_access where user_id = ${userId} and agent = ${agent} returning agent`).length > 0;
  }

  /** Forget grants to an agent that no longer exists. */
  async revokeAgent(agent: string): Promise<void> {
    await this.sql`delete from agent_access where agent = ${agent}`;
  }

  async agentsOf(userId: string): Promise<string[]> {
    return (await this.sql<{ agent: string }[]>`select agent from agent_access where user_id = ${userId} order by agent`).map((r) => r.agent);
  }

  /** Owners and background runs use everything; members only their granted agents, never Sunny. */
  async canUse(speaker: Speaker, agent: string): Promise<boolean> {
    if (speaker.role !== 'member') return true;
    if (agent === 'sunny') return false;
    const [row] = await this.sql`select 1 from agent_access where user_id = ${speaker.id} and agent = ${agent}`;
    return !!row;
  }
}
