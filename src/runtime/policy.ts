import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { FILE_TOOLS, WRITE_TOOLS, type AgentDefinition } from '../agents/schema.ts';
import type { Speaker } from '../users/users.ts';

export type Decision = { kind: 'allow' } | { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string };

export interface PolicyContext {
  def: AgentDefinition;
  cwd: string;
  /** Folders the agent may change freely: its cwd plus its notes and extra dirs. */
  roots: string[];
  /** Folders it may only read. */
  readRoots?: string[];
  /** Path the CLI reported as outside its allowed directories, when it did. */
  blockedPath?: string;
  /** Who the turn runs for. Members never skip an approval that is not read-only. */
  speaker?: Speaker['role'];
  /** True for connector tools that change something (restart a service, mute an alert...). */
  isMutating?: (tool: string) => boolean;
}

/** Files that typically hold credentials. Reads inside an agent's folders are denied outright (see secretDenyRules). */
export const SECRET_FILES = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '.pgpass', '.npmrc', '.netrc', 'secrets.json', 'master.key', 'admin.token', '*.token', 'credentials*'];

const globRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const SECRET_NAME = SECRET_FILES.map(globRegex);

export const isSecretFile = (path: string) => SECRET_NAME.some((re) => re.test(basename(path)));

const writableName = (path: string, globs: string[]) => globs.some((glob) => globRegex(glob).test(basename(path)));

/** Claude Code deny rules that keep secret files unreadable inside the given folders, also for Grep and Glob. */
export function secretDenyRules(roots: string[]): string[] {
  return roots.flatMap((root) => SECRET_FILES.map((name) => `Read(/${resolve(root)}/**/${name})`));
}

/**
 * Keeps Sunny's data folder (tokens, secrets, sessions) unreadable when one of the agent's
 * folders contains it, e.g. a read-only ~/projects. Folders inside it (Sunny's own notes) are not
 * a reason to block it, or Sunny could not read its notes.
 */
export function dataDenyRules(dataDir: string, roots: string[]): string[] {
  const exposed = roots.some((root) => isInside(dataDir, root) && !isInside(root, dataDir));
  return exposed ? [`Read(/${resolve(dataDir)}/**)`] : [];
}

/**
 * Why an agent may not send this file to the chat, or undefined when it may: the file must be
 * one it can read (its folders and read-only folders), not a secret, and not in Sunny's data
 * folder unless that is the agent's own folder.
 */
export function unsendable(path: string, roots: string[], readRoots: string[], dataDir: string): string | undefined {
  if (!roots.some((r) => isInside(path, r)) && !readRoots.some((r) => isInside(path, r))) return 'it is outside the folders you can read';
  if (isSecretFile(path)) return 'it looks like a secret file';
  if (isInside(path, dataDir) && !roots.some((r) => isInside(r, dataDir) && isInside(path, r))) return "it is in Sunny's data folder";
  return undefined;
}

/** Resolves symlinks for paths that exist, so a link inside a root cannot point outside it. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isInside(path: string, root: string): boolean {
  const rel = relative(real(root), real(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Paths a file tool call touches, resolved against the agent's cwd. */
export function toolPaths(tool: string, input: Record<string, unknown>, cwd: string): string[] {
  const paths: string[] = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value) paths.push(resolve(cwd, value));
  }
  // Glob("/etc/**") carries its location in the pattern itself.
  if (tool === 'Glob' && typeof input.pattern === 'string' && isAbsolute(input.pattern)) {
    paths.push(input.pattern.split(/[*?[{]/)[0] || '/');
  }
  if (!paths.length && FILE_TOOLS.has(tool)) paths.push(cwd);
  return paths;
}

/** Shell syntax beyond a plain command or pipeline: sequences, substitutions, redirects, background jobs. */
const SHELL_SYNTAX = /[;&`$<>\n\r(){}]|\|\|/;

/** True when the command, or every part of a pipeline, matches one of the patterns. */
export function commandAllowed(command: string, patterns: string[]): boolean {
  const cmd = command.trim();
  if (!patterns.length || !cmd || SHELL_SYNTAX.test(cmd)) return false;
  const res = patterns.map((p) => globRegex(p.trim().replace(/\s+/g, ' ')));
  return cmd.split('|').every((part) => {
    const segment = part.trim().replace(/\s+/g, ' ');
    return segment !== '' && res.some((re) => re.test(segment));
  });
}

/**
 * Decides whether a tool call runs, needs the owner's approval, or is refused.
 * The SDK only calls this for calls it would otherwise prompt for.
 */
export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  const { access, tools } = ctx.def;
  const member = ctx.speaker === 'member';
  // A friend using a full-access agent still goes through approvals.
  if (access.profile === 'full' && !member) return { kind: 'allow' };
  if (access.alwaysAsk.includes(tool)) return { kind: 'ask', reason: `${tool} always asks first` };

  // Only the connectors Sunny attached exist (strict MCP config). Reading is free; changing things asks.
  if (tool.startsWith('mcp__')) {
    if (!ctx.isMutating?.(tool)) return { kind: 'allow' };
    if (!member && access.autoApprove.includes(tool)) return { kind: 'allow' };
    return { kind: 'ask', reason: member ? 'requested by a guest' : 'this action changes something' };
  }

  const builtin = (tools as string[]).includes(tool);
  if (!builtin) return { kind: 'deny', reason: `${tool} is not one of this agent's tools` };
  if (!member && access.autoApprove.includes(tool)) return { kind: 'allow' };

  if (FILE_TOOLS.has(tool)) {
    const paths = toolPaths(tool, input, ctx.cwd);
    if (ctx.blockedPath) paths.push(resolve(ctx.cwd, ctx.blockedPath));
    const writing = WRITE_TOOLS.has(tool);
    const readRoots = ctx.readRoots ?? [];
    const allowed = writing ? ctx.roots : [...ctx.roots, ...readRoots];
    const outside = paths.filter((p) => !allowed.some((root) => isInside(p, root)));
    if (!outside.length) return { kind: 'allow' };
    const readOnly = writing && outside.every((p) => readRoots.some((root) => isInside(p, root)));
    const secret = outside.some(isSecretFile);
    // Docs the agent keeps inside a read-only folder (OVERVIEW.md...), never secret files.
    if (readOnly && !member && !secret && outside.every((p) => writableName(p, access.writableFiles))) return { kind: 'allow' };
    return { kind: 'ask', reason: `${readOnly ? 'read-only folder' : 'outside its folders'}: ${outside.join(', ')}${secret ? ' (may contain secrets)' : ''}` };
  }

  if (tool === 'WebFetch' || tool === 'WebSearch' || tool === 'TodoWrite') return { kind: 'allow' };
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (commandAllowed(command, access.commands)) return { kind: 'allow' };
    return { kind: 'ask', reason: 'shell command' };
  }
  return { kind: 'ask', reason: `${tool} needs approval` };
}

/** One-line description of a tool call for approvals and progress lines. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  const detail =
    pick('command') ?? pick('file_path') ?? pick('notebook_path') ?? pick('url') ?? pick('query') ?? pick('pattern') ?? pick('path');
  const short = (s: string) => (s.length > 300 ? s.slice(0, 300) + '…' : s);
  const name = tool.replace(/^mcp__(\w[\w-]*)__/, '$1.');
  if (detail) return `${name}: ${short(detail)}`;
  const json = JSON.stringify(input);
  return json === '{}' ? name : `${name} ${short(json)}`;
}
