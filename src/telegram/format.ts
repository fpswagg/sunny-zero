/**
 * Agents write Markdown; Telegram understands a small HTML subset (b, i, s, code, pre, a,
 * blockquote). These helpers convert one to the other and split long replies into messages.
 */

/** Telegram's limit is 4096 characters of visible text per message; keep a margin. */
export const MESSAGE_LIMIT = 3800;

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;

/** Bold, italic and strikethrough on already escaped text. */
function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=\S)\*(?![\w*])/g, '<i>$1</i>')
    .replace(/(?<!\w)_(?=[^\s_])([^_]+?)(?<=\S)_(?!\w)/g, '<i>$1</i>');
}

/** One line of inline Markdown: code spans and links are kept apart from emphasis. */
function inline(text: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|tg:\/\/|mailto:)[^\s)]+)\)/g, (_, label: string, url: string) =>
    keep(`<a href="${escapeHtml(url)}">${emphasis(escapeHtml(label))}</a>`),
  );
  s = emphasis(escapeHtml(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]!);
}

/** Converts Markdown to Telegram HTML. Unclosed code fences (a reply still streaming) run to the end. */
export function toTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;
      const code = escapeHtml(body.join('\n'));
      out.push(fence[2] ? `<pre><code class="language-${escapeHtml(fence[2])}">${code}</code></pre>` : `<pre>${code}</pre>`);
      continue;
    }

    // Tables keep their alignment in monospace.
    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(lines[i++]!);
      out.push(`<pre>${escapeHtml(rows.filter((r) => !TABLE_RULE.test(r)).join('\n'))}</pre>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(inline(lines[i++]!.replace(/^\s*>\s?/, '')));
      out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (heading) out.push(`<b>${inline(heading[1]!)}</b>`);
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push('──────────');
    else if (bullet) out.push(`${bullet[1]}• ${inline(bullet[2]!)}`);
    else out.push(inline(line));
    i++;
  }
  return out.join('\n');
}

/** Cuts one overlong line at a space when it can. */
function cutLine(line: string, max: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    const at = space > max / 2 ? space : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^ /, '');
  }
  parts.push(rest);
  return parts;
}

/**
 * Splits Markdown into pieces of at most `limit` characters on line boundaries. A code block
 * cut in two is closed at the end of one piece and reopened at the start of the next.
 */
export function splitMarkdown(md: string, limit = MESSAGE_LIMIT): string[] {
  if (md.length <= limit) return [md];
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  let open: { line: string; marker: string } | undefined;

  const flush = () => {
    if (open) current.push(open.marker);
    chunks.push(current.join('\n'));
    current = open ? [open.line] : [];
    length = open ? open.line.length + 1 : 0;
  };

  // Room for a reopened fence at the top and a closing one at the bottom.
  const room = limit - 40;
  for (const raw of md.split('\n')) {
    for (const line of cutLine(raw, room)) {
      if (length + line.length + 1 > room && current.length > (open ? 1 : 0)) flush();
      current.push(line);
      length += line.length + 1;
      const fence = FENCE.exec(line);
      if (!fence) continue;
      if (!open) open = { line, marker: fence[1]! };
      else if (!fence[2] && fence[1] === open.marker) open = undefined;
    }
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}
