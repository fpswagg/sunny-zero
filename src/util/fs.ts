import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Write through a temp file and rename, so a crash never leaves half-written JSON. */
export async function writeJsonAtomic(path: string, value: unknown, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  await rename(tmp, path);
}
