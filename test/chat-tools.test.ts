import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileKind } from '../src/runtime/chat-tools.ts';
import { unsendable } from '../src/runtime/policy.ts';

describe('fileKind', () => {
  it('guesses from the extension', () => {
    expect(fileKind('/x/chart.png', 1000)).toBe('photo');
    expect(fileKind('/x/clip.MP4', 1000)).toBe('video');
    expect(fileKind('/x/fun.gif', 1000)).toBe('animation');
    expect(fileKind('/x/song.mp3', 1000)).toBe('audio');
    expect(fileKind('/x/report.pdf', 1000)).toBe('document');
  });

  it('sends big photos as documents, and voice only when asked for an audio file', () => {
    expect(fileKind('/x/huge.jpg', 11 * 1024 * 1024)).toBe('document');
    expect(fileKind('/x/note.ogg', 1000, 'voice')).toBe('voice');
    expect(fileKind('/x/report.pdf', 1000, 'voice')).toBe('document');
    expect(fileKind('/x/chart.png', 1000, 'document')).toBe('document');
    // A wish that does not fit the file is ignored.
    expect(fileKind('/x/report.pdf', 1000, 'photo')).toBe('document');
  });
});

describe('unsendable', () => {
  const base = mkdtempSync(join(tmpdir(), 'sunny-send-'));
  const own = join(base, 'agents', 'atlas', 'workspace');
  const project = join(base, 'project');
  const data = join(base, 'data');
  const sunnyNotes = join(data, 'sunny', 'memory');
  for (const d of [own, project, sunnyNotes]) mkdirSync(d, { recursive: true });

  it('sends files the agent can read', () => {
    expect(unsendable(join(own, 'chart.png'), [own], [project], data)).toBeUndefined();
    expect(unsendable(join(project, 'OVERVIEW.md'), [own], [project], data)).toBeUndefined();
  });

  it('refuses files outside its folders, secrets, and the data folder', () => {
    expect(unsendable('/etc/passwd', [own], [project], data)).toMatch(/outside/);
    expect(unsendable(join(project, '.env'), [own], [project], data)).toMatch(/secret/);
    expect(unsendable(join(data, 'secrets.json.imported'), [own], [base], data)).toMatch(/data folder/);
    // Sunny's own folders sit inside the data folder.
    expect(unsendable(join(sunnyNotes, 'MEMORY.md'), [sunnyNotes], [], data)).toBeUndefined();
  });
});
