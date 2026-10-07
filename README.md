# ☀ Sunny Zero

**Your own team of AI agents, running on your Claude subscription, on your server.**

Sunny is a self-hosted agent system built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). You talk to **Sunny** (on Telegram, in a web app or in the terminal), describe what you need, and Sunny designs, creates, tests and manages other agents for you, then hands work to them.

```
 Telegram ─┐                          ┌─ Sunny (creates, manages, delegates)
 Web app ──┼─► Gateway ─► Runner ─────┤
 Terminal ─┘   (commands,  (Agent SDK) └─ your agents (agents/<name>/)
               approvals)                    └─ connectors (Gmail, GitHub, Notion, this server…)
```

Sunny Zero starts empty: no agents, no memory, no data. Sunny is the only agent, and on the first run it walks you through the setup.

## What you get

- **Sunny, an agent that builds agents.** "Make me an agent that checks my server every morning and tells me if a disk is filling up": Sunny writes its prompt, picks its tools, gives it a schedule and an icon, and tests it.
- **Telegram first.** Talk to Sunny and to each agent (every agent can have its own bot). Send text, photos, files and voice notes (transcribed on your server). Approvals come as ✅ / ❌ buttons.
- **Runs on your Claude subscription.** No API key needed. Other providers (Claude API, OpenAI, Gemini, Kimi, OpenRouter) are optional.
- **Safe by default.** Agents only reach their own folder. Anything else (shell commands, other folders, sending mail) asks you first. Secrets are typed on one-time secure pages, stored encrypted, and never shown to agents.
- **Connectors:** this server (CPU, disks, pm2, Docker, HTTP/TLS checks, alerts), Gmail, Google Drive, GitHub, Vercel, Notion, Notion Calendar, Dropbox, Figma, Spotify, YouTube, Reddit, X, Instagram, TikTok, Letterboxd, your personal Telegram account, and notifications.
- **Triggers:** agents run when you message them, on a schedule (cron), or when an event arrives (a server alert, a webhook).
- **Friends:** give a guest access to one of your agents; anything they ask that changes things asks you.

## Best on a VPS

Sunny is a daemon: it should run 24/7, keep its Telegram bots online and run scheduled agents while you sleep. A small Linux VPS (Debian or Ubuntu, 2 vCPU, 4 GB RAM, 20 GB disk) is the right home for it. It also runs on a laptop for testing, but agents stop when the laptop sleeps, and the secure pages need a public HTTPS address.

## Get started

👉 **[SETUP.md](SETUP.md)**: the simple path. A VPS, your Claude subscription, Telegram. About 20 minutes.

Experts: **[docs/SETUP-ADVANCED.md](docs/SETUP-ADVANCED.md)** (API keys, other providers, your own proxy, tuning).

## Documentation

| | |
|---|---|
| [SETUP.md](SETUP.md) | Simple setup: VPS + Claude subscription + Telegram |
| [docs/SETUP-ADVANCED.md](docs/SETUP-ADVANCED.md) | Every setting, API keys, several Claude accounts |
| [docs/HTTPS.md](docs/HTTPS.md) | A public HTTPS address (Caddy, or your own proxy) |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Models and providers: Claude, OpenAI, Gemini, Kimi, OpenRouter |
| [docs/BUILDING-AGENTS.md](docs/BUILDING-AGENTS.md) | How agents work: `agent.json`, access, memory, triggers |
| [docs/CONNECTORS.md](docs/CONNECTORS.md) | Every connector and how to set it up |
| [docs/TELEGRAM.md](docs/TELEGRAM.md) | Bots, commands, media, guests, notifications |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Example agents and workflows |
| [docs/CLI.md](docs/CLI.md) | The `sunny` command and chat commands |
| [docs/API.md](docs/API.md) | HTTP and WebSocket endpoints, webhooks |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | pm2, Docker, updates, backups |
| [docs/SECURITY.md](docs/SECURITY.md) | How Sunny protects you, and a checklist |
| [docs/TESTING.md](docs/TESTING.md) | Running the test suite |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and fixes |

## Requirements

- Linux (macOS works for development), Node.js ≥ 22.12, pnpm, PostgreSQL (the included `docker-compose.yml` starts one).
- [Claude Code](https://docs.claude.com/en/docs/claude-code) logged in with your Claude subscription (Pro or Max).
- A Telegram account (recommended).

## License

[MIT](LICENSE) © fpswagg
