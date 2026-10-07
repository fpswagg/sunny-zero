import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, getAccessToken, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { ApiError, RestClient, guard, ok } from '../shared.ts';

export const TIKTOK_SECRET_ID = 'tiktok:account';
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CODES: Record<string, string> = {
  access_token_invalid: 'TikTok refused the token. Ask the owner to run the TikTok setup again.',
  scope_not_authorized: 'The owner did not grant this permission when signing in. Run the TikTok setup again and accept all scopes.',
  rate_limit_exceeded: 'TikTok rate limit reached. Try again in a minute.',
  scope_permission_missed: 'The TikTok app is not approved for this permission yet (check the app review status in the TikTok developer portal).',
};

export function explainTikTok(status: number, body: unknown, what: string): string {
  const e = ((body ?? {}) as Json).error ?? {};
  const known = CODES[e.code as string];
  if (known) return known;
  const extra = e.message ? ` TikTok says: ${e.message}` : '';
  if (status === 401) return CODES.access_token_invalid!;
  if (status === 429) return CODES.rate_limit_exceeded!;
  if (status === 404) return `Not found on TikTok: ${what}.`;
  return status >= 500 ? `TikTok is having trouble (HTTP ${status}); try again later.` : `TikTok error HTTP ${status} (${what}).${extra}`;
}

export interface TikTokDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

const USER_FIELDS = 'open_id,display_name,avatar_url,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count,username';
const VIDEO_FIELDS = 'id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count';

/**
 * TikTok through the official Display API: the signed-in owner's own profile, videos and
 * stats, read-only. TikTok has no official search or trending API for normal developers
 * (the Research API is for approved academics), and scraping them breaks its terms and gets
 * accounts and IPs blocked, so those are deliberately not offered. Nothing is ever posted.
 */
export function tiktokConnector(deps: TikTokDeps): Connector {
  const rest =
    deps.rest ?? new RestClient({ baseUrl: 'https://open.tiktokapis.com', minGapMs: 300, service: 'TikTok', explain: explainTikTok, doFetch: deps.fetch });

  const call = async (path: string, o: { method?: 'GET' | 'POST'; body?: unknown; what: string }): Promise<Json> => {
    let token: string;
    try {
      token = await getAccessToken(deps.secrets, TIKTOK_SECRET_ID, PROVIDERS.tiktok!, deps.fetch);
    } catch {
      throw new ApiError('TikTok is not connected: ask the owner to open the TikTok setup link (Sunny: setup_connector tiktok).');
    }
    const res = await rest.request<Json>({ path, method: o.method, body: o.body, what: o.what, headers: { authorization: `Bearer ${token}` } });
    const code = res.error?.code;
    if (code && code !== 'ok') throw new ApiError(explainTikTok(200, res, o.what));
    return res.data ?? {};
  };

  return {
    name: 'tiktok',
    description: "Read-only view of the owner's own TikTok account: profile, followers, videos and per-video stats. No search or trending (TikTok offers no official API for it); never posts.",
    status: async () => ((await deps.secrets.has(TIKTOK_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to TikTok (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.tiktok!,
        scopes: TIKTOK_SCOPES,
        secretId: TIKTOK_SECRET_ID,
        title: 'Sign in to TikTok (read only)',
        description: 'Agents read your profile, videos and stats. They cannot post, and cannot see other accounts: TikTok’s official API only exposes the account that signs in.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'tiktok',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('profile', 'The owner’s TikTok profile: name, bio, verified, followers, following, likes and video counts.', {}, guard(async () => ok((await call(`/v2/user/info/?fields=${USER_FIELDS}`, { what: 'the profile' })).user))),
          tool(
            'my_videos',
            'The owner’s public videos, newest first, with views, likes, comments and shares.',
            { limit: z.number().int().min(1).max(20).default(10), cursor: z.number().int().optional().describe('cursor from the previous call') },
            guard(async ({ limit, cursor }) => {
              const d = await call(`/v2/video/list/?fields=${VIDEO_FIELDS}`, { method: 'POST', body: { max_count: limit, ...(cursor ? { cursor } : {}) }, what: 'the videos' });
              return ok({ results: d.videos ?? [], nextCursor: d.has_more ? d.cursor : undefined });
            }),
          ),
          tool(
            'video_stats',
            'Fresh stats for specific videos of the owner (up to 20 ids from my_videos).',
            { ids: z.array(z.string().regex(/^\d{5,30}$/)).min(1).max(20) },
            guard(async ({ ids }) => {
              const d = await call(`/v2/video/query/?fields=${VIDEO_FIELDS}`, { method: 'POST', body: { filters: { video_ids: ids } }, what: 'these videos' });
              return ok({ results: d.videos ?? [] });
            }),
          ),
        ],
      }),
  };
}
