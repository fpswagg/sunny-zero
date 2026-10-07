import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentSchema } from '../src/agents/schema.ts';
import { commandAllowed, dataDenyRules, decide, describeCall, isInside, isSecretFile, secretDenyRules } from '../src/runtime/policy.ts';

const base = mkdtempSync(join(tmpdir(), 'sunny-policy-'));
const cwd = join(base, 'workspace');
const notes = join(base, 'memory');
mkdirSync(cwd);
mkdirSync(notes);

const def = (extra: object = {}) => agentSchema.parse({ name: 'tester', description: 'x', tools: ['Read', 'Write', 'Bash', 'WebFetch'], ...extra });
const ctx = (extra: object = {}) => ({ def: def(extra), cwd, roots: [cwd, notes] });

describe('decide', () => {
  it('allows file tools inside the agent folders', () => {
    expect(decide('Write', { file_path: join(cwd, 'a.md') }, ctx())).toEqual({ kind: 'allow' });
    expect(decide('Read', { file_path: 'relative.txt' }, ctx())).toEqual({ kind: 'allow' });
    expect(decide('Write', { file_path: join(notes, 'MEMORY.md') }, ctx())).toEqual({ kind: 'allow' });
  });

  it('asks for paths outside the folders, including ../ escapes', () => {
    expect(decide('Read', { file_path: '/etc/passwd' }, ctx()).kind).toBe('ask');
    expect(decide('Write', { file_path: '../../escape.txt' }, ctx()).kind).toBe('ask');
  });

  it('asks when a symlink inside the workspace points outside', () => {
    const link = join(cwd, 'link');
    symlinkSync('/etc', link);
    expect(decide('Read', { file_path: join(link, 'hostname') }, ctx()).kind).toBe('ask');
  });

  it('asks for Bash unless auto-approved', () => {
    expect(decide('Bash', { command: 'ls' }, ctx()).kind).toBe('ask');
    expect(decide('Bash', { command: 'ls' }, ctx({ access: { autoApprove: ['Bash'] } })).kind).toBe('allow');
  });

  it('denies tools the agent was not given', () => {
    expect(decide('Edit', { file_path: join(cwd, 'a') }, ctx()).kind).toBe('deny');
  });

  it('honours alwaysAsk and full access', () => {
    expect(decide('Write', { file_path: join(cwd, 'a') }, ctx({ access: { alwaysAsk: ['Write'] } })).kind).toBe('ask');
    expect(decide('Read', { file_path: '/etc/passwd' }, ctx({ access: { profile: 'full' } })).kind).toBe('allow');
  });

  it('allows attached connector tools and web fetches', () => {
    expect(decide('mcp__email__list', {}, ctx()).kind).toBe('allow');
    expect(decide('WebFetch', { url: 'https://example.com' }, ctx()).kind).toBe('allow');
  });

  it('checks the path the CLI reported as blocked', () => {
    expect(decide('Read', { file_path: join(cwd, 'a') }, { ...ctx(), blockedPath: '/root/.ssh' }).kind).toBe('ask');
  });

  it('checks absolute glob patterns', () => {
    expect(decide('Read', {}, ctx()).kind).toBe('allow');
    expect(isInside(join(cwd, 'x'), cwd)).toBe(true);
    expect(isInside(base, cwd)).toBe(false);
  });
});

describe('read-only folders and commands', () => {
  const project = join(base, 'project');
  mkdirSync(project);
  const ro = (extra: object = {}) => ({ ...ctx(extra), readRoots: [project] });

  it('reads read-only folders freely but asks before changing them', () => {
    expect(decide('Read', { file_path: join(project, 'src/a.ts') }, ro()).kind).toBe('allow');
    const write = decide('Write', { file_path: join(project, 'a.ts') }, ro());
    expect(write).toEqual({ kind: 'ask', reason: `read-only folder: ${join(project, 'a.ts')}` });
  });

  it('writes only the named files in read-only folders without asking', () => {
    const docs = ro({ access: { writableFiles: ['OVERVIEW.md', 'STYLE.md', '.env'] } });
    expect(decide('Write', { file_path: join(project, 'OVERVIEW.md') }, docs).kind).toBe('allow');
    expect(decide('Write', { file_path: join(project, 'sub/STYLE.md') }, docs).kind).toBe('allow');
    expect(decide('Write', { file_path: join(project, 'README.md') }, docs).kind).toBe('ask');
    expect(decide('Write', { file_path: join(project, '.env') }, docs).kind).toBe('ask');
    expect(decide('Write', { file_path: '/elsewhere/OVERVIEW.md' }, docs).kind).toBe('ask');
    expect(decide('Write', { file_path: join(project, 'OVERVIEW.md') }, { ...docs, speaker: 'member' as const }).kind).toBe('ask');
  });

  it("blocks Sunny's data folder only where a folder exposes it", () => {
    const data = join(base, 'data');
    mkdirSync(join(data, 'sunny', 'memory'), { recursive: true });
    expect(dataDenyRules(data, [base])).toEqual([`Read(/${data}/**)`]);
    // Sunny's own notes live inside the data folder: blocking it would hide them.
    expect(dataDenyRules(data, [cwd, join(data, 'sunny', 'memory')])).toEqual([]);
    expect(dataDenyRules(data, [cwd, project])).toEqual([]);
  });

  it('flags secret files', () => {
    expect(isSecretFile('/x/.env')).toBe(true);
    expect(isSecretFile('/x/.env.production')).toBe(true);
    expect(isSecretFile('/x/server.key')).toBe(true);
    expect(isSecretFile('/x/index.ts')).toBe(false);
    expect(decide('Read', { file_path: '/elsewhere/.env' }, ro())).toMatchObject({ kind: 'ask', reason: expect.stringContaining('may contain secrets') });
    expect(secretDenyRules(['/home/x'])).toContain('Read(//home/x/**/.env)');
  });

  it('runs allowed commands and pipelines, asks for anything else', () => {
    const patterns = ['df -h*', 'docker ps*', 'grep *', 'head -n *'];
    expect(commandAllowed('df -h', patterns)).toBe(true);
    expect(commandAllowed('docker  ps -a', patterns)).toBe(true);
    expect(commandAllowed('docker ps | grep db | head -n 5', patterns)).toBe(true);
    expect(commandAllowed('docker ps; rm -rf /', patterns)).toBe(false);
    expect(commandAllowed('docker ps && rm x', patterns)).toBe(false);
    expect(commandAllowed('docker ps $(rm x)', patterns)).toBe(false);
    expect(commandAllowed('docker ps > /etc/passwd', patterns)).toBe(false);
    expect(commandAllowed('docker ps | sh', patterns)).toBe(false);
    expect(commandAllowed('docker ps || true', patterns)).toBe(false);
    expect(commandAllowed('df -h\nrm x', patterns)).toBe(false);
    expect(decide('Bash', { command: 'df -h /' }, ctx({ access: { commands: ['df -h*'] } })).kind).toBe('allow');
    expect(decide('Bash', { command: 'rm -rf /' }, ctx({ access: { commands: ['df -h*'] } })).kind).toBe('ask');
  });
});

describe('who is asking', () => {
  const mutating = (t: string) => t === 'mcp__vps__restart' || t === 'mcp__vps__mute';

  it('asks before connector tools that change things, unless auto-approved', () => {
    expect(decide('mcp__vps__status', {}, { ...ctx(), isMutating: mutating }).kind).toBe('allow');
    expect(decide('mcp__vps__restart', {}, { ...ctx(), isMutating: mutating }).kind).toBe('ask');
    expect(decide('mcp__vps__mute', {}, { ...ctx({ access: { autoApprove: ['mcp__vps__mute'] } }), isMutating: mutating }).kind).toBe('allow');
  });

  it('never lets a guest skip approvals', () => {
    const guest = (extra: object) => ({ ...ctx(extra), speaker: 'member' as const, isMutating: mutating });
    expect(decide('mcp__vps__mute', {}, guest({ access: { autoApprove: ['mcp__vps__mute'] } })).kind).toBe('ask');
    expect(decide('Bash', { command: 'ls' }, guest({ access: { autoApprove: ['Bash'] } })).kind).toBe('ask');
    expect(decide('Read', { file_path: '/etc/passwd' }, guest({ access: { profile: 'full' } })).kind).toBe('ask');
    // Owner-curated read-only commands still run.
    expect(decide('Bash', { command: 'df -h' }, guest({ access: { commands: ['df -h'] } })).kind).toBe('allow');
    expect(decide('Read', { file_path: join(cwd, 'a') }, guest({})).kind).toBe('allow');
  });
});

describe('describeCall', () => {
  it('shortens connector tool names', () => {
    expect(describeCall('mcp__vps__restart', { target: 'pm2:x' })).toBe('vps.restart {"target":"pm2:x"}');
  });

  it('summarizes the interesting argument', () => {
    expect(describeCall('Bash', { command: 'rm -rf /tmp/x' })).toBe('Bash: rm -rf /tmp/x');
    expect(describeCall('TodoWrite', {})).toBe('TodoWrite');
  });
});
