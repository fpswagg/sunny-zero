import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PendingTasks, parseResetTime } from '../src/triggers/pending.ts';
import { testDb } from './helpers/db.ts';

describe('parseResetTime', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  it('reads relative durations', () => {
    expect(parseResetTime('limit reached, resets in 2h 30m', now, 'UTC')?.toISOString()).toBe('2026-10-07T12:30:00.000Z');
  });
  it('reads clock times and rolls to the next day', () => {
    expect(parseResetTime('Session limit reached, resets 3pm (UTC)', now, 'UTC')?.toISOString()).toBe('2026-10-07T15:00:00.000Z');
    expect(parseResetTime('resets 9am (UTC)', now, 'UTC')?.toISOString()).toBe('2026-10-08T09:00:00.000Z');
  });
  it('gives up on texts without a reset', () => {
    expect(parseResetTime('rate limit', now, 'UTC')).toBeUndefined();
  });
});

describe('PendingTasks', () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let tasks: PendingTasks;
  beforeAll(async () => {
    db = await testDb();
    tasks = new PendingTasks(db.sql);
  });
  beforeEach(() => db.reset());
  afterAll(() => db.drop());

  it('records, parks, restarts and finishes a run', async () => {
    const id = await tasks.begin('watcher', 'check', 'cron');
    expect((await tasks.list('running')).map((t) => t.id)).toEqual([id]);
    await tasks.wait(id, { resumeAfter: new Date(Date.now() - 1000), signature: 'a', reason: 'limit' });
    const [t] = await tasks.list('waiting');
    expect(t).toMatchObject({ id, signature: 'a', attempts: 0 });
    expect(await tasks.restart(id)).toBe(true);
    expect((await tasks.list('running'))[0]).toMatchObject({ id, attempts: 1 });
    await tasks.finish(id);
    expect(await tasks.list()).toEqual([]);
  });
});
