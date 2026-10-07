import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** Used when an icon has no clear colour (grey, black and white). */
export const DEFAULT_ACCENT = '#7c83ff';

const cache = new Map<string, string>();

function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * The agent's colour, read from its icon: the most vivid hue that covers a real part of it,
 * brightened so it reads well on a dark background. Each agent's app wears its own colour.
 */
export async function accentOf(svg: string): Promise<string> {
  const key = createHash('sha1').update(svg).digest('hex');
  const hit = cache.get(key);
  if (hit) return hit;
  let accent = DEFAULT_ACCENT;
  try {
    const { data, info } = await sharp(Buffer.from(svg), { density: 72 }).resize(64, 64, { fit: 'cover' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const BINS = 24;
    const weight = new Float64Array(BINS);
    const sums = Array.from({ length: BINS }, () => ({ x: 0, y: 0, s: 0, l: 0, n: 0 }));
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3]! < 128) continue;
      const [h, s, l] = hsl(data[i]!, data[i + 1]!, data[i + 2]!);
      if (s < 0.22 || l < 0.12 || l > 0.92) continue;
      const w = s * s * (1 - Math.abs(l - 0.5));
      const bin = Math.floor(h / (360 / BINS)) % BINS;
      weight[bin] = weight[bin]! + w;
      const b = sums[bin]!;
      b.x += Math.cos((h * Math.PI) / 180) * w;
      b.y += Math.sin((h * Math.PI) / 180) * w;
      b.s += s * w;
      b.l += l * w;
      b.n += w;
    }
    // Neighbouring bins count a little, so one hue split across two bins still wins.
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < BINS; i++) {
      const score = weight[i]! + 0.5 * (weight[(i + 1) % BINS]! + weight[(i + BINS - 1) % BINS]!);
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    // Ignore specks: the colour must cover a little of the icon.
    if (best >= 0 && bestScore > 4) {
      const b = sums[best]!;
      const h = ((Math.atan2(b.y, b.x) * 180) / Math.PI + 360) % 360;
      const s = Math.min(0.9, Math.max(0.6, b.s / b.n));
      const l = Math.min(0.66, Math.max(0.56, b.l / b.n));
      accent = hex(h, s, l);
    }
  } catch {
    /* unreadable icon: default colour */
  }
  cache.set(key, accent);
  return accent;
}

/** Text colour that reads on the accent: dark on light colours (amber, yellow), else white. */
export function inkOn(accent: string): string {
  const n = parseInt(accent.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.4 ? '#15151a' : '#ffffff';
}
