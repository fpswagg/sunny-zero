/** Notion shapes <-> plain text, kept free of I/O so they are easy to test. */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const plain = (rich: Json[] | undefined): string => (rich ?? []).map((r) => r.plain_text ?? '').join('');

export function pageTitle(page: Json): string {
  for (const prop of Object.values<Json>(page.properties ?? {})) if (prop.type === 'title') return plain(prop.title);
  return '';
}

export function databaseTitle(db: Json): string {
  return plain(db.title);
}

/** A property value as a short readable value. */
export function propertyValue(p: Json): unknown {
  switch (p.type) {
    case 'title':
      return plain(p.title);
    case 'rich_text':
      return plain(p.rich_text);
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
      return p[p.type];
    case 'select':
    case 'status':
      return p[p.type]?.name ?? null;
    case 'multi_select':
      return (p.multi_select ?? []).map((o: Json) => o.name);
    case 'date':
      return p.date ? (p.date.end ? `${p.date.start} → ${p.date.end}` : p.date.start) : null;
    case 'people':
      return (p.people ?? []).map((u: Json) => u.name ?? u.id);
    case 'relation':
      return (p.relation ?? []).map((r: Json) => r.id);
    case 'formula':
      return p.formula?.[p.formula.type] ?? null;
    case 'rollup':
      return p.rollup?.[p.rollup.type] ?? null;
    case 'files':
      return (p.files ?? []).map((f: Json) => f.name);
    case 'created_time':
    case 'last_edited_time':
      return p[p.type];
    default:
      return null;
  }
}

export function pageSummary(page: Json) {
  const props: Record<string, unknown> = {};
  for (const [name, p] of Object.entries<Json>(page.properties ?? {})) {
    if (p.type === 'title') continue;
    const v = propertyValue(p);
    if (v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) props[name] = v;
  }
  return { id: page.id, title: pageTitle(page), url: page.url, archived: page.archived || undefined, properties: props };
}

export function databaseSummary(db: Json) {
  const properties: Record<string, string> = {};
  for (const [name, p] of Object.entries<Json>(db.properties ?? {})) {
    const options = (p[p.type]?.options ?? []).map((o: Json) => o.name);
    properties[name] = options.length ? `${p.type} (${options.join(', ')})` : p.type;
  }
  return { id: db.id, title: databaseTitle(db), url: db.url, properties };
}

/** One block as a line of markdown-ish text. Children are handled by the caller. */
export function blockText(b: Json, indent = 0): string {
  const pad = '  '.repeat(indent);
  const t = b.type as string;
  const body = b[t] ?? {};
  const text = plain(body.rich_text);
  switch (t) {
    case 'paragraph':
      return text ? pad + text : '';
    case 'heading_1':
      return `${pad}# ${text}`;
    case 'heading_2':
      return `${pad}## ${text}`;
    case 'heading_3':
      return `${pad}### ${text}`;
    case 'bulleted_list_item':
      return `${pad}- ${text}`;
    case 'numbered_list_item':
      return `${pad}1. ${text}`;
    case 'to_do':
      return `${pad}- [${body.checked ? 'x' : ' '}] ${text}`;
    case 'toggle':
      return `${pad}▸ ${text}`;
    case 'quote':
      return `${pad}> ${text}`;
    case 'callout':
      return `${pad}> ${body.icon?.emoji ?? '💡'} ${text}`;
    case 'code':
      return `${pad}\`\`\`${body.language ?? ''}\n${text}\n${pad}\`\`\``;
    case 'divider':
      return `${pad}---`;
    case 'child_page':
      return `${pad}[page] ${body.title} (${b.id})`;
    case 'child_database':
      return `${pad}[database] ${body.title} (${b.id})`;
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      return `${pad}${body.url ?? ''}`;
    case 'image':
    case 'file':
    case 'pdf':
    case 'video':
      return `${pad}[${t}] ${plain(body.caption) || body.name || ''} ${body.external?.url ?? body.file?.url ?? ''}`.trimEnd();
    case 'equation':
      return `${pad}${body.expression ?? ''}`;
    case 'table_row':
      return `${pad}| ${(body.cells ?? []).map((c: Json[]) => plain(c)).join(' | ')} |`;
    default:
      return text ? pad + text : `${pad}[${t}]`;
  }
}

export const BLOCK_TYPES = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'code', 'divider'] as const;
export type SimpleBlock = { type: (typeof BLOCK_TYPES)[number]; text?: string; checked?: boolean; language?: string };

/** Notion caps one rich_text item at 2000 characters. */
export function richText(text: string): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < Math.max(text.length, 1); i += 2000) out.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  return out;
}

export function toBlock(b: SimpleBlock): Json {
  if (b.type === 'divider') return { object: 'block', type: 'divider', divider: {} };
  const rt = richText(b.text ?? '');
  const body: Json = { rich_text: rt };
  if (b.type === 'to_do') body.checked = Boolean(b.checked);
  if (b.type === 'code') body.language = b.language ?? 'plain text';
  return { object: 'block', type: b.type, [b.type]: body };
}

/** Plain text with blank-line separated paragraphs and simple "# ", "- ", "1. " prefixes -> blocks. */
export function textToBlocks(text: string): SimpleBlock[] {
  const blocks: SimpleBlock[] = [];
  for (const line of text.split('\n')) {
    const l = line.trimEnd();
    if (!l.trim()) continue;
    let m: RegExpExecArray | null;
    if ((m = /^### (.*)/.exec(l))) blocks.push({ type: 'heading_3', text: m[1] });
    else if ((m = /^## (.*)/.exec(l))) blocks.push({ type: 'heading_2', text: m[1] });
    else if ((m = /^# (.*)/.exec(l))) blocks.push({ type: 'heading_1', text: m[1] });
    else if ((m = /^- \[( |x)\] (.*)/i.exec(l))) blocks.push({ type: 'to_do', text: m[2], checked: m[1]!.toLowerCase() === 'x' });
    else if ((m = /^[-*] (.*)/.exec(l))) blocks.push({ type: 'bulleted_list_item', text: m[1] });
    else if ((m = /^\d+\. (.*)/.exec(l))) blocks.push({ type: 'numbered_list_item', text: m[1] });
    else if ((m = /^> (.*)/.exec(l))) blocks.push({ type: 'quote', text: m[1] });
    else if (l === '---') blocks.push({ type: 'divider' });
    else blocks.push({ type: 'paragraph', text: l });
  }
  return blocks;
}

/**
 * Plain values ({"Status": "Done", "Tags": ["a","b"], "Due": "2026-10-10"}) -> Notion property
 * payloads, using the database schema for the types. An object value is passed through as-is.
 */
export function buildProperties(schema: Record<string, Json>, values: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [name, value] of Object.entries(values)) {
    const def = schema[name];
    if (!def) throw new Error(`No property "${name}" in this database. Available: ${Object.keys(schema).join(', ')}`);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[name] = value as Json;
      continue;
    }
    const arr = Array.isArray(value) ? value.map(String) : undefined;
    const str = value === null || value === undefined ? '' : String(value);
    switch (def.type) {
      case 'title':
        out[name] = { title: richText(str) };
        break;
      case 'rich_text':
        out[name] = { rich_text: richText(str) };
        break;
      case 'number': {
        const n = value === null || str === '' ? null : Number(str);
        if (n !== null && Number.isNaN(n)) throw new Error(`"${name}" needs a number, got "${str}"`);
        out[name] = { number: n };
        break;
      }
      case 'checkbox':
        out[name] = { checkbox: value === true || /^(true|yes|1|x)$/i.test(str) };
        break;
      case 'select':
        out[name] = { select: str ? { name: str } : null };
        break;
      case 'status':
        out[name] = { status: { name: str } };
        break;
      case 'multi_select':
        out[name] = { multi_select: (arr ?? (str ? str.split(',').map((s) => s.trim()) : [])).filter(Boolean).map((n) => ({ name: n })) };
        break;
      case 'date': {
        const [start, end] = str.split(/\s*(?:→|\.\.|\/)\s*/);
        out[name] = { date: start ? { start, ...(end ? { end } : {}) } : null };
        break;
      }
      case 'url':
      case 'email':
      case 'phone_number':
        out[name] = { [def.type]: str || null };
        break;
      case 'relation':
        out[name] = { relation: (arr ?? [str]).filter(Boolean).map((id) => ({ id })) };
        break;
      default:
        throw new Error(`Property "${name}" is of type ${def.type}, which cannot be set from plain text`);
    }
  }
  return out;
}
