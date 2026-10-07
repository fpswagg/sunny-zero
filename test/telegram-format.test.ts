import { describe, expect, it } from 'vitest';
import { splitMarkdown, toTelegramHtml } from '../src/telegram/format.ts';

describe('toTelegramHtml', () => {
  it('escapes HTML and converts emphasis', () => {
    expect(toTelegramHtml('a < b & **bold** *it* ~~gone~~')).toBe('a &lt; b &amp; <b>bold</b> <i>it</i> <s>gone</s>');
  });

  it('leaves snake_case and lone asterisks alone', () => {
    expect(toTelegramHtml('use my_var_name and 2 * 3 * 4')).toBe('use my_var_name and 2 * 3 * 4');
  });

  it('keeps code spans literal', () => {
    expect(toTelegramHtml('run `rm **x** <y>` now')).toBe('run <code>rm **x** &lt;y&gt;</code> now');
  });

  it('converts links with safe schemes only', () => {
    expect(toTelegramHtml('[docs](https://x.io/a?b=1&c="2")')).toBe('<a href="https://x.io/a?b=1&amp;c=&quot;2&quot;">docs</a>');
    expect(toTelegramHtml('[bad](javascript:alert(1))')).toBe('[bad](javascript:alert(1))');
  });

  it('renders headings, bullets, rules and quotes', () => {
    expect(toTelegramHtml('## Title\n- one\n  * two\n---\n> quoted\n> more')).toBe(
      '<b>Title</b>\n• one\n  • two\n──────────\n<blockquote>quoted\nmore</blockquote>',
    );
  });

  it('renders code blocks, closed or still streaming', () => {
    expect(toTelegramHtml('```ts\nconst a = 1 < 2;\n```\nafter')).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>\nafter');
    expect(toTelegramHtml('```\nhalf **done**')).toBe('<pre>half **done**</pre>');
  });

  it('puts tables in monospace without the rule row', () => {
    expect(toTelegramHtml('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('<pre>| a | b |\n| 1 | 2 |</pre>');
  });
});

describe('splitMarkdown', () => {
  it('returns short text as is', () => {
    expect(splitMarkdown('hello', 100)).toEqual(['hello']);
  });

  it('splits on lines and stays under the limit', () => {
    const md = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const chunks = splitMarkdown(md, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join('\n')).toBe(md);
  });

  it('closes and reopens a code block cut in two', () => {
    const md = ['intro', '```py', ...Array.from({ length: 30 }, (_, i) => `print(${i})  # ${'y'.repeat(10)}`), '```', 'outro'].join('\n');
    const chunks = splitMarkdown(md, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) expect(c.trimEnd().endsWith('```')).toBe(true);
    for (const c of chunks.slice(1)) expect(c.startsWith('```py')).toBe(true);
  });

  it('cuts a single huge line', () => {
    const chunks = splitMarkdown('word '.repeat(500), 300);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });
});
