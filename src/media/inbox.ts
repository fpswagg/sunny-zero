import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { log } from '../log.ts';
import { imageForModel, probe, videoFrame, type ImageInput, type MediaInfo } from './images.ts';
import type { Transcript } from './transcribe.ts';

export type MediaKind = 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'animation' | 'sticker';

/** A file a channel received and saved in the staging folder, waiting to be handed to an agent. */
export interface StagedFile {
  kind: MediaKind;
  /** Where the channel saved it (the staging folder, which agents cannot read). */
  path: string;
  /** File name to keep: the sender's for documents, made up for photos and voice. */
  name: string;
  mime?: string;
  size: number;
  /** Extra detail for the agent, e.g. a sticker's emoji. */
  note?: string;
}

/** The message an agent gets: the text with what was attached, and the images it sees directly. */
export interface Prepared {
  message: string;
  images: ImageInput[];
}

export interface Transcribe {
  transcribe(file: string): Promise<Transcript>;
}

export interface InboxOptions {
  /** Folder channels download into. Inside the data folder, so agents cannot read it. */
  stagingDir: string;
  /** Days files stay in an agent's inbox. */
  keepDays: number;
  transcriber?: Transcribe;
}

/** Images shown to the model per message; more are saved but not shown. */
export const MAX_IMAGES = 5;

const AV_MIME = /^(audio|video)\//;
const IMAGE_MIME = /^image\/(?!svg)/;
const LABEL: Record<MediaKind, string> = {
  photo: '🖼 Photo',
  document: '📄 File',
  voice: '🎤 Voice message',
  audio: '🎵 Audio',
  video: '🎬 Video',
  video_note: '📹 Video message',
  animation: '🎞 GIF',
  sticker: '🏷 Sticker',
};

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const megabytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** A name that is safe as one path segment: no folders, no hidden files, nothing odd. */
export function safeName(name: string, fallback = 'file'): string {
  const clean = basename(name.normalize('NFC'))
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s_-]+/, '')
    .trim()
    .slice(-120);
  return clean || fallback;
}

/**
 * Files people send in chat. Channels download into a staging folder; once the gateway knows
 * which agent gets the message, the files move to that agent's inbox/<date>/ folder (which it
 * can read), images are prepared for the model and speech is transcribed.
 */
export class Inbox {
  constructor(private readonly opts: InboxOptions) {}

  /** A fresh path in the staging folder for a channel to download into. */
  async stagingPath(name: string): Promise<string> {
    await mkdir(this.opts.stagingDir, { recursive: true, mode: 0o700 });
    return join(this.opts.stagingDir, `${Date.now()}-${randomBytes(4).toString('hex')}-${safeName(name)}`);
  }

  async discard(files: StagedFile[]): Promise<void> {
    for (const f of files) await unlink(f.path).catch(() => {});
  }

  /** Moves the files into the agent's inbox and builds the message it receives. */
  async accept(agentDir: string, text: string, files: StagedFile[], status: (text: string) => void = () => {}): Promise<Prepared> {
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(agentDir, 'inbox', day);
    await mkdir(dir, { recursive: true });
    const images: ImageInput[] = [];
    const parts: string[] = [];

    for (const file of files) {
      const dest = await this.place(file, dir);
      const lines = [`${LABEL[file.kind]}${file.kind === 'document' ? ` "${file.name}"` : ''}${file.note ? ` ${file.note}` : ''}`];
      const facts: string[] = [];
      const mime = file.mime ?? '';
      const showImage = async (load: () => Promise<ImageInput>) => {
        if (images.length >= MAX_IMAGES) return facts.push(`not shown: more than ${MAX_IMAGES} images in one message, use Read to view it`);
        try {
          images.push(await load());
          facts.push('shown to you with this message');
        } catch (err) {
          log.warn({ err: (err as Error).message, file: dest }, 'inbox: image could not be prepared');
          facts.push('could not be shown');
        }
      };

      const isAv = file.kind === 'voice' || file.kind === 'audio' || file.kind === 'video' || file.kind === 'video_note' || file.kind === 'animation' || AV_MIME.test(mime);
      let info: MediaInfo | undefined;
      if (isAv) info = await probe(dest).catch(() => undefined);

      if (file.kind === 'photo' || file.kind === 'sticker' || (file.kind === 'document' && IMAGE_MIME.test(mime))) {
        await showImage(() => imageForModel(dest));
      } else if (info?.hasVideo && file.kind !== 'audio' && file.kind !== 'voice') {
        await showImage(() => videoFrame(dest, info!.duration));
        if (facts.at(-1) === 'shown to you with this message') facts[facts.length - 1] = 'one frame is shown to you with this message';
      }
      if (info?.duration) facts.unshift(clock(info.duration));
      if (file.kind === 'document') facts.push(`${mime || extname(file.name).slice(1) || 'unknown type'}, ${megabytes(file.size)}`);

      let transcript: Transcript | undefined;
      if (info?.hasAudio && this.opts.transcriber) {
        status(`🎤 transcribing ${file.kind === 'voice' ? 'the voice message' : file.name}…`);
        try {
          transcript = await this.opts.transcriber.transcribe(dest);
        } catch (err) {
          log.warn({ err: (err as Error).message, file: dest }, 'inbox: transcription failed');
          facts.push('the transcription failed');
        }
      } else if (info?.hasAudio) {
        facts.push('not transcribed (no speech-to-text here)');
      }
      if (transcript?.language) facts.push(languageName(transcript.language));

      lines[0] += facts.length ? ` (${facts.join(', ')})` : '';
      if (transcript) {
        const said = transcript.text ? `"${transcript.text}"` : '(no speech detected)';
        lines.push(`Transcript${transcript.truncated ? ` of the first ${clock(transcript.seconds)}` : ''}: ${said}`);
      }
      lines.push(`Saved as ${dest}${file.kind === 'document' && !IMAGE_MIME.test(mime) ? ' (use Read to open it: text, code, PDFs and images work)' : ''}`);
      parts.push(lines.join('\n'));
    }

    const header = files.length === 1 ? 'The user sent this:' : `The user sent these ${files.length} items:`;
    const message = [text.trim(), `${header}\n\n${parts.join('\n\n')}`].filter(Boolean).join('\n\n');
    return { message, images };
  }

  /** Moves a staged file into the inbox under a name that is free. */
  private async place(file: StagedFile, dir: string): Promise<string> {
    const name = safeName(file.name, `${file.kind}${extname(file.path)}`);
    const ext = extname(name);
    let dest = join(dir, name);
    for (let i = 2; await exists(dest); i++) dest = join(dir, `${basename(name, ext)}-${i}${ext}`);
    try {
      await rename(file.path, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await copyFile(file.path, dest);
      await unlink(file.path);
    }
    return dest;
  }

  /** Deletes inbox days older than keepDays in the given agent folders, and leftovers in staging. */
  async prune(agentDirs: string[]): Promise<number> {
    const cutoff = new Date(Date.now() - this.opts.keepDays * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const agentDir of agentDirs) {
      const inbox = join(agentDir, 'inbox');
      for (const day of await readdir(inbox).catch(() => [] as string[])) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoff) continue;
        await rm(join(inbox, day), { recursive: true, force: true });
        removed++;
      }
    }
    for (const name of await readdir(this.opts.stagingDir).catch(() => [] as string[])) {
      const path = join(this.opts.stagingDir, name);
      const s = await stat(path).catch(() => undefined);
      if (s && Date.now() - s.mtimeMs > 86_400_000) await rm(path, { force: true });
    }
    return removed;
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
