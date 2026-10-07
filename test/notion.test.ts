import { describe, expect, it } from 'vitest';
import { NotionClient, NotionError, explainError, normalizeId } from '../src/connectors/notion/client.ts';
import { blockText, buildProperties, pageSummary, textToBlocks, toBlock } from '../src/connectors/notion/format.ts';
import { notionConnector } from '../src/connectors/notion/index.ts';
import { ConnectorRegistry } from '../src/connectors/types.ts';

const secrets = (token: string | null = 'ntn_secretsecretsecret1234567890') => ({
  get: async () => (token ? { token } : undefined),
  has: async () => Boolean(token),
  set: async () => {},
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function clientWith(responses: Response[], token?: string | null) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let t = 1_000_000;
  const client = new NotionClient(secrets(token), {
    doFetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error('unexpected request');
      return r;
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
  });
  return { client, calls, sleeps };
}

describe('normalizeId', () => {
  it('accepts ids and URLs', () => {
    const id = '1429989fe8ac4effbc8f57f56486db54';
    const dashed = '1429989f-e8ac-4eff-bc8f-57f56486db54';
    expect(normalizeId(id)).toBe(dashed);
    expect(normalizeId(dashed)).toBe(dashed);
    expect(normalizeId(`https://www.notion.so/My-Page-Title-${id}?pvs=4`)).toBe(dashed);
    expect(() => normalizeId('hello')).toThrow(NotionError);
  });
});

describe('NotionClient', () => {
  it('sends the token and version, and spaces requests under 3 a second', async () => {
    const { client, calls, sleeps } = clientWith([json(200, { a: 1 }), json(200, { b: 2 }), json(200, { c: 3 })]);
    await Promise.all([client.request('GET', '/x'), client.request('GET', '/y'), client.request('GET', '/z')]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer ntn_secretsecretsecret1234567890');
    expect((calls[0]!.init.headers as Record<string, string>)['notion-version']).toBeTruthy();
    expect(sleeps.filter((s) => s > 0).length).toBeGreaterThanOrEqual(2);
    expect(sleeps.every((s) => s <= 350)).toBe(true);
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const { client, sleeps } = clientWith([json(429, { code: 'rate_limited' }, { 'retry-after': '2' }), json(200, { ok: true })]);
    await expect(client.request('GET', '/x')).resolves.toEqual({ ok: true });
    expect(sleeps).toContain(2000);
  });

  it('gives up after repeated 429 with a clear message', async () => {
    const { client } = clientWith([1, 2, 3, 4].map(() => json(429, {})));
    await expect(client.request('GET', '/x')).rejects.toThrow(/rate limit/i);
  });

  it('explains 404 and 401 without leaking the token', async () => {
    const a = clientWith([json(404, { code: 'object_not_found', message: 'Could not find page' })]);
    await expect(a.client.request('GET', '/pages/1', undefined, 'this page')).rejects.toThrow(/not shared with the integration/);
    const b = clientWith([json(401, { message: 'API token is invalid.' })]);
    await expect(b.client.request('GET', '/x')).rejects.toThrow(/refused the token/);
    expect(explainError(403, undefined, 'this page')).toMatch(/share the page/);
  });

  it('says so when Notion is not connected', async () => {
    const { client } = clientWith([], null);
    await expect(client.request('GET', '/x')).rejects.toThrow(/not connected/);
  });

  it('redacts secrets in responses', async () => {
    const { client } = clientWith([json(200, { note: 'api_key=abcdefghijkl1234' })]);
    expect(JSON.stringify(await client.request('GET', '/x'))).not.toContain('abcdefghijkl1234');
  });
});

describe('format', () => {
  it('renders blocks as text', () => {
    const rt = (s: string) => [{ plain_text: s }];
    expect(blockText({ type: 'heading_2', heading_2: { rich_text: rt('Plan') } })).toBe('## Plan');
    expect(blockText({ type: 'to_do', to_do: { rich_text: rt('Ship'), checked: true } })).toBe('- [x] Ship');
    expect(blockText({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt('a') } }, 1)).toBe('  - a');
    expect(blockText({ type: 'divider', divider: {} })).toBe('---');
  });

  it('turns plain text into blocks and back into Notion shapes', () => {
    const blocks = textToBlocks('# Title\nhello\n- one\n- [x] done\n1. first\n> quote\n---');
    expect(blocks.map((b) => b.type)).toEqual(['heading_1', 'paragraph', 'bulleted_list_item', 'to_do', 'numbered_list_item', 'quote', 'divider']);
    expect(blocks[3]!.checked).toBe(true);
    const long = toBlock({ type: 'paragraph', text: 'x'.repeat(4500) }) as any;
    expect(long.paragraph.rich_text).toHaveLength(3);
  });

  it('builds properties from the database schema', () => {
    const schema = { Name: { type: 'title' }, Status: { type: 'status' }, Tags: { type: 'multi_select' }, Due: { type: 'date' }, Qty: { type: 'number' }, Done: { type: 'checkbox' } };
    const props = buildProperties(schema, { Name: 'Task', Status: 'Done', Tags: ['a', 'b'], Due: '2026-10-10 → 2026-10-12', Qty: '3', Done: 'yes' });
    expect(props.Name).toEqual({ title: [{ type: 'text', text: { content: 'Task' } }] });
    expect(props.Status).toEqual({ status: { name: 'Done' } });
    expect(props.Tags).toEqual({ multi_select: [{ name: 'a' }, { name: 'b' }] });
    expect(props.Due).toEqual({ date: { start: '2026-10-10', end: '2026-10-12' } });
    expect(props.Qty).toEqual({ number: 3 });
    expect(props.Done).toEqual({ checkbox: true });
    expect(() => buildProperties(schema, { Nope: 1 })).toThrow(/Available: Name/);
    expect(() => buildProperties(schema, { Qty: 'abc' })).toThrow(/number/);
  });

  it('summarises a page', () => {
    const s = pageSummary({ id: 'p', url: 'u', properties: { Name: { type: 'title', title: [{ plain_text: 'Hi' }] }, Status: { type: 'status', status: { name: 'Open' } }, Empty: { type: 'rich_text', rich_text: [] } } });
    expect(s).toMatchObject({ id: 'p', title: 'Hi', properties: { Status: 'Open' } });
    expect(s.properties).not.toHaveProperty('Empty');
  });
});

describe('notionConnector', () => {
  it('marks only the write tools as mutating, and reports status', async () => {
    const registry = new ConnectorRegistry();
    registry.register(notionConnector({ secrets: secrets() }));
    for (const t of ['create_page', 'update_page', 'append_blocks', 'create_database_row']) expect(registry.isMutating(`mcp__notion__${t}`)).toBe(true);
    for (const t of ['search', 'get_page', 'query_database', 'list_databases']) expect(registry.isMutating(`mcp__notion__${t}`)).toBe(false);
    expect(await registry.get('notion')!.status()).toEqual({ ready: true });
    const none = notionConnector({ secrets: secrets(null) });
    expect((await none.status()).ready).toBe(false);
  });

  it('validates the token on setup before saving it', async () => {
    const { client } = clientWith([json(401, { message: 'invalid' })]);
    const flow = client.setupFlow();
    const screen = await flow.submit({ token: 'ntn_bad' }, { token: 't', oauthRedirectUri: '' });
    expect(screen.kind).toBe('form');
    expect(JSON.stringify(screen)).not.toContain('ntn_bad');
    expect((screen as { error?: string }).error).toMatch(/refused the token/);
  });
});
