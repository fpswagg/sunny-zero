import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { oauthFlow, PROVIDERS } from '../../auth/oauth2.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { explainWith, oauthCaller } from '../oauth-api.ts';
import { RestClient, UNTRUSTED_NOTE, guard, ok } from '../shared.ts';

export const FIGMA_SECRET_ID = 'figma:account';
export const FIGMA_SCOPES = ['current_user:read', 'file_content:read', 'file_comments:read', 'file_versions:read', 'projects:read'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const explainFigma = explainWith('Figma', 'Figma');

/** File key from a key or any figma.com/file|design/<key>/… URL. */
export const fileKey = (s: string) => /figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/.exec(s)?.[1] ?? s.trim();

export interface FigmaDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/** Figma, read only: files (structure, not images), comments, versions, projects. */
export function figmaConnector(deps: FigmaDeps): Connector {
  const rest = deps.rest ?? new RestClient({ baseUrl: 'https://api.figma.com/v1', minGapMs: 500, service: 'Figma', explain: explainFigma, doFetch: deps.fetch });
  const call = oauthCaller({ secrets: deps.secrets, secretId: FIGMA_SECRET_ID, provider: PROVIDERS.figma!, rest, setupName: 'figma', fetch: deps.fetch });
  const key = z.string().min(5).max(300).describe('file key or figma.com URL');
  /** Compact outline of a node tree. */
  const outline = (n: Json, depth: number): Json => ({ id: n.id, name: n.name, type: n.type, ...(n.characters ? { text: String(n.characters).slice(0, 200) } : {}), ...(depth > 0 && n.children ? { children: (n.children as Json[]).slice(0, 60).map((c) => outline(c, depth - 1)) } : n.children ? { childCount: n.children.length } : {}) });

  return {
    name: 'figma',
    description: "The owner's Figma (read only): file structure and text, comments, version history, team projects.",
    status: async () => ((await deps.secrets.has(FIGMA_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'not signed in to Figma (setup)' }),
    setup: (): AuthFlow =>
      oauthFlow(deps.secrets, {
        provider: PROVIDERS.figma!,
        scopes: FIGMA_SCOPES,
        secretId: FIGMA_SECRET_ID,
        title: 'Sign in to Figma',
        description: 'Read-only: agents can read files, comments, versions and projects. They cannot edit designs or post comments.',
        fetch: deps.fetch,
      }),
    server: () =>
      createSdkMcpServer({
        name: 'figma',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('me', 'The signed-in Figma user.', {}, guard(async () => { const m = await call('/me'); return ok({ handle: m.handle, email: m.email, id: m.id }); })),
          tool('get_file', 'Outline of a file: pages and top-level frames, with text found at the first levels.', { file: key, depth: z.number().int().min(1).max(4).default(2) }, guard(async ({ file, depth }) => {
            const f = await call(`/files/${fileKey(file)}?depth=${depth}`, { what: 'this file' });
            return ok({ note: UNTRUSTED_NOTE, name: f.name, lastModified: f.lastModified, version: f.version, document: outline(f.document, depth) });
          })),
          tool('get_nodes', 'Details of specific nodes (ids from get_file).', { file: key, ids: z.array(z.string()).min(1).max(20) }, guard(async ({ file, ids }) => {
            const r = await call(`/files/${fileKey(file)}/nodes?ids=${encodeURIComponent(ids.join(','))}`, { what: 'these nodes' });
            return ok({ note: UNTRUSTED_NOTE, nodes: Object.fromEntries(Object.entries(r.nodes as Json).map(([id, v]) => [id, v?.document ? outline(v.document, 3) : null])) });
          })),
          tool('comments', 'Comments on a file.', { file: key }, guard(async ({ file }) =>
            ok({ note: UNTRUSTED_NOTE, results: ((await call(`/files/${fileKey(file)}/comments`, { what: 'comments' })).comments as Json[]).slice(0, 100).map((c) => ({ id: c.id, author: c.user?.handle, message: String(c.message).slice(0, 1000), at: c.created_at, resolved: Boolean(c.resolved_at), replyTo: c.parent_id || undefined })) }))),
          tool('versions', 'Version history of a file.', { file: key }, guard(async ({ file }) =>
            ok(((await call(`/files/${fileKey(file)}/versions`, { what: 'versions' })).versions as Json[]).slice(0, 50).map((v) => ({ id: v.id, label: v.label, description: v.description, at: v.created_at, by: v.user?.handle }))))),
          tool('team_projects', 'Projects of a team (team id is in the team page URL).', { teamId: z.string().min(3).max(40) }, guard(async ({ teamId }) =>
            ok(((await call(`/teams/${teamId}/projects`, { what: 'this team' })).projects as Json[]).map((p) => ({ id: p.id, name: p.name }))))),
          tool('project_files', 'Files of a project.', { projectId: z.string().min(3).max(40) }, guard(async ({ projectId }) =>
            ok(((await call(`/projects/${projectId}/files`, { what: 'this project' })).files as Json[]).map((f) => ({ key: f.key, name: f.name, modified: f.last_modified }))))),
        ],
      }),
  };
}
