import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../src/auth/oauth2.ts';
import { oauthCaller, explainWith } from '../src/connectors/oauth-api.ts';
import { RestClient } from '../src/connectors/shared.ts';
import { dropboxConnector, apiArg } from '../src/connectors/dropbox/index.ts';
import { spotifyConnector } from '../src/connectors/spotify/index.ts';
import { figmaConnector, fileKey } from '../src/connectors/figma/index.ts';
import { redditConnector } from '../src/connectors/reddit/index.ts';

const secrets = (v: Record<string, string> | null) => ({ get: async () => v ?? undefined, has: async () => Boolean(v), set: async () => {}, patch: async () => {} }) as never;

describe('oauthCaller', () => {
  it('sends the bearer token, extra headers, raw bodies and text', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response('hello', { status: 200 }))) as never;
    const rest = new RestClient({ baseUrl: 'https://api.test', minGapMs: 0, service: 'T', explain: explainWith('T', 't'), doFetch });
    const call = oauthCaller({ secrets: secrets({ access_token: 'AT', expires_at: String(Date.now() + 3600_000) }), secretId: 's', provider: PROVIDERS.reddit!, rest, setupName: 't', headers: { 'user-agent': 'ua' } });
    expect(await call('/x', { method: 'POST', raw: 'body', asText: true, headers: { 'content-type': 'text/plain' } })).toBe('hello');
    const h = seen[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer AT');
    expect(h['user-agent']).toBe('ua');
    expect(h['content-type']).toBe('text/plain');
    expect(seen[0]!.init.body).toBe('body');
  });
  it('says how to connect when signed out', async () => {
    const rest = new RestClient({ baseUrl: 'https://api.test', minGapMs: 0, service: 'T', explain: explainWith('T', 't') });
    await expect(oauthCaller({ secrets: secrets(null), secretId: 's', provider: PROVIDERS.spotify!, rest, setupName: 'spotify' })('/x')).rejects.toThrow(/setup_connector spotify/);
  });
  it('explains errors without echoing long bodies', () => {
    expect(explainWith('S', 'S')(401, {}, 'x')).toContain('setup again');
    expect(explainWith('S', 'S')(400, { error: 'x'.repeat(500) }, 'x').length).toBeLessThan(300);
  });
});

describe('providers and tools', () => {
  it('provider settings', () => {
    expect(PROVIDERS.reddit).toMatchObject({ basicAuth: true, pkce: false });
    expect(PROVIDERS.dropbox!.authorizeParams).toMatchObject({ token_access_type: 'offline' });
  });
  it('read-only connectors have no mutating tools', () => {
    for (const c of [spotifyConnector({ secrets: secrets(null) }), figmaConnector({ secrets: secrets(null) }), redditConnector({ secrets: secrets(null) })]) expect(c.mutatingTools ?? []).toEqual([]);
  });
  it('dropbox writes ask; header arg is ascii', async () => {
    const c = dropboxConnector({ secrets: secrets(null) });
    expect(c.mutatingTools).toEqual(['upload', 'share_link']);
    expect((await c.status()).ready).toBe(false);
    expect(apiArg({ path: '/café' })).toBe('{"path":"/caf\\u00e9"}');
  });
  it('figma file keys from urls', () => {
    expect(fileKey('https://www.figma.com/design/AbC123xyz/My-file?node-id=1')).toBe('AbC123xyz');
    expect(fileKey('AbC123xyz')).toBe('AbC123xyz');
  });
});
