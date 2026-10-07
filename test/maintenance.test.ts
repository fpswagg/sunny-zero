import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Maintenance, hourIn } from '../src/maintenance.ts';
import { testDb } from './helpers/db.ts';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => (db = await testDb()));
beforeEach(() => db.reset());
afterAll(() => db.drop());

const at4 = new Date('2026-10-07T04:10:00Z');
const make = (over: { busy?: boolean; uptimeH?: number; now?: Date } = {}) => {
  const restart = vi.fn();
  const m = new Maintenance({ sql: db.sql, timezone: 'UTC', busy: () => over.busy ?? false, restart, now: () => over.now ?? at4, uptimeMs: () => (over.uptimeH ?? 30) * 3_600_000 });
  return { m, restart };
};
const addRun = (when: Date) => db.sql`insert into runs (at, agent, conversation, origin, message, reply, is_error, duration_ms) values (${when}, 'a', 'c', 'cron', 'm', 'r', false, 1)`;

describe('Maintenance', () => {
  it('reads the hour in a zone', () => {
    expect(hourIn(at4, 'UTC')).toBe(4);
    expect(hourIn(at4, 'Africa/Lagos')).toBe(5);
  });
  it('restarts at the hour when up 24 h and idle', async () => {
    const { m, restart } = make();
    await m.tick();
    expect(restart).toHaveBeenCalledOnce();
  });
  it('does not restart when too young, busy, wrong hour or recently used', async () => {
    for (const over of [{ uptimeH: 10 }, { busy: true }, { now: new Date('2026-10-07T12:00:00Z') }]) {
      const { m, restart } = make(over);
      await m.tick();
      expect(restart).not.toHaveBeenCalled();
    }
    await addRun(new Date('2026-10-07T03:50:00Z'));
    const { m, restart } = make();
    await m.tick();
    expect(restart).not.toHaveBeenCalled();
  });
  it('drops sessions unused for a week only', async () => {
    await db.sql`insert into sessions (key, session_id, cwd, updated_at) values ('old', 's', '/', ${new Date('2026-09-20T00:00:00Z')}), ('new', 's', '/', ${new Date('2026-10-06T00:00:00Z')})`;
    await make({ uptimeH: 1 }).m.tick();
    expect((await db.sql`select key from sessions`).map((r) => r.key)).toEqual(['new']);
  });
});
