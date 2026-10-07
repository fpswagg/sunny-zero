# Testing

The suite uses [Vitest](https://vitest.dev). Most tests run without network or Claude; the database tests need Postgres.

```sh
docker compose up -d     # the Postgres from docker-compose.yml
pnpm typecheck           # TypeScript, no emit
pnpm test                # all tests
pnpm vitest run test/triggers.test.ts   # one file
pnpm vitest              # watch mode
```

**Database.** Tests use `SUNNY_TEST_DATABASE_URL` if set, otherwise a `sunny_test` database next to `SUNNY_DATABASE_URL` (created on first run; the user needs the right to create databases, which the Docker one has). Your real data is never touched.

**Files.** Tests write to `/tmp/sunny-test-data` and `/tmp/sunny-test-agents` (see `vitest.config.ts`), never to `data/` or `agents/`.

**What is covered:** agent schema and registry, the permission policy (folders, secret files, command patterns), the gateway (routing, commands, approvals, guests, voice-only replies), Telegram (hub, Markdown, media), triggers and the event bus, the server monitor's rules, providers and the model proxy translation, the secret store, auth flows, the apps' APIs, maintenance jobs.

`test/agents-in-repo.test.ts` checks every folder in `agents/`: a valid `agent.json`, a real `prompt.md` and an `icon.svg`. Run it after adding an agent by hand.

## Trying a change safely

Run a second daemon next to your real one with its own database, folders and port, and **without** Telegram (a bot can only be polled by one daemon):

```sh
SUNNY_PORT=3299 SUNNY_DATA_DIR=/tmp/sunny-dev/data SUNNY_AGENTS_DIR=/tmp/sunny-dev/agents \
SUNNY_DATABASE_URL=postgresql://sunny:sunny@127.0.0.1:5432/sunny_dev pnpm dev
```

Create the `sunny_dev` database first (`docker exec sunny-db createdb -U sunny sunny_dev`).
