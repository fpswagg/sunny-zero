import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAccounts } from '../src/providers/claude-accounts.ts';

const creds = (token: string, org: string) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 1, subscriptionType: 'pro' }, organizationUuid: org });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sunny-acc-'));
  const configDir = join(root, 'claude');
  await mkdir(configDir, { recursive: true });
  const claudeJson = join(root, 'claude.json');
  const live = (token: string, org: string, email: string) =>
    Promise.all([
      writeFile(join(configDir, '.credentials.json'), JSON.stringify(creds(token, org))),
      writeFile(claudeJson, JSON.stringify({ keep: 'me', oauthAccount: { accountUuid: org, emailAddress: email, organizationUuid: org } })),
    ]);
  const accounts = new ClaudeAccounts({ dataDir: join(root, 'data'), claudeConfigDir: configDir, claudeJson });
  const read = async () => ({ creds: JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8')), json: JSON.parse(await readFile(claudeJson, 'utf8')) });
  return { accounts, live, read, root };
}

describe('ClaudeAccounts', () => {
  it('imports the current login as the first account', async () => {
    const { accounts, live } = await setup();
    await live('a1', 'org-a', 'a@x.com');
    const list = await accounts.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'a@x.com', active: true, plan: 'pro' });
  });

  it('switches, keeps renewed tokens, and leaves the rest of ~/.claude.json alone', async () => {
    const { accounts, live, read } = await setup();
    await live('a1', 'org-a', 'a@x.com');
    await accounts.list();
    // a second login done by hand is picked up as a second account
    await live('b1', 'org-b', 'b@x.com');
    expect((await accounts.list()).map((a) => a.label).sort()).toEqual(['a@x.com', 'b@x.com']);
    // the live token of B renews, then we switch to A: B's slot must keep the renewed token
    await live('b2', 'org-b', 'b@x.com');
    const a = await accounts.switchTo('a@x.com');
    expect(a.active).toBe(true);
    let now = await read();
    expect(now.creds.claudeAiOauth.accessToken).toBe('a1');
    expect(now.json.oauthAccount.emailAddress).toBe('a@x.com');
    expect(now.json.keep).toBe('me');
    await accounts.switchTo('next');
    now = await read();
    expect(now.creds.claudeAiOauth.accessToken).toBe('b2');
  });

  it('refuses to switch with one account, and to remove the one in use', async () => {
    const { accounts, live } = await setup();
    await live('a1', 'org-a', 'a@x.com');
    await expect(accounts.switchTo('next')).rejects.toThrow(/only one/i);
    await expect(accounts.remove('a@x.com')).rejects.toThrow(/in use/i);
  });
});
