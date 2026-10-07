import { describe, expect, it } from 'vitest';
import { notionCalendarConnector, pickProperty } from '../src/connectors/notion-calendar/index.ts';

const secrets = (has: boolean) => ({ get: async () => (has ? { token: 'x' } : undefined), has: async () => has, set: async () => {} });

describe('notion calendar', () => {
  it('picks properties and explains', () => {
    const s = { Name: { type: 'title' }, When: { type: 'date' }, Due: { type: 'date' } };
    expect(pickProperty(s, 'date')).toBe('When');
    expect(pickProperty(s, 'date', 'Due')).toBe('Due');
    expect(() => pickProperty(s, 'date', 'Name')).toThrow(/not a date/);
    expect(() => pickProperty({ Name: { type: 'title' } }, 'date')).toThrow(/no date property/);
  });
  it('status follows the Notion connection; creating asks', async () => {
    expect((await notionCalendarConnector({ secrets: secrets(false) }).status()).ready).toBe(false);
    const c = notionCalendarConnector({ secrets: secrets(true) });
    expect((await c.status()).ready).toBe(true);
    expect(c.mutatingTools).toEqual(['create_event']);
  });
});
