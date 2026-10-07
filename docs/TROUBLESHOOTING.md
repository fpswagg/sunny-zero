# Troubleshooting

First look at the logs: `pnpm pm2:logs` (or `logs/` in the project folder).

**Sunny doesn't start: "SUNNY_DATABASE_URL is not set" or ECONNREFUSED.** Postgres isn't running or the URL is wrong. `docker compose up -d`, then `docker ps` should show `sunny-db`. Check `SUNNY_DATABASE_URL` in `.env`.

**"Not logged in" / "Please run /login" / 401.** The Claude login of the user running Sunny is missing or expired. As that user: `claude auth login`, then retry (no restart needed). With several accounts: `/account`.

**"Usage limit reached".** Your subscription's limit for this period. `/limits` shows when it resets. Add a second account (`/account add`) or give agents `fallbackModels` on another provider.

**`sunny chat` / `setup` says it can't connect.** The daemon isn't running (`pm2 ls`), or it listens on another port than the client expects (`SUNNY_PORT`).

**The Telegram bot doesn't answer.**
- Only linked accounts in private chats get answers. Run `pnpm sunny setup telegram` again for a fresh link, or `/telegram pair` from a linked account.
- Two daemons polling the same bot (a `pnpm serve` next to pm2, or another server) fight over it: stop one.
- Check the logs for `409 Conflict` (same cause) or `401` (token revoked in @BotFather: set it up again).

**Secure links / `/manage` / apps say "needs https".** Set up [HTTPS](HTTPS.md) and `SUNNY_PUBLIC_URL`, then `pnpm pm2:start`.

**The secure page doesn't open on my phone.** `SUNNY_PUBLIC_URL` must be reachable from the internet: try `curl https://your-domain/health` from another machine. Check ports 80/443 at your VPS provider and in `ufw`.

**Caddy can't get a certificate.** The domain must point to this server's IP and port 80 must be open (Let's Encrypt checks it). `docker logs` of the Caddy container says why.

**OAuth sign-in fails with "redirect_uri mismatch".** Register exactly `SUNNY_PUBLIC_URL/auth/oauth/callback` in the provider's app settings.

**An agent keeps asking for approval.** That's the policy working. Add the exact commands it needs to `access.commands`, a folder to `readOnlyDirs` or `extraDirs`, or a tool to `autoApprove`; or ask Sunny to.

**Voice notes are slow the first time.** The Whisper model (about 250 MB) downloads once into `data/models`. Then a short note takes a few seconds.

**High memory.** Each working agent is a Claude Code process. Local transcription uses about 1.3 GB while loaded (it unloads after 10 idle minutes). pm2 restarts Sunny above 2 GB.

**I lost `data/master.key`.** Stored credentials can't be decrypted any more. Delete them (ask Sunny to list and delete credentials) and set them up again. Everything else still works.

**Reset everything.** Stop Sunny, `docker compose down -v` (deletes the database), delete `data/`, start again. Your agents in `agents/` stay unless you delete them too.
