# Setup: the simple path

**What you need:** a VPS, a Claude subscription (Pro or Max) and Telegram. No API key.

**Time:** about 20 minutes.

> Sunny runs best on a VPS: it stays online 24/7, so your bots answer and your scheduled agents run even when your computer is off. A small Debian or Ubuntu server (2 vCPU, 4 GB RAM) is enough.

## 1. Prepare the server

Log in to your VPS over SSH as a normal user (not root) with `sudo`, then install the tools:

```sh
# Node.js 22 and pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pnpm pm2 @anthropic-ai/claude-code

# Docker, for the database
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

## 2. Log in to Claude (your subscription)

Sunny runs on the Claude Code login of this server, so every agent uses your subscription:

```sh
claude auth login
```

It prints a link. Open it on your phone or computer, sign in with your Claude account, copy the code Claude shows, and paste it back in the terminal. That's it: no API key.

(Later, you can add a second Claude subscription from Telegram with `/account add`, and Sunny switches to it when the first one hits its limit.)

## 3. Install Sunny

```sh
git clone https://github.com/fpswagg/sunny-zero.git sunny
cd sunny
pnpm install
cp .env.example .env
docker compose up -d        # starts Postgres, matching the URL in .env
```

Open `.env` and set your timezone (for scheduled agents), for example `SUNNY_TIMEZONE=Europe/Paris`. Everything else can stay as it is.

## 4. Start it

```sh
pnpm pm2:start              # runs Sunny in the background, restarts it on crash
pm2 startup                 # run the command it prints, so Sunny starts again after a reboot
```

Check that it runs: `pnpm pm2:logs` (Ctrl+C to leave). The database tables are created on the first start.

## 5. Connect Telegram

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a username. BotFather gives you a **token**.
2. On the server, run:
   ```sh
   pnpm sunny setup telegram
   ```
   Paste the token (it stays hidden).
3. Sunny prints a link `t.me/<your_bot>?start=…`. Open it in Telegram and press **Start**. This makes your Telegram account the **owner**: from now on the bot answers you, and only you.

## 6. Say hello

Send your bot a message. Sunny is the only agent for now, and it guides you through the rest:

- **HTTPS** (recommended): secure pages for passwords and keys, sign-ins with Google or GitHub, and the Telegram app need a public HTTPS address. Sunny explains it, or follow [docs/HTTPS.md](docs/HTTPS.md) (5 minutes with a free domain).
- **Your first agent**: tell Sunny what you need ("an agent that summarises my unread mail every morning") and it builds it.
- **Connectors**: Gmail, GitHub, Notion, your server… Sunny sends you a secure page when one needs a login.

You can also chat in the terminal: `pnpm chat`.

## Useful commands

| | |
|---|---|
| `pnpm pm2:logs` | follow the logs |
| `pnpm pm2:stop` / `pnpm pm2:start` | stop / start Sunny |
| `pnpm chat` | talk to Sunny in the terminal |
| `/help` in Telegram | every chat command |

Something wrong? See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Want API keys, other models or your own proxy? See [docs/SETUP-ADVANCED.md](docs/SETUP-ADVANCED.md).
