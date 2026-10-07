# Advanced setup

For people who want more than the [simple path](../SETUP.md): API keys, other providers, several Claude accounts, every setting, running without Docker or pm2.

## Requirements

- Node.js ≥ 22.12 and pnpm (the version pinned in `package.json` is downloaded automatically).
- PostgreSQL 14+ (any server; `docker compose up -d` starts a local one).
- Claude Code (`npm i -g @anthropic-ai/claude-code`) if any agent uses the Claude subscription (the default).
- pm2 for production, or any process manager (systemd works too, see [DEPLOYMENT.md](DEPLOYMENT.md)).

## All settings (`.env`)

Only `SUNNY_DATABASE_URL` matters for a first start. `.env.example` has every variable with a comment.

| Variable | Default | What |
|---|---|---|
| `SUNNY_DATABASE_URL` | | Postgres URL. The schema is created and migrated on start. |
| `SUNNY_PUBLIC_URL` | | Public HTTPS address (secure pages, OAuth, Telegram apps). See [HTTPS.md](HTTPS.md). |
| `SUNNY_PORT` / `SUNNY_BIND` | `3210` / `127.0.0.1` | Where the daemon listens. Keep loopback behind a proxy. |
| `SUNNY_TIMEZONE` | `UTC` | Timezone of cron triggers (an agent's trigger can set its own). |
| `SUNNY_MODEL` | `opus` | Sunny's own model. |
| `SUNNY_AGENT_DEFAULT_MODEL` | `sonnet` | Model of new agents that name none. |
| `SUNNY_VOICE_LIGHT` | `true` | Voice notes and calls use the provider's light model. |
| `SUNNY_COMPACT_TOKENS` | `200000` | Summarise conversations beyond this size. `0`: Claude Code's default. |
| `SUNNY_USE_API_KEY` | `false` | Let runs on the subscription use `ANTHROPIC_API_KEY` instead (see below). |
| `SUNNY_CLAUDE_MAIN` | | With several Claude accounts, the one to use first. |
| `SUNNY_APPROVAL_TIMEOUT_MIN` | `10` | Unanswered approvals are denied after this. |
| `SUNNY_AUTH_LINK_TTL_MIN` | `15` | Lifetime of one-time secure links. |
| `SUNNY_MASTER_KEY` | | Base64 32-byte key for stored credentials. Unset: `data/master.key` is created. |
| `SUNNY_INBOX_DAYS` | `30` | Files sent in chat are kept this long. |
| `SUNNY_WHISPER_MODEL` / `SUNNY_WHISPER_LANGUAGES` / `SUNNY_TRANSCRIBE_MAX_MIN` | | Local voice transcription (see [TELEGRAM.md](TELEGRAM.md)). |
| `SUNNY_EVENTS_SECRET` | | Shared secret (16+ chars) for `POST /events/<source>` webhooks. See [API.md](API.md). |
| `SUNNY_DATA_DIR` / `SUNNY_AGENTS_DIR` | `./data` / `./agents` | Where Sunny keeps its files and agents. |
| `LOG_LEVEL` | `info` | `trace` … `error`. |

Changes to `.env` need a restart: `pnpm pm2:start` (it reloads with the new environment).

## Claude: subscription, tokens, several accounts

- **Subscription (default).** Runs use the `claude` login of the user that runs Sunny (`claude auth login`).
- **Headless token.** `claude setup-token` prints a long-lived token. Put it in the environment of the daemon as `CLAUDE_CODE_OAUTH_TOKEN` (for example in `ecosystem.config.cjs` or a systemd unit), not in a file agents can read.
- **Two subscriptions.** `/account add` (Telegram) or "add a Claude account" to Sunny sends a secure page: sign in with the other account and paste the code. When one hits its limit, agents move to the next and you are told. `/account switch` changes it by hand.
- **Claude API key.** Prefer the `anthropic` provider ([PROVIDERS.md](PROVIDERS.md)): the key is stored encrypted and agents never see it. `SUNNY_USE_API_KEY=true` is the old way: it lets the Claude Code runs use `ANTHROPIC_API_KEY` from Sunny's environment.

## Other providers

Agents can run on the Claude API, OpenAI, Google Gemini, Moonshot Kimi or OpenRouter, each with its own key, while keeping Claude Code's tools and permissions. See [PROVIDERS.md](PROVIDERS.md). Keys go through `/connect <provider>`, never `.env`.

## Without Docker

Any Postgres works. Create a user and a database, then point `SUNNY_DATABASE_URL` at it:

```sh
sudo -u postgres psql -c "create user sunny with password 'change-me';"
sudo -u postgres psql -c "create database sunny owner sunny;"
```

## Without pm2

`pnpm serve` runs the daemon in the foreground (`pnpm dev` restarts it on code changes). Never run it next to the pm2 one: they would share the port and the Telegram bots. A systemd unit is in [DEPLOYMENT.md](DEPLOYMENT.md).

## The `sunny` command

```sh
ln -s "$PWD/bin/sunny" ~/.local/bin/sunny
sunny chat
```

See [CLI.md](CLI.md).

## Voice replies

Agents can answer with voice notes. Connect ElevenLabs, OpenAI or Gemini keys (ask Sunny) and set an agent's `voice` (see [BUILDING-AGENTS.md](BUILDING-AGENTS.md)). Incoming voice is transcribed by ElevenLabs or OpenAI when their keys are connected, otherwise locally with Whisper.

## OAuth apps (Google, GitHub, Microsoft…)

Connectors that sign in with a provider (Gmail, Drive, YouTube, Spotify, Dropbox, Figma, Reddit, X, TikTok) need an OAuth client registered with that provider. The first time, Sunny's secure page asks for the client id and secret and shows the **redirect URI** to register: `SUNNY_PUBLIC_URL/auth/oauth/callback`. Details per connector in [CONNECTORS.md](CONNECTORS.md).
