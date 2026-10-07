import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { explainWith, oauthCaller } from '../oauth-api.ts';
import { RestClient, UNTRUSTED_NOTE, guard, ok } from '../shared.ts';

export const REDDIT_SECRET_ID = 'reddit:account';
export const REDDIT_SCOPES = ['identity', 'read', 'history', 'mysubreddits'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const explainReddit = explainWith('Reddit', 'Reddit');
/** Reddit blocks generic user agents; it asks for a descriptive one. */
const UA = 'web:sunny-agent:v0.1 (personal assistant, read only)';
const sub = z.string().regex(/^[A-Za-z0-9_]{2,21}$/, 'subreddit name without r/');

export interface RedditDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/**
 * Reddit, read only. No submit/comment/vote scopes are requested, so automated posting (which
 * gets accounts shadow-banned) is impossible. Free API tier is about 100 requests a minute; we
 * keep to roughly 1 a second. Post and comment text is written by strangers: data, not instructions.
 */
export function redditConnector(deps: RedditDeps): Connector {
  const rest = deps.rest ?? new RestClient({ baseUrl: 'https://oauth.reddit.com', minGapMs: 1000, service: 'Reddit', explain: explainReddit, doFetch: deps.fetch });
  const call = oauthCaller({ secrets: deps.secrets, secretId: REDDIT_SECRET_ID, provider: PROVIDERS.reddit!, rest, setupName: 'reddit', fetch: deps.fetch, headers: { 'user-agent': UA } });
  const qs = (o: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries({ raw_json: 1, ...o }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  const post = (d: Json) => ({ id: d.id, title: d.title, subreddit: d.subreddit, author: d.author, score: d.score, comments: d.num_comments, created: d.created_utc && new Date(d.created_utc * 1000).toISOString(), url: d.url, permalink: `https://www.reddit.com${d.permalink}`, text: d.selftext ? String(d.selftext).slice(0, 2000) : undefined, nsfw: d.over_18 || undefined });
  const listing = (r: Json) => ((r.data?.children as Json[]) ?? []).map((c) => c.data);
  const comment = (c: Json, depth: number): Json => ({ author: c.author, score: c.score, text: String(c.body ?? '').slice(0, 1500), ...(depth > 0 && c.replies?.data ? { replies: listing(c.replies).filter((x) => x.body).slice(0, 5).map((x) => comment(x, depth - 1)) } : {}) });

  return {
    name: 'reddit',
    description: "The owner's Reddit (read only): subreddit posts, post comments, search, the owner's subscriptions and history. Cannot post, comment or vote.",
    status: async () => ((await deps.secrets.has(REDDIT_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to Reddit (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.reddit!,
        scopes: REDDIT_SCOPES,
        secretId: REDDIT_SECRET_ID,
        title: 'Sign in to Reddit',
        description: 'Read-only: agents can read subreddits, posts, comments and your history. They cannot post, comment or vote. Reddit API apps are reviewed; keep usage personal and low.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'reddit',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('me', 'The signed-in Reddit account.', {}, guard(async () => { const m = await call(`/api/v1/me?${qs({})}`); return ok({ name: m.name, karma: m.total_karma, created: m.created_utc && new Date(m.created_utc * 1000).toISOString() }); })),
          tool('subscribed', 'Subreddits the owner follows.', { limit: z.number().int().min(1).max(100).default(50) }, guard(async ({ limit }) =>
            ok(listing(await call(`/subreddits/mine/subscriber?${qs({ limit })}`)).map((s) => ({ name: s.display_name, subscribers: s.subscribers, description: String(s.public_description ?? '').slice(0, 150) }))))),
          tool('subreddit_posts', 'Posts of a subreddit.', { subreddit: sub, sort: z.enum(['hot', 'new', 'top', 'rising']).default('hot'), time: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).default('day').describe('only for sort=top'), limit: z.number().int().min(1).max(50).default(15) }, guard(async ({ subreddit, sort, time, limit }) =>
            ok({ note: UNTRUSTED_NOTE, results: listing(await call(`/r/${subreddit}/${sort}?${qs({ limit, t: sort === 'top' ? time : undefined })}`, { what: `r/${subreddit}` })).map(post) }))),
          tool('get_post', 'A post with its top comments.', { id: z.string().regex(/^[a-z0-9]{4,10}$/), limit: z.number().int().min(1).max(50).default(15) }, guard(async ({ id, limit }) => {
            const [p, c] = (await call<Json[]>(`/comments/${id}?${qs({ limit, depth: 2, sort: 'top' })}`, { what: 'this post' })) as [Json, Json];
            return ok({ note: UNTRUSTED_NOTE, post: post(listing(p)[0]), comments: listing(c).filter((x) => x.body).map((x) => comment(x, 1)) });
          })),
          tool('search', 'Search posts, in one subreddit or everywhere.', { query: z.string().min(1).max(300), subreddit: sub.optional(), sort: z.enum(['relevance', 'new', 'top', 'comments']).default('relevance'), limit: z.number().int().min(1).max(50).default(15) }, guard(async ({ query, subreddit, sort, limit }) =>
            ok({ note: UNTRUSTED_NOTE, results: listing(await call(`${subreddit ? `/r/${subreddit}` : ''}/search?${qs({ q: query, sort, limit, restrict_sr: subreddit ? 1 : undefined })}`, { what: 'search' })).map(post) }))),
          tool('user_activity', 'Recent posts or comments of a user (the owner by default).', { username: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/).optional(), kind: z.enum(['submitted', 'comments']).default('submitted'), limit: z.number().int().min(1).max(50).default(15) }, guard(async ({ username, kind, limit }) => {
            const name = username ?? ((await call(`/api/v1/me?${qs({})}`)).name as string);
            const items = listing(await call(`/user/${name}/${kind}?${qs({ limit })}`, { what: `u/${name}` }));
            return ok({ note: UNTRUSTED_NOTE, results: kind === 'submitted' ? items.map(post) : items.map((c) => ({ subreddit: c.subreddit, text: String(c.body).slice(0, 800), score: c.score, permalink: `https://www.reddit.com${c.permalink}` })) });
          })),
        ],
      }),
  };
}
