import { createHash, randomBytes } from 'node:crypto';
import type { SecretStore, SecretValues } from '../secrets/store.ts';
import type { AuthFlow, Screen } from './types.ts';
import { formFlow } from './flows.ts';

export interface OAuthProvider {
  id: string;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Extra authorize parameters, e.g. Google's access_type=offline to get a refresh token. */
  authorizeParams?: Record<string, string>;
  /** Where the user creates the OAuth client, shown on the setup form. */
  consoleUrl?: string;
  setupHelp?: string;
  /** Name of the client id parameter; TikTok calls it client_key. */
  clientIdParam?: string;
  /** Scope separator; TikTok wants commas. */
  scopeSeparator?: string;
  /** Send client credentials as HTTP Basic (X confidential clients). */
  basicAuth?: boolean;
  /** PKCE (default true). */
  pkce?: boolean;
}

export const PROVIDERS: Record<string, OAuthProvider> = {
  x: {
    id: 'x',
    name: 'X',
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    basicAuth: true,
    consoleUrl: 'https://developer.x.com/en/portal/dashboard',
    setupHelp: 'In your X developer app, enable OAuth 2.0 (type "Web App / confidential client") and add the redirect URI shown below.',
  },
  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    clientIdParam: 'client_key',
    scopeSeparator: ',',
    pkce: false,
    consoleUrl: 'https://developers.tiktok.com/apps/',
    setupHelp: 'Create an app with the Login Kit and Display API products, add the redirect URI shown below, and use the Client key as Client ID.',
  },
  google: {
    id: 'google',
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    setupHelp:
      'Create an OAuth client of type "Web application" and add the redirect URI shown below. Set the consent screen\'s publishing status to "In production" (in "Testing", Google expires tokens after 7 days).',
  },
  dropbox: {
    id: 'dropbox',
    name: 'Dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    authorizeParams: { token_access_type: 'offline' },
    consoleUrl: 'https://www.dropbox.com/developers/apps',
    setupHelp: 'Create a scoped app, tick the permissions Sunny needs (files.metadata.read, files.content.read, files.content.write, sharing.write) and add the redirect URI shown below. App key = Client ID.',
  },
  spotify: {
    id: 'spotify',
    name: 'Spotify',
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    basicAuth: true,
    consoleUrl: 'https://developer.spotify.com/dashboard',
    setupHelp: 'Create an app (Web API) and add the redirect URI shown below. In development mode, add your own account under User Management.',
  },
  figma: {
    id: 'figma',
    name: 'Figma',
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    basicAuth: true,
    consoleUrl: 'https://www.figma.com/developers/apps',
    setupHelp: 'Create an app, add the redirect URI shown below and the read scopes (file_content:read, file_comments:read, file_versions:read, current_user:read).',
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    basicAuth: true,
    pkce: false,
    authorizeParams: { duration: 'permanent' },
    consoleUrl: 'https://www.reddit.com/prefs/apps',
    setupHelp: 'Create an app of type "web app", set the redirect uri shown below. Client ID is the short string under the app name.',
  },
  microsoft: {
    id: 'microsoft',
    name: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    consoleUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  github: {
    id: 'github',
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    consoleUrl: 'https://github.com/settings/developers',
  },
};

/** Secret id holding a provider's OAuth client (client_id, client_secret). */
export const clientSecretId = (provider: string) => `oauth-client:${provider}`;

export interface OAuthFlowOptions {
  provider: OAuthProvider;
  scopes: string[];
  /** Secret id the tokens are stored under, e.g. "google:gmail". */
  secretId: string;
  title?: string;
  description?: string;
  onSaved?: (tokens: SecretValues) => Promise<void>;
  fetch?: typeof fetch;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * The provider's own consent screen (authorization code + PKCE). When no OAuth client is
 * configured for the provider yet, the flow first asks for one on the same page.
 */
export function oauthFlow(secrets: SecretStore, opts: OAuthFlowOptions): AuthFlow {
  const { provider } = opts;
  const title = opts.title ?? `Sign in with ${provider.name}`;
  const doFetch = opts.fetch ?? fetch;
  const verifier = b64url(randomBytes(32));
  let setup: AuthFlow | undefined;

  const consent = async (token: string, redirectUri: string, error?: string): Promise<Screen> => {
    const client = await secrets.get(clientSecretId(provider.id));
    if (!client?.client_id) throw new Error('OAuth client missing');
    const url = new URL(provider.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      [provider.clientIdParam ?? 'client_id']: client.client_id,
      redirect_uri: redirectUri,
      scope: opts.scopes.join(provider.scopeSeparator ?? ' '),
      state: token,
      ...(provider.pkce === false ? {} : { code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }),
      ...provider.authorizeParams,
    }).toString();
    return { kind: 'redirect', title, description: opts.description, url: url.toString(), buttonLabel: `Continue with ${provider.name}`, error };
  };

  return {
    title,
    async start(ctx) {
      if (await secrets.has(clientSecretId(provider.id))) return consent(ctx.token, ctx.oauthRedirectUri);
      setup = formFlow(secrets, {
        title: `Set up ${provider.name} sign-in`,
        description: [
          `Sunny needs your own ${provider.name} OAuth client once. ${provider.setupHelp ?? ''}`,
          `Redirect URI: ${ctx.oauthRedirectUri}`,
        ].join('\n\n'),
        links: provider.consoleUrl ? [{ label: `Open ${provider.name} console`, url: provider.consoleUrl }] : undefined,
        fields: [
          { name: 'client_id', label: 'Client ID' },
          { name: 'client_secret', label: 'Client secret', type: 'password' },
        ],
        secretId: clientSecretId(provider.id),
        label: `${provider.name} OAuth client`,
      });
      return setup.start(ctx);
    },
    async submit(values, ctx) {
      if (!setup) return consent(ctx.token, ctx.oauthRedirectUri);
      const screen = await setup.submit(values, ctx);
      if (screen.kind !== 'done') return screen;
      setup = undefined;
      return consent(ctx.token, ctx.oauthRedirectUri);
    },
    async callback(params, ctx) {
      const error = params.get('error');
      if (error) return consent(ctx.token, ctx.oauthRedirectUri, `${provider.name} said: ${params.get('error_description') ?? error}`);
      const code = params.get('code');
      if (!code) return consent(ctx.token, ctx.oauthRedirectUri, 'No authorization code came back. Try again.');
      const client = await secrets.get(clientSecretId(provider.id));
      if (!client) return { kind: 'failed', title, message: 'The OAuth client was removed during sign-in.' };
      const tokens = await requestToken(doFetch, provider, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: ctx.oauthRedirectUri,
        client_id: client.client_id ?? '',
        client_secret: client.client_secret ?? '',
        ...(provider.pkce === false ? {} : { code_verifier: verifier }),
      });
      if ('error' in tokens) return consent(ctx.token, ctx.oauthRedirectUri, tokens.error);
      await secrets.set(opts.secretId, tokens, { kind: 'oauth2', label: `${provider.name}: ${opts.scopes.join(' ')}` });
      await opts.onSaved?.(tokens);
      return { kind: 'done', title, message: `Signed in with ${provider.name}. You can close this page and go back to the chat.` };
    },
  };
}

async function requestToken(doFetch: typeof fetch, provider: OAuthProvider, body: Record<string, string>): Promise<SecretValues | { error: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'sunny-agent/0.1' };
  const form = { ...body };
  if (provider.basicAuth) {
    headers.authorization = `Basic ${Buffer.from(`${form.client_id ?? ''}:${form.client_secret ?? ''}`).toString('base64')}`;
    delete form.client_secret;
  }
  if (provider.clientIdParam && provider.clientIdParam !== 'client_id') {
    form[provider.clientIdParam] = form.client_id ?? '';
    delete form.client_id;
  }
  const res = await doFetch(provider.tokenUrl, { method: 'POST', headers, body: new URLSearchParams(form) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    return { error: `Token exchange failed: ${String(json.error_description ?? json.error ?? res.status)}` };
  }
  const out: SecretValues = { access_token: json.access_token, token_type: String(json.token_type ?? 'Bearer') };
  if (typeof json.refresh_token === 'string') out.refresh_token = json.refresh_token;
  if (typeof json.scope === 'string') out.scope = json.scope;
  if (typeof json.open_id === 'string') out.open_id = json.open_id;
  if (typeof json.expires_in === 'number') out.expires_at = String(Date.now() + json.expires_in * 1000);
  return out;
}

/** A valid access token for a stored OAuth secret, refreshed when it is about to expire. */
export async function getAccessToken(secrets: SecretStore, secretId: string, provider: OAuthProvider, doFetch: typeof fetch = fetch): Promise<string> {
  const tokens = await secrets.get(secretId);
  if (!tokens?.access_token) throw new Error(`not signed in (${secretId})`);
  const expiresAt = Number(tokens.expires_at ?? Infinity);
  if (expiresAt - Date.now() > 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error(`token expired and no refresh token (${secretId})`);
  const client = await secrets.get(clientSecretId(provider.id));
  if (!client) throw new Error(`OAuth client for ${provider.name} is missing`);
  const fresh = await requestToken(doFetch, provider, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id ?? '',
    client_secret: client.client_secret ?? '',
  });
  if ('error' in fresh) throw new Error(fresh.error);
  await secrets.patch(secretId, fresh);
  return fresh.access_token!;
}
