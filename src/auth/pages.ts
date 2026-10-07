import { isSecretField } from './flows.ts';
import type { Field, Screen } from './types.ts';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

const STYLE = `
:root { --bg:#f4f4f7; --card:#fff; --text:#15151a; --muted:#6c6c78; --line:rgba(0,0,0,.08); --field:#f4f4f7; --accent:#f0a030; --accent-text:#1a1408; --error-bg:#fdecea; --error:#a4231b; --ok:#1d9a4f; color-scheme:light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b0b0f; --card:#14141a; --text:#f1f1f4; --muted:#9797a3; --line:rgba(255,255,255,.08); --field:#0e0e13; --accent:#f6b255; --accent-text:#1a1408; --error-bg:#3a1a17; --error:#ff9b91; --ok:#4fd88a; } }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; background:radial-gradient(110% 50% at 50% -10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 65%), var(--bg); color:var(--text); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
main { max-width:440px; margin:0 auto; padding:44px 16px; }
.brand { display:flex; align-items:center; gap:8px; font-weight:650; color:var(--muted); margin:0 4px 16px; }
.brand span { display:grid; place-items:center; width:30px; height:30px; border-radius:50%; background:var(--accent); color:var(--accent-text); font-size:16px; box-shadow:0 8px 20px -8px var(--accent); }
.brand small { margin-left:auto; font-weight:500; font-size:.8rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:22px; padding:26px 22px; box-shadow:0 24px 60px -30px rgba(0,0,0,.45); }
h1 { font-size:1.35rem; letter-spacing:-.01em; margin:0 0 8px; }
p { margin:0 0 12px; color:var(--muted); overflow-wrap:anywhere; }
label { display:block; font-weight:600; font-size:.95rem; margin:18px 0 6px; }
.help { font-size:.85rem; color:var(--muted); margin-top:5px; font-weight:400; }
input, textarea { width:100%; padding:12px 14px; font:inherit; color:var(--text); background:var(--field); border:1px solid var(--line); border-radius:12px; transition:border-color .2s, box-shadow .2s; }
input:focus, textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
button, .button { display:block; width:100%; margin-top:22px; padding:13px; font:inherit; font-weight:650; text-align:center; text-decoration:none; color:var(--accent-text); background:var(--accent); border:0; border-radius:14px; cursor:pointer; box-shadow:0 12px 28px -14px var(--accent); }
button:active, .button:active { transform:scale(.98); }
.error { background:var(--error-bg); color:var(--error); padding:11px 14px; border-radius:12px; margin:12px 0; }
.links a { color:var(--accent); }
.status { display:grid; place-items:center; width:56px; height:56px; border-radius:50%; font-size:1.6rem; margin-bottom:12px; background:color-mix(in srgb, var(--text) 8%, transparent); }
.ok { color:var(--ok); background:color-mix(in srgb, var(--ok) 15%, transparent); }
footer { margin-top:16px; font-size:.8rem; color:var(--muted); text-align:center; }
`;

function layout(title: string, body: string, footer = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Sunny</title><style>${STYLE}</style></head>
<body><main><div class="brand"><span>☀</span> Sunny<small>🔒 secure page</small></div><div class="card">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</main></body></html>`;
}

function field(f: Field): string {
  const secret = isSecretField(f);
  const id = `f-${esc(f.name)}`;
  const common = `id="${id}" name="${esc(f.name)}"${f.optional ? '' : ' required'}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`;
  const input =
    f.type === 'textarea'
      ? `<textarea ${common} rows="4">${secret ? '' : esc(f.value ?? '')}</textarea>`
      : `<input ${common} type="${secret ? 'password' : (f.type ?? 'text')}"${secret ? ' autocomplete="new-password"' : ` value="${esc(f.value ?? '')}"`}${f.type === 'tel' || f.name === 'code' ? ' inputmode="numeric" autocomplete="one-time-code"' : ''}>`;
  return `<label for="${id}">${esc(f.label)}${f.optional ? ' <span class="help">(optional)</span>' : ''}</label>${input}${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}`;
}

export function renderScreen(screen: Screen, action: string, expiresAt?: number): string {
  const expiry = expiresAt ? `This link works once and expires at ${new Date(expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (server time).` : '';
  switch (screen.kind) {
    case 'form': {
      const links = screen.links?.length
        ? `<p class="links">${screen.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join(' · ')}</p>`
        : '';
      return layout(
        screen.title,
        `<h1>${esc(screen.title)}</h1>${screen.description ? paragraphs(screen.description) : ''}${links}
${screen.error ? `<div class="error" role="alert">${esc(screen.error)}</div>` : ''}
<form method="post" action="${esc(action)}" autocomplete="off">${screen.fields.map(field).join('')}
<button type="submit">${esc(screen.submitLabel ?? 'Continue')}</button></form>`,
        expiry,
      );
    }
    case 'redirect':
      return layout(
        screen.title,
        `<h1>${esc(screen.title)}</h1>${screen.description ? paragraphs(screen.description) : ''}
${screen.error ? `<div class="error" role="alert">${esc(screen.error)}</div>` : ''}
<a class="button" href="${esc(screen.url)}" rel="noreferrer">${esc(screen.buttonLabel)}</a>`,
        expiry,
      );
    case 'done':
      return layout(screen.title, `<div class="status ok">✓</div><h1>${esc(screen.title)}</h1>${paragraphs(screen.message)}`);
    case 'failed':
      return layout(screen.title, `<div class="status">✕</div><h1>${esc(screen.title)}</h1>${paragraphs(screen.message)}`);
  }
}

export function renderExpired(): string {
  return layout('Link expired', `<h1>This link is no longer valid</h1><p>Auth links work once and expire after a few minutes. Ask Sunny for a new one.</p>`);
}
