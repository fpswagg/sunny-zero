# Security

Sunny gives AI agents real power on your server. It is built to keep you in control. This page says how, and what you should do.

## How Sunny protects you

- **Owner only.** Bots answer only Telegram accounts you linked, in private chats. Everyone else is ignored and logged. The terminal and `/ws` need the admin token (`data/admin.token`).
- **Approvals.** Agents reach only their own folder. Other folders, shell commands not on their allowlist, and connector actions that change things (send, post, redeploy, restart) ask you first, with ✅ / ❌ buttons. Unanswered approvals are denied after 10 minutes.
- **Secrets never go through chat.** Tokens, keys and passwords are typed on one-time HTTPS pages (single use, 15 minutes), encrypted with AES-256-GCM in Postgres. The key lives outside the database (`data/master.key` or `SUNNY_MASTER_KEY`).
- **Agents never see secrets.** Connectors use the credentials; agents only get the tools. Secret-looking environment variables are removed from agents, and secret files (`.env`, `*.key`, `*.pem`, SSH keys, `.pgpass`…) are unreadable to them, even in read-only folders. Sunny's own data folder is always off-limits.
- **Provider keys stay in the proxy.** Runs on API providers get a token valid for one run on the loopback proxy.
- **Guests are contained.** A guest only uses the agents you granted. Anything they ask that changes something asks you, even on agents that normally don't ask. They never get Sunny, approvals or your history.
- **Webhooks are signed.** `/events/<source>` needs `SUNNY_EVENTS_SECRET` (compared in constant time) and is off until you set it.
- **Agents are isolated from your Claude setup.** They don't load your `~/.claude` settings, plugins or claude.ai connectors.

## What it can't protect you from

- A **`full`** agent can do anything your user can. Give it only to agents you write and trust.
- **Prompt injection.** Web pages, mails and messages an agent reads can contain instructions. Sunny's prompt tells agents to treat them as data, and approvals catch risky actions, but auto-approved tools and allowlisted commands run without asking. Keep those lists small, especially on agents that read untrusted content.
- **Your Claude account and your server** are only as safe as their passwords and SSH keys.

## Checklist

- [ ] Run Sunny as a normal user, not root. Don't give that user passwordless `sudo` if agents will have `Bash`.
- [ ] SSH with keys only; disable password login.
- [ ] Firewall: open only 22, 80 and 443 (`ufw default deny incoming && ufw allow 22,80,443/tcp && ufw enable`). Port 3210 and Postgres 5432 stay on loopback.
- [ ] `SUNNY_BIND=127.0.0.1` (the default) unless your proxy needs otherwise; then block 3210 from outside, IPv4 **and** IPv6.
- [ ] HTTPS for `SUNNY_PUBLIC_URL` (see [HTTPS.md](HTTPS.md)).
- [ ] Back up `data/master.key` somewhere safe, apart from database dumps. Never commit it.
- [ ] Change the default Postgres password if others use the machine.
- [ ] Keep `.env` out of git (it is in `.gitignore`).
- [ ] Prefer `restricted` agents. Grant folders read-only when reading is enough. Keep `commands` and `autoApprove` short.
- [ ] Set `/budget` limits on agents that run on API keys or on schedules.
- [ ] Unlink Telegram accounts you no longer use (`/telegram`).
- [ ] Update regularly (`git pull && pnpm install`).

## Reporting a problem

Open an issue without details for anything sensitive, and ask for a private channel.
