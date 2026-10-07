import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);

/** An image shown to the model with the message (base64, as the Messages API takes it). */
export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

/** Longest side Claude uses at full detail; larger images only cost tokens. */
const MAX_SIDE = 1568;

/** Any image sharp reads (JPEG, PNG, WebP, GIF, HEIC, TIFF...) as a JPEG for the model. Only the first frame of an animation. */
export async function imageForModel(file: string): Promise<ImageInput> {
  const jpeg = await sharp(file, { animated: false })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: 'image/jpeg', data: jpeg.toString('base64') };
}

export interface MediaInfo {
  /** Seconds, when known. */
  duration?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function probe(file: string): Promise<MediaInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const duration = Number(info.format?.duration);
  const types = new Set((info.streams ?? []).map((s) => s.codec_type));
  return { duration: Number.isFinite(duration) ? duration : undefined, hasAudio: types.has('audio'), hasVideo: types.has('video') };
}

/** One frame of a video (a third of the way in, past intros and fades) as a JPEG for the model. */
export async function videoFrame(file: string, duration?: number): Promise<ImageInput> {
  const at = duration ? Math.min(duration / 3, Math.max(duration - 0.1, 0)) : 0;
  const { stdout } = await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!stdout.length) throw new Error('no frame');
  const jpeg = await sharp(stdout).resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { mediaType: 'image/jpeg', data: jpeg.toString('base64') };
}
