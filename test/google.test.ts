import { describe, expect, it } from 'vitest';
import { bodyText, buildRaw, gmailConnector } from '../src/connectors/gmail/index.ts';
import { driveConnector, multipart, q } from '../src/connectors/gdrive/index.ts';
import { youtubeConnector, explainYouTube } from '../src/connectors/youtube/index.ts';

const secrets = (v: Record<string, string> | null) => ({ get: async () => v ?? undefined, has: async () => Boolean(v), set: async () => {}, patch: async () => {} }) as never;
const b = (s: string) => Buffer.from(s).toString('base64url');

describe('gmail', () => {
  it('extracts text, falling back to html', () => {
    expect(bodyText({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b('<p>Hi</p>') } }, { mimeType: 'text/plain', body: { data: b('Hello') } }] })).toBe('Hello');
    expect(bodyText({ mimeType: 'text/html', body: { data: b('<style>x{}</style><p>Hi&nbsp;you</p>') } })).toBe('Hi you');
  });
  it('builds a safe message', () => {
    const raw = Buffer.from(buildRaw({ to: ['a@b.co'], subject: 'Héllo', text: 'x' }), 'base64url').toString();
    expect(raw).toContain('To: a@b.co');
    expect(raw).toContain('=?UTF-8?B?');
    expect(() => buildRaw({ to: ['a@b.co\r\nBcc: evil@x.co'], subject: 's', text: 'x' })).toThrow();
    expect(() => buildRaw({ to: ['a@b.co'], subject: 's\nBcc: x', text: 'x' })).toThrow();
  });
  it('only send asks; status', async () => {
    expect(gmailConnector({ secrets: secrets(null) }).mutatingTools).toEqual(['send']);
    expect((await gmailConnector({ secrets: secrets(null) }).status()).ready).toBe(false);
  });
});

describe('drive', () => {
  it('escapes queries and builds multipart', () => {
    expect(q("it's")).toBe("'it\\'s'");
    const m = multipart({ name: 'a' }, 'hi', 'text/plain', 'BND');
    expect(m.body).toContain('--BND--');
    expect(m.body).toContain('"name":"a"');
  });
  it('writes ask, reads do not', () => {
    expect(driveConnector({ secrets: secrets(null) }).mutatingTools).toEqual(['create_folder', 'create_file', 'share']);
  });
});

describe('youtube', () => {
  it('is read only and explains quota', () => {
    const c = youtubeConnector({ secrets: secrets(null) });
    expect(c.mutatingTools ?? []).toEqual([]);
    expect(explainYouTube(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }, 'x')).toContain('quota');
  });
});
