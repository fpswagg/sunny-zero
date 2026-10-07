# Connectors

Connectors give agents tools for outside services. An agent gets a connector by listing it in `connectors` in its `agent.json` (or ask Sunny: "give example-agent the github connector").

- **Ask Sunny to set one up** ("connect my GitHub"): it sends a one-time secure page. Credentials are stored encrypted; agents never see them.
- Ask Sunny "which connectors are ready?", or open Connectors in the `/manage` app.
- Tools that **change** something (send a mail, post, redeploy, restart) always ask you first, unless you auto-approve them for an agent.
- Secure pages and sign-ins need [HTTPS](HTTPS.md).

## Sign-in with a provider (OAuth)

These use the provider's own sign-in page. The first time, you register a small "OAuth app" with the provider and paste its client id and secret on Sunny's page. The redirect URI to register is `SUNNY_PUBLIC_URL/auth/oauth/callback` (Sunny's page shows it).

| Connector | What agents can do | Where to create the OAuth app |
|---|---|---|
| `gmail` | search and read mail, labels; send (asks; max 10/hour). Never deletes. | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (enable the Gmail API) |
| `gdrive` | browse, search, read; create folders and text files, share with a named person (asks). Never deletes or overwrites. | Google Cloud Console (enable the Drive API) |
| `youtube` | your channel, videos, stats, comments, search. Read only. | Google Cloud Console (enable YouTube Data API v3) |
| `dropbox` | browse, search, read; upload new files, share links (asks). Never deletes. | [Dropbox App Console](https://www.dropbox.com/developers/apps) |
| `figma` | files, text, comments, versions, projects. Read only. | [Figma developers](https://www.figma.com/developers/apps) |
| `spotify` | now playing, history, top items, playlists, search. Read only. | [Spotify dashboard](https://developer.spotify.com/dashboard) |
| `reddit` | subreddits, posts, comments, your subscriptions and history. Read only. | [Reddit apps](https://www.reddit.com/prefs/apps) (type "web app") |
| `x` | timeline, posts, mentions, DMs, search; post, reply, like (asks). | [X developer portal](https://developer.x.com/) |
| `tiktok` | your own profile, videos and stats. Read only. | [TikTok for developers](https://developers.tiktok.com/) |

Google apps in "testing" mode must list your Google account as a test user.

## Token or key

| Connector | What agents can do | What you paste |
|---|---|---|
| `github` | repos, PRs, issues, commits, code search; comment (asks). No merge or push. | A [fine-grained token](https://github.com/settings/personal-access-tokens) (read: Contents, Issues, Pull requests, Metadata) |
| `vercel` | projects, deployments, build logs, domains, analytics; redeploy (asks). | An [access token](https://vercel.com/account/tokens), and the team id if your projects are in a team |
| `notion` | search, read pages and databases; create pages, edit properties, add rows (asks). | An [internal integration](https://www.notion.so/my-integrations) secret. Then share pages with the integration in Notion ("Connections"). |
| `notion-calendar` | calendars made of Notion databases with a date property: list and add events (asks). | Nothing more: it uses the `notion` connection. |
| `instagram` | Business/Creator account: profile, posts, stories, comments, DMs, insights. Read only. | A Meta Graph API access token |
| `letterboxd` | search films, watchlist, reviews; add, rate, review (asks). | Letterboxd API key and secret (approved by Letterboxd), your username and password |

## Your Telegram account: `telegram-user`

Not a bot: your own account (through the official MTProto API). Agents list chats, read and search messages, and send, edit or delete your own messages in existing chats (asks first).

Setup is a multi-step secure page: `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org) → API development tools, then your phone number, the login code Telegram sends, and your 2FA password if you have one. The session is stored encrypted. Treat it like your password.

## This server: `vps`

Ready as soon as Sunny runs; no setup. Tools: `status`, `processes` (pm2), `containers` (Docker), `top`, `logs` (secrets masked), `history` (30 days of metrics), `alerts`, `check_url`, `disk_usage`, `restart` (asks), `mute` / `unmute`, `configure` (thresholds, extra HTTP checks, ignore list).

It checks the server every minute and **emits events** when something goes wrong (disk filling up, memory, a crashed app, a failing URL, a certificate about to expire). An agent with the trigger `{ "type": "event", "source": "vps", "on": "alert" }` wakes up on them. See [WORKFLOWS.md](WORKFLOWS.md).

The user running Sunny needs access to `pm2` and `docker` (member of the `docker` group) for those parts.

## Notifications: `notify`

A `send` tool for messages that must reach you outside the current chat: results of scheduled runs, alerts, digests. It can send silently. Limited to 10 a minute and 60 an hour per agent. See [TELEGRAM.md](TELEGRAM.md#notifications).

## Writing a connector

Each connector is a folder in `src/connectors/<name>/` exporting a definition (see `src/connectors/types.ts`): a name, a description, its status, an optional setup (form, steps or OAuth) and an in-process MCP server with its tools. Register it in `src/daemon.ts` next to the others and mark the tools that change things so they ask first. Copy a small one such as `spotify` or `vercel` to start.
