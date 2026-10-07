import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SecretStore } from '../../secrets/store.ts';
import type { Connector } from '../types.ts';
import { NotionClient, normalizeId } from '../notion/client.ts';
import { pageSummary } from '../notion/format.ts';
import { UNTRUSTED_NOTE, WriteBudget, fail, guard, ok } from '../shared.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface NotionCalendarDeps {
  secrets: Pick<SecretStore, 'get' | 'has' | 'set'>;
  client?: NotionClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const iso = z.string().regex(ISO, 'ISO date: 2026-10-12 or 2026-10-12T14:30:00+01:00');

/** First property of a given type in a database schema (or the one named, if given). */
export function pickProperty(schema: Record<string, Json>, type: string, name?: string): string {
  if (name) {
    if (schema[name]?.type !== type) throw new Error(`"${name}" is not a ${type} property. Available: ${Object.entries(schema).filter(([, p]) => p.type === type).map(([n]) => n).join(', ') || 'none'}`);
    return name;
  }
  const found = Object.entries(schema).find(([, p]) => p.type === type)?.[0];
  if (!found) throw new Error(`This database has no ${type} property, so it cannot be used as a calendar.`);
  return found;
}

/**
 * Notion Calendar (formerly Cron) has no public API: it only shows Notion databases that have a
 * date property. So this connector works on those databases through the Notion integration the
 * owner already connected (same token, same sharing rules): list events in a date range, and add
 * an event as a new row. Events appear in Notion Calendar on their own. Nothing is deleted.
 */
export function notionCalendarConnector(deps: NotionCalendarDeps): Connector {
  const client = deps.client ?? new NotionClient(deps.secrets);
  const writes = new WriteBudget(30, 3600_000);
  const schemaOf = async (id: string) => (await client.request<Json>('GET', `/databases/${id}`, undefined, 'this calendar database')).properties as Record<string, Json>;

  return {
    name: 'notion-calendar',
    description: 'Notion Calendar through Notion databases with a date property: list calendars, list events in a date range, add events (asks first). Uses the Notion connection; no separate login.',
    mutatingTools: ['create_event'],
    status: async () => ((await deps.secrets.has('notion:integration')) ? { ready: true, detail: 'uses the Notion connection' } : { ready: false, detail: 'connect Notion first (setup_connector notion)' }),
    server: () =>
      createSdkMcpServer({
        name: 'notion-calendar',
        version: '0.1.0',
        alwaysLoad: true,
        tools: [
          tool('list_calendars', 'Notion databases that can act as calendars (they have a date property).', {}, guard(async () => {
            const res = await client.request<Json>('POST', '/search', { filter: { property: 'object', value: 'database' }, page_size: 50 });
            const dbs = (res.results as Json[]).flatMap((d) => {
              const dates = Object.entries<Json>(d.properties ?? {}).filter(([, p]) => p.type === 'date').map(([n]) => n);
              return dates.length ? [{ id: d.id, title: (d.title as Json[] | undefined)?.map((t) => t.plain_text).join('') || 'Untitled', dateProperties: dates }] : [];
            });
            return ok(dbs);
          })),
          tool(
            'list_events',
            'Events of a calendar database between two dates (inclusive), earliest first.',
            { database: z.string().min(8), from: iso, to: iso, dateProperty: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) },
            guard(async ({ database, from, to, dateProperty, limit }) => {
              const id = normalizeId(database);
              const prop = pickProperty(await schemaOf(id), 'date', dateProperty);
              const res = await client.request<Json>('POST', `/databases/${id}/query`, {
                page_size: limit,
                filter: { and: [{ property: prop, date: { on_or_after: from } }, { property: prop, date: { on_or_before: to } }] },
                sorts: [{ property: prop, direction: 'ascending' }],
              }, 'this calendar');
              return ok({ note: UNTRUSTED_NOTE, dateProperty: prop, events: (res.results as Json[]).map((p) => ({ ...pageSummary(p), when: p.properties?.[prop]?.date })) });
            }),
          ),
          tool(
            'create_event',
            'Add an event (a new row) to a calendar database. Use a date for all-day, or a date-time with offset for timed events.',
            { database: z.string().min(8), title: z.string().min(1).max(300), start: iso, end: iso.optional(), timeZone: z.string().optional().describe('IANA, e.g. Europe/Paris'), dateProperty: z.string().optional(), notes: z.string().max(2000).optional() },
            guard(async ({ database, title, start, end, timeZone, dateProperty, notes }) => {
              if (end && end < start) return fail('The end is before the start.');
              const id = normalizeId(database);
              const schema = await schemaOf(id);
              const prop = pickProperty(schema, 'date', dateProperty);
              const titleProp = pickProperty(schema, 'title');
              writes.take('events');
              const page = await client.request<Json>('POST', '/pages', {
                parent: { database_id: id },
                properties: { [titleProp]: { title: [{ text: { content: title } }] }, [prop]: { date: { start, ...(end ? { end } : {}), ...(timeZone ? { time_zone: timeZone } : {}) } } },
                ...(notes ? { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: notes } }] } }] } : {}),
              }, 'the event');
              return ok({ created: page.url, id: page.id });
            }),
          ),
        ],
      }),
  };
}
