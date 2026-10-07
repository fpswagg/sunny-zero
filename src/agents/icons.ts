import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/** Every agent has a square SVG icon in its folder that matches its name (a sun for Sunny, a moon for a night watcher). */
export const ICON_FILE = 'icon.svg';
export const SUNNY_ICON = join(import.meta.dirname, '..', 'sunny', 'icon.svg');

const MAX_SVG_BYTES = 64 * 1024;

/** Problems that make an SVG unsafe or unusable as an icon, or undefined when it is fine. */
export function svgProblem(svg: string): string | undefined {
  const s = svg.trim();
  if (Buffer.byteLength(s) > MAX_SVG_BYTES) return 'the SVG is larger than 64 KB';
  if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return 'it must be a single <svg> document';
  if (/<script|<foreignObject|<iframe|<image|\son\w+\s*=|javascript:/i.test(s)) return 'scripts, event handlers, embedded images and foreignObject are not allowed';
  if (/(href|src)\s*=\s*["'](?!#)/i.test(s) || /url\(\s*['"]?(?!#)/i.test(s)) return 'only internal references (#id) are allowed';
  if (!/viewBox\s*=/.test(s)) return 'add a square viewBox, e.g. viewBox="0 0 512 512"';
  return undefined;
}

/** Renders an icon for Telegram (JPEG) or the web (PNG). Throws when the SVG does not render. */
export async function renderIcon(svg: string, size = 640, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
  const image = sharp(Buffer.from(svg), { density: 300 }).resize(size, size, { fit: 'cover' });
  return format === 'jpeg' ? image.flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer() : image.png().toBuffer();
}

export async function readIcon(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, 'utf8') : undefined;
}

/** Validates, test-renders and saves an agent's icon. Returns an error message instead of throwing. */
export async function saveIcon(agentDir: string, svg: string): Promise<string | undefined> {
  const problem = svgProblem(svg);
  if (problem) return problem;
  try {
    await renderIcon(svg, 64, 'png');
  } catch (err) {
    return `the SVG does not render: ${(err as Error).message}`;
  }
  await writeFile(join(agentDir, ICON_FILE), svg.trim() + '\n');
  return undefined;
}
