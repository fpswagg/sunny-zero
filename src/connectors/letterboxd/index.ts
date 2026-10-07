import { createHmac, randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { formFlow } from '../../auth/flows.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { ApiError, RestClient, UNTRUSTED_NOTE, WriteBudget, guard, ok } from '../shared.ts';

export const LETTERBOXD_SECRET_ID = 'letterboxd:account';
const BASE = 'https://api.letterboxd.com/api/v0';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function explainLetterboxd(status: number, body: unknown, what: string): string {
  const b = (body ?? {}) as Json;
  const extra = b.messages?.[0] ?? b.error_description ?? b.message ?? b.error;
  const detail = extra ? ` Letterboxd says: ${typeof extra === 'string' ? extra : (extra.message ?? JSON.stringify(extra))}` : '';
  switch (status) {
    case 400:
      return `Letterboxd rejected the request (${what}).${detail}`;
    case 401:
      return 'Letterboxd refused the login or signature. Check the API key/secret, username and password in the Letterboxd setup.';
    case 403:
      return `Letterboxd forbids this (${what}): the API key may not have this permission, or the member is private.${detail}`;
    case 404:
      return `Not found on Letterboxd: ${what}.`;
    case 429:
      return 'Letterboxd rate limit reached. Try again in a minute.';
    default:
      return status >= 500 ? `Letterboxd is having trouble (HTTP ${status}); try again later.` : `Letterboxd error HTTP ${status}.${detail}`;
  }
}

/** Letterboxd signs every request: HMAC-SHA256 over METHOD, full URL and body, split by NUL bytes. */
export function signRequest(secret: string, method: string, url: string, body = ''): string {
  return createHmac('sha256', secret).update(`${method}\u0000${url}\u0000${body}`).digest('hex');
}

/** Letterboxd ratings run from 0.5 to 5 in half steps. */
export const ratingSchema = z
  .number()
  .min(0.5)
  .max(5)
  .refine((n) => Number.isInteger(n * 2), 'Ratings go in half steps: 0.5, 1, 1.5 … 5');

export interface LetterboxdDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
}

/**
 * Letterboxd through its official API. That API is available on request only (Letterboxd
 * issues an API key and secret to approved projects), and its member login is a password
 * grant, so the owner's password is stored encrypted next to the key. Without an approved
 * key this connector cannot work and nothing else (scraping, unofficial logins) is tried,
 * since Letterboxd's terms forbid it. Writes ask the owner and are capped per hour.
 */
export function letterboxdConnector(deps: LetterboxdDeps): Connector {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;
  const rest = deps.rest ?? new RestClient({ baseUrl: BASE, minGapMs: 500, service: 'Letterboxd', explain: explainLetterboxd, doFetch: deps.fetch });
  const writes = new WriteBudget(30, 60 * 60_000);
  let session: { token: string; expiresAt: number; refresh?: string } | undefined;
  let memberId: string | undefined;

  const creds = async () => {
    const c = await deps.secrets.get(LETTERBOXD_SECRET_ID);
    if (!c?.api_key || !c.api_secret || !c.username || !c.password) throw new ApiError('Letterboxd is not connected: ask the owner to open the Letterboxd setup link (Sunny: setup_connector letterboxd).');
    return c as Record<'api_key' | 'api_secret' | 'username' | 'password', string>;
  };

  /** Adds apikey/nonce/timestamp and the signature to a path. */
  const signed = (c: { api_key: string; api_secret: string }, method: string, path: string, body = ''): string => {
    const url = new URL(`${BASE}${path}`);
    url.searchParams.set('apikey', c.api_key);
    url.searchParams.set('nonce', uuid());
    url.searchParams.set('timestamp', String(Math.floor(now() / 1000)));
    const sig = signRequest(c.api_secret, method, url.toString(), body);
    url.searchParams.set('signature', sig);
    return url.toString();
  };

  const login = async (c: Awaited<ReturnType<typeof creds>>) => {
    const form = session?.refresh && now() > (session?.expiresAt ?? 0) ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refresh }) : new URLSearchParams({ grant_type: 'password', username: c.username, password: c.password });
    const res = await rest.request<Json>({ method: 'POST', path: signed(c, 'POST', '/auth/token', form.toString()), body: form, what: 'the login' });
    session = { token: res.access_token, expiresAt: now() + (Number(res.expires_in ?? 3600) - 60) * 1000, refresh: res.refresh_token };
  };

  const call = async <T = Json>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, what = path): Promise<T> => {
    const c = await creds();
    if (!session || now() > session.expiresAt) await login(c);
    const json = body === undefined ? '' : JSON.stringify(body);
    return rest.request<T>({ method, path: signed(c, method, path, json), body, what, headers: { authorization: `Bearer ${session!.token}` } });
  };

  const me = async () => (memberId ??= (await call<Json>('GET', '/me', undefined, 'the account')).member.id as string);
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
    return p.toString();
  };
  const film = (f: Json) => ({ id: f.id, name: f.name, year: f.releaseYear, directors: (f.directors ?? []).map((d: Json) => d.name), rating: f.rating, url: f.links?.find((l: Json) => l.type === 'letterboxd')?.url });
  const entry = (e: Json) => ({ id: e.id, film: film(e.film ?? {}), rating: e.rating, review: e.review?.text, containsSpoilers: e.review?.containsSpoilers, watchedOn: e.diaryDetails?.diaryDate, at: e.whenCreated, url: e.links?.find((l: Json) => l.type === 'letterboxd')?.url });
  const page = (res: Json, results: unknown) => ({ note: UNTRUSTED_NOTE, results, nextCursor: res.next });

  return {
    name: 'letterboxd',
    description: "The owner's Letterboxd: search films, watchlist, reviews and ratings; add to watchlist, rate and review (asking first). Needs a Letterboxd-approved API key.",
    mutatingTools: ['add_to_watchlist', 'remove_from_watchlist', 'rate', 'review', 'delete_review'],
    status: async () => ((await deps.secrets.has(LETTERBOXD_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'no Letterboxd API key (setup)' }),
    setup: (): AuthFlow =>
      formFlow(deps.secrets, {
        title: 'Connect Letterboxd',
        description:
          'Letterboxd gives API keys only on request (write to api@letterboxd.com describing the project). Enter the key and secret they send, then your own username and password: the API logs members in with their password, so it is stored encrypted and never shown to agents. Letterboxd’s terms forbid scraping, so nothing works without an approved key.',
        links: [{ label: 'Letterboxd API', url: 'https://api-docs.letterboxd.com/' }],
        fields: [
          { name: 'api_key', label: 'API key' },
          { name: 'api_secret', label: 'API secret', type: 'password' },
          { name: 'username', label: 'Letterboxd username' },
          { name: 'password', label: 'Letterboxd password', type: 'password' },
        ],
        secretId: LETTERBOXD_SECRET_ID,
        label: 'Letterboxd account',
        validate: async (v) => {
          try {
            const form = new URLSearchParams({ grant_type: 'password', username: v.username ?? '', password: v.password ?? '' });
            const c = { api_key: v.api_key ?? '', api_secret: v.api_secret ?? '' };
            await rest.request({ method: 'POST', path: signed(c, 'POST', '/auth/token', form.toString()), body: form, what: 'the login' });
            return undefined;
          } catch (err) {
            return (err as Error).message;
          }
        },
      }),
    server: () =>
      createSdkMcpServer({
        name: 'letterboxd',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool(
            'search_films',
            'Search films by title.',
            { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(30).default(10) },
            guard(async ({ query, limit }) => {
              const res = await call<Json>('GET', `/search?${qs({ input: query, include: 'FilmSearchItem', perPage: limit })}`, undefined, 'the search');
              return ok({ results: (res.items ?? []).map((i: Json) => film(i.film ?? {})) });
            }),
          ),
          tool('get_film', 'Details of a film by Letterboxd id, and whether the owner watched, rated or watchlisted it.', { film: z.string().min(2).max(20) }, guard(async ({ film: id }) => {
            const [f, rel] = await Promise.all([call<Json>('GET', `/film/${id}`, undefined, 'this film'), call<Json>('GET', `/film/${id}/me`, undefined, 'this film')]);
            return ok({ ...film(f), description: f.description, genres: (f.genres ?? []).map((g: Json) => g.name), runtime: f.runTime, you: rel.relationship });
          })),
          tool(
            'watchlist',
            "The owner's watchlist (or another public member's, by member id).",
            { member: z.string().optional(), limit: z.number().int().min(1).max(100).default(30), cursor: z.string().optional() },
            guard(async ({ member, limit, cursor }) => {
              const res = await call<Json>('GET', `/member/${member ?? (await me())}/watchlist?${qs({ perPage: limit, cursor })}`, undefined, 'the watchlist');
              return ok(page(res, (res.items ?? []).map(film)));
            }),
          ),
          tool(
            'reviews',
            'Reviews: the owner’s own, a member’s (member id), or everyone’s for a film (film id).',
            { member: z.string().optional(), film: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), cursor: z.string().optional() },
            guard(async ({ member, film: f, limit, cursor }) => {
              const who = f ? member : (member ?? (await me()));
              const res = await call<Json>('GET', `/log-entries?${qs({ member: who, film: f, hasReview: 'true', perPage: limit, cursor, memberRelationship: who && !member ? 'Owner' : undefined })}`, undefined, 'the reviews');
              return ok(page(res, (res.items ?? []).map(entry)));
            }),
          ),
          tool(
            'ratings',
            'Films the owner (or a member) rated, with their star ratings.',
            { member: z.string().optional(), limit: z.number().int().min(1).max(100).default(30), cursor: z.string().optional() },
            guard(async ({ member, limit, cursor }) => {
              const res = await call<Json>('GET', `/log-entries?${qs({ member: member ?? (await me()), hasRating: 'true', perPage: limit, cursor })}`, undefined, 'the ratings');
              return ok(page(res, (res.items ?? []).map(entry)));
            }),
          ),
          tool('add_to_watchlist', 'Add a film to the owner’s watchlist.', { film: z.string() }, guard(async ({ film: id }) => {
            writes.take('writes');
            await call('PATCH', `/film/${id}/me`, { inWatchlist: true }, 'this film');
            return ok('Added to the watchlist.');
          })),
          tool('remove_from_watchlist', 'Remove a film from the owner’s watchlist.', { film: z.string() }, guard(async ({ film: id }) => {
            writes.take('writes');
            await call('PATCH', `/film/${id}/me`, { inWatchlist: false }, 'this film');
            return ok('Removed from the watchlist.');
          })),
          tool('rate', 'Rate a film, 0.5 to 5 stars in half steps.', { film: z.string(), rating: ratingSchema }, guard(async ({ film: id, rating }) => {
            writes.take('writes');
            await call('PATCH', `/film/${id}/me`, { rating }, 'this film');
            return ok(`Rated ${rating} stars.`);
          })),
          tool(
            'review',
            'Log a film with a written review (and optional rating) to the owner’s diary.',
            { film: z.string(), text: z.string().min(1).max(10_000), rating: ratingSchema.optional(), spoilers: z.boolean().default(false), watchedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
            guard(async ({ film: id, text, rating, spoilers, watchedOn }) => {
              writes.take('writes');
              const res = await call<Json>('POST', '/log-entries', { filmId: id, review: { text, containsSpoilers: spoilers }, ...(rating ? { rating } : {}), ...(watchedOn ? { diaryDetails: { diaryDate: watchedOn } } : {}) }, 'the review');
              return ok({ logged: entry(res.logEntry ?? res) });
            }),
          ),
          tool('delete_review', 'Delete one of the owner’s own log entries/reviews by its id (permanent).', { entry: z.string().min(2).max(20) }, guard(async ({ entry: id }) => {
            writes.take('writes');
            await call('DELETE', `/log-entry/${id}`, undefined, 'this entry');
            return ok('Deleted.');
          })),
        ],
      }),
  };
}
