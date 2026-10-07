import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../src/auth/manager.ts';
import { formFlow } from '../src/auth/flows.ts';
import { clientSecretId, getAccessToken, oauthFlow, PROVIDERS } from '../src/auth/oauth2.ts';
import { renderScreen } from '../src/auth/pages.ts';
import { SecretStore } from '../src/secrets/store.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
beforeEach(() => db.reset());
afterAll(() => db.drop());

const store = () => new SecretStore(db.sql, mkdtempSync(join(tmpdir(), 'sunny-auth-')));

describe('form flow through the manager', () => {
  it('re-asks on missing fields, saves, then locks the link', async () => {
    const secrets = store();
    const auth = new AuthManager('https://sunny.test', 60_000);
    const done = vi.fn();
    const link = auth.create(
      formFlow(secrets, {
        title: 'IMAP',
        fields: [
          { name: 'user', label: 'Email', type: 'email' },
          { name: 'password', label: 'App password', type: 'password' },
        ],
        secretId: 'imap',
      }),
      done,
    );
    expect(link.url).toBe(`https://sunny.test/auth/${link.token}`);
    expect((await auth.view(link.token))?.kind).toBe('form');

    const retry = await auth.submit(link.token, { user: 'me@example.com' });
    expect(retry).toMatchObject({ kind: 'form', error: expect.stringContaining('App password') });
    // The non-secret field is kept, the secret one is not echoed.
    const html = renderScreen(retry!, '/auth/x');
    expect(html).toContain('value="me@example.com"');

    const ok = await auth.submit(link.token, { user: 'me@example.com', password: 'abcd efgh' });
    expect(ok?.kind).toBe('done');
    expect(await secrets.get('imap')).toEqual({ user: 'me@example.com', password: 'abcd efgh' });
    expect(done).toHaveBeenCalledWith(true, expect.anything());
    // Further submissions cannot overwrite.
    expect((await auth.submit(link.token, { user: 'evil', password: 'x' }))?.kind).toBe('done');
    expect((await secrets.get('imap'))?.user).toBe('me@example.com');
    auth.close();
  });

  it('runs validation before saving', async () => {
    const secrets = store();
    const auth = new AuthManager('https://sunny.test', 60_000);
    const link = auth.create(
      formFlow(secrets, { title: 'Key', fields: [{ name: 'key', label: 'Key', type: 'password' }], secretId: 'k', validate: async (v) => (v.key === 'good' ? undefined : 'Key rejected') }),
    );
    expect(await auth.submit(link.token, { key: 'bad' })).toMatchObject({ kind: 'form', error: 'Key rejected' });
    expect(await secrets.has('k')).toBe(false);
    expect((await auth.submit(link.token, { key: 'good' }))?.kind).toBe('done');
    auth.close();
  });

  it('unknown and expired links show nothing', async () => {
    const auth = new AuthManager('https://sunny.test', -1);
    const link = auth.create(formFlow(store(), { title: 'x', fields: [], secretId: 'x' }));
    expect(await auth.view(link.token)).toBeUndefined();
    expect(await auth.view('nope')).toBeUndefined();
    auth.close();
  });

  it('escapes user-controlled text in pages', () => {
    const html = renderScreen({ kind: 'form', title: '<script>x</script>', fields: [{ name: 'a', label: '"><img>', value: '<b>' }] }, '/auth/t');
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('"><img>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('oauth flow', () => {
  it('asks for the OAuth client first, then redirects with PKCE and exchanges the code', async () => {
    const secrets = store();
    const auth = new AuthManager('https://sunny.test', 60_000);
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'gmail.readonly' }));
    const link = auth.create(oauthFlow(secrets, { provider: PROVIDERS.google!, scopes: ['https://www.googleapis.com/auth/gmail.readonly'], secretId: 'google:gmail', fetch: fetchMock as typeof fetch }));

    const setup = await auth.view(link.token);
    expect(setup).toMatchObject({ kind: 'form' });
    expect(setup?.kind === 'form' && setup.description).toContain('https://sunny.test/auth/oauth/callback');

    const redirect = await auth.submit(link.token, { client_id: 'cid', client_secret: 'csecret' });
    expect(redirect?.kind).toBe('redirect');
    const url = new URL(redirect?.kind === 'redirect' ? redirect.url : '');
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toBe(link.token);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');

    const done = await auth.callback(link.token, new URLSearchParams({ code: 'the-code', state: link.token }));
    expect(done?.kind).toBe('done');
    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(await secrets.get('google:gmail')).toMatchObject({ access_token: 'at', refresh_token: 'rt' });
    auth.close();
  });

  it('shows the provider error and lets the user retry', async () => {
    const secrets = store();
    await secrets.set(clientSecretId('google'), { client_id: 'cid', client_secret: 's' }, { kind: 'form' });
    const auth = new AuthManager('https://sunny.test', 60_000);
    const link = auth.create(oauthFlow(secrets, { provider: PROVIDERS.google!, scopes: ['x'], secretId: 'g' }));
    expect((await auth.view(link.token))?.kind).toBe('redirect');
    const again = await auth.callback(link.token, new URLSearchParams({ error: 'access_denied' }));
    expect(again).toMatchObject({ kind: 'redirect', error: expect.stringContaining('access_denied') });
    auth.close();
  });

  it('refreshes an expired access token', async () => {
    const secrets = store();
    await secrets.set(clientSecretId('google'), { client_id: 'cid', client_secret: 's' }, { kind: 'form' });
    await secrets.set('g', { access_token: 'old', refresh_token: 'rt', expires_at: String(Date.now() - 1000) }, { kind: 'oauth2' });
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'new', expires_in: 3600 }));
    expect(await getAccessToken(secrets, 'g', PROVIDERS.google!, fetchMock as typeof fetch)).toBe('new');
    expect(await secrets.get('g')).toMatchObject({ access_token: 'new', refresh_token: 'rt' });
    expect(await getAccessToken(secrets, 'g', PROVIDERS.google!, fetchMock as typeof fetch)).toBe('new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
