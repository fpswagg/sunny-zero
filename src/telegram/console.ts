import { escapeHtml } from './format.ts';

/** One line of the live console card: a tool call or a status note. */
export interface ConsoleStep {
  agent: string;
  /** "Read: src/a.ts", "vps.status", "Bash: git status"... (describeCall), or a status text. */
  text: string;
  kind: 'tool' | 'status';
}

const MAX_SHOWN = 6;
const DETAIL_MAX = 72;

const ICONS: [RegExp, string][] = [
  [/^Read\b/, '📖'],
  [/^(Write|Edit|MultiEdit|NotebookEdit)\b/, '✏️'],
  [/^Bash\b/, '💻'],
  [/^(Grep|Glob)\b/, '🔎'],
  [/^(WebFetch|WebSearch)\b/, '🌐'],
  [/^TodoWrite\b/, '📝'],
  [/^(Task|Agent)\b/, '🤝'],
  [/^agents\./, '📨'],
  [/^chat\.send_voice\b/, '🎙'],
  [/^chat\./, '📎'],
  [/^vps\./, '🖥'],
  [/^notify\./, '🔔'],
  [/^sunny\./, '☀️'],
  [/^\w[\w-]*\./, '🔌'],
];

/** Splits "Read: src/a.ts" into a tool name and its detail. */
export function splitStep(text: string): { name: string; detail: string } {
  const m = /^([\w.-]+)(?::\s*|\s+)([\s\S]*)$/.exec(text);
  if (!m) return { name: text, detail: '' };
  return { name: m[1]!, detail: m[2]!.replace(/\s+/g, ' ').trim() };
}

export function iconOf(step: ConsoleStep): string {
  if (step.kind === 'status') return 'ℹ️';
  for (const [re, icon] of ICONS) if (re.test(step.text)) return icon;
  return '⚙️';
}

/** "42s", "1m05", "1h02" */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function stepLine(step: ConsoleStep, mark: string, lead: string): string {
  const who = step.agent !== lead ? `<i>${escapeHtml(step.agent)}</i> · ` : '';
  if (step.kind === 'status') return `${mark} ${iconOf(step)} ${who}<i>${escapeHtml(cut(step.text))}</i>`;
  const { name, detail } = splitStep(step.text);
  const shownName = name.replace(/^mcp__/, '');
  return `${mark} ${iconOf(step)} ${who}<b>${escapeHtml(shownName)}</b>${detail ? ` <code>${escapeHtml(cut(detail))}</code>` : ''}`;
}

const cut = (s: string) => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}…` : s);

/** The live card while an agent works: header with time and step count, the latest steps below. */
export function renderLive(lead: string, steps: ConsoleStep[], startedAt: number, now = Date.now()): string {
  const tools = steps.filter((s) => s.kind === 'tool').length;
  const header = `⏳ <b>${escapeHtml(lead)}</b> is working · ${elapsed(now - startedAt)}${tools ? ` · ${tools} step${tools > 1 ? 's' : ''}` : ''}`;
  if (!steps.length) return header;
  const shown = steps.slice(-MAX_SHOWN);
  const hidden = steps.length - shown.length;
  const lines = shown.map((s, i) => stepLine(s, i === shown.length - 1 ? '▸' : '✓', lead));
  if (hidden) lines.unshift(`<i>… ${hidden} earlier</i>`);
  return `${header}\n<blockquote>${lines.join('\n')}</blockquote>`;
}

/** What stays once the turn ends: one compact line, all steps folded in an expandable quote. */
export function renderDone(lead: string, steps: ConsoleStep[], startedAt: number, ok: boolean, now = Date.now()): string {
  const tools = steps.filter((s) => s.kind === 'tool').length;
  const header = `${ok ? '✅' : '⚠️'} <b>${escapeHtml(lead)}</b> · ${tools} step${tools === 1 ? '' : 's'} · ${elapsed(now - startedAt)}`;
  const all = steps.slice(-25);
  const lines = all.map((s) => stepLine(s, '·', lead));
  if (steps.length > all.length) lines.unshift(`<i>… ${steps.length - all.length} earlier</i>`);
  return lines.length ? `${header}\n<blockquote expandable>${lines.join('\n')}</blockquote>` : header;
}
