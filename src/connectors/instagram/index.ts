import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { formFlow } from '../../auth/flows.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { ApiError, RestClient, UNTRUSTED_NOTE, guard, ok } from '../shared.ts';

export const INSTAGRAM_SECRET_ID = 'instagram:account';
const VERSION = 'v23.0';
const REFRESH_AFTER_MS = 30 * 24 * 3600_000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function explainInstagram(status: number, body: unknown, what: string): string {
  const e = ((body ?? {}) as Json).error ?? {};
  const code = e.code as number | undefined;
  const extra = e.message ? ` Instagram says: ${e.message}` : '';
  if (code === 190 || status === 401) return 'Instagram refused the token (expired or revoked). Ask the owner to generate a new token and run the Instagram setup again.';
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) return 'Instagram rate limit reached. Wait a while before trying again.';
  if (code === 10 || code === 200 || code === 3 || status === 403) return `The token lacks the permission for this (${what}). Add the needed instagram_business_* permission to the token.${extra}`;
  if (code === 100 || status === 400) return `Instagram rejected the request (${what}).${extra}`;
  if (status === 404) return `Not found on Instagram: ${what}.`;
  return status >= 500 ? `Instagram is having trouble (HTTP ${status}); try again later.` : `Instagram error HTTP ${status}.${extra}`;
}

export interface InstagramDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
  now?: () => number;
}

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url';

/** Instagram insights: metric names are the account-level ones the API accepts. */
export const ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'follows_and_unfollows', 'profile_links_taps'] as const;
export const MEDIA_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'] as const;

/**
 * Instagram through Meta's official "Instagram API with Instagram Login": read-only, for a
 * Business or Creator account, with a long-lived token the owner generates. It never posts,
 * replies or sends DMs. Personal accounts have no official API; scraping them breaks
 * Instagram's terms and gets accounts restricted, so it is deliberately not offered.
 */
export function instagramConnector(deps: InstagramDeps): Connector {
  const now = deps.now ?? Date.now;
  const rest =
    deps.rest ?? new RestClient({ baseUrl: `https://graph.instagram.com/${VERSION}`, minGapMs: 600, service: 'Instagram', explain: explainInstagram, doFetch: deps.fetch });

  const token = async (): Promise<string> => {
    const s = await deps.secrets.get(INSTAGRAM_SECRET_ID);
    if (!s?.access_token) throw new ApiError('Instagram is not connected: ask the owner to open the Instagram setup link (Sunny: setup_connector instagram).');
    const refreshedAt = Number(s.refreshed_at ?? 0);
    if (now() - refreshedAt > REFRESH_AFTER_MS) {
      try {
        const r = await rest.request<Json>({ path: `/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: s.access_token })}`, what: 'the token refresh' });
        if (typeof r.access_token === 'string') {
          await deps.secrets.patch(INSTAGRAM_SECRET_ID, { access_token: r.access_token, refreshed_at: String(now()) });
          return r.access_token;
        }
      } catch {
        // A failed refresh is not fatal while the token still works; the next call that fails reports expiry.
      }
    }
    return s.access_token;
  };

  const get = async <T = Json>(path: string, params: Record<string, string | number | undefined> = {}, what = path): Promise<T> => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
    p.set('access_token', await token());
    return rest.request<T>({ path: `${path}?${p}`, what });
  };
  const page = (res: Json, results: unknown) => ({ note: UNTRUSTED_NOTE, results, nextCursor: res.paging?.cursors?.after, hasMore: Boolean(res.paging?.next) });
  const mediaId = (s: string) => {
    const m = /^(\d{5,30})$/.exec(s.trim());
    if (!m) throw new ApiError('Give the numeric media id (from get_posts), not a URL');
    return m[1]!;
  };
  const daysAgo = (n: number) => Math.floor(now() / 1000) - n * 86400;

  return {
    name: 'instagram',
    description: "Read-only view of the owner's Instagram Business/Creator account: profile, posts, stories, comments, DMs and insights. Never posts or sends anything.",
    status: async () => ((await deps.secrets.has(INSTAGRAM_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'no Instagram token (setup)' }),
    setup: (): AuthFlow =>
      formFlow(deps.secrets, {
        title: 'Connect Instagram (read only)',
        description:
          'Works with Instagram Business or Creator accounts only (switch in the Instagram app: Settings → Account type). In the Meta developer dashboard, create an app, add "Instagram API with Instagram Login", add your account as a tester, and generate a token with the read permissions (instagram_business_basic, instagram_business_manage_comments, instagram_business_manage_insights, instagram_business_manage_messages). Sunny only reads and never posts, replies or sends DMs. Tokens last 60 days; Sunny renews it by itself. Personal accounts have no official API.',
        links: [{ label: 'Meta for Developers', url: 'https://developers.facebook.com/apps/' }],
        fields: [{ name: 'access_token', label: 'Access token', type: 'password' }],
        secretId: INSTAGRAM_SECRET_ID,
        label: 'Instagram token',
        validate: async ({ access_token = '' }) => {
          try {
            await rest.request({ path: `/me?${new URLSearchParams({ fields: 'user_id,username', access_token })}`, what: 'the account' });
            return undefined;
          } catch (err) {
            return (err as Error).message;
          }
        },
        onSaved: async () => {
          await deps.secrets.patch(INSTAGRAM_SECRET_ID, { refreshed_at: String(now()) });
        },
      }),
    server: () =>
      createSdkMcpServer({
        name: 'instagram',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool(
            'profile',
            'The account profile: username, bio, account type and counts.',
            {},
            guard(async () => ok(await get('/me', { fields: 'user_id,username,name,account_type,biography,profile_picture_url,followers_count,follows_count,media_count,website' }, 'the profile'))),
          ),
          tool(
            'get_posts',
            'Recent posts and reels, newest first, with like and comment counts.',
            { limit: z.number().int().min(1).max(50).default(12), cursor: z.string().optional() },
            guard(async ({ limit, cursor }) => {
              const res = await get<Json>('/me/media', { fields: MEDIA_FIELDS, limit, after: cursor }, 'the posts');
              return ok(page(res, res.data));
            }),
          ),
          tool(
            'get_post',
            'One post by media id.',
            { media: z.string() },
            guard(async ({ media }) => ok(await get(`/${mediaId(media)}`, { fields: MEDIA_FIELDS }, 'this post'))),
          ),
          tool(
            'get_stories',
            'Stories live right now (they disappear after 24 hours).',
            {},
            guard(async () => {
              const res = await get<Json>('/me/stories', { fields: 'id,media_type,media_url,permalink,timestamp' }, 'the stories');
              return ok({ results: res.data ?? [] });
            }),
          ),
          tool(
            'get_comments',
            'Comments on a post, with replies.',
            { media: z.string(), limit: z.number().int().min(1).max(50).default(25), cursor: z.string().optional() },
            guard(async ({ media, limit, cursor }) => {
              const res = await get<Json>(`/${mediaId(media)}/comments`, { fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp}', limit, after: cursor }, 'these comments');
              return ok(page(res, res.data));
            }),
          ),
          tool(
            'get_dms',
            'Direct message conversations. Without `conversation`, lists them; with it, returns its recent messages.',
            { conversation: z.string().optional(), limit: z.number().int().min(1).max(50).default(20), cursor: z.string().optional() },
            guard(async ({ conversation, limit, cursor }) => {
              if (!conversation) {
                const res = await get<Json>('/me/conversations', { platform: 'instagram', fields: 'id,updated_time,participants', limit, after: cursor }, 'the conversations');
                return ok(page(res, res.data));
              }
              const res = await get<Json>(`/${conversation.trim().replace(/[^\w-]/g, '')}`, { fields: `messages.limit(${limit}){id,created_time,from,to,message}` }, 'this conversation');
              return ok({ note: UNTRUSTED_NOTE, results: res.messages?.data ?? [] });
            }),
          ),
          tool(
            'analytics',
            `Account insights over the last N days. Metrics: ${ACCOUNT_METRICS.join(', ')}. Followers and profile counts come from \`profile\`; \`follower_count\` gives daily follower growth.`,
            {
              metrics: z.array(z.enum([...ACCOUNT_METRICS, 'follower_count'])).min(1).max(8).default(['reach', 'views', 'accounts_engaged', 'total_interactions']),
              days: z.number().int().min(1).max(30).default(7),
            },
            guard(async ({ metrics, days }) => {
              const growth = metrics.includes('follower_count');
              const totals = metrics.filter((m) => m !== 'follower_count');
              const out: Json = {};
              if (totals.length) {
                const res = await get<Json>('/me/insights', { metric: totals.join(','), period: 'day', metric_type: 'total_value', since: daysAgo(days), until: Math.floor(now() / 1000) }, 'the insights');
                for (const m of res.data ?? []) out[m.name] = m.total_value?.value;
              }
              if (growth) {
                const res = await get<Json>('/me/insights', { metric: 'follower_count', period: 'day', since: daysAgo(Math.min(days, 30)), until: Math.floor(now() / 1000) }, 'the follower growth');
                out.follower_count_daily = (res.data?.[0]?.values ?? []).map((v: Json) => ({ date: v.end_time, change: v.value }));
              }
              return ok({ days, ...out });
            }),
          ),
          tool(
            'post_insights',
            `Insights for one post. Metrics: ${MEDIA_METRICS.join(', ')}.`,
            { media: z.string(), metrics: z.array(z.enum(MEDIA_METRICS)).min(1).default(['reach', 'views', 'likes', 'comments', 'shares', 'saved']) },
            guard(async ({ media, metrics }) => {
              const res = await get<Json>(`/${mediaId(media)}/insights`, { metric: metrics.join(',') }, 'this post');
              return ok(Object.fromEntries((res.data ?? []).map((m: Json) => [m.name, m.values?.[0]?.value])));
            }),
          ),
          tool(
            'lookup_account',
            'Public numbers and recent posts of another Business/Creator account by username (Instagram "business discovery"). Not available for personal accounts or with every token; the error says so.',
            { username: z.string().min(1).max(40), limit: z.number().int().min(1).max(12).default(6) },
            guard(async ({ username, limit }) => {
              const u = username.trim().replace(/^@/, '').replace(/[^\w.]/g, '');
              const res = await get<Json>('/me', { fields: `business_discovery.username(${u}){username,name,biography,followers_count,follows_count,media_count,media.limit(${limit}){id,caption,media_type,permalink,timestamp,like_count,comments_count}}` }, `@${u}`);
              return ok({ note: UNTRUSTED_NOTE, ...(res.business_discovery as Json) });
            }),
          ),
        ],
      }),
  };
}
