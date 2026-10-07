import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentDefinition } from './schema.ts';
import { cronProblem } from '../triggers/scheduler.ts';
import { isSecretFile } from '../runtime/policy.ts';

/** Problems that make a definition unusable, checked before asking for approval. */
export function problems(def: AgentDefinition, timezone: string): string[] {
  const out: string[] = [];
  const a = def.access;
  if (a.profile === 'workspace' && !a.workdir) out.push('workspace agents need access.workdir (absolute path)');
  for (const dir of [a.workdir, ...a.extraDirs, ...a.readOnlyDirs]) if (dir && !isAbsolute(dir)) out.push(`"${dir}" must be an absolute path`);
  for (const dir of a.readOnlyDirs) if (isAbsolute(dir) && !existsSync(dir)) out.push(`read-only folder ${dir} does not exist`);
  for (const name of a.writableFiles) {
    if (name.includes('/')) out.push(`writable file "${name}" must be a file name, not a path`);
    else if (isSecretFile(name)) out.push(`writable file "${name}" looks like a secret file`);
  }
  if (a.writableFiles.length && !a.readOnlyDirs.length) out.push('access.writableFiles only applies inside access.readOnlyDirs');
  for (const t of def.triggers) {
    if (t.type !== 'cron') continue;
    const problem = cronProblem(t.schedule, t.timezone ?? timezone);
    if (problem) out.push(problem);
  }
  if (def.provider && def.provider !== 'claude' && !def.model) out.push(`provider "${def.provider}" needs a model`);
  for (const p of a.commands) if (/[;&`$<>|]/.test(p)) out.push(`command pattern "${p}" may not contain shell syntax (; & | $ \` < >); list each command of a pipeline separately`);
  return out;
}

/** Creates a workspace agent's folders. */
export async function ensureDirs(def: AgentDefinition): Promise<void> {
  if (def.access.profile === 'restricted') return;
  for (const dir of [def.access.workdir, ...def.access.extraDirs]) if (dir && !existsSync(dir)) await mkdir(dir, { recursive: true });
}
