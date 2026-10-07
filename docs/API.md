# HTTP and WebSocket API

The daemon listens on `SUNNY_BIND:SUNNY_PORT` (default `127.0.0.1:3210`). Everything below is relative to `SUNNY_PUBLIC_URL` when you have one.

## Health

`GET /health` → `{"ok": true}`. Use it for uptime checks.

## Events (webhooks)

Other apps can wake your agents by sending events. Set `SUNNY_EVENTS_SECRET` (16+ characters) in `.env` first; without it the endpoint answers `503`.

```sh
curl -X POST https://sunny.example.com/events/shop \
  -H 'content-type: application/json' \
  -H "x-sunny-secret: $SUNNY_EVENTS_SECRET" \
  -d '{"name":"order","summary":"New order #1042, 89 €","data":{"amount":"89","country":"FR"}}'
```

- `source` (in the path), `name` and `summary` are required; `data` is optional (string values are what `filter` matches).
- Answers: `200 {"ok":true}`, `400` (missing fields), `401` (wrong secret), `503` (not configured).
- An agent with the trigger `{ "type": "event", "source": "shop", "on": "order", "filter": { "country": "FR" } }` runs with the event appended to its prompt. Events arriving together are handled in one run. Every event is logged in the `events` table.

## WebSocket: `/ws`

The terminal client (`sunny chat`) and scripts use it. It is the owner's channel, protected by the admin token (`sunny token`, stored in `data/admin.token`). It is meant for the same machine: keep it on loopback or behind HTTPS.

Client → server:

```jsonc
{ "type": "hello", "token": "<admin token>", "channel": "cli", "conversation": "default" }
{ "type": "message", "text": "@example-agent what is new in Node 24?" }
{ "type": "approve", "id": "<approval id>", "allow": true }
```

Server → client:

```jsonc
{ "type": "ready", "conversationId": "cli:default", "agent": "sunny" }
{ "type": "event", "event": { "type": "text", ... } }     // text, tool, status, reply, approval, auth_link, notice, notify, file, error
{ "type": "fatal", "error": "invalid token" }
```

Simplest use from a script: `sunny ask "message"` (see [CLI.md](CLI.md)).

## Secure pages: `/auth/:token`

One-time pages for credentials, multi-step logins and OAuth sign-ins. Links come from Sunny (in chat), work once and expire after `SUNNY_AUTH_LINK_TTL_MIN` minutes. OAuth providers redirect to `/auth/oauth/callback`.

## Agent apps: `/a/…`

- `/a/` is the hub: an installable web app (PWA) listing your agents.
- `/a/<agent>` is one agent's app: chat and voice calls, same conversation as Telegram.
- Sign-in is a one-time link from `/app <agent>` in Telegram. Needs `SUNNY_PUBLIC_URL`.

## Telegram Mini App: `/app`

The management app opened by `/manage` in Telegram. Every request is checked against Telegram's signed launch data and your linked accounts.

## Model proxy: `/llm`

Loopback only. Runs on other providers talk to this proxy with a token valid for that run; it holds the real key and forwards or translates requests. Not for outside use.
