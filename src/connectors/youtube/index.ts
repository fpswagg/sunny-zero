import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { explainWith, oauthCaller } from '../oauth-api.ts';
import { RestClient, UNTRUSTED_NOTE, guard, ok } from '../shared.ts';

export const YOUTUBE_SECRET_ID = 'google:youtube';
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const explainYouTube = (status: number, body: unknown, what: string) => {
  const reason = (((body ?? {}) as Json).error?.errors?.[0]?.reason as string | undefined) ?? '';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return 'YouTube daily API quota used up (10,000 units, resets at midnight Pacific). Try tomorrow; search costs 100 units.';
  if (reason === 'commentsDisabled') return 'Comments are turned off on this video.';
  return explainWith('YouTube', 'YouTube')(status, body, what);
};

export interface YouTubeDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/** YouTube Data API, read only (youtube.readonly scope): no upload, comment, rate or subscribe is possible. */
export function youtubeConnector(deps: YouTubeDeps): Connector {
  const rest = deps.rest ?? new RestClient({ baseUrl: 'https://www.googleapis.com/youtube/v3', minGapMs: 150, service: 'YouTube', explain: explainYouTube, doFetch: deps.fetch });
  const call = oauthCaller({ secrets: deps.secrets, secretId: YOUTUBE_SECRET_ID, provider: PROVIDERS.google!, rest, setupName: 'youtube', fetch: deps.fetch });
  const qs = (o: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  const video = (v: Json) => ({ id: v.id?.videoId ?? v.id, title: v.snippet?.title, channel: v.snippet?.channelTitle, published: v.snippet?.publishedAt, views: v.statistics?.viewCount, likes: v.statistics?.likeCount, comments: v.statistics?.commentCount, duration: v.contentDetails?.duration, url: `https://youtu.be/${v.id?.videoId ?? v.id}` });
  const channel = (c: Json) => ({ id: c.id, title: c.snippet?.title, description: c.snippet?.description?.slice(0, 500), subscribers: c.statistics?.hiddenSubscriberCount ? 'hidden' : c.statistics?.subscriberCount, videos: c.statistics?.videoCount, views: c.statistics?.viewCount, uploadsPlaylist: c.contentDetails?.relatedPlaylists?.uploads });

  return {
    name: 'youtube',
    description: "The owner's YouTube channel (read only): channel info and stats, videos, video stats, comments, search.",
    status: async () => ((await deps.secrets.has(YOUTUBE_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to Google (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.google!,
        scopes: YOUTUBE_SCOPES,
        secretId: YOUTUBE_SECRET_ID,
        title: 'Sign in to YouTube',
        description: 'Read-only: agents can see your channel, videos, stats and comments. They cannot upload, comment, like or subscribe. The YouTube API has a daily quota of 10,000 units.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'youtube',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('my_channel', "The owner's channel: stats and uploads playlist.", {}, guard(async () => ok(((await call(`/channels?${qs({ part: 'snippet,statistics,contentDetails', mine: 'true' })}`)).items as Json[]).map(channel)))),
          tool('channel', 'Public info of any channel by id.', { id: z.string().min(3).max(60) }, guard(async ({ id }) => ok(((await call(`/channels?${qs({ part: 'snippet,statistics,contentDetails', id })}`, { what: 'this channel' })).items as Json[]).map(channel)))),
          tool('my_videos', "The owner's latest uploads with stats.", { limit: z.number().int().min(1).max(50).default(15) }, guard(async ({ limit }) => {
            const ch = ((await call(`/channels?${qs({ part: 'contentDetails', mine: 'true' })}`)).items as Json[])[0];
            const uploads = ch?.contentDetails?.relatedPlaylists?.uploads;
            if (!uploads) return ok([]);
            const ids = ((await call(`/playlistItems?${qs({ part: 'contentDetails', playlistId: uploads, maxResults: limit })}`)).items as Json[]).map((i) => i.contentDetails.videoId).join(',');
            return ok(ids ? ((await call(`/videos?${qs({ part: 'snippet,statistics,contentDetails', id: ids })}`)).items as Json[]).map(video) : []);
          })),
          tool('video', 'Details and stats of videos by id (up to 20).', { ids: z.array(z.string()).min(1).max(20) }, guard(async ({ ids }) => ok({ note: UNTRUSTED_NOTE, results: ((await call(`/videos?${qs({ part: 'snippet,statistics,contentDetails', id: ids.join(',') })}`, { what: 'these videos' })).items as Json[]).map((v) => ({ ...video(v), description: v.snippet?.description?.slice(0, 1000) })) }))),
          tool('comments', 'Top-level comments of a video (newest or most relevant).', { videoId: z.string().min(5).max(20), order: z.enum(['time', 'relevance']).default('time'), limit: z.number().int().min(1).max(50).default(20) }, guard(async ({ videoId, order, limit }) =>
            ok({ note: UNTRUSTED_NOTE, results: ((await call(`/commentThreads?${qs({ part: 'snippet', videoId, order, maxResults: limit, textFormat: 'plainText' })}`, { what: 'comments' })).items as Json[]).map((t) => ({ author: t.snippet.topLevelComment.snippet.authorDisplayName, text: String(t.snippet.topLevelComment.snippet.textDisplay).slice(0, 1000), likes: t.snippet.topLevelComment.snippet.likeCount, replies: t.snippet.totalReplyCount, at: t.snippet.topLevelComment.snippet.publishedAt })) }))),
          tool('search', 'Search public videos (costs 100 quota units, so use sparingly).', { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(25).default(10) }, guard(async ({ query, limit }) =>
            ok({ note: UNTRUSTED_NOTE, results: ((await call(`/search?${qs({ part: 'snippet', q: query, type: 'video', maxResults: limit })}`, { what: 'search' })).items as Json[]).map(video) }))),
        ],
      }),
  };
}
