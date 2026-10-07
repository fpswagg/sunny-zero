# Workflows

Ideas to start with. For each one, just **describe it to Sunny**: it builds the agent. The JSON shows what you'd get.

## Morning server report

An agent that checks the server at 8:00 and sends a short report.

```jsonc
{
  "name": "watcher",
  "description": "Watches this server and sends a morning report",
  "model": "haiku",
  "connectors": ["vps", "notify"],
  "triggers": [
    { "type": "manual" },
    { "type": "cron", "schedule": "0 8 * * *", "prompt": "Check the server and send me a 5-line report." }
  ]
}
```

## React to alerts

The `vps` connector checks the server every minute and emits `alert` events. Add a trigger and the agent wakes up when something breaks, looks at the logs, and tells you what's wrong and what it suggests:

```jsonc
{ "type": "event", "source": "vps", "on": "alert", "filter": { "severity": "critical" },
  "prompt": "Find the cause with status and logs. Tell me in 3 lines. Don't restart anything without asking." }
```

## Daily mail digest

`gmail` + `notify`, cron at 18:00: "Summarise today's unread mail: what needs an answer, what can wait. Draft replies but don't send."

## Webhook from your app

Your shop, form or CI posts events to Sunny (see [API.md](API.md#events-webhooks)):

```sh
curl -X POST https://sunny.example.com/events/shop -H "x-sunny-secret: …" \
  -H 'content-type: application/json' -d '{"name":"order","summary":"Order #1042, 89 €"}'
```

An agent with `{ "type": "event", "source": "shop", "on": "order" }` handles each order (or each batch).

## Project companion

A `restricted` agent with `readOnlyDirs: ["/srv/my-app"]` and `writableFiles: ["NOTES.md"]`: it reads your code, answers questions about it, and keeps a notes file up to date, without being able to change anything else.

## A developer agent

A `workspace` agent with `workdir: "/home/you/projects/my-app"`, tools `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, and `commands: ["pnpm test*", "git status", "git diff*"]`. It codes in that folder; other commands ask you.

## Agents asking agents

Every agent can call another with `ask_agent` (you approve each pair once, or "always allow"). Example: a planning agent that asks the developer agent to build something, then asks the watcher to check the deployment.

Sunny can also delegate: "ask watcher how the disk looks" runs the agent and brings back its answer. Files you sent Sunny can be passed on.

## Research with sources

`agents/example-agent` is exactly this: `WebSearch` + `WebFetch`, answers with links, notes in `memory/`. Copy it, enable it, done.

## Sharing an agent with a friend

"Add my friend Alice and give her the research agent": Sunny creates the guest, grants the agent and sends you an invite link to pass on. She talks to it on Telegram; anything that changes something asks you.
