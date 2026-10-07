# Agents

The easiest way to make an agent is to **ask Sunny**: describe the job, and it writes the prompt, picks the tools, connectors, access and triggers, draws an icon, and tests it. This page explains what it builds, so you can read or edit it by hand.

## The folder

```
agents/<name>/
  agent.json    settings (validated by src/agents/schema.ts)
  prompt.md     the system prompt
  icon.svg      square icon; also the Telegram bot's picture
  workspace/    its working folder (restricted agents)
  memory/       its notes, when memory.notes is on
  inbox/        files sent to it in chat
```

Edits to `agent.json`, `prompt.md` and `icon.svg` are picked up live, no restart. `agents/example-agent` is a template (disabled): copy the folder, rename it (folder and `name`), set `"enabled": true`.

## `agent.json`

```jsonc
{
  "name": "watcher",                                  // lowercase, digits, dashes
  "description": "Watches the server and reports problems",
  "provider": "claude",                               // optional: claude (default) | anthropic | openai | gemini | kimi | openrouter
  "model": "sonnet",                                  // alias, full id, or "provider:model"
  "effort": "medium",                                 // low | medium | high | xhigh | max
  "fallbackModels": ["haiku"],                        // tried in order if the main model fails
  "tools": ["Read", "Glob", "Grep", "Bash"],          // built-in tools it may use
  "connectors": ["vps", "notify"],
  "notify": [],                                       // where notify.send delivers (default: your Telegram)
  "triggers": [
    { "type": "manual" },
    { "type": "cron", "schedule": "0 8 * * *", "prompt": "Send the morning report." },
    { "type": "event", "source": "vps", "on": "*", "filter": { "severity": "critical" } }
  ],
  "access": {
    "profile": "restricted",          // restricted | workspace | full
    "workdir": "/abs/path",           // workspace profile: the folder it works in
    "extraDirs": [],                  // workspace profile: more folders it may change
    "readOnlyDirs": ["/srv/my-app"],  // any profile: read, never change; secret files blocked
    "writableFiles": ["NOTES.md"],    // names it may still write inside readOnlyDirs
    "commands": ["df -h*", "systemctl status *"],   // shell commands that run without asking
    "autoApprove": ["mcp__vps__mute"],             // tools that never ask (for the owner)
    "alwaysAsk": []                                 // tools that always ask
  },
  "memory": { "session": "conversation", "notes": true },
  "voice": { "provider": "openai", "voice": "onyx", "instructions": "calm and warm", "reply": "auto" },
  "maxTurns": 40,
  "enabled": true
}
```

Built-in tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`, `NotebookEdit`, `TodoWrite`.

## Access

These **ask you first** (in the chat you are using, or on Telegram for background runs):

- anything outside the agent's folders;
- any shell command not matched by `access.commands`;
- connector tools that change things (unless in `autoApprove`);
- tools listed in `alwaysAsk`.

Details:

- `restricted` agents work only in `agents/<name>/`. `workspace` agents also get `workdir` and `extraDirs`. `full` agents run without approvals (except when a guest is talking): give it only to agents you trust with your whole server.
- `readOnlyDirs` gives read access to parts of the server. `.env`, keys, tokens and similar files are always blocked (Grep and Glob too). Sunny's data folder is never readable.
- `writableFiles` are exceptions inside read-only folders (globs over the file name, e.g. `*.md`). Secret-looking names are refused.
- `commands` patterns match the whole command (`*` = anything). Pipelines need every part to match; other shell syntax (`;`, `&&`, `$( )`, `>`) always asks.
- Sunny may create `restricted` agents freely. Folders, commands, `full` access or auto-approved tools need your approval when they are added.

**Isolation.** Agents don't load your `~/.claude` settings, plugins or claude.ai connectors: they only get what their definition lists. Environment variables that look like secrets (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`…) are removed.

## Memory

| `session` | |
|---|---|
| `none` | every message starts fresh |
| `conversation` | one history per chat; background runs start fresh |
| `shared` | one history across all chats and triggers (good for background workers); guests still get their own |

`notes: true` adds a `memory/` folder with `MEMORY.md` that the agent reads and keeps up to date. Long conversations are summarised automatically (`SUNNY_COMPACT_TOKENS`). `/new` starts a fresh conversation.

## Triggers

| trigger | runs when |
|---|---|
| `manual` | someone messages the agent, or Sunny (or another agent) delegates to it |
| `cron` | on a schedule (`SUNNY_TIMEZONE`, or the trigger's `timezone`), at most every 5 minutes; a run still going skips the next |
| `event` | a connector or a webhook emits a matching event: `source`, `on` (name or `*`), optional `filter` on data fields (globs), optional `prompt` |

**Background runs** (cron, event) use the conversation `task:<agent>`:

- their approvals reach you on Telegram as buttons;
- errors always reach you;
- the final reply is sent to you, unless the agent has `notify` and reports by itself.

`/stop <agent>` stops one.

## Agents working together

Every agent can ask another agent (the `ask_agent` tool); you approve the first call between two agents, or choose "always allow". Sunny delegates with `run_agent` and can pass files on. See [WORKFLOWS.md](WORKFLOWS.md).

## Voice

`voice.reply`: `auto` lets the agent decide when a voice note fits, `always` speaks every reply, `off` never. Voice needs an ElevenLabs, OpenAI or Gemini key (ask Sunny to connect one).

## Icons

`icon.svg` is a square SVG (`viewBox="0 0 512 512"`), shapes and gradients only (no text, scripts or external images). It should read well small and cropped to a circle. Its main colour becomes the agent's accent colour in the apps (or set `color`).

## Managing

Ask Sunny, or use the commands (see [CLI.md](CLI.md)): `/agents`, `/agent <name>`, `/model`, `/effort`, `/pause`, `/resume`, `/reset`, `/runs`, `/usage`, or the `/manage` app in Telegram. Deleted agents go to `data/trash/`, and a daily backup of all agents (definitions, prompts, notes; no secrets) is kept for 14 days.
