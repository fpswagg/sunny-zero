import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { explainWith, oauthCaller } from '../oauth-api.ts';
import { RestClient, guard, ok } from '../shared.ts';

export const SPOTIFY_SECRET_ID = 'spotify:account';
export const SPOTIFY_SCOPES = ['user-read-private', 'user-read-currently-playing', 'user-read-playback-state', 'user-read-recently-played', 'user-top-read', 'playlist-read-private', 'playlist-read-collaborative', 'user-library-read'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const explainSpotify = explainWith('Spotify', 'Spotify');

export interface SpotifyDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/** Spotify, read only: no playback control, no playlist or library changes (none of those scopes are requested). */
export function spotifyConnector(deps: SpotifyDeps): Connector {
  const rest = deps.rest ?? new RestClient({ baseUrl: 'https://api.spotify.com/v1', minGapMs: 200, service: 'Spotify', explain: explainSpotify, doFetch: deps.fetch });
  const call = oauthCaller({ secrets: deps.secrets, secretId: SPOTIFY_SECRET_ID, provider: PROVIDERS.spotify!, rest, setupName: 'spotify', fetch: deps.fetch });
  const qs = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
  const track = (t: Json) => ({ name: t?.name, artists: (t?.artists as Json[] | undefined)?.map((a) => a.name).join(', '), album: t?.album?.name, url: t?.external_urls?.spotify, durationMs: t?.duration_ms });

  return {
    name: 'spotify',
    description: "The owner's Spotify (read only): what is playing, recently played, top artists and tracks, playlists, saved tracks, search.",
    status: async () => ((await deps.secrets.has(SPOTIFY_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to Spotify (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.spotify!,
        scopes: SPOTIFY_SCOPES,
        secretId: SPOTIFY_SECRET_ID,
        title: 'Sign in to Spotify',
        description: 'Read-only: agents can see what you play, your history, top items, playlists and saved tracks. They cannot control playback or change playlists.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'spotify',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('me', 'The Spotify profile.', {}, guard(async () => { const m = await call('/me'); return ok({ name: m.display_name, id: m.id, country: m.country, plan: m.product, followers: m.followers?.total }); })),
          tool('now_playing', 'What is playing right now (or nothing).', {}, guard(async () => {
            const p = await call('/me/player/currently-playing?additional_types=episode');
            return ok(p?.item ? { playing: Boolean(p.is_playing), ...track(p.item), progressMs: p.progress_ms } : { playing: false });
          })),
          tool('recent', 'Recently played tracks.', { limit: z.number().int().min(1).max(50).default(20) }, guard(async ({ limit }) =>
            ok(((await call(`/me/player/recently-played?${qs({ limit })}`)).items as Json[]).map((i) => ({ ...track(i.track), playedAt: i.played_at }))))),
          tool('top', 'Top artists or tracks over a period (short = 4 weeks, medium = 6 months, long = years).', { type: z.enum(['artists', 'tracks']), range: z.enum(['short_term', 'medium_term', 'long_term']).default('medium_term'), limit: z.number().int().min(1).max(50).default(20) }, guard(async ({ type, range, limit }) => {
            const items = (await call(`/me/top/${type}?${qs({ time_range: range, limit })}`)).items as Json[];
            return ok(type === 'tracks' ? items.map(track) : items.map((a) => ({ name: a.name, genres: a.genres, popularity: a.popularity, url: a.external_urls?.spotify })));
          })),
          tool('playlists', "The owner's playlists.", { limit: z.number().int().min(1).max(50).default(30) }, guard(async ({ limit }) =>
            ok(((await call(`/me/playlists?${qs({ limit })}`)).items as Json[]).map((p) => ({ id: p.id, name: p.name, tracks: p.tracks?.total, public: p.public, url: p.external_urls?.spotify }))))),
          tool('playlist_tracks', 'Tracks of a playlist.', { id: z.string().min(5).max(40), limit: z.number().int().min(1).max(100).default(50) }, guard(async ({ id, limit }) =>
            ok(((await call(`/playlists/${id}/tracks?${qs({ limit })}`, { what: 'this playlist' })).items as Json[]).map((i) => track(i.track))))),
          tool('saved_tracks', 'Liked songs, latest first.', { limit: z.number().int().min(1).max(50).default(20) }, guard(async ({ limit }) =>
            ok(((await call(`/me/tracks?${qs({ limit })}`)).items as Json[]).map((i) => ({ ...track(i.track), savedAt: i.added_at }))))),
          tool('search', 'Search tracks, artists, albums or playlists.', { query: z.string().min(1).max(200), type: z.enum(['track', 'artist', 'album', 'playlist']).default('track'), limit: z.number().int().min(1).max(20).default(10) }, guard(async ({ query, type, limit }) => {
            const r = await call(`/search?${qs({ q: query, type, limit })}`, { what: 'search' });
            const items = (r[`${type}s`]?.items as Json[]).filter(Boolean);
            return ok(type === 'track' ? items.map(track) : items.map((i) => ({ name: i.name, url: i.external_urls?.spotify, id: i.id })));
          })),
        ],
      }),
  };
}
