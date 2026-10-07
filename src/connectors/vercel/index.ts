import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { formFlow } from '../../auth/flows.ts';
import type { AuthFlow } from '../../auth/types.ts';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { ApiError, RestClient, WriteBudget, guard, ok } from '../shared.ts';

export const VERCEL_SECRET_ID = 'vercel:account';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function explainVercel(status: number, body: unknown, what: string): string {
  const m = (((body ?? {}) as Json).error?.message as string | undefined) ?? '';
  const extra = m ? ` Vercel says: ${m}` : '';
  if (status === 401) return 'Vercel refused the token (expired or revoked). Ask the owner to run the Vercel setup again.';
  if (status === 403) return `The token is not allowed to do this (${what}). Check its scope/team.${extra}`;
  if (status === 404) return `Not found on Vercel: ${what}.`;
  if (status === 429) return 'Vercel rate limit reached. Wait a while.';
  return status >= 500 ? `Vercel is having trouble (HTTP ${status}).` : `Vercel error HTTP ${status}.${extra}`;
}

export interface VercelDeps {
  secrets: SecretStore;
  rest?: RestClient;
  fetch?: typeof fetch;
}

/**
 * Vercel through an API token. Reads projects, deployments, build logs and domains. The one
 * write is redeploying an existing deployment (asks first, capped). Env vars are never read
 * (they hold secrets); no deletes, no domain changes.
 */
export function vercelConnector(deps: VercelDeps): Connector {
  const rest = deps.rest ?? new RestClient({ baseUrl: 'https://api.vercel.com', minGapMs: 200, service: 'Vercel', explain: explainVercel, doFetch: deps.fetch });
  const deploys = new WriteBudget(10, 3600_000);
  const call = async <T = Json>(path: string, what: string, init: { method?: 'POST'; body?: unknown } = {}) => {
    const c = await deps.secrets.get(VERCEL_SECRET_ID);
    if (!c?.token) throw new ApiError('Vercel is not connected: ask the owner to run the Vercel setup.');
    const team = c.team_id ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(c.team_id)}` : '';
    return rest.request<T>({ ...init, path: path + team, what, headers: { authorization: `Bearer ${c.token}` } });
  };
  const dep = (d: Json) => ({ id: d.uid ?? d.id, project: d.name, state: d.readyState ?? d.state, target: d.target, url: d.url && `https://${d.url}`, branch: d.meta?.githubCommitRef, commit: d.meta?.githubCommitMessage, created: d.created && new Date(d.created).toISOString() });

  return {
    name: 'vercel',
    description: "The owner's Vercel: projects, deployments, build logs, domains, analytics; redeploy (asks first).",
    mutatingTools: ['redeploy'],
    status: async () => ((await deps.secrets.has(VERCEL_SECRET_ID)) ? { ready: true } : { ready: false, detail: 'no Vercel token (setup)' }),
    setup: (): AuthFlow =>
      formFlow(deps.secrets, {
        title: 'Connect Vercel',
        description: 'Create an access token (scope: the team you use). If your projects live in a team, paste its team id (Team Settings → General) so Sunny looks there.',
        links: [{ label: 'Create token', url: 'https://vercel.com/account/tokens' }],
        fields: [
          { name: 'token', label: 'Access token', type: 'password' },
          { name: 'team_id', label: 'Team id (optional)', optional: true },
        ],
        secretId: VERCEL_SECRET_ID,
        label: 'Vercel token',
        validate: async ({ token = '' }) => {
          try {
            await rest.request({ path: '/v2/user', what: 'the account', headers: { authorization: `Bearer ${token}` } });
            return undefined;
          } catch (err) {
            return (err as Error).message;
          }
        },
      }),
    server: () =>
      createSdkMcpServer({
        name: 'vercel',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('list_projects', 'Projects with their framework and latest deployment.', { limit: z.number().int().min(1).max(100).default(30) }, guard(async ({ limit }) =>
            ok(((await call(`/v9/projects?limit=${limit}`, 'projects')).projects as Json[]).map((p) => ({ id: p.id, name: p.name, framework: p.framework, latest: p.latestDeployments?.[0] && dep(p.latestDeployments[0]) }))))),
          tool('list_deployments', 'Recent deployments, optionally of one project.', { project: z.string().optional(), state: z.enum(['BUILDING', 'ERROR', 'READY', 'QUEUED', 'CANCELED']).optional(), limit: z.number().int().min(1).max(50).default(20) }, guard(async ({ project, state, limit }) => {
            const p = new URLSearchParams({ limit: String(limit), ...(project ? { app: project } : {}), ...(state ? { state } : {}) });
            return ok(((await call(`/v6/deployments?${p}`, 'deployments')).deployments as Json[]).map(dep));
          })),
          tool('get_deployment', 'One deployment (id or url).', { id: z.string().min(3).max(200) }, guard(async ({ id }) => {
            const d = await call(`/v13/deployments/${encodeURIComponent(id)}`, id);
            return ok({ ...dep(d), error: d.errorMessage, aliases: d.alias });
          })),
          tool('build_logs', 'Build log lines of a deployment, to find why it failed.', { id: z.string().min(3).max(200), limit: z.number().int().min(1).max(300).default(100) }, guard(async ({ id, limit }) => {
            const ev = await call<Json[]>(`/v3/deployments/${encodeURIComponent(id)}/events?limit=${limit}`, id);
            return ok(ev.map((e) => e.text ?? e.payload?.text).filter(Boolean).join('\n').slice(-12_000));
          })),
          tool('list_domains', 'Domains with their verification and expiry.', {}, guard(async () =>
            ok(((await call('/v5/domains', 'domains')).domains as Json[]).map((d) => ({ name: d.name, verified: d.verified, expires: d.expiresAt && new Date(d.expiresAt).toISOString(), nameservers: d.serviceType }))))),
          tool('project_domains', 'Domains attached to a project.', { project: z.string().min(1) }, guard(async ({ project }) =>
            ok(((await call(`/v9/projects/${encodeURIComponent(project)}/domains`, project)).domains as Json[]).map((d) => ({ name: d.name, verified: d.verified, redirect: d.redirect, branch: d.gitBranch }))))),
          tool('analytics_status', 'Whether Web Analytics is enabled on a project. Vercel has no public API for the numbers; they are in the dashboard.', { project: z.string().min(1) }, guard(async ({ project }) => {
            const p = await call(`/v9/projects/${encodeURIComponent(project)}`, project);
            return ok({ webAnalytics: p.analytics ?? null, speedInsights: p.speedInsights ?? null, note: 'Visitor and page-view numbers are only in the Vercel dashboard (no official API).' });
          })),
          tool('redeploy', 'Redeploy an existing deployment (same source) to production or preview. About 10 an hour.', { id: z.string().min(3).max(200), target: z.enum(['production', 'preview']).default('production') }, guard(async ({ id, target }) => {
            deploys.take('redeploys');
            const old = await call(`/v13/deployments/${encodeURIComponent(id)}`, id);
            const d = await call('/v13/deployments?forceNew=1', id, { method: 'POST', body: { name: old.name, deploymentId: old.id ?? old.uid, target } });
            return ok(dep(d));
          })),
        ],
      }),
  };
}
