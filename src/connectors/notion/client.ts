import type { AuthFlow } from '../../auth/types.ts';
import { formFlow } from '../../auth/flows.ts';
import type { SecretStore } from '../../secrets/store.ts';
import { redactObject } from '../../util/redact.ts';

/** Where the integration token is stored. */
export const NOTION_SECRET_ID = 'notion:integration';
const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
/** Notion allows an average of 3 requests a second; stay just under it. */
const MIN_GAP_MS = 350;
const MAX_RETRIES = 3;

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Turns a Notion error response into a message an agent (and the owner) can act on. */
export function explainError(status: number, body: { code?: string; message?: string } | undefined, what: string): string {
  const detail = body?.message ? ` Notion says: ${body.message}` : '';
  switch (status) {
    case 400:
      return `Notion rejected the request (${body?.code ?? 'validation_error'}).${detail}`;
    case 401:
      return 'Notion refused the token (unauthorized). Ask the owner to run the Notion setup again with a valid integration token.';
    case 403:
      return `The Notion integration has no permission for this (${what}). In Notion, share the page with the integration or enable the needed capability (read/update/insert content).`;
    case 404:
      return `Not found: ${what}. Either the id is wrong or the page/database is not shared with the integration (Notion: ••• menu → Connections → add it).`;
    case 409:
      return `Notion had a write conflict on ${what}; try again in a moment.`;
    case 429:
      return 'Notion rate limit hit and retries ran out; wait a little and try again.';
    default:
      return status >= 500 ? `Notion is having trouble (HTTP ${status}); try again later.${detail}` : `Notion error HTTP ${status}.${detail}`;
  }
}

/** Accepts a bare id, a dashed uuid, or a Notion URL, and returns the dashed uuid. */
export function normalizeId(input: string): string {
  const clean = input.trim().split('?')[0]!.split('#')[0]!;
  const m = /([0-9a-f]{32})\/?$/i.exec(clean.replace(/-/g, ''));
  if (!m) throw new NotionError(`"${input}" is not a Notion id or page URL`);
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface NotionClientOptions {
  doFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minGapMs?: number;
}

/**
 * Small Notion API client: one request at a time, spaced to stay under 3 requests a second,
 * with retries for 429/5xx honouring Retry-After. Responses are redacted before agents see them.
 */
export class NotionClient {
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly gap: number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(
    private readonly secrets: Pick<SecretStore, 'get' | 'has' | 'set'>,
    opts: NotionClientOptions = {},
  ) {
    this.doFetch = opts.doFetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.gap = opts.minGapMs ?? MIN_GAP_MS;
  }

  configured(): Promise<boolean> {
    return this.secrets.has(NOTION_SECRET_ID);
  }

  private async token(): Promise<string> {
    const creds = await this.secrets.get(NOTION_SECRET_ID);
    if (!creds?.token) throw new NotionError('Notion is not connected yet: ask the owner to open the Notion setup link (Sunny: setup_connector notion).');
    return creds.token;
  }

  /** Runs `fn` after every earlier request, at least `gap` ms after the previous one started. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastAt + this.gap - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();
      return fn();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async request<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, what = path, tokenOverride?: string): Promise<T> {
    const token = tokenOverride ?? (await this.token());
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.schedule(() =>
          this.doFetch(`${API}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          }),
        );
      } catch (err) {
        if (attempt < 2) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        throw new NotionError(`Could not reach Notion: ${(err as Error).message}`);
      }
      if (res.ok) return redactObject((await res.json()) as T);
      const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const err = (await res.json().catch(() => undefined)) as { code?: string; message?: string } | undefined;
      throw new NotionError(explainError(res.status, err, what), res.status);
    }
  }

  /** The page that collects the integration token; it is checked against Notion before saving. */
  setupFlow(): AuthFlow {
    return formFlow(this.secrets as SecretStore, {
      title: 'Connect Notion',
      description:
        'Create an internal integration at notion.so/my-integrations, copy its secret, paste it here. Then, in Notion, open each page or database you want agents to use → ••• → Connections → add the integration. Agents never see the token.',
      links: [{ label: 'My integrations', url: 'https://www.notion.so/my-integrations' }],
      fields: [{ name: 'token', label: 'Integration token', type: 'password', placeholder: 'ntn_… or secret_…' }],
      secretId: NOTION_SECRET_ID,
      label: 'Notion integration',
      validate: async ({ token = '' }) => {
        try {
          await this.request('GET', '/users/me', undefined, 'the integration', token);
          return undefined;
        } catch (err) {
          return (err as Error).message;
        }
      },
    });
  }
}
