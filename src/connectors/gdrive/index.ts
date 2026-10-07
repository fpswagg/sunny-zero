import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { explainWith, oauthCaller } from '../oauth-api.ts';
import { ApiError, RestClient, UNTRUSTED_NOTE, WriteBudget, guard, ok } from '../shared.ts';

export const GDRIVE_SECRET_ID = 'google:drive';
/** drive.readonly reads everything; drive.file only lets Sunny touch files it creates itself. */
export const GDRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const explainDrive = explainWith('Google Drive', 'Drive');
const FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink,owners(displayName),trashed';
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Escapes a value for a Drive query string. */
export const q = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function multipart(meta: Json, text: string, mime: string, boundary = `sunny${Math.random().toString(36).slice(2)}`) {
  return { boundary, body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${text}\r\n--${boundary}--` };
}

export interface DriveDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/**
 * Google Drive: read everything, create folders and text files. Writes only reach files
 * Sunny created itself (drive.file scope), so existing files cannot be overwritten or deleted,
 * and nothing is ever shared publicly: sharing is by named email, view/comment only.
 */
export function driveConnector(deps: DriveDeps): Connector {
  const rest = deps.rest ?? new RestClient({ baseUrl: 'https://www.googleapis.com/drive/v3', minGapMs: 120, service: 'Google Drive', explain: explainDrive, doFetch: deps.fetch });
  const writes = new WriteBudget(30, 3600_000);
  const call = oauthCaller({ secrets: deps.secrets, secretId: GDRIVE_SECRET_ID, provider: PROVIDERS.google!, rest, setupName: 'gdrive', fetch: deps.fetch });
  const file = (f: Json) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, size: f.size, parent: f.parents?.[0], url: f.webViewLink, owner: f.owners?.[0]?.displayName });
  const list = async (query: string, limit: number) => ok({ note: UNTRUSTED_NOTE, results: ((await call(`/files?${new URLSearchParams({ q: `${query} and trashed=false`, pageSize: String(limit), fields: `files(${FIELDS})`, orderBy: 'modifiedTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`)).files as Json[]).map(file) });

  return {
    name: 'gdrive',
    description: "The owner's Google Drive: browse, search and read files; create folders and text files, share with a named person (asks first). Cannot delete or overwrite.",
    mutatingTools: ['create_folder', 'create_file', 'share'],
    status: async () => ((await deps.secrets.has(GDRIVE_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to Google (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.google!,
        scopes: GDRIVE_SCOPES,
        secretId: GDRIVE_SECRET_ID,
        title: 'Sign in to Google Drive',
        description: 'Agents will read your Drive. They can create folders and text files and share those with a named person after asking you. They cannot delete or change your existing files.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'gdrive',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('list_files', 'Files in a folder (default: My Drive root), newest first.', { folderId: z.string().default('root'), limit: z.number().int().min(1).max(100).default(30) }, guard(({ folderId, limit }) => list(`${q(folderId)} in parents`, limit))),
          tool('search', 'Search by name or content (plain words).', { text: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) }, guard(({ text, limit }) => list(`(name contains ${q(text)} or fullText contains ${q(text)})`, limit))),
          tool('get_file', 'Metadata of one file.', { id: z.string().min(3).max(100) }, guard(async ({ id }) => ok(file(await call(`/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: 'true' })}`, { what: 'this file' }))))),
          tool('read_file', 'Text of a Google Doc/Sheet(csv)/Slides, or of a plain-text file. Binary files are not read.', { id: z.string().min(3).max(100) }, guard(async ({ id }) => {
            const m = await call(`/files/${encodeURIComponent(id)}?${new URLSearchParams({ fields: 'id,name,mimeType,size', supportsAllDrives: 'true' })}`, { what: 'this file' });
            const exp = EXPORTS[m.mimeType as string];
            if (!exp && !/^text\/|json|xml|csv|markdown/.test(m.mimeType)) throw new ApiError(`Cannot read ${m.mimeType} files as text.`);
            if (!exp && Number(m.size) > 2_000_000) throw new ApiError('File too large to read (2 MB max).');
            const text = await call<string>(exp ? `/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exp)}` : `/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { asText: true, what: 'this file' });
            return ok({ note: UNTRUSTED_NOTE, name: m.name, content: text.length > 30_000 ? `${text.slice(0, 30_000)}…(truncated)` : text });
          })),
          tool('create_folder', 'Create a folder.', { name: z.string().min(1).max(200), parentId: z.string().optional() }, guard(async ({ name, parentId }) => {
            writes.take('Drive writes');
            return ok(file(await call(`/files?fields=${encodeURIComponent(FIELDS)}`, { method: 'POST', body: { name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }, what: 'the folder' })));
          })),
          tool('create_file', 'Create a new text file (txt, md, csv, json…). Never overwrites.', { name: z.string().min(1).max(200), content: z.string().max(500_000), mimeType: z.string().default('text/plain'), parentId: z.string().optional() }, guard(async ({ name, content, mimeType, parentId }) => {
            writes.take('Drive writes');
            const { boundary, body } = multipart({ name, ...(parentId ? { parents: [parentId] } : {}) }, content, mimeType);
            return ok(file(await call(`https://www.googleapis.com/upload/drive/v3/files?${new URLSearchParams({ uploadType: 'multipart', fields: FIELDS })}`, { method: 'POST', raw: body, headers: { 'content-type': `multipart/related; boundary=${boundary}` }, what: 'the file' })));
          })),
          tool('share', 'Share a file Sunny created with one named person (viewer or commenter). Never public links.', { id: z.string().min(3), email: z.string().email(), role: z.enum(['reader', 'commenter']).default('reader') }, guard(async ({ id, email, role }) => {
            writes.take('Drive writes');
            await call(`/files/${encodeURIComponent(id)}/permissions?sendNotificationEmail=true`, { method: 'POST', body: { type: 'user', role, emailAddress: email }, what: 'sharing' });
            return ok({ shared: true, with: email, role });
          })),
        ],
      }),
  };
}
