# Deployment

Sunny is a long-running daemon. It is **best on a VPS**: always on, so bots answer, schedules run and alerts reach you at any hour. It also runs on a home server or a Raspberry Pi 5 (8 GB). A laptop is fine for testing.

**Sizing:** 2 vCPU, 4 GB RAM, 20 GB disk is comfortable. Each running agent is a Claude Code process (about 200–400 MB while it works). Local voice transcription needs about 1.3 GB more while loaded.

## pm2 (recommended)

```sh
pnpm pm2:start      # start or reload with the current .env, and save the process list
pm2 startup         # once: run the command it prints, so pm2 starts at boot
pnpm pm2:logs       # logs (also written to logs/)
pnpm pm2:stop
```

`ecosystem.config.cjs` runs `node --import tsx src/cli.ts serve` and restarts the daemon if it uses more than 2 GB.

## systemd (alternative)

```ini
# /etc/systemd/system/sunny.service
[Unit]
Description=Sunny
After=network-online.target docker.service

[Service]
User=youruser
WorkingDirectory=/home/youruser/sunny
ExecStart=/usr/bin/node --import tsx src/cli.ts serve
Restart=always
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now sunny`. Use one or the other, never both.

## Database

`docker-compose.yml` runs Postgres 17 bound to `127.0.0.1:5432`, data in the `sunny-db` volume. Change the password in both `docker-compose.yml` and `SUNNY_DATABASE_URL` if other users share the machine. A managed Postgres works too.

## Updating

```sh
git pull
pnpm install
pnpm typecheck
pnpm pm2:start      # migrations run on start
```

Restarting stops the runs in progress (agents and Sunny); conversations resume where they were.

## Backups

What to keep:

| | |
|---|---|
| Postgres | conversations, users, encrypted credentials, runs, events: `docker exec sunny-db pg_dump -U sunny sunny > sunny.sql` |
| `data/master.key` (or `SUNNY_MASTER_KEY`) | **the key that decrypts your credentials.** Without it, the stored secrets are lost. Keep it apart from the database dump. |
| `agents/` | your agents (prompts, settings, notes) |
| `.env` | your settings |

Sunny also keeps a daily archive of the agents (definitions, prompts, notes, settings; no secrets or chats), the last 14 (`/backup`, `/backup now` sends one to you).

Example nightly dump, with `crontab -e`:

```cron
30 3 * * * docker exec sunny-db pg_dump -U sunny sunny | gzip > ~/backups/sunny-$(date +\%F).sql.gz
```

## Moving to another server

Copy the database dump, `data/master.key`, `agents/` and `.env`, restore the dump into the new Postgres, log in to Claude (`claude auth login`), then start. Stop the old daemon first: two daemons can't poll the same Telegram bots.

## Docker for Sunny itself?

Sunny is not containerised on purpose: agents work on the host (files, shell, pm2, Docker) with Sunny's permission checks as the safety layer. Inside a container they would only see the container. Only Postgres and the optional Caddy run in Docker.
