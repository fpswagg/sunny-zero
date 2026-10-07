import postgres from 'postgres';

export type Sql = postgres.Sql;

/** Connects to Postgres. int8 columns (Telegram ids, serials) come back as numbers; they stay below 2^53. */
export function connectDb(url: string, options: postgres.Options<Record<string, postgres.PostgresType>> = {}): Sql {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    types: { bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number) => String(x) } },
    ...options,
  }) as unknown as Sql;
}

/** Schema changes, applied in order once each. Never edit an applied one: add a new entry. */
const MIGRATIONS: string[] = [
  `
  create table sessions (
    key text primary key,
    session_id text not null,
    cwd text not null,
    updated_at timestamptz not null default now()
  );
  create table conversations (
    id text primary key,
    agent text not null,
    updated_at timestamptz not null default now()
  );
  create table secrets (
    id text primary key,
    kind text not null,
    label text,
    fields text[] not null,
    iv text not null,
    tag text not null,
    data text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table telegram_owners (
    id bigint primary key,
    name text not null,
    username text,
    paired_at timestamptz not null default now()
  );
  create table runs (
    id bigserial primary key,
    at timestamptz not null default now(),
    agent text not null,
    conversation text not null,
    origin text not null,
    message text not null,
    reply text not null,
    is_error boolean not null,
    cost_usd double precision,
    duration_ms integer not null,
    session_id text
  );
  create index runs_agent_at on runs (agent, at desc);
  create table notifications (
    id bigserial primary key,
    at timestamptz not null default now(),
    agent text not null,
    conversation text not null,
    silent boolean not null,
    delivered text[] not null,
    text text not null
  );
  create index notifications_at on notifications (at desc);
  `,
  // Users and access: one owner, any number of members; Telegram accounts are identities of a user.
  // Telegram conversations gain the bot they belong to: telegram:<chat> becomes telegram:sunny:<chat>.
  `
  create table users (
    id text primary key,
    name text not null,
    role text not null check (role in ('owner', 'member')),
    created_at timestamptz not null default now()
  );
  create table identities (
    channel text not null,
    external_id text not null,
    user_id text not null references users (id) on delete cascade,
    label text,
    created_at timestamptz not null default now(),
    primary key (channel, external_id)
  );
  create table agent_access (
    user_id text not null references users (id) on delete cascade,
    agent text not null,
    granted_at timestamptz not null default now(),
    primary key (user_id, agent)
  );
  create table telegram_chats (
    bot text not null,
    chat_id bigint not null,
    user_id text not null references users (id) on delete cascade,
    started_at timestamptz not null default now(),
    primary key (bot, chat_id)
  );
  create table connector_state (
    connector text not null,
    key text not null,
    value jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (connector, key)
  );
  create table metrics (
    at timestamptz primary key,
    data jsonb not null
  );
  create table events (
    id bigserial primary key,
    at timestamptz not null default now(),
    source text not null,
    name text not null,
    summary text not null,
    data jsonb not null,
    agents text[] not null default '{}'
  );
  create index events_at on events (at desc);

  insert into users (id, name, role) values ('owner', 'Owner', 'owner');
  insert into identities (channel, external_id, user_id, label, created_at)
    select 'telegram', id::text, 'owner', name || coalesce(' (@' || username || ')', ''), paired_at from telegram_owners;
  insert into telegram_chats (bot, chat_id, user_id, started_at) select 'sunny', id, 'owner', paired_at from telegram_owners;
  drop table telegram_owners;

  update conversations set id = regexp_replace(id, '^telegram:(-?[0-9]+)$', 'telegram:sunny:\\1') where id ~ '^telegram:-?[0-9]+$';
  update sessions set key = regexp_replace(key, '::telegram:(-?[0-9]+)$', '::telegram:sunny:\\1') where key ~ '::telegram:-?[0-9]+$';
  update runs set conversation = regexp_replace(conversation, '^telegram:(-?[0-9]+)$', 'telegram:sunny:\\1') where conversation ~ '^telegram:-?[0-9]+$';
  update notifications set conversation = regexp_replace(conversation, '^telegram:(-?[0-9]+)$', 'telegram:sunny:\\1') where conversation ~ '^telegram:-?[0-9]+$';
  update notifications set delivered = array(select regexp_replace(d, '^telegram:(-?[0-9]+)$', 'telegram:sunny:\\1') from unnest(delivered) d);
  `,
  // Model providers: which model family a session was written with, what each run used, and daemon settings.
  `
  alter table sessions add column ns text not null default 'claude';
  alter table runs add column model text, add column input_tokens bigint, add column output_tokens bigint;
  create table settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now()
  );
  `,
  // Agent web apps: browser sessions (cookie hash only) for people outside Telegram.
  `
  create table web_sessions (
    token_hash text primary key,
    user_id text not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at timestamptz not null,
    user_agent text
  );
  create index web_sessions_user on web_sessions (user_id);
  `,
  // Activity: model fallbacks and agent-to-agent calls, for the Mini App and /activity.
  `
  create table activity (
    id bigserial primary key,
    at timestamptz not null default now(),
    kind text not null,
    agent text not null,
    other text,
    detail text not null,
    ok boolean not null default true
  );
  create index activity_at on activity (at desc);
  create index activity_kind_at on activity (kind, at desc);
  `,
  // Background runs that have not finished: resumed after a restart, or parked until a limit resets.
  `
  create table pending_tasks (
    id bigserial primary key,
    agent text not null,
    message text not null,
    origin text not null,
    status text not null default 'running',
    created_at timestamptz not null default now(),
    resume_after timestamptz,
    signature text,
    reason text,
    attempts integer not null default 0
  );
  `,
  // Chat turns in progress: if Sunny restarts mid-turn, the agent picks the conversation up again.
  `
  create table open_turns (
    id bigserial primary key,
    conversation_id text not null,
    agent text not null,
    speaker jsonb not null,
    resumes integer not null default 0,
    started_at timestamptz not null default now()
  );
  `,
];

/** Brings the schema up to date (or up to `target`, for tests). Safe to run from several processes at once. */
export async function migrate(sql: Sql, target = MIGRATIONS.length): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(726166)`;
    await tx`create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())`;
    const [row] = await tx<{ version: number | null }[]>`select max(version) as version from schema_migrations`;
    const current = row?.version ?? 0;
    for (let v = current + 1; v <= target; v++) {
      await tx.unsafe(MIGRATIONS[v - 1]!);
      await tx`insert into schema_migrations (version) values (${v})`;
    }
    return Math.max(0, target - current);
  });
}
