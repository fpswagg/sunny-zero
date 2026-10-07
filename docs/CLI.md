# Commands

## The `sunny` command

Run it with `pnpm sunny <command>` from the project folder, or put it on your PATH:

```sh
ln -s "$PWD/bin/sunny" ~/.local/bin/sunny
```

```
sunny serve                       start the daemon (web server + agents), in the foreground
sunny chat [-a agent] [-c name]   chat in the terminal (named conversations keep separate memory)
sunny ask [-a agent] <message>    send one message, print the reply, exit
sunny setup telegram [agent]      connect Sunny's Telegram bot, or an agent's own (token typed hidden)
sunny token                       print the client token
```

`chat`, `ask` and `setup` talk to the running daemon (start it first with `pnpm pm2:start`).

Examples:

```sh
sunny chat                                  # talk to Sunny
sunny chat -a example-agent -c research     # talk to an agent, in a conversation named "research"
sunny ask "how much disk is left?"          # one-shot, for scripts
sunny ask -a watcher "status" | mail -s report me@example.com
sunny setup telegram watcher                # give the agent "watcher" its own bot
```

In the terminal, approvals print as questions (answer `yes` or `no`) and buttons print as the commands they run.

## pnpm scripts

| | |
|---|---|
| `pnpm pm2:start` | start (or reload) the daemon under pm2, with the current `.env` |
| `pnpm pm2:stop` | stop it |
| `pnpm pm2:logs` | follow the logs (also in `logs/`) |
| `pnpm serve` / `pnpm dev` | run in the foreground / restart on code changes (not next to pm2) |
| `pnpm chat` | `sunny chat` |
| `pnpm db:up` | start the Postgres container |
| `pnpm typecheck` / `pnpm test` | checks, see [TESTING.md](TESTING.md) |

## Chat commands

Work in Telegram, the terminal and the apps. `/help` lists them all.

**Everyone**

| | |
|---|---|
| `@agent message` | send one message to an agent |
| `/use <agent>` · `/use sunny` | talk to an agent directly · back to Sunny |
| `/agents` | list agents (guests see theirs) |
| `/new` | fresh conversation with the current agent |
| `/stop` · `/stop <agent>` | stop what runs here · stop an agent's background run |
| `/status` | current agent, running work, background runs |
| `yes` / `no` | answer the latest approval |

On an agent's own bot only `/new`, `/stop`, `/status` and `/help` exist: that bot talks to its agent only.

**Owner: agents and models**

| | |
|---|---|
| `/agent <name>` | an agent's card with buttons |
| `/model <agent> <model>` · `/model default <model>` | change a model · the default for new agents |
| `/effort <agent> <level>` | how hard it thinks |
| `/pause <agent>` · `/resume <agent>` | no answers, schedules or events while paused |
| `/reset <agent>` | forget its conversations (notes stay) |
| `/test <agent>` | one-line test through its model |
| `/providers` · `/connect <id>` · `/disconnect <id>` · `/models <id>` | model providers and keys |
| `/account` | Claude subscriptions: add one, switch when a limit is reached |

**Owner: watching and spending**

| | |
|---|---|
| `/runs <agent>` · `/usage [days]` · `/limits` | latest runs · tokens and cost · subscription limits |
| `/budget` | daily spend limit per agent (alert or block) |
| `/activity` | model fallbacks and agent-to-agent calls |
| `/console` · `/usagecard` | live progress card · pinned usage card |
| `/quiet` | night hours without notification sound |
| `/backup` · `/backup now` | agent backups |

**Owner: Telegram and apps**

| | |
|---|---|
| `/telegram` · `/telegram pair` · `/telegram unlink <id>` | your bots and accounts · link another of your accounts · unlink one |
| `/manage` | the manager app (needs HTTPS) |
| `/apps` · `/app <agent>` | every app · an agent's chat and voice app |
