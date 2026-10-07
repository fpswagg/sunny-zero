# Models and providers

By default everything runs on your **Claude subscription**: no API key, no extra bill. Each agent (and Sunny) can also run on another provider, while keeping Claude Code's tools, permissions and sessions.

| Provider | id | How |
|---|---|---|
| Claude subscription (default) | `claude` | the `claude` login on the server |
| Claude API | `anthropic` | API key, forwarded |
| Moonshot Kimi | `kimi` | Anthropic-compatible API, forwarded |
| OpenRouter | `openrouter` | Anthropic-compatible API, forwarded |
| OpenAI (GPT) | `openai` | Chat Completions, translated by Sunny |
| Google Gemini | `gemini` | OpenAI-compatible API, translated by Sunny |

## Connecting a key

`/connect <id>` in chat (or ask Sunny, or use the `/manage` app). You type the key on a one-time secure page; it is checked with the provider and stored encrypted. Never put provider keys in `.env`.

Agents never see the key. A run on another provider gets a token valid for that run only, on Sunny's local proxy (`/llm`, loopback only), which holds the key and forwards or translates the requests.

## Choosing models

- Models are written `provider:model`: `openai:gpt-5.5`, `gemini:gemini-3.8-flash`, `openrouter:moonshotai/kimi-k3`. A bare name (`opus`, `sonnet`, `haiku`) means the subscription.
- `/models <id>` lists a provider's models live, with context size and price when known.
- `/model <agent> <model>` changes one; `/test <agent>` checks it works.
- `effort` (`low` … `max`) maps to each provider's reasoning setting; if a model refuses a level, the next lower one is used.
- `fallbackModels` (up to 5) are tried in order when the main model fails (usage limit, rate limit, outage). You are told when it happens (`/activity`).

## Limits to know

- `WebSearch` is a Claude-only tool: GPT and Gemini agents don't get it (they still have `WebFetch`).
- A conversation stays with its model family: switching provider starts conversations fresh.
- Usage (runs, tokens, cost) is logged per run: `/usage`, `/runs <agent>`. On the subscription, costs are shown as the API-equivalent price.
- `/limits` shows the subscription's session and weekly usage, and balances for OpenRouter and Kimi.

## Several Claude subscriptions

`/account add` signs in a second Claude account on a secure page. When the one in use hits its limit, agents move to the next one by themselves and you are told. `/account switch` changes it by hand.

## Voice and transcription keys

ElevenLabs, OpenAI and Gemini keys also enable voice replies and cloud transcription (ask Sunny to connect them). Without them, incoming voice notes are transcribed locally with Whisper.
