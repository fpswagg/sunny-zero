import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { explainWith, oauthCaller } from '../oauth-api.ts';
import { ApiError, RestClient, UNTRUSTED_NOTE, WriteBudget, guard, ok } from '../shared.ts';

export const DROPBOX_SECRET_ID = 'dropbox:account';
export const DROPBOX_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write', 'sharing.write'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const explainDropbox = explainWith('Dropbox', 'Dropbox');

/** Dropbox wants non-ASCII characters in the API-Arg header escaped as \uXXXX. */
export const apiArg = (o: unknown) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const path = z.string().max(500).describe('"" for the root, otherwise /folder/file');

export interface DropboxDeps {
  secrets: SecretStore;
  rest?: RestClient;
  content?: RestClient;
  fetch?: typeof fetch;
}

/**
 * Dropbox: read and search files, upload new files (never overwrites: conflicts get renamed),
 * create shared links. No delete, move or unshare. Writes ask the owner.
 */
export function dropboxConnector(deps: DropboxDeps): Connector {
  const mk = (baseUrl: string) => new RestClient({ baseUrl, minGapMs: 150, service: 'Dropbox', explain: explainDropbox, doFetch: deps.fetch });
  const rpc = oauthCaller({ secrets: deps.secrets, secretId: DROPBOX_SECRET_ID, provider: PROVIDERS.dropbox!, rest: deps.rest ?? mk('https://api.dropboxapi.com/2'), setupName: 'dropbox', fetch: deps.fetch });
  const content = oauthCaller({ secrets: deps.secrets, secretId: DROPBOX_SECRET_ID, provider: PROVIDERS.dropbox!, rest: deps.content ?? mk('https://content.dropboxapi.com/2'), setupName: 'dropbox', fetch: deps.fetch });
  const writes = new WriteBudget(30, 3600_000);
  const entry = (e: Json) => ({ name: e.name, path: e.path_display, kind: e['.tag'], size: e.size, modified: e.server_modified });
  const norm = (p: string) => (p === '' || p.startsWith('/') ? p : `/${p}`);

  return {
    name: 'dropbox',
    description: "The owner's Dropbox: browse, search and read files; upload new files and create share links (asks first). Cannot delete, move or overwrite.",
    mutatingTools: ['upload', 'share_link'],
    status: async () => ((await deps.secrets.has(DROPBOX_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to Dropbox (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.dropbox!,
        scopes: DROPBOX_SCOPES,
        secretId: DROPBOX_SECRET_ID,
        title: 'Sign in to Dropbox',
        description: 'Agents will read your files, and upload new files or create share links only after asking you. They cannot delete, move or overwrite anything.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'dropbox',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('account', 'The Dropbox account and space used.', {}, guard(async () => {
            const [a, s] = await Promise.all([rpc('/users/get_current_account', { method: 'POST' }), rpc('/users/get_space_usage', { method: 'POST' })]);
            return ok({ name: a.name?.display_name, email: a.email, usedBytes: s.used, allocatedBytes: s.allocation?.allocated });
          })),
          tool('list_folder', 'Contents of a folder.', { path: path.default(''), limit: z.number().int().min(1).max(200).default(50) }, guard(async ({ path, limit }) =>
            ok({ note: UNTRUSTED_NOTE, results: ((await rpc('/files/list_folder', { method: 'POST', body: { path: norm(path), limit }, what: path || 'the root' })).entries as Json[]).map(entry) }))),
          tool('search', 'Search files by name or content.', { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).default(20) }, guard(async ({ query, limit }) =>
            ok({ note: UNTRUSTED_NOTE, results: ((await rpc('/files/search_v2', { method: 'POST', body: { query, options: { max_results: limit } } })).matches as Json[]).map((m) => entry(m.metadata?.metadata ?? {})) }))),
          tool('read_file', 'Text of a small text file (2 MB max).', { path: path.min(1) }, guard(async ({ path }) => {
            const meta = await rpc('/files/get_metadata', { method: 'POST', body: { path: norm(path) }, what: path });
            if (Number(meta.size) > 2_000_000) throw new ApiError('File too large to read (2 MB max).');
            const text = await content<string>('/files/download', { method: 'POST', asText: true, headers: { 'dropbox-api-arg': apiArg({ path: norm(path) }) }, what: path });
            if (text.includes('\u0000')) throw new ApiError('This looks like a binary file; only text can be read.');
            return ok({ note: UNTRUSTED_NOTE, name: meta.name, content: text.length > 30_000 ? `${text.slice(0, 30_000)}…(truncated)` : text });
          })),
          tool('upload', 'Upload a new text file. If the name exists, Dropbox renames the new one; nothing is overwritten.', { path: path.min(1), content: z.string().max(1_000_000) }, guard(async ({ path, content: text }) => {
            writes.take('Dropbox writes');
            const r = await content('/files/upload', { method: 'POST', raw: text, headers: { 'content-type': 'application/octet-stream', 'dropbox-api-arg': apiArg({ path: norm(path), mode: 'add', autorename: true, mute: true }) }, what: path });
            return ok(entry(r));
          })),
          tool('share_link', 'Create (or fetch) a view-only share link for a file or folder. Anyone with the link can see it, so confirm with the owner.', { path: path.min(1) }, guard(async ({ path }) => {
            writes.take('Dropbox writes');
            const existing = ((await rpc('/sharing/list_shared_links', { method: 'POST', body: { path: norm(path), direct_only: true } })).links as Json[]) ?? [];
            if (existing[0]) return ok({ url: existing[0].url, existing: true });
            const r = await rpc('/sharing/create_shared_link_with_settings', { method: 'POST', body: { path: norm(path), settings: { requested_visibility: 'public', access: 'viewer' } }, what: path });
            return ok({ url: r.url });
          })),
        ],
      }),
  };
}
