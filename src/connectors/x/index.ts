import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, getAccessToken, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { ApiError, RestClient, UNTRUSTED_NOTE, WriteBudget, guard, ok } from '../shared.ts';

export const X_SECRET_ID = 'x:account';
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'like.read', 'like.write', 'dm.read', 'follows.read', 'offline.access'];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function explainX(status: number, body: unknown, what: string): string {
  const b = (body ?? {}) as Json;
  const detail = b.detail ?? b.title ?? b.errors?.[0]?.message;
  const extra = detail ? ` X says: ${detail}` : '';
  switch (status) {
    case 400:
      return `X rejected the request.${extra}`;
    case 401:
      return 'X refused the token. Ask the owner to run the X setup again (sign in).';
    case 402:
      return `The X developer account has no API credit left, or the plan does not include this.${extra}`;
    case 403:
      return `X forbids this (${what}): the app lacks the scope or plan, the account is protected, or the post is a duplicate.${extra}`;
    case 404:
      return `Not found on X: ${what}.${extra}`;
    case 429:
      return 'X rate limit reached. Try again later.';
    default:
      return status >= 500 ? `X is having trouble (HTTP ${status}); try again later.` : `X error HTTP ${status}.${extra}`;
  }
}

const TWEET_FIELDS = 'created_at,public_metrics,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,lang';
const USER_FIELDS = 'username,name,description,verified,public_metrics,created_at,protected';
const EXPANSIONS = 'author_id';

export interface XDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/** Joins tweets with their authors' handles for readable output. */
export function formatTweets(res: Json): Json[] {
  const users = new Map<string, Json>((res.includes?.users ?? []).map((u: Json) => [u.id, u]));
  return ((res.data ?? []) as Json[]).map((t) => ({
    id: t.id,
    author: users.get(t.author_id)?.username ? `@${users.get(t.author_id)!.username}` : t.author_id,
    at: t.created_at,
    text: t.text,
    metrics: t.public_metrics,
    replyTo: t.referenced_tweets?.find((r: Json) => r.type === 'replied_to')?.id,
    quotes: t.referenced_tweets?.find((r: Json) => r.type === 'quoted')?.id,
    conversation: t.conversation_id,
    url: `https://x.com/i/status/${t.id}`,
  }));
}

/** Accepts a tweet id or URL. */
export function tweetId(input: string): string {
  const m = /(\d{5,25})(?:\D*)$/.exec(input.trim());
  if (!m) throw new ApiError(`"${input}" is not a post id or URL`);
  return m[1]!;
}

/**
 * X (Twitter) through the official API v2 with OAuth 2.0 user sign-in (tokens refresh on their
 * own, nothing is shown to agents). Writes ask the owner and share one hourly budget so a
 * looping agent cannot trigger X's automation/spam rules. Every write is the owner's account.
 */
export function xConnector(deps: XDeps): Connector {
  const rest =
    deps.rest ??
    new RestClient({ baseUrl: 'https://api.x.com', minGapMs: 1000, service: 'X', explain: explainX, doFetch: deps.fetch, maxWaitSec: 60 });
  const writes = new WriteBudget(30, 60 * 60_000);
  let meId: string | undefined;

  const call = async <T = Json>(path: string, o: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; what?: string } = {}): Promise<T> => {
    let token: string;
    try {
      token = await getAccessToken(deps.secrets, X_SECRET_ID, PROVIDERS.x!, deps.fetch);
    } catch {
      throw new ApiError('X is not connected: ask the owner to open the X setup link (Sunny: setup_connector x).');
    }
    return rest.request<T>({ path, method: o.method, body: o.body, what: o.what, headers: { authorization: `Bearer ${token}` } });
  };
  const me = async () => (meId ??= (await call<Json>('/2/users/me')).data.id as string);
  const q = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
    return p.toString();
  };
  const tweets = (extra: Record<string, string | number | undefined> = {}) => q({ 'tweet.fields': TWEET_FIELDS, expansions: EXPANSIONS, 'user.fields': 'username,name', ...extra });
  const page = (res: Json, results: unknown) => ({ note: UNTRUSTED_NOTE, results, nextToken: res.meta?.next_token });
  const handle = (h: string) => h.trim().replace(/^@/, '');

  return {
    name: 'x',
    description: "The owner's X (Twitter) account: read timeline, posts, replies, mentions, DMs, search; post, reply, quote, retweet and like (asking first).",
    mutatingTools: ['post', 'retweet', 'unretweet', 'like', 'unlike', 'delete_post'],
    status: async () => ((await deps.secrets.has(X_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to X (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.x!,
        scopes: X_SCOPES,
        secretId: X_SECRET_ID,
        title: 'Sign in to X',
        description:
          'Agents will read your timeline, posts and DMs, and can post, reply, quote, retweet and like only after asking you. X API access is paid and has per-endpoint limits; automated likes/retweets/replies in bulk break X rules, so Sunny caps writes at 30 an hour.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'x',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('me', 'The signed-in X account: handle, name, bio and counts.', {}, guard(async () => ok((await call<Json>(`/2/users/me?${q({ 'user.fields': USER_FIELDS })}`)).data))),
          tool(
            'user',
            'Public profile of an X account by handle.',
            { handle: z.string().min(1).max(50) },
            guard(async ({ handle: h }) => ok((await call<Json>(`/2/users/by/username/${handle(h)}?${q({ 'user.fields': USER_FIELDS })}`, { what: `@${handle(h)}` })).data)),
          ),
          tool(
            'timeline',
            'Home timeline (people the owner follows), newest first.',
            { limit: z.number().int().min(5).max(100).default(20), nextToken: z.string().optional() },
            guard(async ({ limit, nextToken }) => {
              const res = await call<Json>(`/2/users/${await me()}/timelines/reverse_chronological?${tweets({ max_results: limit, pagination_token: nextToken })}`);
              return ok(page(res, formatTweets(res)));
            }),
          ),
          tool(
            'user_posts',
            "An account's recent posts (use the owner's own handle for their posts).",
            { handle: z.string().min(1).max(50), limit: z.number().int().min(5).max(100).default(20), nextToken: z.string().optional() },
            guard(async ({ handle: h, limit, nextToken }) => {
              const u = await call<Json>(`/2/users/by/username/${handle(h)}`, { what: `@${handle(h)}` });
              const res = await call<Json>(`/2/users/${u.data.id}/tweets?${tweets({ max_results: limit, pagination_token: nextToken })}`);
              return ok(page(res, formatTweets(res)));
            }),
          ),
          tool(
            'get_post',
            'One post by id or URL.',
            { post: z.string() },
            guard(async ({ post }) => ok(formatTweets(await call<Json>(`/2/tweets/${tweetId(post)}?${tweets()}`, { what: 'this post' }).then((r) => ({ data: [r.data], includes: r.includes })))[0])),
          ),
          tool(
            'replies',
            'Replies in the conversation of a post (recent search, last 7 days).',
            { post: z.string(), limit: z.number().int().min(10).max(100).default(20), nextToken: z.string().optional() },
            guard(async ({ post, limit, nextToken }) => {
              const id = tweetId(post);
              const res = await call<Json>(`/2/tweets/search/recent?${tweets({ query: `conversation_id:${id}`, max_results: limit, next_token: nextToken })}`, { what: 'this conversation' });
              return ok(page(res, formatTweets(res)));
            }),
          ),
          tool(
            'mentions',
            'Recent posts that mention the owner.',
            { limit: z.number().int().min(5).max(100).default(20), nextToken: z.string().optional() },
            guard(async ({ limit, nextToken }) => {
              const res = await call<Json>(`/2/users/${await me()}/mentions?${tweets({ max_results: limit, pagination_token: nextToken })}`);
              return ok(page(res, formatTweets(res)));
            }),
          ),
          tool(
            'search',
            'Search posts from the last 7 days. Supports X operators ("from:handle", "#tag", "-is:retweet", "lang:fr").',
            { query: z.string().min(1).max(500), limit: z.number().int().min(10).max(100).default(20), nextToken: z.string().optional() },
            guard(async ({ query, limit, nextToken }) => {
              const res = await call<Json>(`/2/tweets/search/recent?${tweets({ query, max_results: limit, next_token: nextToken })}`);
              return ok(page(res, formatTweets(res)));
            }),
          ),
          tool(
            'dms',
            'Recent direct messages (all conversations), newest first.',
            { limit: z.number().int().min(1).max(100).default(20), nextToken: z.string().optional() },
            guard(async ({ limit, nextToken }) => {
              const res = await call<Json>(`/2/dm_events?${q({ max_results: limit, pagination_token: nextToken, 'dm_event.fields': 'created_at,sender_id,text,dm_conversation_id,event_type', event_types: 'MessageCreate' })}`);
              return ok(page(res, (res.data ?? []).map((e: Json) => ({ id: e.id, conversation: e.dm_conversation_id, from: e.sender_id, at: e.created_at, text: e.text }))));
            }),
          ),
          tool(
            'post',
            'Publish a post. Give `replyTo` (post id or URL) to reply, or `quote` to quote another post. Text limit is 280 characters unless the account is Premium.',
            { text: z.string().min(1).max(25_000), replyTo: z.string().optional(), quote: z.string().optional() },
            guard(async ({ text, replyTo, quote }) => {
              if (replyTo && quote) throw new ApiError('Use either replyTo or quote, not both');
              writes.take('writes');
              const body: Json = { text };
              if (replyTo) body.reply = { in_reply_to_tweet_id: tweetId(replyTo) };
              if (quote) body.quote_tweet_id = tweetId(quote);
              const res = await call<Json>('/2/tweets', { method: 'POST', body, what: 'the post' });
              return ok({ posted: res.data.id, url: `https://x.com/i/status/${res.data.id}` });
            }),
          ),
          tool(
            'retweet',
            'Repost a post.',
            { post: z.string() },
            guard(async ({ post }) => {
              writes.take('writes');
              await call(`/2/users/${await me()}/retweets`, { method: 'POST', body: { tweet_id: tweetId(post) }, what: 'this post' });
              return ok('Reposted.');
            }),
          ),
          tool(
            'unretweet',
            'Undo a repost.',
            { post: z.string() },
            guard(async ({ post }) => {
              writes.take('writes');
              await call(`/2/users/${await me()}/retweets/${tweetId(post)}`, { method: 'DELETE', what: 'this post' });
              return ok('Repost removed.');
            }),
          ),
          tool(
            'like',
            'Like a post.',
            { post: z.string() },
            guard(async ({ post }) => {
              writes.take('writes');
              await call(`/2/users/${await me()}/likes`, { method: 'POST', body: { tweet_id: tweetId(post) }, what: 'this post' });
              return ok('Liked.');
            }),
          ),
          tool(
            'unlike',
            'Remove a like.',
            { post: z.string() },
            guard(async ({ post }) => {
              writes.take('writes');
              await call(`/2/users/${await me()}/likes/${tweetId(post)}`, { method: 'DELETE', what: 'this post' });
              return ok('Like removed.');
            }),
          ),
          tool(
            'delete_post',
            "Delete one of the owner's own posts (permanent on X).",
            { post: z.string() },
            guard(async ({ post }) => {
              writes.take('writes');
              await call(`/2/tweets/${tweetId(post)}`, { method: 'DELETE', what: 'this post' });
              return ok('Post deleted.');
            }),
          ),
        ],
      }),
  };
}
