import { getAccessToken, type OAuthProvider } from '../auth/oauth2.ts';
import type { SecretStore } from '../secrets/store.ts';
import { ApiError, type RestClient } from './shared.ts';

/** Authenticated calls for an OAuth connector: fresh token each time, clear message when signed out. */
export function oauthCaller(o: { secrets: SecretStore; secretId: string; provider: OAuthProvider; rest: RestClient; setupName: string; fetch?: typeof fetch; headers?: Record<string, string> }) {
  return async <T = any>(path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; what?: string; raw?: string | Uint8Array; asText?: boolean; headers?: Record<string, string> } = {}): Promise<T> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    let token: string;
    try {
      token = await getAccessToken(o.secrets, o.secretId, o.provider, o.fetch);
    } catch {
      throw new ApiError(`${o.provider.name} is not connected: ask the owner to open the setup link (Sunny: setup_connector ${o.setupName}).`);
    }
    return o.rest.request<T>({ path, method: init.method, body: init.body, what: init.what, raw: init.raw, asText: init.asText, headers: { authorization: `Bearer ${token}`, ...o.headers, ...init.headers } });
  };
}

/** Generic error text for the simple REST providers. */
export const explainWith =
  (service: string, setupName: string) =>
  (status: number, body: unknown, what: string): string => {
    const b = (body ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const said = String(b.error?.message ?? b.error_summary ?? b.message ?? (typeof b.error === 'string' ? b.error : '') ?? '').slice(0, 200);
    const extra = said ? ` ${service} says: ${said}` : '';
    if (status === 401) return `${service} refused the token (expired or revoked). Ask the owner to run the ${setupName} setup again.`;
    if (status === 403) return `${service} says this is not allowed (${what}). The permissions granted at sign-in may not include it.${extra}`;
    if (status === 404) return `Not found on ${service}: ${what}.`;
    if (status === 429) return `${service} rate limit reached. Wait a while before trying again.`;
    if (status >= 500) return `${service} is having trouble (HTTP ${status}); try again later.`;
    return `${service} rejected the request (${what}, HTTP ${status}).${extra}`;
  };
