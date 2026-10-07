# Telegram

Telegram is the main way to use Sunny: from your phone, with voice notes, photos and approval buttons. Setup is in [SETUP.md](../SETUP.md#5-connect-telegram).

## Bots

**Sunny's bot.**
1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and follow the steps.
2. Give Sunny the token in either of these ways:
   - Run `sunny setup telegram` and paste the token. It is read hidden, sent to the daemon over the local socket, and checked with Telegram.
   - Ask Sunny to "set up Telegram". It sends a one-time page where you paste the token.
3. Sunny replies with a link (`t.me/<bot>?start=CODE`) that links your Telegram account to you, the owner. The code works once and expires with the auth-link TTL.

**A bot per agent.** Any agent can have its own bot, so you talk to it directly, and its alerts and approvals come from it:
- Ask Sunny to "set up a Telegram bot for watcher", or run `sunny setup telegram watcher`.
- Sunny sets the bot's name, description and profile picture from the agent's `icon.svg`, and updates them when they change.
- Your linked accounts work there right away: open the bot and press Start.

**Who it answers.** Bots answer **linked accounts in private chats** only. They ignore everyone else and log who tried.
- Each account belongs to a user (see [People and access](#people-and-access)).
- Linking an account alerts you on Sunny's bot.
- Accounts live in `identities`, the chats each bot may message in `telegram_chats`, and tokens encrypted in the secret store.

In Telegram:
- Replies stream in by editing the message as it grows.
- Tool use appears as a small progress message that disappears when the turn ends.
- Approvals come with ✅ Allow and ❌ Deny buttons, or you can just reply `yes` or `no`.
- Auth links appear as an **Open** button.

**Everything you can send.** Not just text:

| You send | The agent gets |
|---|---|
| Photo, album (grouped into one message), image file | the image itself, resized to what Claude reads at full detail (up to 5 per message) |
| Voice message, audio, video message, video | the speech **transcribed on this server** (Whisper, language detected), plus one frame of videos |
| GIF, sticker | a frame or the sticker image, with its emoji |
| Any other file (PDF, code, CSV, zip...) | its name, type and size; the agent opens it with Read (text, code, PDFs and images work) |
| Location, place, contact, poll, checklist, dice | spelled out as text (with a map link) |
| Forward, reply, quote | who it was forwarded from, and the message or the quoted part you replied to |

- Captions are the message. On Sunny's bot, a caption like `@watcher` sends the file to that agent.
- Files go to the receiving agent's `inbox/<date>/` folder. They are deleted after `SUNNY_INBOX_DAYS` days (30 by default).
- Telegram lets bots download up to 20 MB. Bigger files get a reply saying so.
- Games and payments are not supported; the bot says so.
- **Agents send files back** with the `chat` tool `send_file`: a chart as a photo, an export as a document, an `.ogg` as a voice message (up to 50 MB). In background runs the file goes where the agent's notifications go. In the terminal you see the file's path.
- **Sunny can pass files on.** `run_agent` copies files from Sunny's inbox into the agent's.

**Transcription.** When ElevenLabs or OpenAI keys are connected, voice is transcribed there. Otherwise it runs on this machine with [Whisper](https://huggingface.co/onnx-community/whisper-small) on ONNX (`@huggingface/transformers`), CPU only:
- No audio leaves the server.
- The model, about 250 MB, is downloaded once into `data/models`.
- It uses about 1.3 GB of RAM while it is loaded, and unloads after 10 idle minutes.
- A short voice note takes about 5 seconds; a minute of speech takes about 20.
- Set `SUNNY_WHISPER_LANGUAGES=fr,en` to limit language detection to the languages you speak.
- `SUNNY_WHISPER_MODEL=onnx-community/whisper-base` is about twice as fast but less accurate in French.
- Speech after `SUNNY_TRANSCRIBE_MAX_MIN` minutes (15 by default) is cut.

Bots use long polling, so they need no inbound port. Only one daemon can poll a given bot at a time, and Sunny refuses a token another of its bots already uses.

## People and access

| | can |
|---|---|
| **owner** (you) | everything. Link as many of your Telegram accounts as you like (`/telegram pair`, or `invite_user owner`). Terminal and web clients are the owner. |
| **guest** (member) | use only the agents granted to them, on the agent's own bot or through Sunny's bot. Never Sunny itself, never approvals. |

Ask Sunny, e.g. "add my friend Alice and give her the example agent":
1. `add_user` creates the guest.
2. `grant_access` gives them an agent (asks you first, and says what that agent can reach).
3. `invite_user` sends *you* a one-time link to pass on.

`revoke_access` and `remove_user` undo it.

**What guests can and can't do:**
- Anything a guest's request would change asks **you**, even tools the agent normally runs without asking, and even on `full` agents. The guest sees "waiting for the owner".
- A guest never joins an agent's shared history: they get their own.
- The agent is told who it is talking to, so it doesn't share your private notes.

## Notifications

Agents with the `notify` connector get a `send` tool for messages that should reach you outside the current chat, such as results, alerts and digests. It can send silently.
- Messages come from the agent's own bot when it has one and you pressed Start there, otherwise from Sunny's bot.
- The agent's `notify` field can narrow where they go:

| `notify` | goes to |
|---|---|
| `[]` (default) | your Telegram (agent bot, else Sunny's), or every open terminal and web chat if Telegram isn't set up |
| `["telegram"]`, `["cli"]`, `["web"]` | that channel |
| `["cli:default"]` | that exact conversation, if it's reachable |

Sends are limited to 10 a minute and 60 an hour per agent. Every notification goes into the `notifications` table, whether or not it was delivered.


## Apps

With [HTTPS](HTTPS.md):

- `/manage` (or the **Agents** menu button) opens the manager, a Telegram Mini App: models, effort, tests, pause, instructions, tools, connectors, memory, schedules, guests, bots, providers, usage.
- `/app <agent>` opens an agent's own app: chat and **voice calls**, in Telegram or in a browser (installable on your home screen).
