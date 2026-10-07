import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { Inbox, MAX_IMAGES, safeName, type StagedFile } from '../src/media/inbox.ts';
import type { Transcript } from '../src/media/transcribe.ts';

const base = mkdtempSync(join(tmpdir(), 'sunny-inbox-'));
const media = join(base, 'media');
const agentDir = join(base, 'agents', 'atlas');
mkdirSync(media);
mkdirSync(agentDir, { recursive: true });

const heard: string[] = [];
const transcriber = {
  async transcribe(file: string): Promise<Transcript> {
    heard.push(file);
    return { text: 'Bonjour, peux-tu regarder ça ?', language: 'fr', seconds: 1, truncated: false };
  },
};
const inbox = new Inbox({ stagingDir: join(base, 'staging'), keepDays: 30, transcriber });

/** Copies a sample into the staging folder, as a channel would after downloading it. */
async function stage(sample: string, kind: StagedFile['kind'], name: string, mime?: string): Promise<StagedFile> {
  const path = await inbox.stagingPath(name);
  execFileSync('cp', [join(media, sample), path]);
  return { kind, path, name, mime, size: statSync(path).size };
}

beforeAll(async () => {
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3a7' } }).png().toFile(join(media, 'big.png'));
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libopus', join(media, 'voice.ogg'));
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-shortest', '-pix_fmt', 'yuv420p', join(media, 'clip.mp4'));
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-pix_fmt', 'yuv420p', '-an', join(media, 'gif.mp4'));
  writeFileSync(join(media, 'notes.txt'), 'hello');
});

describe('Inbox.accept', () => {
  it('moves a photo into the inbox and shows it to the model, resized', async () => {
    const file = await stage('big.png', 'photo', 'photo-1.jpg', 'image/jpeg');
    const { message, images } = await inbox.accept(agentDir, 'what is this?', [file]);
    expect(existsSync(file.path)).toBe(false);
    const day = new Date().toISOString().slice(0, 10);
    expect(message).toBe(`what is this?\n\nThe user sent this:\n\n🖼 Photo (shown to you with this message)\nSaved as ${join(agentDir, 'inbox', day, 'photo-1.jpg')}`);
    expect(images).toHaveLength(1);
    const meta = await sharp(Buffer.from(images[0]!.data, 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1568, 1045]);
  });

  it('transcribes voice messages and names the language', async () => {
    const file = await stage('voice.ogg', 'voice', 'voice-2.ogg', 'audio/ogg');
    const { message, images } = await inbox.accept(agentDir, '', [file], (s) => heard.push(`status: ${s}`));
    expect(images).toEqual([]);
    expect(message).toMatch(/^The user sent this:\n\n🎤 Voice message \(0:02, French\)\nTranscript: "Bonjour, peux-tu regarder ça \?"\nSaved as .*voice-2\.ogg$/);
    expect(heard).toContain('status: 🎤 transcribing the voice message…');
  });

  it('shows a frame of a video and transcribes its sound; a silent GIF gets a frame only', async () => {
    const video = await stage('clip.mp4', 'video', 'video-3.mp4', 'video/mp4');
    const gif = await stage('gif.mp4', 'animation', 'gif-4.mp4', 'video/mp4');
    heard.length = 0;
    const { message, images } = await inbox.accept(agentDir, '', [video, gif]);
    expect(images).toHaveLength(2);
    expect(message).toContain('🎬 Video (0:02, one frame is shown to you with this message, French)\nTranscript: "Bonjour');
    expect(message).toContain('🎞 GIF (0:01, one frame is shown to you with this message)\nSaved as');
    expect(heard).toHaveLength(1);
  });

  it('points to documents, keeps their name, and never overwrites', async () => {
    const one = await stage('notes.txt', 'document', 'notes.txt', 'text/plain');
    const two = await stage('notes.txt', 'document', 'notes.txt', 'text/plain');
    const { message } = await inbox.accept(agentDir, '', [one, two]);
    expect(message).toContain('📄 File "notes.txt" (text/plain, 1 KB)');
    expect(message).toContain('notes.txt (use Read to open it');
    expect(message).toContain('notes-2.txt (use Read to open it');
  });

  it(`shows at most ${MAX_IMAGES} images`, async () => {
    const photos = [];
    for (let i = 0; i < MAX_IMAGES + 1; i++) photos.push(await stage('big.png', 'photo', `p${i}.jpg`, 'image/jpeg'));
    const { images, message } = await inbox.accept(agentDir, '', photos);
    expect(images).toHaveLength(MAX_IMAGES);
    expect(message).toContain('not shown: more than');
  });
});

describe('Inbox housekeeping', () => {
  it('makes names safe', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('.env')).toBe('env');
    expect(safeName('rapport final (v2).pdf')).toBe('rapport final _v2_.pdf');
    expect(safeName('', 'voice.ogg')).toBe('voice.ogg');
  });

  it('removes old inbox days and stale staging files', async () => {
    const old = join(agentDir, 'inbox', '2000-01-01');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'x.txt'), 'x');
    const stale = await inbox.stagingPath('stale.bin');
    writeFileSync(stale, 'x');
    utimesSync(stale, new Date(0), new Date(0));
    expect(await inbox.prune([agentDir])).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(agentDir, 'inbox')).length).toBeGreaterThan(0);
  });
});
