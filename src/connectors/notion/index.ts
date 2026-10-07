import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { NotionClient, normalizeId } from './client.ts';
import { BLOCK_TYPES, blockText, buildProperties, databaseSummary, pageSummary, textToBlocks, toBlock, type SimpleBlock } from './format.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const guard =
  <A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };

const MAX_BLOCKS = 300;
const MAX_DEPTH = 2;

export interface NotionConnectorDeps {
  secrets: Pick<SecretStore, 'get' | 'has' | 'set'>;
  client?: NotionClient;
}

const blockInput = z.object({
  type: z.enum(BLOCK_TYPES),
  text: z.string().max(20_000).optional(),
  checked: z.boolean().optional().describe('to_do only'),
  language: z.string().optional().describe('code only, e.g. "typescript"'),
});

/**
 * The owner's Notion workspace through an internal integration token. The token lives in the
 * secret store; agents only see the tools. It can only reach pages shared with the integration.
 * Reading is free; creating and changing content asks the owner.
 */
export function notionConnector(deps: NotionConnectorDeps): Connector & { client: NotionClient } {
  const client = deps.client ?? new NotionClient(deps.secrets);

  /** Page/database children as text lines, following nested blocks a couple of levels down. */
  const readBlocks = async (blockId: string, depth: number, budget: { left: number }): Promise<string[]> => {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ page_size: '100' });
      if (cursor) q.set('start_cursor', cursor);
      const res = await client.request<Json>('GET', `/blocks/${blockId}/children?${q}`, undefined, 'this page');
      for (const b of res.results as Json[]) {
        if (budget.left <= 0) {
          lines.push('…(truncated: page is longer than 300 blocks)');
          return lines;
        }
        budget.left--;
        const line = blockText(b, depth);
        if (line) lines.push(line);
        if (b.has_children && depth < MAX_DEPTH && b.type !== 'child_page' && b.type !== 'child_database') {
          lines.push(...(await readBlocks(b.id, depth + 1, budget)));
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return lines;
  };

  const schemaOf = async (databaseId: string) => (await client.request<Json>('GET', `/databases/${databaseId}`, undefined, 'this database')).properties as Record<string, Json>;

  const search = (query: string, kind: 'page' | 'database' | undefined, pageSize: number, cursor?: string) =>
    client.request<Json>('POST', '/search', {
      query,
      page_size: pageSize,
      ...(cursor ? { start_cursor: cursor } : {}),
      ...(kind ? { filter: { property: 'object', value: kind } } : {}),
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });

  const paged = (res: Json, results: unknown[]) => ({ results, nextCursor: res.has_more ? res.next_cursor : undefined });

  return {
    name: 'notion',
    client,
    description: "The owner's Notion: search, read pages and databases, and (asking first) create pages, edit properties, add content and database rows. Only pages shared with the integration are visible.",
    mutatingTools: ['create_page', 'update_page', 'append_blocks', 'create_database_row'],
    status: async () => ((await client.configured()) ? { ready: true } : { ready: false, detail: 'not connected (Notion setup: token missing)' }),
    setup: () => client.setupFlow(),
    server: () =>
      createSdkMcpServer({
        name: 'notion',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool(
            'search',
            'Search pages and databases by title in the shared part of Notion, most recently edited first. Empty query lists recent items.',
            {
              query: z.string().max(200).default(''),
              kind: z.enum(['page', 'database']).optional(),
              pageSize: z.number().int().min(1).max(50).default(10),
              cursor: z.string().optional().describe('nextCursor from the previous call'),
            },
            guard(async ({ query, kind, pageSize, cursor }) => {
              const res = await search(query, kind, pageSize, cursor);
              const items = (res.results as Json[]).map((r) => (r.object === 'database' ? { object: 'database', ...databaseSummary(r) } : { object: 'page', ...pageSummary(r) }));
              return ok(paged(res, items));
            }),
          ),
          tool(
            'list_databases',
            'List the databases shared with the integration, with their property names and types (and select options).',
            { pageSize: z.number().int().min(1).max(50).default(25), cursor: z.string().optional() },
            guard(async ({ pageSize, cursor }) => {
              const res = await search('', 'database', pageSize, cursor);
              return ok(paged(res, (res.results as Json[]).map(databaseSummary)));
            }),
          ),
          tool(
            'get_page',
            'Read a page: its properties and its content as text (headings, lists, to-dos, code, nested blocks up to 2 levels, max 300 blocks). Accepts a page id or URL.',
            { page: z.string().describe('Page id or Notion URL') },
            guard(async ({ page }) => {
              const id = normalizeId(page);
              const p = await client.request<Json>('GET', `/pages/${id}`, undefined, 'this page');
              const content = await readBlocks(id, 0, { left: MAX_BLOCKS });
              return ok({ ...pageSummary(p), content: content.join('\n') });
            }),
          ),
          tool(
            'query_database',
            'Rows of a database. `filter` and `sorts` use the Notion API format, e.g. {"property":"Status","status":{"equals":"Done"}} or {"and":[...]}. Use list_databases first to see property names and types.',
            {
              database: z.string().describe('Database id or URL'),
              filter: z.record(z.string(), z.unknown()).optional(),
              sorts: z.array(z.record(z.string(), z.unknown())).max(5).optional(),
              pageSize: z.number().int().min(1).max(100).default(20),
              cursor: z.string().optional(),
            },
            guard(async ({ database, filter, sorts, pageSize, cursor }) => {
              const id = normalizeId(database);
              const res = await client.request<Json>(
                'POST',
                `/databases/${id}/query`,
                { page_size: pageSize, ...(filter ? { filter } : {}), ...(sorts ? { sorts } : {}), ...(cursor ? { start_cursor: cursor } : {}) },
                'this database',
              );
              return ok(paged(res, (res.results as Json[]).map(pageSummary)));
            }),
          ),
          tool(
            'create_page',
            'Create a page under another page, with optional content. `content` is plain text: "# ", "## ", "- ", "1. ", "- [ ] ", "> " prefixes become headings, lists, to-dos and quotes. Use create_database_row for database rows.',
            { parent: z.string().describe('Parent page id or URL'), title: z.string().min(1).max(500), content: z.string().max(50_000).optional() },
            guard(async ({ parent, title, content }) => {
              const blocks = content ? textToBlocks(content).slice(0, 100).map(toBlock) : [];
              const p = await client.request<Json>(
                'POST',
                '/pages',
                { parent: { page_id: normalizeId(parent) }, properties: { title: { title: [{ type: 'text', text: { content: title } }] } }, ...(blocks.length ? { children: blocks } : {}) },
                'the parent page',
              );
              return ok({ created: pageSummary(p) });
            }),
          ),
          tool(
            'create_database_row',
            'Add a row to a database. `values` maps property names to plain values: text, number, true/false, "2026-10-10" or "2026-10-10 → 2026-10-12" for dates, an array for multi_select. The title property is required. Types come from the database itself.',
            {
              database: z.string().describe('Database id or URL'),
              values: z.record(z.string(), z.unknown()),
              content: z.string().max(50_000).optional().describe('Optional page body as plain text'),
            },
            guard(async ({ database, values, content }) => {
              const id = normalizeId(database);
              const properties = buildProperties(await schemaOf(id), values);
              const blocks = content ? textToBlocks(content).slice(0, 100).map(toBlock) : [];
              const p = await client.request<Json>('POST', '/pages', { parent: { database_id: id }, properties, ...(blocks.length ? { children: blocks } : {}) }, 'this database');
              return ok({ created: pageSummary(p) });
            }),
          ),
          tool(
            'update_page',
            'Change a page\'s properties (same plain `values` format as create_database_row, for pages that live in a database), its title, or archive it (archived: true moves it to the trash; nothing is deleted for good).',
            {
              page: z.string(),
              values: z.record(z.string(), z.unknown()).optional(),
              title: z.string().min(1).max(500).optional().describe('New title for a page that is not in a database'),
              archived: z.boolean().optional(),
            },
            guard(async ({ page, values, title, archived }) => {
              const id = normalizeId(page);
              const body: Json = {};
              if (values && Object.keys(values).length) {
                const current = await client.request<Json>('GET', `/pages/${id}`, undefined, 'this page');
                const dbId = current.parent?.database_id as string | undefined;
                if (!dbId) throw new Error('This page is not a database row; use `title` to rename it, or append_blocks to add content');
                body.properties = buildProperties(await schemaOf(dbId), values);
              }
              if (title) body.properties = { ...(body.properties ?? {}), title: { title: [{ type: 'text', text: { content: title } }] } };
              if (archived !== undefined) body.archived = archived;
              if (!Object.keys(body).length) throw new Error('Nothing to change: give values, title or archived');
              const p = await client.request<Json>('PATCH', `/pages/${id}`, body, 'this page');
              return ok({ updated: pageSummary(p) });
            }),
          ),
          tool(
            'append_blocks',
            'Add content at the end of a page. Either `text` (plain text; "# ", "- ", "1. ", "- [ ] ", "> " prefixes become headings, lists, to-dos, quotes) or explicit `blocks`. Max 100 blocks per call.',
            { page: z.string(), text: z.string().max(50_000).optional(), blocks: z.array(blockInput).max(100).optional() },
            guard(async ({ page, text, blocks }) => {
              const simple: SimpleBlock[] = blocks ?? (text ? textToBlocks(text) : []);
              if (!simple.length) throw new Error('Nothing to add: give text or blocks');
              if (simple.length > 100) throw new Error('Too many blocks for one call (max 100); split the content');
              const res = await client.request<Json>('PATCH', `/blocks/${normalizeId(page)}/children`, { children: simple.map(toBlock) }, 'this page');
              return ok({ added: (res.results as Json[]).length });
            }),
          ),
        ],
      }),
  };
}
