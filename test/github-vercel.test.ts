import { describe, expect, it } from 'vitest';
import { githubConnector, explainGitHub } from '../src/connectors/github/index.ts';
import { vercelConnector, explainVercel } from '../src/connectors/vercel/index.ts';

const secrets = (v: Record<string, string> | null) => ({ get: async () => v ?? undefined, has: async () => Boolean(v), set: async () => {}, patch: async () => {} }) as never;

describe('github', () => {
  it('status + only comment asks', async () => {
    expect((await githubConnector({ secrets: secrets(null) }).status()).ready).toBe(false);
    const c = githubConnector({ secrets: secrets({ token: 't' }) });
    expect((await c.status()).ready).toBe(true);
    expect(c.mutatingTools).toEqual(['comment']);
  });
  it('explains errors', () => {
    expect(explainGitHub(401, {}, 'x')).toContain('setup');
    expect(explainGitHub(403, { message: 'API rate limit exceeded' }, 'x')).toContain('rate limit');
    expect(explainGitHub(404, {}, 'repo')).toContain('repo');
  });
});

describe('vercel', () => {
  it('status + only redeploy asks', async () => {
    expect((await vercelConnector({ secrets: secrets(null) }).status()).ready).toBe(false);
    expect(vercelConnector({ secrets: secrets({ token: 't' }) }).mutatingTools).toEqual(['redeploy']);
  });
  it('explains errors', () => {
    expect(explainVercel(401, {}, 'x')).toContain('setup');
    expect(explainVercel(429, {}, 'x')).toContain('rate limit');
  });
});
