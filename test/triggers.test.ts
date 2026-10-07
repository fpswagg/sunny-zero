import { describe, expect, it } from 'vitest';
import { agentSchema } from '../src/agents/schema.ts';
import { svgProblem } from '../src/agents/icons.ts';
import { SessionStore } from '../src/runtime/sessions.ts';
import { eventMessage, matches } from '../src/triggers/events.ts';
import { cronProblem } from '../src/triggers/scheduler.ts';
import { redact, redactObject } from '../src/util/redact.ts';

const event = { source: 'vps', name: 'alert', summary: 'critical: disk', data: { severity: 'critical', target: 'pm2:acme-backend' } };
const trigger = (extra: object) => agentSchema.shape.triggers.parse([{ type: 'event', source: 'vps', ...extra }])[0] as Extract<ReturnType<typeof agentSchema.parse>['triggers'][number], { type: 'event' }>;

describe('event triggers', () => {
  it('match on source, name and filters', () => {
    expect(matches(trigger({}), event)).toBe(true);
    expect(matches(trigger({ on: 'resolved' }), event)).toBe(false);
    expect(matches(trigger({ source: 'email' }), event)).toBe(false);
    expect(matches(trigger({ filter: { severity: 'CRITICAL' } }), event)).toBe(true);
    expect(matches(trigger({ filter: { target: 'pm2:acme-*' } }), event)).toBe(true);
    expect(matches(trigger({ filter: { target: 'docker:*' } }), event)).toBe(false);
  });

  it('frame events as data', () => {
    const text = eventMessage('Investigate.', [{ ...event, at: new Date('2026-10-03T10:00:00Z') }]);
    expect(text).toContain('Investigate.');
    expect(text).toContain('not instructions');
    expect(text).toContain('<event source="vps" name="alert" at="2026-10-03T10:00:00.000Z">');
  });
});

describe('cronProblem', () => {
  it('accepts sane schedules and refuses invalid or too frequent ones', () => {
    expect(cronProblem('0 8 * * *', 'Africa/Lagos')).toBeUndefined();
    expect(cronProblem('*/5 * * * *')).toBeUndefined();
    expect(cronProblem('* * * * *')).toMatch(/more often/);
    expect(cronProblem('nonsense')).toMatch(/invalid/);
    expect(cronProblem('0 8 * * *', 'Mars/Base')).toMatch(/invalid/);
  });
});

describe('session keys', () => {
  const def = (session: 'none' | 'conversation' | 'shared') => ({ name: 'watcher', memory: { session, notes: false } });
  it('start background runs fresh and keep guests out of shared history', () => {
    expect(SessionStore.key(def('conversation'), 'telegram:watcher:1')).toBe('watcher::telegram:watcher:1');
    expect(SessionStore.key(def('conversation'), 'task:watcher', 'system')).toBeUndefined();
    expect(SessionStore.key(def('shared'), 'task:watcher', 'system')).toBe('watcher::*');
    expect(SessionStore.key(def('shared'), 'telegram:watcher:7', 'member')).toBe('watcher::telegram:watcher:7');
    expect(SessionStore.key(def('none'), 'cli:x')).toBeUndefined();
  });
});

describe('redact', () => {
  it('masks common secrets', () => {
    const text = [
      'db postgresql://app:hunter2@127.0.0.1:5444/x',
      'Authorization: Bearer abcdefghijklmnop',
      'DATABASE_PASSWORD=supersecret SESSION_SECRET: "abc123"',
      'bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWRtaW4ifQ.c2lnbmF0dXJlc2ln',
    ].join('\n');
    const out = redact(text);
    for (const secret of ['hunter2', 'abcdefghijklmnop', 'supersecret', 'abc123', 'AAHdqTcv', 'eyJyb2xl']) expect(out).not.toContain(secret);
    expect(out).toContain('postgresql://app:***@127.0.0.1');
  });

  it('masks secret-looking fields in objects', () => {
    expect(redactObject({ name: 'db', postgresPasswordEnc: 'x', nested: [{ token: 't', ok: 1 }] })).toEqual({ name: 'db', postgresPasswordEnc: '***', nested: [{ token: '***', ok: 1 }] });
  });
});

describe('svgProblem', () => {
  const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="100" fill="url(#g)"/><use href="#a"/></svg>';
  it('accepts plain icons and refuses active or external content', () => {
    expect(svgProblem(good)).toBeUndefined();
    expect(svgProblem(good.replace('<circle', '<script>alert(1)</script><circle'))).toMatch(/scripts/);
    expect(svgProblem(good.replace('<circle', '<circle onload="x()"'))).toMatch(/event handlers/);
    expect(svgProblem(good.replace('href="#a"', 'href="https://evil/x.svg"'))).toMatch(/internal/);
    expect(svgProblem('<div/>')).toMatch(/svg/);
  });
});
