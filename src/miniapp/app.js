// Sunny's agent manager: a Telegram Mini App with Telegram's native look (theme, back and main
// buttons, popups, haptics). Plain browser JavaScript, served as is. Text always goes in through
// textContent, never as HTML.

const tg = window.Telegram?.WebApp;
const inTelegram = !!tg?.initData;
const root = document.documentElement;
const can = (version) => !!tg?.isVersionAtLeast?.(version);

if (inTelegram) {
  root.classList.add('tg');
  root.classList.add(/android/.test(tg.platform) ? 'android' : tg.platform || 'web');
  tg.ready();
  tg.expand();
  if (can('6.1')) {
    tg.setHeaderColor('secondary_bg_color');
    tg.setBackgroundColor('secondary_bg_color');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const plain = (s) => String(s ?? '').replace(/\*\*|`|_(?=\S)|(?<=\S)_/g, '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const refOf = (provider, model) => (!provider || provider === 'claude' ? model : `${provider}:${model}`);
const money = (usd) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(3)}` : '$0');
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
const ago = (iso) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
};
const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(text) {
  toastEl.textContent = plain(text);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function haptic(kind) {
  if (!can('6.1')) return;
  try {
    if (kind === 'select') tg.HapticFeedback.selectionChanged();
    else if (kind === 'success' || kind === 'error' || kind === 'warning') tg.HapticFeedback.notificationOccurred(kind);
    else tg.HapticFeedback.impactOccurred(kind || 'light');
  } catch {
    /* not supported */
  }
}

// Native popups (Telegram limits a popup message to 256 characters).
function alertBox(message) {
  return new Promise((resolve) => (can('6.2') ? tg.showAlert(clip(plain(message), 256), resolve) : (alert(plain(message)), resolve())));
}
function confirmBox(message) {
  return new Promise((resolve) => (can('6.2') ? tg.showConfirm(clip(plain(message), 256), resolve) : resolve(confirm(plain(message)))));
}
function popup(title, message, buttons) {
  return new Promise((resolve) => {
    if (!can('6.2')) {
      const first = buttons.find((b) => b.type !== 'cancel');
      return resolve(first && confirm(`${title}\n\n${message}`) ? first.id : null);
    }
    tg.showPopup({ title: clip(title, 64), message: clip(plain(message), 256), buttons }, (id) => resolve(id || null));
  });
}

function fail(err) {
  haptic('error');
  alertBox(err?.message || String(err));
}

function openLink(url) {
  if (inTelegram) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

// ── API ─────────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`/app/api${path}`, {
    method,
    headers: { authorization: `tma ${tg?.initData ?? ''}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Calls once; when the server asks to confirm new privileges, asks the owner and repeats with confirm: true. */
async function withConfirm(call) {
  try {
    return await call(false);
  } catch (err) {
    if (err.status !== 409 || !err.data?.confirm) throw err;
    haptic('warning');
    const ok = await confirmBox(`${err.message}?\n\n${err.data.confirm.map((r) => `• ${r}`).join('\n')}`);
    return ok ? call(true) : undefined;
  }
}

// ── State ───────────────────────────────────────────────────────────────────────

const S = {
  boot: null,
  details: new Map(),
  icons: new Map(),
  models: new Map(),
  /** Provider picked on a model page, per target. */
  picked: new Map(),
  usageDays: 7,
  usageHours: 24,
  modelLimit: 60,
  /** Asked before leaving a page with unsaved edits. */
  dirty: null,
  connecting: false,
};

async function loadBoot() {
  S.boot = await api('GET', '/bootstrap');
}
const agentView = (name) => S.boot.agents.find((a) => a.name === name);
function putAgent(view) {
  if (!view) return;
  const i = S.boot.agents.findIndex((a) => a.name === view.name);
  if (i >= 0) S.boot.agents[i] = { ...S.boot.agents[i], ...view, prompt: undefined };
  S.details.delete(view.name);
}
async function details(name) {
  if (!S.details.has(name)) S.details.set(name, await api('GET', `/agents/${encodeURIComponent(name)}`));
  return S.details.get(name);
}

function loadIcon(name, fresh = false) {
  if (fresh) S.icons.delete(name);
  if (!S.icons.has(name)) {
    S.icons.set(
      name,
      fetch(`/app/api/agents/${encodeURIComponent(name)}/icon${fresh ? `?v=${Date.now()}` : ''}`, { headers: { authorization: `tma ${tg?.initData ?? ''}` } })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : null))
        .catch(() => null),
    );
  }
  return S.icons.get(name);
}

// ── Components ──────────────────────────────────────────────────────────────────

function avatar(name, cls = '') {
  const accent = S.boot?.agents?.find((a) => a.name === name)?.accent;
  const el = h('div', { class: `avatar ${cls}`, 'aria-hidden': 'true', style: accent ? `--agent:${accent}` : undefined }, name[0].toUpperCase());
  loadIcon(name).then((url) => {
    if (url) el.replaceChildren(h('img', { src: url, alt: '' }));
  });
  return el;
}

// Line icons (24×24, drawn in white): fonts do not carry the same symbols everywhere.
const ICONS = {
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  chart: 'M5 20V11M12 20V4M19 20v-7',
  chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  gauge: 'M4.5 17.5a9 9 0 1 1 15 0M12 13l4-4',
  play: 'M8 5v14l11-7z',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  info: 'M12 11v6M12 7.5v.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  wrench: 'M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z',
  memory: 'M5 6c0-1.7 3-3 7-3s7 1.3 7 3-3 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3 3 7 3s7-1.3 7-3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  send: 'M21 3 10 14M21 3l-6.5 18-4.5-7-7-4.5z',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.3M15.5 4.2a3.5 3.5 0 0 1 0 6.6',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0',
  mic: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v4M8 22h8',
};
const SVG = 'http://www.w3.org/2000/svg';
function glyph(name, color) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.info);
  const filled = name === 'play' || name === 'bolt' || name === 'star';
  path.setAttribute('fill', filled ? '#fff' : 'none');
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', filled ? '1' : '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return h('div', { class: 'icon', style: `background:${color}` }, svg);
}
const initial = (letter, color) => h('div', { class: 'icon', style: `background:${color}` }, h('b', { style: 'font-size:15px' }, letter));

const PROVIDER_ICON = {
  claude: ['C', '#d97757'],
  anthropic: ['A', '#b6603f'],
  openai: ['O', '#10a37f'],
  gemini: ['G', '#4285f4'],
  kimi: ['K', '#16191f'],
  openrouter: ['R', '#6467f2'],
};
const providerIcon = (id) => {
  const [letter, color] = PROVIDER_ICON[id] ?? ['?', '#8e8e93'];
  return initial(letter, color);
};

function cell(o) {
  const clickable = !!o.onClick;
  const classes = ['cell', o.nav && 'nav', o.cls, o.icon && 'has-icon', o.avatar && 'has-avatar', o.selected && 'selected'].filter(Boolean).join(' ');
  const el = h(
    clickable ? 'button' : 'div',
    { class: classes, type: clickable ? 'button' : undefined, onclick: o.onClick },
    o.icon,
    o.avatar,
    h(
      'div',
      { class: 'cell-body' },
      h('div', { class: `cell-title${o.wrap ? ' wrap' : ''}` }, o.title, o.badge),
      o.subtitle ? h('div', { class: `cell-subtitle${o.wrap ? ' wrap' : ''}` }, o.subtitle) : null,
    ),
    o.value !== undefined && o.value !== null ? h('div', { class: 'cell-value' }, o.value) : null,
    o.right,
  );
  return el;
}

function switchCell(o) {
  const input = h('input', { type: 'checkbox', checked: !!o.checked, disabled: !!o.disabled, 'aria-label': o.title });
  input.addEventListener('change', async () => {
    haptic('select');
    input.disabled = true;
    try {
      const ok = await o.onChange(input.checked);
      if (ok === false) input.checked = !input.checked;
    } catch (err) {
      input.checked = !input.checked;
      fail(err);
    } finally {
      input.disabled = !!o.disabled;
    }
  });
  return cell({ ...o, right: h('label', { class: 'switch' }, input, h('span')) });
}

const badge = (text, cls = '') => h('span', { class: `badge ${cls}` }, text);

function section(header, cells, footer) {
  const list = cells.flat().filter(Boolean);
  return [
    header ? (header instanceof Node ? header : h('div', { class: 'section-header' }, header)) : h('div', { class: 'gap' }),
    list.length ? h('div', { class: 'section' }, list) : null,
    footer ? h('div', { class: 'section-footer' }, footer) : null,
  ];
}

function hero(name, title, subtitle, chip, actions) {
  const accent = S.boot?.agents?.find((a) => a.name === name)?.accent;
  const editable = S.boot?.agents?.find((a) => a.name === name)?.isSunny === false;
  const pic = avatar(name, 'lg');
  const face = editable
    ? h('button', { type: 'button', class: 'avatar-edit', 'aria-label': 'Change icon', onclick: () => go(`/agent/${name}/icon`) }, pic, h('span', { class: 'avatar-pen' }, '✎'))
    : pic;
  return h('div', { class: `hero${accent ? ' tinted' : ''}`, style: accent ? `--agent:${accent}` : undefined }, face, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null, chip, actions);
}

/** The agent's own app (chat and voice call), same origin: the Telegram sign-in carries over. */
function openAgentApp(name) {
  sessionStorage.setItem('sunny_from_manager', '1');
  location.href = `/a/${encodeURIComponent(name)}/`;
}

const empty = (title, text, action) => h('div', { class: 'empty' }, h('b', {}, title), text, action ? h('div', { style: 'margin-top:16px' }, action) : null);

// ── Main button (Telegram) or a plain button (browser preview) ─────────────────

let mainHandler = null;
let mainFallback = null;
function setMain(text, onClick) {
  const run = async () => {
    if (inTelegram) tg.MainButton.showProgress(false);
    try {
      await onClick();
    } catch (err) {
      fail(err);
    } finally {
      if (inTelegram) tg.MainButton.hideProgress();
    }
  };
  if (inTelegram) {
    if (mainHandler) tg.MainButton.offClick(mainHandler);
    mainHandler = run;
    tg.MainButton.setParams({ text, is_visible: true, is_active: true });
    tg.MainButton.onClick(mainHandler);
  } else {
    mainFallback?.remove();
    mainFallback = h('div', { class: 'section', style: 'margin-top:20px' }, cell({ title: text, cls: 'action', onClick: run }));
    document.querySelector('.page')?.append(mainFallback);
  }
}
function hideMain() {
  if (inTelegram) {
    if (mainHandler) tg.MainButton.offClick(mainHandler);
    mainHandler = null;
    tg.MainButton.hide();
  }
  mainFallback?.remove();
  mainFallback = null;
}

// ── Router ──────────────────────────────────────────────────────────────────────

const stack = [];
let renderToken = 0;

function go(path) {
  stack.push(path);
  haptic('light');
  render(false);
}
async function back() {
  if (S.dirty && !(await confirmBox('Discard your changes?'))) return;
  S.dirty = null;
  if (stack.length > 1) {
    stack.pop();
    render(true);
  } else if (inTelegram) {
    tg.close();
  }
}
if (can('6.1')) tg.BackButton.onClick(back);

async function render(backwards = false, keepScroll = false) {
  const token = ++renderToken;
  const path = stack[stack.length - 1];
  const scroll = keepScroll ? window.scrollY : 0;
  hideMain();
  S.dirty = null;
  if (can('6.1')) stack.length > 1 ? tg.BackButton.show() : tg.BackButton.hide();
  const page = h('div', { class: `page${backwards ? ' back' : ''}` });
  if (keepScroll) page.style.animation = 'none';
  if (stack.length > 1) page.append(h('button', { class: 'webback', onclick: back }, '‹ Back'));
  const slow = setTimeout(() => token === renderToken && app.replaceChildren(h('div', { class: 'skeleton' }, h('div'), h('div'), h('div'))), 150);
  let nodes;
  try {
    nodes = await route(path);
  } catch (err) {
    nodes = [empty('Something went wrong', err.message, h('button', { class: 'presets', onclick: () => render() }, 'Try again'))];
  }
  clearTimeout(slow);
  if (token !== renderToken) return;
  page.append(...[nodes].flat(Infinity).filter(Boolean));
  app.replaceChildren(page);
  if (mainFallback) page.append(mainFallback);
  window.scrollTo(0, scroll);
}
/** Re-renders the current page in place. */
const refresh = () => render(false, true);

const app = document.getElementById('app');

function route(path) {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return homePage();
  const [head, name, sub, extra] = parts;
  if (head === 'budgets') return budgetsPage();
  if (head === 'hub') return hubPage();
  if (head === 'activity') return activityPage(name);
  if (head === 'agent' && name) {
    if (!agentView(name)) return [empty('Not found', `There is no agent named "${name}".`)];
    switch (sub) {
      case undefined:
        return agentPage(name);
      case 'model':
        return modelPage(name);
      case 'effort':
        return effortPage(name);
      case 'fallbacks':
        return fallbacksPage(name);
      case 'fallback-add':
        return modelPage(name, true);
      case 'icon':
        return iconPage(name);
      case 'color':
        return colorPage(name);
      case 'prompt':
        return promptPage(name);
      case 'description':
        return descriptionPage(name);
      case 'tools':
        return toolsPage(name);
      case 'memory':
        return memoryPage(name);
      case 'voice':
        return voicePage(name);
      case 'triggers':
        return extra === 'new' ? newSchedulePage(name) : triggersPage(name);
      case 'guests':
        return guestsPage(name);
      case 'runs':
        return runsPage(name);
    }
  }
  if (head === 'connectors') return connectorsPage();
  if (head === 'connector' && name) return connectorPage(name);
  if (head === 'providers') return providersPage();
  if (head === 'provider' && name) return providerPage(name);
  if (head === 'usage') return usagePage();
  if (head === 'voice') return voiceProvidersPage();
  if (head === 'settings') return sub === 'model' || name === 'model' ? modelPage('#default') : name === 'effort' ? effortPage('#default') : settingsPage();
  return [empty('Not found', path)];
}

// ── Pages: home ─────────────────────────────────────────────────────────────────

function agentSubtitle(a) {
  return `${a.modelRef}${a.effort ? ` · ${a.effort}` : ''}`;
}

async function homePage() {
  const { providers, defaults } = S.boot;
  const hubOrder = S.boot.hub?.order ?? [];
  // Same order as the hub; the main agent (the one the hub opens on) is marked.
  const agents = [...S.boot.agents].sort((a, b) => (hubOrder.indexOf(a.name) + 1 || 1e6) - (hubOrder.indexOf(b.name) + 1 || 1e6));
  const connected = providers.filter((p) => p.connected).length;
  const usageCell = cell({ icon: glyph('chart', '#ff9500'), title: 'Usage', value: '', nav: true, onClick: () => go('/usage') });
  api('GET', '/limits')
    .then(({ subscription }) => {
      if (!subscription.ok || !subscription.windows.length) throw new Error('no limits');
      const short = (w) => `${w.kind.startsWith('session') || w.kind === 'five_hour' ? 'Session' : 'Week'} ${Math.round(w.percent)}%`;
      usageCell.querySelector('.cell-value').textContent = subscription.windows.slice(0, 2).map(short).join(' · ');
    })
    .catch(() =>
      api('GET', '/usage?days=7')
        .then(({ rows }) => {
          const cost = rows.reduce((s, r) => s + r.costUsd, 0);
          const runs = rows.reduce((s, r) => s + r.runs, 0);
          usageCell.querySelector('.cell-value').textContent = `${runs} runs · ${money(cost)}`;
        })
        .catch(() => {}),
    );
  return [
    section(
      'Agents',
      agents.map((a) =>
        cell({
          avatar: avatar(a.name, a.enabled ? '' : 'dim'),
          title: a.name,
          badge: [a.isSunny ? badge('built in', 'accent') : null, S.boot.hub?.main === a.name ? badge('main', 'accent') : null, !a.enabled ? badge('paused') : null, !a.ready ? badge('no key', 'warn') : null],
          subtitle: agentSubtitle(a),
          nav: true,
          onClick: () => go(`/agent/${a.name}`),
        }),
      ),
      'New agents are created by asking Sunny in chat.',
    ),
    section('Hub', [cell({ icon: glyph('star', '#ff9500'), title: 'Order & main agent', subtitle: 'How the agents are lined up in the hub app', value: S.boot.hub?.main ?? '', nav: true, onClick: () => go('/hub') })]),
    section('Models', [
      cell({ icon: glyph('bolt', '#5856d6'), title: 'Providers', value: `${connected} of ${providers.length}`, nav: true, onClick: () => go('/providers') }),
      cell({ icon: glyph('star', '#34c759'), title: 'New agents', value: refOf(defaults.provider, defaults.model), nav: true, onClick: () => go('/settings') }),
    ]),
    section('Connectors', [
      cell({ icon: glyph('wrench', '#007aff'), title: 'Connectors', subtitle: 'Notion, X, Gmail, GitHub, Spotify…', value: `${S.boot.connectors.filter((c) => c.ready).length} of ${S.boot.connectors.length} ready`, nav: true, onClick: () => go('/connectors') }),
    ]),
    section('Activity', [usageCell]),
    (() => {
      const voiceCell = cell({ icon: glyph('mic', '#5856d6'), title: 'Voice providers', value: '', nav: true, onClick: () => go('/voice') });
      api('GET', '/voice')
        .then(({ engines }) => {
          voiceCell.querySelector('.cell-value').textContent = engines.length ? `${engines.length} connected` : 'Not connected';
        })
        .catch(() => {});
      return section('Voice', [voiceCell]);
    })(),
  ];
}

// ── Pages: agent ────────────────────────────────────────────────────────────────

const SESSION_INFO = {
  conversation: ['Per chat', 'One history per chat; background runs start fresh'],
  shared: ['Shared', 'One history across all chats and runs (guests get their own)'],
  none: ['None', 'Every message starts fresh'],
};

function voiceSummary(a) {
  const r = a.voice?.reply ?? 'auto';
  const mode = r === 'auto' ? 'Auto' : r === 'always' ? 'Always' : 'Off';
  const names = { elevenlabs: 'ElevenLabs', gemini: 'Gemini', openai: 'OpenAI' };
  return a.voice?.provider ? `${mode} · ${names[a.voice.provider] ?? a.voice.provider}` : mode;
}

function triggerSummary(a) {
  const crons = a.triggers.filter((t) => t.type === 'cron').length;
  const events = a.triggers.filter((t) => t.type === 'event').length;
  return [crons && `${crons} timed`, events && `${events} event${events > 1 ? 's' : ''}`].filter(Boolean).join(' · ') || 'None';
}

async function testModel(name, cellEl) {
  cellEl.classList.add('busy');
  try {
    const r = await api('POST', `/agents/${encodeURIComponent(name)}/test`, {});
    haptic(r.isError ? 'error' : 'success');
    const stats = [`${(r.durationMs / 1000).toFixed(1)}s`, r.outputTokens !== undefined ? `${r.inputTokens ?? 0}→${r.outputTokens} tokens` : '', r.costUsd ? money(r.costUsd) : ''].filter(Boolean).join(' · ');
    await popup(r.isError ? 'Model failed' : 'Model works', `${r.modelRef} · ${stats}\n\n${r.text}`, [{ type: 'ok' }]);
  } catch (err) {
    fail(err);
  } finally {
    cellEl.classList.remove('busy');
  }
}

async function botAction(a) {
  if (a.bot.username) {
    const choice = await popup(`@${a.bot.username}`, `${a.name}'s own Telegram bot. People you give access talk to it directly.`, [
      { id: 'open', type: 'default', text: 'Open chat' },
      { id: 'remove', type: 'destructive', text: 'Remove bot' },
      { type: 'cancel' },
    ]);
    if (choice === 'open') tg?.openTelegramLink ? tg.openTelegramLink(`https://t.me/${a.bot.username}`) : openLink(`https://t.me/${a.bot.username}`);
    if (choice === 'remove' && (await confirmBox(`Remove @${a.bot.username}? People will reach ${a.name} through Sunny's bot only.`))) {
      const r = await api('DELETE', `/agents/${a.name}/bot`);
      putAgent(r.agent);
      toast('Bot removed');
      refresh();
    }
    return;
  }
  await api('POST', `/agents/${a.name}/bot`);
  haptic('success');
  await alertBox(`Create the bot with @BotFather (/newbot), then paste its token on the secure page Sunny just sent to your chat. Sunny sets ${a.name}'s name, description and picture.`);
}

async function agentPage(name) {
  const d = await details(name);
  const a = { ...agentView(name), ...d.agent };
  const usage = d.usage.reduce((s, r) => ({ runs: s.runs + r.runs, cost: s.cost + r.costUsd }), { runs: 0, cost: 0 });
  const testCell = cell({ icon: glyph('play', '#34c759'), title: 'Test model', cls: 'action', value: '', onClick: () => testModel(name, testCell) });
  const out = [
    hero(
      name,
      name,
      a.description,
      a.isSunny ? h('span', { class: 'chip on' }, 'Built in') : h('span', { class: `chip ${a.enabled ? 'on' : ''}` }, a.enabled ? 'Active' : 'Paused'),
      a.enabled || a.isSunny ? h('button', { class: 'hero-btn', type: 'button', onclick: () => openAgentApp(name) }, 'Chat & call') : null,
    ),
  ];
  if (!a.isSunny) {
    out.push(
      section(null, [
        switchCell({
          title: 'Active',
          subtitle: 'Answers messages and runs its schedules',
          checked: a.enabled,
          onChange: async (on) => {
            const r = await api('POST', `/agents/${name}/enabled`, { enabled: on });
            putAgent(r.agent);
            toast(r.message);
            refresh();
          },
        }),
      ]),
    );
  }
  if (!a.isSunny) {
    out.push(
      section('Look', [
        cell({ avatar: avatar(name), title: 'Icon', subtitle: 'Also the picture of its Telegram bot', nav: true, onClick: () => go(`/agent/${name}/icon`) }),
        cell({ icon: h('div', { class: 'icon', style: `background:${a.accent}` }), title: 'Colour', value: a.accent, subtitle: 'Tints its app and this page', nav: true, onClick: () => go(`/agent/${name}/color`) }),
      ]),
    );
  }
  out.push(
    section(
      'Brain',
      [
        cell({
          icon: providerIcon(a.provider),
          title: 'Model',
          value: a.model,
          subtitle: a.ready ? a.providerName : `${a.providerName}: not connected`,
          nav: true,
          onClick: () => go(`/agent/${name}/model`),
        }),
        cell({ icon: glyph('gauge', '#af52de'), title: 'Effort', value: a.effort ?? 'Default', nav: true, onClick: () => go(`/agent/${name}/effort`) }),
        cell({ icon: glyph('chart', '#ff9500'), title: 'Daily budget', value: (() => { const b = S.boot.budgets?.[name] ?? S.boot.budgets?.['*']; return b?.dailyUsd ? `${usd(b.dailyUsd)}/day` : 'None'; })(), subtitle: S.boot.budgets?.[name]?.spent ? `Spent today ${usd(S.boot.budgets[name].spent)}` : undefined, nav: true, onClick: () => go('/budgets') }),
        a.isSunny ? null : cell({ icon: glyph('bolt', '#ff9500'), title: 'Fallbacks', value: a.fallbackModels?.length ? `${a.fallbackModels.length}` : 'None', subtitle: a.fallbackModels?.length ? a.fallbackModels.join(' → ') : 'Backup models when this one is unavailable', nav: true, onClick: () => go(`/agent/${name}/fallbacks`) }),
        testCell,
      ],
      a.ready ? null : `Runs fail until ${a.providerName} is connected or the model is changed.`,
    ),
  );
  if (!a.isSunny) {
    out.push(
      section('Behaviour', [
        cell({ icon: glyph('pencil', '#ff9500'), title: 'Instructions', subtitle: (a.prompt ?? '').split('\n').find((l) => l.trim()) ?? 'No prompt', nav: true, onClick: () => go(`/agent/${name}/prompt`) }),
        cell({ icon: glyph('info', '#8e8e93'), title: 'Description', subtitle: a.description, nav: true, onClick: () => go(`/agent/${name}/description`) }),
        cell({ icon: glyph('wrench', '#007aff'), title: 'Tools & connectors', value: `${a.tools.length + a.connectors.length}`, nav: true, onClick: () => go(`/agent/${name}/tools`) }),
        cell({ icon: glyph('memory', '#ff2d55'), title: 'Memory', value: `${SESSION_INFO[a.memory.session][0]}${a.memory.notes ? ' + notes' : ''}`, nav: true, onClick: () => go(`/agent/${name}/memory`) }),
        cell({ icon: glyph('mic', '#5856d6'), title: 'Voice', value: voiceSummary(a), nav: true, onClick: () => go(`/agent/${name}/voice`) }),
        cell({ icon: glyph('clock', '#ff3b30'), title: 'Schedules', value: triggerSummary(a), nav: true, onClick: () => go(`/agent/${name}/triggers`) }),
      ]),
      section('People', [
        cell({ icon: glyph('send', '#2aabee'), title: 'Telegram bot', value: a.bot.username ? `@${a.bot.username}` : a.bot.stored ? 'Not running' : 'Set up', nav: true, onClick: () => botAction(a).catch(fail) }),
        cell({ icon: glyph('users', '#5ac8fa'), title: 'Guests', value: a.guests.length ? a.guests.map((g) => g.name).join(', ') : 'Only you', nav: true, onClick: () => go(`/agent/${name}/guests`) }),
      ]),
      section(
        'Access',
        (a.privileges.length ? a.privileges : ['Restricted: its own folder; anything else asks you']).map((p) => cell({ title: p, wrap: true })),
        'Ask Sunny in chat to change folders, allowed commands or approvals: new access always asks you first.',
      ),
    );
  }
  out.push(
    section(
      'Telegram & voice',
      [
        switchCell({
          title: 'Live progress card',
          subtitle: a.consoleOwn === undefined ? `Following the global setting (${S.boot.consoleGlobal ? 'on' : 'off'})` : 'Steps shown while it works. Own setting.',
          checked: a.consoleOwn ?? S.boot.consoleGlobal,
          onChange: async (on) => {
            await setAgentPref(name, { console: on });
          },
        }),
        switchCell({
          title: 'Light model for voice',
          subtitle: a.voiceLightOwn === undefined ? `Following the global setting (${S.boot.voiceLight ? 'on' : 'off'})` : 'Voice messages and calls run on a cheaper model. Own setting.',
          checked: a.voiceLightOwn ?? S.boot.voiceLight,
          onChange: async (on) => {
            await setAgentPref(name, { voiceLight: on });
          },
        }),
        a.consoleOwn !== undefined || a.voiceLightOwn !== undefined
          ? cell({ title: 'Follow global settings', subtitle: 'Drop this agent’s own switches', onClick: async () => { await setAgentPref(name, { console: null, voiceLight: null }); render(false, true); } })
          : null,
      ],
    ),
    section('Activity', [
      ...d.runs.slice(0, 3).map((r) => runCell(r)),
      cell({ title: 'All runs', value: `${usage.runs} in 30 days · ${money(usage.cost)}`, nav: true, onClick: () => go(`/agent/${name}/runs`) }),
    ]),
  );
  out.push(
    section(null, [
      cell({
        title: 'Forget conversations',
        cls: 'action',
        onClick: async () => {
          if (!(await confirmBox(`Forget all of ${name}'s conversations? Its notes are kept.`))) return;
          const r = await api('POST', `/agents/${name}/reset`).catch(fail);
          if (r) toast(r.message);
        },
      }),
      a.isSunny
        ? null
        : cell({
            title: 'Delete agent',
            cls: 'destructive',
            onClick: async () => {
              haptic('warning');
              if (!(await confirmBox(`Delete ${name}? Its bot and guests' access go too. Files are kept in the trash.`))) return;
              try {
                await api('DELETE', `/agents/${name}`, { confirm: true });
                haptic('success');
                await loadBoot();
                stack.length = 1;
                render(true);
                toast(`${name} deleted`);
              } catch (err) {
                fail(err);
              }
            },
          }),
    ]),
  );
  return out;
}

function runCell(r) {
  return cell({
    icon: h('span', { class: `dot ${r.isError ? 'err' : 'on'}` }),
    title: `${ago(r.at)} · ${r.origin}`,
    subtitle: r.message.replace(/\s+/g, ' '),
    value: r.costUsd ? money(r.costUsd) : `${Math.round(r.durationMs / 1000)}s`,
    onClick: () =>
      popup(
        `${r.isError ? 'Failed' : 'Run'} · ${when(r.at)}`,
        `${r.model ? `${r.model} · ` : ''}${Math.round(r.durationMs / 1000)}s${r.outputTokens ? ` · ${tokens(r.inputTokens ?? 0)}→${tokens(r.outputTokens)}` : ''}\n\n› ${clip(r.message, 90)}\n\n${clip(r.reply, 120)}`,
        [{ type: 'close' }],
      ),
  });
}

// ── Pages: model and effort ─────────────────────────────────────────────────────

async function modelsOf(provider, refreshList = false) {
  if (refreshList || !S.models.has(provider)) S.models.set(provider, api('GET', `/providers/${provider}/models${refreshList ? '?refresh=1' : ''}`).then((r) => r.models));
  try {
    return await S.models.get(provider);
  } catch (err) {
    S.models.delete(provider);
    throw err;
  }
}

async function connectProvider(id) {
  try {
    const { url, code } = await api('POST', `/providers/${id}/connect`);
    S.connecting = true;
    if (code) {
      await alertBox(`Open the ChatGPT page and enter this code:\n\n${code}\n\n(valid 15 minutes; also sent to your chat)`);
      openLink(url);
      return;
    }
    openLink(url);
    toast('Paste the key on the secure page. The link is in your chat too.');
  } catch (err) {
    fail(err);
  }
}
// Back from the secure key page: pick up the new provider.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.connecting) return;
  S.connecting = false;
  try {
    await loadBoot();
    S.models.clear();
    refresh();
  } catch {
    /* keep the old state */
  }
});

// Backup models: tried in order when the main one hits a limit, a quota or is down.
async function saveFallbacks(name, models) {
  const r = await api('POST', `/agents/${encodeURIComponent(name)}/fallbacks`, { models });
  putAgent(r.agent);
  const v = agentView(name);
  if (v && r.agent) v.fallbackModels = r.agent.fallbackModels;
  return r;
}

async function fallbacksPage(name) {
  const a = agentView(name);
  const list = a.fallbackModels ?? [];
  const run = async (models, msg) => {
    try {
      await saveFallbacks(name, models);
      haptic('success');
      if (msg) toast(msg);
      refresh();
    } catch (err) {
      fail(err);
    }
  };
  const btn = (label, title, disabled, fn) =>
    h('button', { type: 'button', title, 'aria-label': title, disabled: disabled || undefined, style: `padding:6px 9px;border-radius:8px;font-size:15px;${disabled ? 'opacity:.3' : ''}`, onclick: (e) => { e.stopPropagation(); if (!disabled) fn(); } }, label);
  const cells = list.map((ref, i) =>
    cell({
      icon: providerIcon(ref.includes(':') ? ref.split(':')[0] : 'claude'),
      title: ref,
      subtitle: i === 0 ? `Tried first when ${a.modelRef} fails` : `Tried after ${list[i - 1]}`,
      right: h(
        'div',
        { style: 'display:flex;gap:2px;margin-left:8px' },
        btn('↑', 'Move up', i === 0, () => { const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; run(n); }),
        btn('↓', 'Move down', i === list.length - 1, () => { const n = [...list]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; run(n); }),
        btn('✕', 'Remove', false, async () => { if (await confirmBox(`Remove ${ref} from ${name}’s fallbacks?`)) run(list.filter((_, k) => k !== i), 'Removed'); }),
      ),
    }),
  );
  return [
    section('Main model', [cell({ icon: providerIcon(a.provider), title: a.modelRef, subtitle: 'Used first' })]),
    section(
      'Fallbacks',
      [...cells, list.length >= 5 ? null : cell({ title: list.length ? 'Add another fallback' : 'Add a fallback model', cls: 'action', onClick: () => go(`/agent/${name}/fallback-add`) })],
      list.length
        ? 'When the main model fails (usage limit, rate limit, overload, provider down), the next one takes over for that message. A model from another family starts its own conversation history.'
        : 'None yet. When the main model fails, the message fails too. Add a backup, ideally from another provider.',
    ),
    list.length ? section(null, [cell({ title: 'Remove all fallbacks', cls: 'action', onClick: async () => { if (await confirmBox(`Remove all of ${name}’s fallbacks?`)) run([], 'Removed'); } })]) : null,
  ];
}

async function modelPage(target, fallback = false) {
  const isDefault = target === '#default';
  const a = isDefault ? null : agentView(target);
  const current = fallback ? { provider: undefined, model: '' } : isDefault ? S.boot.defaults : { provider: a.provider, model: a.model };
  const currentRef = fallback ? '' : refOf(current.provider, current.model);
  const providers = S.boot.providers;
  const pickKey = fallback ? `${target}#fb` : target;
  const picked = S.picked.get(pickKey) ?? current.provider ?? 'claude';
  const pickedInfo = providers.find((p) => p.id === picked);

  const save = async (ref) => {
    try {
      if (fallback) {
        const r = await saveFallbacks(target, [...(a.fallbackModels ?? []), ref]);
        haptic('success');
        toast(plain(r.message));
        return back();
      }
      const r = isDefault ? await api('POST', '/defaults', { model: ref }) : await api('POST', `/agents/${encodeURIComponent(target)}/model`, { model: ref });
      haptic('success');
      if (isDefault) S.boot.defaults = r.defaults;
      else putAgent(r.agent);
      toast(r.message);
      back();
    } catch (err) {
      fail(err);
    }
  };

  const chips = h(
    'div',
    { class: 'segmented scroll' },
    providers.map((p) =>
      h(
        'button',
        {
          type: 'button',
          class: p.id === picked ? 'on' : '',
          onclick: () => {
            if (!p.connected) return connectProvider(p.id);
            haptic('select');
            S.picked.set(pickKey, p.id);
            refresh();
          },
        },
        p.name,
        p.connected ? null : h('small', { style: 'margin-left:4px;color:var(--link)' }, '＋'),
      ),
    ),
  );
  const out = [
    !fallback && currentRef ? section('Current', [cell({ icon: providerIcon(current.provider ?? 'claude'), title: currentRef, subtitle: isDefault ? 'For new agents' : `Used by ${target}`, selected: true })]) : null,
    h('div', { class: 'section-header' }, 'Provider'),
    chips,
    h(
      'div',
      { class: 'section-footer' },
      fallback ? 'Pick the backup model: it takes over when the main one fails.' : isDefault ? 'Agents created from now on start with this model.' : '＋ means not connected yet: tap it to add the key.',
    ),
  ];

  if (!pickedInfo?.connected) return out;
  let models;
  try {
    models = await modelsOf(picked);
  } catch (err) {
    out.push(section('Models', [cell({ title: 'Could not load the models', subtitle: err.message, wrap: true }), cell({ title: 'Try again', cls: 'action', onClick: () => (S.models.delete(picked), refresh()) })]));
    return out;
  }

  S.modelLimit = 60;
  const list = h('div', { class: 'section' });
  const search = h('input', { class: 'field', type: 'search', placeholder: `Search ${models.length} models`, enterkeyhint: 'search', autocomplete: 'off' });
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const all = models
      .filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q))
      .sort((x, y) => Number(refOf(picked, y.id) === currentRef) - Number(refOf(picked, x.id) === currentRef) || Number(!!y.suggested) - Number(!!x.suggested));
    const shown = all.slice(0, S.modelLimit);
    list.replaceChildren(
      ...(shown.length
        ? [...shown.map((m) => {
            const ref = refOf(picked, m.id);
            const info = [m.name, m.context ? `${tokens(m.context)} context` : '', m.pricing ? `${money(m.pricing.input)} / ${money(m.pricing.output)} per M` : ''].filter(Boolean).join(' · ');
            return cell({ title: m.id, badge: m.suggested ? badge('suggested', 'accent') : null, subtitle: info || null, selected: ref === currentRef, onClick: () => save(ref) });
          }), all.length > shown.length ? cell({ title: `Show more (${all.length - shown.length})`, cls: 'action', onClick: () => { S.modelLimit += 60; fill(); } }) : null].filter(Boolean)
        : [cell({ title: 'No model matches', subtitle: 'Use a custom id below' })]),
    );
  };
  search.addEventListener('input', fill);
  fill();

  const custom = h('input', { class: 'field code', placeholder: picked === 'openrouter' ? 'vendor/model' : 'model id', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  out.push(
    h(
      'div',
      { class: 'section-header' },
      `${pickedInfo.family} models`,
      picked === 'claude' ? null : h('button', { onclick: () => (S.models.delete(picked), modelsOf(picked, true).then(refresh, fail)) }, 'Refresh'),
    ),
    h('div', { class: 'section search', style: 'margin-bottom:12px' }, search),
    list,
    pickedInfo.notes ? h('div', { class: 'section-footer' }, plain(pickedInfo.notes)) : null,
    section('Custom model', [h('div', { class: 'cell' }, custom), cell({ title: 'Use this model', cls: 'action', onClick: () => custom.value.trim() && save(refOf(picked, custom.value.trim())) })], 'Checked against the provider before it is saved.'),
  );
  return out;
}

const EFFORT_INFO = [
  ['default', 'Default', 'The model’s own setting'],
  ['low', 'Low', 'Quick and cheap: simple tasks'],
  ['medium', 'Medium', 'Balanced'],
  ['high', 'High', 'Careful reasoning'],
  ['xhigh', 'Extra high', 'Hard problems; slower'],
  ['max', 'Max', 'Everything it has: slowest and costliest'],
];

async function effortPage(target) {
  const isDefault = target === '#default';
  const current = isDefault ? S.boot.defaults.effort : agentView(target).effort;
  const save = async (level) => {
    try {
      const r = isDefault
        ? await api('POST', '/defaults', { model: refOf(S.boot.defaults.provider, S.boot.defaults.model), effort: level })
        : await api('POST', `/agents/${encodeURIComponent(target)}/effort`, { effort: level });
      haptic('success');
      if (isDefault) S.boot.defaults = r.defaults;
      else putAgent(r.agent);
      toast(r.message);
      back();
    } catch (err) {
      fail(err);
    }
  };
  return section(
    'Thinking effort',
    EFFORT_INFO.map(([id, title, subtitle]) => cell({ title, subtitle, selected: (current ?? 'default') === id, onClick: () => save(id) })),
    'Higher effort gives better answers on hard work but is slower and uses more tokens. A model without a level uses the nearest one.',
  );
}

// ── Pages: behaviour ────────────────────────────────────────────────────────────

async function patch(name, body) {
  const r = await withConfirm((confirm) => api('PATCH', `/agents/${encodeURIComponent(name)}`, { ...body, confirm }));
  if (!r) return undefined;
  putAgent(r.agent);
  return r;
}

async function promptPage(name) {
  const d = await details(name);
  const original = d.agent.prompt ?? '';
  const editor = h('textarea', { class: 'field editor', spellcheck: 'false' });
  editor.value = original;
  let shown = false;
  editor.addEventListener('input', () => {
    const changed = editor.value !== original;
    S.dirty = changed;
    if (changed && !shown) {
      shown = true;
      setMain('Save instructions', async () => {
        if (!editor.value.trim()) throw new Error('The instructions cannot be empty.');
        await patch(name, { prompt: editor.value });
        S.dirty = null;
        haptic('success');
        toast('Instructions saved');
        back();
      });
    } else if (!changed && shown) {
      shown = false;
      hideMain();
    }
  });
  if (inTelegram && can('7.7')) tg.disableVerticalSwipes();
  return [section(`${name}'s instructions`, [editor], 'The system prompt: purpose, steps, output format and boundaries. Changes apply from the next message.')];
}

async function descriptionPage(name) {
  const a = agentView(name);
  const input = h('textarea', { class: 'field', rows: 4, maxlength: 500 });
  input.value = a.description;
  input.addEventListener('input', () => {
    S.dirty = input.value !== a.description;
  });
  setMain('Save', async () => {
    if (!input.value.trim()) throw new Error('Describe what the agent does.');
    await patch(name, { changes: { description: input.value.trim() } });
    S.dirty = null;
    haptic('success');
    toast('Description saved');
    back();
  });
  return section('Description', [input], 'One or two sentences. It is also the agent’s Telegram bot description.');
}

const TOOL_INFO = {
  Read: 'Read files',
  Write: 'Create files',
  Edit: 'Change files',
  Glob: 'Find files by name',
  Grep: 'Search inside files',
  Bash: 'Run shell commands',
  WebFetch: 'Open web pages',
  WebSearch: 'Search the web (Claude models only)',
  NotebookEdit: 'Edit Jupyter notebooks',
  TodoWrite: 'Keep a task list',
};

async function toolsPage(name) {
  const a = agentView(name);
  const tools = new Set(a.tools);
  const connectors = new Set(a.connectors);
  const update = () => {
    const changed = [...tools].sort().join() !== [...a.tools].sort().join() || [...connectors].sort().join() !== [...a.connectors].sort().join();
    S.dirty = changed || null;
    if (changed)
      setMain('Save', async () => {
        const r = await patch(name, { changes: { tools: S.boot.tools.filter((t) => tools.has(t)), connectors: [...connectors] } });
        if (!r) return;
        S.dirty = null;
        haptic('success');
        toast('Saved');
        back();
      });
    else hideMain();
  };
  const toggle = (set, key) => (on) => {
    on ? set.add(key) : set.delete(key);
    update();
  };
  return [
    section(
      'Built-in tools',
      S.boot.tools.map((t) => switchCell({ title: t, subtitle: TOOL_INFO[t], checked: tools.has(t), onChange: toggle(tools, t) })),
      'Give only what the job needs. File and shell tools outside its folders still ask you.',
    ),
    S.boot.connectors.length
      ? section(
          'Connectors',
          S.boot.connectors.map((c) => switchCell({ title: c.name, subtitle: `${c.description}${c.ready ? '' : ' (needs setup)'}`, checked: connectors.has(c.name), onChange: toggle(connectors, c.name) })),
          'Connector tools that change things ask you first.',
        )
      : null,
  ];
}

async function memoryPage(name) {
  const a = agentView(name);
  const save = async (memory) => {
    await patch(name, { changes: { memory } });
    haptic('success');
    refresh();
  };
  return [
    section(
      'Conversation history',
      Object.entries(SESSION_INFO).map(([id, [title, subtitle]]) => cell({ title, subtitle, wrap: true, selected: a.memory.session === id, onClick: () => a.memory.session !== id && save({ session: id }).catch(fail) })),
      'Changing this forgets the current conversations.',
    ),
    section('Notes', [switchCell({ title: 'Persistent notes', subtitle: 'A memory/ folder of durable facts it reads and keeps up to date', checked: a.memory.notes, onChange: (on) => save({ notes: on }) })]),
  ];
}

// ── Pages: voice ────────────────────────────────────────────────────────────

async function voicePage(name) {
  const a = agentView(name);
  const orig = a.voice ?? {};
  const state = { reply: orig.reply ?? 'auto', provider: orig.provider ?? '', voice: orig.voice ?? '', instructions: orig.instructions ?? '' };

  const isChanged = () =>
    state.reply !== (orig.reply ?? 'auto') || state.provider !== (orig.provider ?? '') || state.voice.trim() !== (orig.voice ?? '') || state.instructions.trim() !== (orig.instructions ?? '');

  const showSave = () => {
    if (isChanged()) {
      S.dirty = true;
      setMain('Save', async () => {
        const v = state.voice.trim();
        const ins = state.instructions.trim();
        const voice = state.reply === 'auto' && !state.provider && !v && !ins ? null : { reply: state.reply, provider: state.provider || undefined, voice: v || undefined, instructions: ins || undefined };
        await patch(name, { changes: { voice } });
        S.dirty = null;
        haptic('success');
        toast('Voice saved');
        back();
      });
    } else {
      S.dirty = null;
      hideMain();
    }
  };

  const engines = S.boot.voiceEngines ?? [];
  const EN = { elevenlabs: 'ElevenLabs', gemini: 'Gemini', openai: 'OpenAI' };
  const MODES = [['auto', 'Auto', 'The agent decides when a voice note fits (often richer than the text)'], ['always', 'Always', 'Every reply includes a voice message'], ['off', 'Off', 'Text only']];

  const replyEl = h('div', { class: 'section' });
  const fillReply = () => replyEl.replaceChildren(...MODES.map(([id, t, s]) => cell({ title: t, subtitle: s, selected: state.reply === id, onClick: () => { state.reply = id; haptic('select'); fillReply(); showSave(); } })));
  fillReply();

  const engineEl = h('div', { class: 'section' });
  const fillEngine = () =>
    engineEl.replaceChildren(
      cell({ title: 'Auto', subtitle: 'First available', selected: !state.provider, onClick: () => { state.provider = ''; state.voice = ''; haptic('select'); fillEngine(); fillVoice(); showSave(); } }),
      ...['elevenlabs', 'gemini', 'openai'].map((e) =>
        cell({ title: EN[e], subtitle: engines.includes(e) ? '' : 'Not connected', selected: state.provider === e, onClick: () => { if (state.provider !== e) state.voice = ''; state.provider = e; haptic('select'); fillEngine(); fillVoice(); showSave(); } }),
      ),
    );
  fillEngine();

  const catalog = await api('GET', '/voice/voices').catch(() => ({ gemini: [], openai: [], elevenlabs: [] }));
  const voiceEl = h('div', { class: 'section' });
  const voiceNote = h('div', { class: 'section-footer' });
  const customInput = h('input', { class: 'field code', placeholder: 'Other voice (name or id)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const effectiveEngine = () => state.provider || engines[0] || 'gemini';
  const voiceOptions = () => {
    const e = effectiveEngine();
    if (e === 'elevenlabs') return catalog.elevenlabs.map((v) => ({ id: v.id, name: v.name, hint: v.hint }));
    return (catalog[e] ?? []).map((n) => ({ id: n, name: n }));
  };
  const fillVoice = () => {
    const opts = voiceOptions();
    const known = opts.some((o) => o.id === state.voice);
    voiceEl.replaceChildren(
      cell({ title: 'Default', subtitle: 'The engine’s own voice for this agent', selected: !state.voice.trim(), onClick: () => { state.voice = ''; customInput.value = ''; haptic('select'); fillVoice(); showSave(); } }),
      ...opts.map((o) => cell({ title: o.name, subtitle: o.hint || (o.name !== o.id ? o.id : null), selected: state.voice === o.id, onClick: () => { state.voice = o.id; customInput.value = ''; haptic('select'); fillVoice(); showSave(); } })),
      state.voice.trim() && !known ? cell({ title: state.voice, subtitle: 'Custom voice', selected: true }) : null,
    );
    voiceNote.textContent =
      effectiveEngine() === 'elevenlabs' && !catalog.elevenlabs.length
        ? 'Could not load your ElevenLabs voices. Type a voice id below.'
        : `Voices of ${EN[effectiveEngine()] ?? 'the engine'}. Changing the engine keeps your pick only if it exists there.`;
  };
  customInput.addEventListener('change', () => { const v = customInput.value.trim(); if (v) { state.voice = v; fillVoice(); showSave(); } });
  fillVoice();

  const instrInput = h('textarea', { class: 'field', rows: 3, placeholder: 'Calm and friendly, like a voice message to a friend', maxlength: 500 });
  instrInput.value = state.instructions;
  instrInput.addEventListener('input', () => { state.instructions = instrInput.value; showSave(); });

  return [
    h('div', { class: 'section-header' }, 'Voice replies'),
    replyEl,
    h('div', { class: 'section-footer' }, 'When should the agent answer with a voice message.'),
    h('div', { class: 'section-header' }, 'Engine'),
    engineEl,
    h('div', { class: 'section-footer' }, engines.length ? 'Which service speaks. Auto tries them in order. Tap “Not connected” engines on the Voice providers page to add a key.' : 'Connect ElevenLabs, Gemini or OpenAI to enable voice.'),
    cell({ title: 'Voice providers', subtitle: 'Add or change keys', nav: true, onClick: () => go('/voice') }),
    h('div', { class: 'section-header' }, 'Voice'),
    voiceEl,
    voiceNote,
    ...section('Other voice', [customInput], 'Paste a voice id or name that is not in the list.'),
    ...section('Speaking style', [instrInput], 'Tone and personality for Gemini and OpenAI voices.'),
  ];
}

// ── Pages: voice providers ──────────────────────────────────────────────────────

async function voiceProvidersPage() {
  const { engines, providers } = await api('GET', '/voice');
  const names = { elevenlabs: 'ElevenLabs', gemini: 'Gemini', openai: 'OpenAI' };
  const eleven = providers.elevenlabs;

  const keyInput = h('input', { class: 'field code', type: 'password', placeholder: 'ElevenLabs API key', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const voiceInput = h('input', { class: 'field code', placeholder: 'Default voice id (optional)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  voiceInput.value = eleven.voiceId || '';
  const modelInput = h('input', { class: 'field code', placeholder: 'Model (optional, e.g. eleven_multilingual_v2)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  modelInput.value = eleven.model || '';

  const save = async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) return fail('Paste the ElevenLabs API key.');
    await api('POST', '/voice/elevenlabs', { apiKey, voiceId: voiceInput.value.trim(), model: modelInput.value.trim() });
    haptic('success');
    toast('ElevenLabs key saved');
    refresh();
  };

  const remove = async () => {
    if (!(await confirmBox('Remove the ElevenLabs key? Voice replies will fall back to Gemini or OpenAI if they are connected.'))) return;
    await api('DELETE', '/voice/elevenlabs');
    haptic('success');
    toast('ElevenLabs key removed');
    refresh();
  };

  const buttons = h(
    'div',
    { class: 'presets' },
    h('button', { onclick: save }, 'Save key'),
    eleven.connected
      ? h(
          'button',
          { style: 'color:var(--destructive); background: color-mix(in srgb, var(--destructive) 12%, transparent);', onclick: remove },
          'Remove',
        )
      : null,
  );

  const providerCells = ['gemini', 'openai'].map((id) =>
    cell({
      title: names[id],
      value: providers[id].connected ? 'Connected' : 'Not connected',
      ...(providers[id].connected ? {} : { nav: true, onClick: () => go('/providers') }),
    }),
  );

  return [
    h('div', { class: 'section-header' }, 'ElevenLabs'),
    ...section('API key', [keyInput], 'Paste your ElevenLabs key. It is stored encrypted; you can change or remove it anytime.'),
    ...section('Default voice', [voiceInput], 'Optional ElevenLabs voice id. Each agent can still override this.'),
    ...section('Model', [modelInput], 'Optional model, e.g. eleven_multilingual_v2.'),
    buttons,
    h('div', { class: 'section-header', style: 'margin-top:24px' }, 'Model-provider voices'),
    h('div', { class: 'section' }, ...providerCells),
    h('div', { class: 'section-footer' }, 'Gemini and OpenAI TTS reuse the model keys set in Providers.'),
  ];
}

// ── Pages: schedules ────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function humanCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [m, hr, dom, mon, dow] = f;
  const at = /^\d+$/.test(m) && /^\d+$/.test(hr) ? `${hr.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (at && dom === '*' && mon === '*') {
    if (dow === '*') return `Every day at ${at}`;
    if (dow === '1-5') return `Weekdays at ${at}`;
    if (/^[0-6]$/.test(dow)) return `${DAYS[Number(dow)]}s at ${at}`;
  }
  if (m === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  const every = /^\*\/(\d+)$/.exec(m);
  if (every && hr === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${every[1]} minutes`;
  return expr;
}

async function triggersPage(name) {
  const a = agentView(name);
  const remove = async (i) => {
    const t = a.triggers[i];
    const choice = await popup(t.type === 'cron' ? humanCron(t.schedule) : `${t.source}:${t.on}`, t.prompt ?? '', [{ id: 'delete', type: 'destructive', text: 'Delete' }, { type: 'cancel' }]);
    if (choice !== 'delete') return;
    await patch(name, { changes: { triggers: a.triggers.filter((_, j) => j !== i) } }).catch(fail);
    haptic('success');
    refresh();
  };
  const next = new Map(a.next.map((n) => [n.schedule, n.next]));
  return [
    section(
      'Triggers',
      a.triggers.map((t, i) => {
        if (t.type === 'manual') return cell({ icon: glyph('mail', '#34c759'), title: 'Messages', subtitle: 'Answers when someone writes to it or Sunny delegates' });
        if (t.type === 'cron')
          return cell({
            icon: glyph('clock', '#ff3b30'),
            title: humanCron(t.schedule),
            subtitle: t.prompt,
            value: next.get(t.schedule) ? when(next.get(t.schedule)) : t.schedule,
            onClick: () => remove(i),
          });
        return cell({ icon: glyph('bolt', '#ff9500'), title: `On ${t.source}:${t.on}`, subtitle: t.prompt ?? (t.filter ? JSON.stringify(t.filter) : 'Handles the events'), onClick: () => remove(i) });
      }),
      'Tap a schedule or event to delete it. Ask Sunny in chat for event triggers.',
    ),
    section(null, [cell({ title: 'Add schedule', cls: 'action', onClick: () => go(`/agent/${name}/triggers/new`) })]),
  ];
}

async function newSchedulePage(name) {
  const a = agentView(name);
  const schedule = h('input', { class: 'field code', placeholder: '0 8 * * *', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const prompt = h('textarea', { class: 'field', rows: 4, placeholder: 'What to do, e.g. “Send the morning report.”' });
  const label = h('div', { class: 'section-footer' }, '');
  const describe = () => (label.textContent = schedule.value.trim() ? `${humanCron(schedule.value)} · ${S.boot.timezone}` : `Cron: minute hour day month weekday, in ${S.boot.timezone}.`);
  schedule.addEventListener('input', describe);
  describe();
  const PRESETS = [
    ['Every morning', '0 8 * * *'],
    ['Weekdays 9:00', '0 9 * * 1-5'],
    ['Mondays 9:00', '0 9 * * 1'],
    ['Every hour', '0 * * * *'],
    ['Every evening', '0 20 * * *'],
  ];
  setMain('Add schedule', async () => {
    if (!schedule.value.trim()) throw new Error('Enter a schedule.');
    const r = await patch(name, { changes: { triggers: [...a.triggers, { type: 'cron', schedule: schedule.value.trim(), prompt: prompt.value.trim() || 'Run your scheduled task.' }] } });
    if (!r) return;
    haptic('success');
    toast('Schedule added');
    back();
  });
  return [
    h('div', { class: 'section-header' }, 'When'),
    h('div', { class: 'section' }, schedule, h('div', { class: 'presets' }, PRESETS.map(([t, v]) => h('button', { type: 'button', onclick: () => ((schedule.value = v), describe(), haptic('select')) }, t)))),
    label,
    section('What to do', [prompt], 'Background runs report through notifications. No more often than every 5 minutes.'),
  ];
}

// ── Pages: people and activity ──────────────────────────────────────────────────

async function guestsPage(name) {
  const a = agentView(name);
  const all = S.boot.guests;
  const withAccess = all.filter((g) => g.agents.includes(name));
  const others = all.filter((g) => !g.agents.includes(name));
  const reload = async () => {
    await loadBoot();
    refresh();
  };
  return [
    section(
      'Can use ' + name,
      withAccess.length
        ? withAccess.map((g) =>
            cell({
              icon: initial(g.name[0].toUpperCase(), '#5ac8fa'),
              title: g.name,
              subtitle: g.linked ? 'Linked Telegram account' : 'No account linked yet',
              onClick: async () => {
                if (!(await confirmBox(`Stop ${g.name} from using ${name}?`))) return;
                await api('DELETE', `/agents/${name}/guests/${g.id}`).catch(fail);
                toast('Access removed');
                reload();
              },
            }),
          )
        : [cell({ title: 'Only you', subtitle: 'No guest can use this agent' })],
      withAccess.length ? 'Tap a guest to remove their access.' : null,
    ),
    others.length
      ? section(
          'Give access',
          others.map((g) =>
            cell({
              icon: initial(g.name[0].toUpperCase(), '#8e8e93'),
              title: g.name,
              cls: 'action',
              onClick: async () => {
                const r = await withConfirm((confirm) => api('POST', `/agents/${name}/guests`, { user: g.id, confirm })).catch(fail);
                if (!r) return;
                haptic('success');
                toast(`${g.name} can use ${name}`);
                reload();
              },
            }),
          ),
          'Guests use only their agents, never Sunny, and anything that changes things asks you.',
        )
      : null,
    h('div', { class: 'section-footer', style: 'margin-top:16px' }, 'Ask Sunny in chat to add new guests and send them an invite link.'),
  ];
}

async function runsPage(name) {
  const d = await details(name);
  return section(`${name}: latest runs`, d.runs.length ? d.runs.map(runCell) : [cell({ title: 'No runs yet' })], 'Costs on the Claude subscription are what the API would charge.');
}

/** "in 4 h 40 min · 18:59" */
function resetsIn(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  const min = Math.max(0, Math.round((at.getTime() - Date.now()) / 60000));
  const span = min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${Math.round(min / 1440)} d`;
  const clock = at.toLocaleString(undefined, { weekday: min >= 1440 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' });
  return `Resets in ${span} · ${clock}`;
}

function limitSections(limits) {
  const { subscription: sub, accounts } = limits;
  const out = [];
  const subCells = sub.ok
    ? sub.windows.map((w) => {
        const pct = Math.round(w.percent);
        const el = cell({ title: w.label, subtitle: resetsIn(w.resetsAt), value: `${pct}%` });
        el.querySelector('.cell-body').append(h('div', { class: `bar limit${pct >= 90 ? ' crit' : pct >= 75 ? ' warn' : ''}` }, h('i', { style: `width:${Math.max(2, Math.min(100, w.percent))}%` })));
        return el;
      })
    : [cell({ title: 'Limits unavailable', subtitle: sub.error, wrap: true })];
  if (sub.extraUsage?.enabled) subCells.push(cell({ title: 'Extra usage', value: `${sub.extraUsage.usedCredits ?? 0}${sub.extraUsage.monthlyLimit ? ` / ${sub.extraUsage.monthlyLimit}` : ''} ${sub.extraUsage.currency ?? ''}`.trim() }));
  const actions = h('span', { style: 'display:flex;gap:4px;flex-wrap:wrap;font-size:12px;' },
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); S.limitsRefresh = true; haptic('select'); refresh(); } }, '🔄'),
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('/limits'); haptic('select'); } }, '📊'),
    sub.ok ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('/provider/claude'); haptic('select'); } }, '↔️') : null,
  );
  out.push(
    section(
      `Claude subscription${sub.plan ? ` · ${sub.plan}` : ''}`,
      subCells,
      h('span', {}, 'Same limits as claude.ai and Claude Code. ', actions),
    ),
  );
  if (accounts.length)
    out.push(
      section(
        'Other providers',
        accounts.map((a) =>
          a.error
            ? cell({ title: a.name, subtitle: `Couldn't read: ${a.error}`, wrap: true })
            : a.facts.length
              ? cell({ title: a.name, subtitle: a.facts.slice(1).map((f) => `${f.label}: ${f.value}`).join(' · ') || a.facts[0].label, value: a.facts[0].value, wrap: true })
              : cell({ title: a.name, subtitle: a.note, wrap: true }),
        ),
      ),
    );
  return out;
}

// ── Hub: order of the agents and the main one ───────────────────────────────────
async function saveHub(change) {
  try {
    S.boot.hub = await api('PUT', '/hub', change);
    haptic('select');
    refresh();
  } catch (err) {
    fail(err);
  }
}

function hubPage() {
  const hub = S.boot.hub ?? { order: S.boot.agents.map((a) => a.name), main: null };
  const iconBtn = (label, d, onClick, opts = {}) => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', opts.on ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return h('button', { class: `hub-btn${opts.on ? ' on' : ''}`, type: 'button', 'aria-label': label, 'aria-pressed': opts.on === undefined ? undefined : String(!!opts.on), disabled: opts.disabled ? '' : undefined, onclick: (e) => { e.stopPropagation(); onClick(); } }, svg);
  };
  const cells = hub.order.map((name, i) => {
    const move = (to) => {
      const order = [...hub.order];
      order.splice(to, 0, order.splice(i, 1)[0]);
      saveHub({ order });
    };
    const isMain = hub.main === name;
    return cell({
      avatar: avatar(name),
      title: name,
      subtitle: isMain ? 'Main: the hub opens on it' : undefined,
      right: h(
        'div',
        { class: 'hub-btns' },
        iconBtn(`Main agent: ${name}`, 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z', () => saveHub({ main: isMain ? null : name }), { on: isMain }),
        iconBtn(`Move ${name} up`, 'M6 15l6-6 6 6', () => move(i - 1), { disabled: i === 0 }),
        iconBtn(`Move ${name} down`, 'M6 9l6 6 6-6', () => move(i + 1), { disabled: i === hub.order.length - 1 }),
      ),
    });
  });
  return [section('Agents in the hub', cells, 'Use the arrows to reorder; the star picks the agent the hub shows first when it opens. If it is deleted, the first agent is shown. Saved on the server, so every device agrees.')];
}

// ── Claude subscriptions: switch to the other one when a limit is reached ──────
async function claudeAccountSections() {
  const { accounts } = await api('GET', '/claude-accounts').catch(() => ({ accounts: [] }));
  if (!accounts.length) return [];
  const cells = accounts.map((a) =>
    cell({
      icon: glyph('bolt', a.active ? '#34c759' : '#8e8e93'),
      title: a.label,
      subtitle: [a.plan, a.email && a.email !== a.label ? a.email : '', a.health?.lastFail && !(a.health.lastOk && a.health.lastOk > a.health.lastFail) ? `failed ${ago(a.health.lastFail)}${a.health.resetHint ? `, resets ${a.health.resetHint}` : ''}` : ''].filter(Boolean).join(' · ') || undefined,
      value: a.active ? 'In use' : 'Switch',
      onClick: a.active
        ? undefined
        : async () => {
            if (!(await confirmBox(`Run the agents on ${a.label} from now on? Conversations carry on.`))) return;
            try {
              await api('POST', '/claude-accounts/switch', { account: a.id });
              haptic('success');
              toast(`Now using ${a.label}`);
              S.limitsRefresh = true;
              refresh();
            } catch (err) {
              fail(err);
            }
          },
    }),
  );
  cells.push(
    cell({
      title: 'Add a Claude account',
      cls: 'action',
      onClick: async () => {
        try {
          const { url } = await api('POST', '/claude-accounts/add');
          S.connecting = true;
          openLink(url);
          toast('Sign in with the other account and paste the code. The link is in your chat too.');
        } catch (err) {
          fail(err);
        }
      },
    }),
  );
  return section('Claude accounts', cells, accounts.length < 2 ? 'Add your second subscription. Sunny switches by itself when the one in use fails or hits its limit.' : 'The main account (★ to change) is used whenever it works. If the one in use fails or reaches its limit, Sunny moves to the other one by itself and tells you; tap an account to switch by hand.');
}

const USAGE_RANGES = [['6h', 6], ['24h', 24], ['3d', 72], ['7d', 168], ['30d', 720]];

/** Bars of cost per hour for the recent window, hours with no runs left empty. */
function hourChart(buckets) {
  const max = Math.max(...buckets.map((b) => b.costUsd), 0.0001);
  const showEvery = buckets.length > 36 ? 12 : buckets.length > 12 ? 6 : 1;
  return h(
    'div',
    { class: 'chart' },
    h(
      'div',
      { class: 'chart-bars' },
      buckets.map((b) => {
        const t = new Date(b.hour);
        return h('div', { class: 'chart-col', title: `${t.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: ${money(b.costUsd)} · ${b.runs} runs · ${tokens(b.inputTokens + b.outputTokens)} tokens` }, h('i', { style: `height:${b.runs ? Math.max(4, (b.costUsd / max) * 100) : 0}%` }));
      }),
    ),
    h('div', { class: 'chart-axis' }, buckets.map((b, i) => h('span', {}, i % showEvery === 0 || i === buckets.length - 1 ? `${String(new Date(b.hour).getHours()).padStart(2, '0')}h` : ''))),
  );
}

async function usagePage() {
  const hoursMode = S.usageHours != null;
  const days = hoursMode ? S.usageHours / 24 : S.usageDays;
  const force = S.limitsRefresh;
  S.limitsRefresh = false;
  const [{ rows, providers: spend = [], buckets = [] }, limits] = await Promise.all([
    hoursMode
      ? api('GET', `/usage/hours?hours=${S.usageHours}`).then(async (r) => ({ rows: r.rows, buckets: r.buckets, providers: await api('GET', `/usage?days=${Math.max(1, Math.ceil(S.usageHours / 24))}`).then((u) => u.providers).catch(() => []) }))
      : api('GET', `/usage?days=${days}`),
    api('GET', `/limits${force ? '?refresh=1' : ''}`).catch(() => null),
  ]);
  const byAgent = new Map();
  for (const r of rows) {
    const a = byAgent.get(r.agent) ?? { runs: 0, errors: 0, cost: 0, input: 0, output: 0, models: new Set() };
    a.runs += r.runs;
    a.errors += r.errors;
    a.cost += r.costUsd;
    a.input += r.inputTokens;
    a.output += r.outputTokens;
    if (r.model) a.models.add(r.model);
    byAgent.set(r.agent, a);
  }
  const list = [...byAgent.entries()].sort((x, y) => y[1].cost - x[1].cost || y[1].runs - x[1].runs);
  const total = list.reduce((s, [, a]) => s + a.cost, 0);
  const runs = list.reduce((s, [, a]) => s + a.runs, 0);
  const max = Math.max(...list.map(([, a]) => a.cost), 0) || 1;
  const seg = h(
    'div',
    { class: 'segmented' },
    [
      ...USAGE_RANGES.map(([label, hrs]) =>
        h('button', { type: 'button', class: hoursMode && S.usageHours === hrs ? 'on' : '', onclick: () => { S.usageHours = hrs; haptic('select'); refresh(); } }, label),
      ),
      ...[90].map((d) => h('button', { type: 'button', class: !hoursMode && S.usageDays === d ? 'on' : '', onclick: () => { S.usageHours = null; S.usageDays = d; haptic('select'); refresh(); } }, `${d}d`)),
    ],
  );
  return [
    ...(limits ? limitSections(limits) : []),
    ...(await claudeAccountSections()),
    seg,
    section(null, [h('div', { class: 'stat' }, h('b', {}, money(total)), h('span', {}, `${hoursMode ? `Last ${S.usageHours} hours` : 'Period'} · ${runs} runs · ${tokens(list.reduce((s, [, a]) => s + a.input + a.output, 0))} tokens`))]),
    hoursMode ? section('Cost per hour', [hourChart(buckets)], 'Each bar is one hour (your local time). Tap a bar to see its numbers.') : null,
    hoursMode && rows.length
      ? section(
          'By model',
          [...rows.reduce((m, r) => m.set(r.model || 'unknown', { runs: (m.get(r.model || 'unknown')?.runs ?? 0) + r.runs, cost: (m.get(r.model || 'unknown')?.cost ?? 0) + r.costUsd, tok: (m.get(r.model || 'unknown')?.tok ?? 0) + r.inputTokens + r.outputTokens }), new Map()).entries()]
            .sort((x, y) => y[1].cost - x[1].cost)
            .map(([model, v]) => cell({ title: model, subtitle: `${v.runs} runs · ${tokens(v.tok)} tokens`, value: money(v.cost) })),
        )
      : null,
    section(
      'By agent',
      list.length
        ? list.map(([name, a]) => {
            const el = cell({
              avatar: avatar(name),
              title: name,
              subtitle: [`${a.runs} runs`, a.errors ? `${a.errors} failed` : '', [...a.models].join(', ')].filter(Boolean).join(' · '),
              value: money(a.cost),
              nav: !!agentView(name),
              onClick: agentView(name) ? () => go(`/agent/${name}`) : undefined,
            });
            el.querySelector('.cell-body').append(h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(2, (a.cost / max) * 100)}%` })));
            return el;
          })
        : [cell({ title: 'No runs in this period' })],
      'On the Claude subscription you pay a flat fee; its costs show what the API would charge. Other providers show their own price when known.',
    ),
    ...(spend.length > 1 || (spend[0] && spend[0].provider !== 'claude')
      ? [section('By provider', spend.map((p) => cell({ title: p.name, subtitle: `${p.runs} runs · ${tokens(p.inputTokens + p.outputTokens)} tokens`, value: money(p.costUsd) })))]
      : []),
  ];
}


// ── Pages: connectors ───────────────────────────────────────────────────────────

const CONNECTOR_COLORS = { notion: '#1f1f1f', x: '#000000', instagram: '#e1306c', tiktok: '#111111', letterboxd: '#00a878', 'telegram-user': '#2aabee', github: '#24292f', vercel: '#000000', gmail: '#ea4335', gdrive: '#1fa463', youtube: '#ff0000', dropbox: '#0061ff', spotify: '#1db954', figma: '#a259ff', reddit: '#ff4500', 'notion-calendar': '#2f6feb', vps: '#34c759', notify: '#ff9500' };
const connectorIcon = (name) => initial((name === 'x' ? 'X' : name[0] ?? '?').toUpperCase(), CONNECTOR_COLORS[name] ?? '#8e8e93');

async function loadConnectors() {
  const { connectors } = await api('GET', '/connectors');
  S.boot.connectors = connectors.map((c) => ({ name: c.name, description: c.description, ready: c.ready }));
  return connectors;
}

async function sendSetup(name) {
  try {
    const { url } = await api('POST', `/connectors/${encodeURIComponent(name)}/setup`);
    S.connectingConnector = true;
    openLink(url);
    toast('Finish on the secure page. The link is in your chat too.');
  } catch (err) {
    fail(err);
  }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.connectingConnector) return;
  S.connectingConnector = false;
  try {
    await loadConnectors();
    refresh();
  } catch {
    /* keep the old state */
  }
});

async function connectorsPage() {
  const list = await loadConnectors();
  const ready = list.filter((c) => c.ready);
  const todo = list.filter((c) => !c.ready);
  const row = (c) =>
    cell({
      icon: connectorIcon(c.name),
      title: c.name,
      badge: c.mutating.length ? badge('can act', 'warn') : null,
      subtitle: c.ready ? c.description : [c.detail || 'Needs setup', c.description].filter(Boolean).join(' · '),
      value: c.ready ? '✓' : c.setup ? h('span', { style: 'color:var(--link)' }, 'Set up') : undefined,
      nav: true,
      onClick: () => go(`/connector/${encodeURIComponent(c.name)}`),
    });
  return [
    section('Needs setup', todo.map(row), todo.length ? 'Tap one, then “Send setup page”: the secure link opens here and also lands in your chat. Keys never pass through chat.' : null),
    section('Ready', ready.length ? ready.map(row) : [cell({ title: 'Nothing connected yet' })]),
  ];
}

async function connectorPage(name) {
  const list = await loadConnectors();
  const c = list.find((x) => x.name === name);
  if (!c) return [empty('Not found', `There is no connector named "${name}".`)];
  const agents = S.boot.agents.filter((a) => c.agents.includes(a.name));
  return [
    h('div', { class: 'hero' }, h('div', { class: 'avatar lg', style: `background:${CONNECTOR_COLORS[c.name] ?? '#8e8e93'}` }, (c.name === 'x' ? 'X' : c.name[0] ?? '?').toUpperCase()), h('h1', {}, c.name), h('p', {}, c.description), h('span', { class: `chip ${c.ready ? 'on' : ''}` }, c.ready ? 'Ready' : c.detail || 'Needs setup')),
    c.setup
      ? section(null, [cell({ title: c.ready ? 'Reconnect or change settings' : 'Send setup page', cls: 'action', onClick: () => sendSetup(c.name) })], 'Opens a one-time secure page. Credentials are stored encrypted and never shown to agents.')
      : section(null, [cell({ title: 'No setup needed' })]),
    c.mutating.length ? section('Asks you first', c.mutating.map((t) => cell({ title: t })), 'These tools change something, so the owner approves each use.') : null,
    section(
      'Agents using it',
      agents.length ? agents.map((a) => cell({ avatar: avatar(a.name), title: a.name, nav: true, onClick: () => go(`/agent/${a.name}/tools`) })) : [cell({ title: 'No agent yet', subtitle: 'Turn it on from an agent’s Tools & connectors page' })],
    ),
  ];
}

// ── Pages: providers and settings ───────────────────────────────────────────────

async function providersPage() {
  const agents = S.boot.agents;
  return section(
    'Model providers',
    S.boot.providers.map((p) => {
      const users = agents.filter((a) => a.provider === p.id).map((a) => a.name);
      return cell({
        icon: providerIcon(p.id),
        title: p.name,
        subtitle: p.connected ? (users.length ? `Used by ${users.join(', ')}` : 'Connected') : 'Not connected',
        value: p.connected ? h('span', { class: 'dot on' }) : null,
        nav: true,
        onClick: () => go(`/provider/${p.id}`),
      });
    }),
    'Keys are entered on a one-time secure page, checked with the provider and stored encrypted on your server. Agents never see them.',
  );
}

async function providerPage(id) {
  const p = S.boot.providers.find((x) => x.id === id);
  if (!p) return [empty('Not found', id)];
  const users = S.boot.agents.filter((a) => a.provider === id);
  const subscription = p.protocol === 'subscription';
  const actions = [];
  if (!subscription) {
    actions.push(cell({ title: p.connected ? 'Replace key' : 'Connect', cls: 'action', onClick: () => connectProvider(id) }));
    if (p.keyUrl) actions.push(cell({ title: 'Get a key ↗', cls: 'action', subtitle: p.keyHelp, wrap: true, onClick: () => openLink(p.keyUrl) }));
  }
  const out = [
    h('div', { class: 'hero' }, h('div', { class: 'avatar lg', style: `background:${(PROVIDER_ICON[id] ?? [])[1] ?? '#8e8e93'}` }, (PROVIDER_ICON[id] ?? ['?'])[0]), h('h1', {}, p.name), h('p', {}, plain(p.notes ?? '')), h('span', { class: `chip ${p.connected ? 'on' : ''}` }, p.connected ? (subscription ? 'Always on' : `Connected${p.updatedAt ? ` ${p.updatedAt.slice(0, 10)}` : ''}`) : 'Not connected')),
    actions.length ? section(null, actions) : null,
    ...(id === 'claude' ? await claudeAccountSections() : []),
  ];
  if (p.connected) {
    out.push(
      section(
        'Used by',
        users.length ? users.map((a) => cell({ avatar: avatar(a.name), title: a.name, subtitle: agentSubtitle(a), nav: true, onClick: () => go(`/agent/${a.name}`) })) : [cell({ title: 'No agent yet', subtitle: 'Pick one of its models on an agent’s Model page' })],
      ),
    );
    const modelsCell = cell({ title: 'Models', value: '…' });
    modelsOf(id)
      .then((m) => (modelsCell.querySelector('.cell-value').textContent = `${m.length} available`))
      .catch((err) => (modelsCell.querySelector('.cell-value').textContent = err.message));
    out.push(section(null, [modelsCell]));
  }
  if (p.connected && !subscription) {
    out.push(
      section(null, [
        cell({
          title: 'Disconnect',
          cls: 'destructive',
          onClick: async () => {
            haptic('warning');
            const warn = users.length ? ` ${users.map((a) => a.name).join(', ')} will fail until you change their model.` : '';
            if (!(await confirmBox(`Forget the ${p.name} key?${warn}`))) return;
            try {
              await api('DELETE', `/providers/${id}`);
              await loadBoot();
              S.models.delete(id);
              haptic('success');
              toast(`${p.name} disconnected`);
              refresh();
            } catch (err) {
              fail(err);
            }
          },
        }),
      ]),
    );
  }
  return out;
}

async function settingsPage() {
  const d = S.boot.defaults;
  return section(
    'New agents',
    [
      cell({ icon: providerIcon(d.provider ?? 'claude'), title: 'Model', value: refOf(d.provider, d.model), nav: true, onClick: () => go('/settings/model') }),
      cell({ icon: glyph('gauge', '#af52de'), title: 'Effort', value: d.effort ?? 'Default', nav: true, onClick: () => go('/settings/effort') }),
    ],
    'Used when Sunny creates an agent without naming a model. Sunny’s own model is on its page.',
  ).concat(
    section(
      'Voice & console',
      [
        switchCell({
          title: 'Live progress card',
          subtitle: 'Telegram: the card showing each step while an agent works. Agents can override this.',
          checked: S.boot.consoleGlobal,
          onChange: async (on) => {
            await api('POST', '/console', { on });
            S.boot.consoleGlobal = on;
          },
        }),
        switchCell({
          title: 'Light model for voice',
          subtitle: 'Voice messages and calls run on a cheaper model (Haiku on Claude). Off: the agent’s own model.',
          checked: S.boot.voiceLight,
          onChange: async (on) => {
            await api('POST', '/voice-light', { on });
            S.boot.voiceLight = on;
          },
        }),
      ],
    ),
    agentCallsSection(),
    quietSection(),
    section(
      'Spending & history',
      [
        cell({ icon: glyph('gauge', '#ff9500'), title: 'Daily budgets', value: budgetSummary(), nav: true, onClick: () => go('/budgets') }),
        cell({ icon: glyph('bolt', '#5856d6'), title: 'Activity', subtitle: 'Model fallbacks and agent-to-agent calls', nav: true, onClick: () => go('/activity') }),
      ],
    ),
    backupSection(),
  );
}

const BUDGET_STEPS = [null, 1, 5, 10, 25, 50];
const usd = (n) => `$${n < 1 ? n.toFixed(2) : n % 1 ? n.toFixed(2) : n}`;

function budgetSummary() {
  const n = Object.values(S.boot.budgets ?? {}).filter((b) => b?.dailyUsd).length;
  return n ? `${n} set` : 'None';
}

async function saveBudget(agent, dailyUsd, block) {
  const r = await api('POST', '/budget', { agent, dailyUsd, block });
  S.boot.budgets = r.budgets;
  haptic('success');
  render(false, true);
}

function budgetsPage() {
  const budgets = S.boot.budgets ?? {};
  const names = ['*', ...S.boot.agents.map((a) => a.name)];
  const cells = names.flatMap((n) => {
    const b = budgets[n]?.dailyUsd ? budgets[n] : null;
    const idx = b ? BUDGET_STEPS.indexOf(b.dailyUsd) : 0;
    const next = BUDGET_STEPS[(idx + 1) % BUDGET_STEPS.length] ?? null;
    const spent = budgets[n]?.spent;
    return [
      cell({
        icon: n === '*' ? glyph('star', '#ff9500') : avatar(n, 'sm'),
        title: n === '*' ? 'Default for all agents' : n,
        subtitle: n === '*' ? 'Applies to agents without their own budget' : spent !== undefined ? `Spent today ${usd(spent)}` : undefined,
        value: b ? `${usd(b.dailyUsd)}/day` : 'None',
        onClick: () => saveBudget(n, next, b?.block ?? false).catch(fail),
      }),
      b ? switchCell({ title: `Block ${n === '*' ? 'agents' : n} at the limit`, checked: b.block, onChange: async (on) => { await saveBudget(n, b.dailyUsd, on); } }) : null,
    ];
  });
  return section('Daily budgets', cells, 'Tap to cycle $1 → $5 → $10 → $25 → $50 → none. You are told at 80% and 100%; with “Block”, the agent stops at the limit until tomorrow. On the Claude subscription the amount is what the API would charge.');
}

function quietSection() {
  const q = S.boot.quiet ?? { enabled: false, from: '22:00', to: '07:00' };
  const save = async (patch) => {
    const r = await api('POST', '/quiet', patch);
    S.boot.quiet = r.quiet;
  };
  const time = (key) => {
    const input = h('input', { type: 'time', value: q[key], style: 'background:transparent;border:0;color:inherit;font:inherit' });
    input.addEventListener('change', () => input.value && save({ [key]: input.value }).catch(fail));
    return input;
  };
  return section(
    'Quiet mode',
    [
      switchCell({ title: 'Silent at night', subtitle: `Notifications arrive without sound (${S.boot.timezone}). Approvals still ring.`, checked: q.enabled, onChange: async (on) => { await save({ enabled: on }); } }),
      cell({ title: 'From', right: time('from') }),
      cell({ title: 'To', right: time('to') }),
    ],
  );
}

function backupSection() {
  const b = S.boot.backup ?? { last: null, count: 0 };
  return section(
    'Backups',
    [
      cell({
        icon: glyph('bolt', '#34c759'),
        title: 'Back up agents now',
        subtitle: b.last ? `Last: ${new Date(b.last.at).toLocaleString()} · ${b.count} kept` : 'None yet',
        cls: 'action',
        onClick: async () => {
          try {
            const r = await api('POST', '/backup');
            S.boot.backup = r.backup;
            haptic('success');
            toast('Backup done');
            render(false, true);
          } catch (err) {
            fail(err);
          }
        },
      }),
    ],
    'Agent definitions, prompts, icons, notes and Sunny’s settings: a daily archive, the last 14 kept. Secrets and chats are not included.',
  );
}

async function activityPage(kind) {
  const q = kind === 'fallback' || kind === 'agent_call' ? `?kind=${kind}` : '';
  const { activity } = await api('GET', `/activity${q}`);
  const tab = (label, k) => h('button', { type: 'button', class: 'badge', style: `padding:6px 12px;margin-right:6px;${(kind ?? '') === k ? 'font-weight:700' : 'opacity:.6'}`, onclick: () => go(k ? `/activity/${k}` : '/activity') }, label);
  const when = (d) => new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  return [
    h('div', { style: 'padding:12px 16px' }, tab('All', ''), tab('Fallbacks', 'fallback'), tab('Calls', 'agent_call')),
    activity.length
      ? section(
          null,
          activity.map((r) =>
            cell({
              icon: glyph('bolt', r.kind === 'fallback' ? '#ff9500' : '#5856d6'),
              title: r.kind === 'fallback' ? `${r.agent}: ${r.other}` : `${r.agent} → ${r.other}`,
              subtitle: `${when(r.at)} · ${r.detail.replace(/\s+/g, ' ').slice(0, 160)}`,
              wrap: true,
              badge: r.ok ? null : badge('failed', 'red'),
            }),
          ),
        )
      : empty('Nothing yet', 'Fallback switches and agent calls show up here.'),
  ];
}

/** Agent-to-agent calls: the cooldown, and the pairs answered "always allow" (tap to revoke). */
async function setAgentPref(name, prefs) {
  const r = await api('POST', `/agents/${encodeURIComponent(name)}/prefs`, prefs);
  putAgent(r.agent);
  const v = agentView(name);
  if (v && r.agent) {
    v.consoleOwn = r.agent.consoleOwn;
    v.voiceLightOwn = r.agent.voiceLightOwn;
  }
}

function agentCallsSection() {
  const calls = S.boot.agentCalls ?? { always: [], cooldownSec: 30 };
  const steps = [0, 10, 30, 60, 120, 300];
  const next = steps[(steps.indexOf(calls.cooldownSec) + 1) % steps.length] ?? 30;
  const save = async (payload) => {
    const r = await api('POST', '/agent-calls', payload);
    S.boot.agentCalls = r.agentCalls;
    render(false, true);
  };
  return section(
    'Agent calls',
    [
      cell({ icon: glyph('gauge', '#34c759'), title: 'Cooldown', value: calls.cooldownSec ? `${calls.cooldownSec}s` : 'None', subtitle: 'Between two calls to the same agent · tap to change', onClick: () => save({ cooldownSec: next }) }),
      ...calls.always.map((pair) =>
        cell({
          icon: glyph('bolt', '#ff9500'),
          title: pair.replace('>', ' → '),
          value: 'Always allowed',
          subtitle: 'Tap to ask again every time',
          onClick: async () => {
            if (!(await confirmBox(`Ask again before ${pair.replace('>', ' calls ')}?`))) return;
            await save({ revoke: pair });
          },
        }),
      ),
    ],
    calls.always.length ? null : 'When an agent asks another one, you can answer “Always allow” on the request.',
  );
}


// ── Icon and colour ─────────────────────────────────────────────────────────────

const GLYPHS = {
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  heart: 'M12 20.5s-8-4.7-8-10.2A4.3 4.3 0 0 1 12 8a4.3 4.3 0 0 1 8 2.3c0 5.5-8 10.2-8 10.2z',
  flame: 'M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z',
  leaf: 'M5 19C5 10 10 5 20 4c0 10-5 15-14 15zM5 19l8-8',
  cloud: 'M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.5 4.8 4.8 0 0 1 17 18z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  rocket: 'M5 15c-1 1-1.5 4-1.5 4s3-.5 4-1.5M14 4c4 0 6 2 6 6-2 4-5 6-8 7l-5-5c1-3 3-6 7-8zM15 9.5h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  code: 'M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  bug: 'M9 7a3 3 0 0 1 6 0M8 10h8v6a4 4 0 0 1-8 0zM4 12h4M16 12h4M5 19l3-2M19 19l-3-2M5 6l3 2M19 6l-3 2',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M9 7h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  cart: 'M3 4h2l2.5 11h10L20 7H6M9 20h.01M17 20h.01',
  bolt: ICONS.bolt,
  star: ICONS.star,
  chart: ICONS.chart,
  chip: ICONS.chip,
  wrench: ICONS.wrench,
  mail: ICONS.mail,
  mic: ICONS.mic,
  clock: ICONS.clock,
  send: ICONS.send,
  users: ICONS.users,
  pencil: ICONS.pencil,
  memory: ICONS.memory,
};
const FILLED = new Set(['bolt', 'star', 'moon', 'heart', 'flame', 'shield']);
const GRADIENTS = [
  ['#ff9a3c', '#e5484d'], ['#f6c945', '#f2762e'], ['#34d399', '#0f9d8a'], ['#38bdf8', '#2563eb'],
  ['#a78bfa', '#6d28d9'], ['#f472b6', '#be185d'], ['#fb7185', '#e11d48'], ['#94a3b8', '#334155'],
  ['#22d3ee', '#7c3aed'], ['#a3e635', '#16a34a'], ['#fbbf24', '#b45309'], ['#2dd4bf', '#1d4ed8'],
];
const ACCENTS = ['#e5484d', '#f2762e', '#f6c945', '#34c759', '#0f9d8a', '#2aabee', '#2563eb', '#7c83ff', '#a855f7', '#ec4899', '#94a3b8', '#16191f'];

/** A square 512 SVG: gradient, soft highlight, one bold glyph with a shadow. Shapes only, so it passes the server check. */
function iconSvg(glyphName, [c1, c2]) {
  const d = GLYPHS[glyphName] ?? GLYPHS.star;
  const filled = FILLED.has(glyphName);
  const body = (extra) => `<path d="${d}" ${extra} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient><radialGradient id="h" cx=".3" cy=".2" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><rect width="512" height="512" fill="url(#h)"/><g transform="translate(106 112) scale(12.5)" fill="none" stroke="#000" opacity=".18">${body(`fill="${filled ? '#000' : 'none'}" stroke="#000"`)}</g><g transform="translate(106 106) scale(12.5)">${body(`fill="${filled ? '#fff' : 'none'}" stroke="#fff"`)}</g></svg>`;
}
const svgUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Reads a photo, crops it to a square and shrinks it until it fits the 60 KB request limit. */
function photoToData(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      let size = 384;
      let out = '';
      for (let tries = 0; tries < 6; tries++) {
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        for (const q of [0.82, 0.7, 0.55]) {
          out = canvas.toDataURL('image/jpeg', q);
          if (out.length < 58_000) {
            URL.revokeObjectURL(url);
            return resolve(out);
          }
        }
        size = Math.round(size * 0.8);
      }
      URL.revokeObjectURL(url);
      reject(new Error('That image is too big. Try a smaller one.'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image I can read.'));
    };
    img.src = url;
  });
}

async function iconPage(name) {
  const a = agentView(name);
  if (a.isSunny) return [empty('Built in', 'Sunny’s icon cannot change.')];
  let glyphName = S.iconDraft?.[name]?.glyph ?? 'star';
  let grad = S.iconDraft?.[name]?.grad ?? 0;
  let pending = null; // { svg } or { image }
  const preview = h('div', { class: 'avatar lg icon-preview', style: `--agent:${a.accent}` });
  const showUrl = (url) => preview.replaceChildren(h('img', { src: url, alt: '' }));
  loadIcon(name).then((url) => url && !pending && showUrl(url));
  const note = h('div', { class: 'section-footer' }, 'Pick a symbol and colours, choose a photo, or paste an SVG. It also becomes the picture of the agent’s Telegram bot.');

  const update = () => {
    const svg = iconSvg(glyphName, GRADIENTS[grad]);
    pending = { svg };
    showUrl(svgUrl(svg));
    S.iconDraft = { ...(S.iconDraft ?? {}), [name]: { glyph: glyphName, grad } };
    arm();
    swatches.forEach((el, i) => el.classList.toggle('on', i === grad && pending.svg));
    tiles.forEach(([k, el]) => el.classList.toggle('on', k === glyphName && !!pending.svg));
  };
  const arm = () => {
    S.dirty = true;
    setMain('Save icon', async () => {
      const r = await api('POST', `/agents/${encodeURIComponent(name)}/icon`, pending);
      putAgent(r.agent);
      await loadIcon(name, true);
      S.dirty = null;
      if (S.iconDraft) delete S.iconDraft[name];
      haptic('success');
      toast(r.message);
      back();
    });
  };

  const swatches = GRADIENTS.map(([c1, c2], i) =>
    h('button', { type: 'button', class: 'swatch', 'aria-label': `Colour ${i + 1}`, style: `background:linear-gradient(135deg,${c1},${c2})`, onclick: () => { grad = i; haptic('select'); update(); } }),
  );
  const tiles = Object.keys(GLYPHS).map((k) => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', GLYPHS[k]);
    p.setAttribute('fill', FILLED.has(k) ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.7');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
    const el = h('button', { type: 'button', class: 'tile', 'aria-label': k, onclick: () => { glyphName = k; haptic('select'); update(); } }, svg);
    return [k, el];
  });

  const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const image = await photoToData(f);
      pending = { image };
      showUrl(image);
      arm();
      swatches.forEach((el) => el.classList.remove('on'));
      tiles.forEach(([, el]) => el.classList.remove('on'));
    } catch (err) {
      fail(err);
    }
  });
  const svgBox = h('textarea', { class: 'field code', rows: 6, spellcheck: 'false', placeholder: '<svg viewBox="0 0 512 512">…</svg>' });
  svgBox.addEventListener('input', () => {
    const v = svgBox.value.trim();
    if (!v.startsWith('<svg') && !v.startsWith('<?xml')) return;
    pending = { svg: v };
    showUrl(svgUrl(v));
    arm();
  });

  return [
    h('div', { class: 'hero tinted', style: `--agent:${a.accent}` }, preview, h('h1', {}, `${name}'s icon`)),
    section('Symbol', [h('div', { class: 'tiles' }, tiles.map(([, el]) => el))]),
    section('Colours', [h('div', { class: 'swatches' }, swatches)]),
    section(null, [
      cell({ icon: glyph('send', '#2aabee'), title: 'Choose a photo', subtitle: 'Cropped to a square', nav: true, onClick: () => file.click() }),
      file,
    ]),
    section('Or paste an SVG', [svgBox], 'Shapes and gradients only: no scripts or external images.'),
  ];
}

async function colorPage(name) {
  const a = agentView(name);
  if (a.isSunny) return [empty('Built in', 'Sunny’s colour cannot change.')];
  const save = async (color) => {
    const r = await patch(name, { changes: { color } });
    if (!r) return;
    haptic('success');
    toast(color ? `Colour set to ${color}` : 'Colour follows the icon');
    refresh();
  };
  const custom = h('input', { type: 'color', value: a.accent, class: 'colorwell', 'aria-label': 'Custom colour' });
  custom.addEventListener('change', () => save(custom.value).catch(fail));
  return [
    h('div', { class: 'hero tinted', style: `--agent:${a.accent}` }, avatar(name, 'lg'), h('h1', {}, 'Colour'), h('p', {}, a.accent)),
    section('Pick one', [h('div', { class: 'swatches round' }, ACCENTS.map((c) => h('button', { type: 'button', class: `swatch${c.toLowerCase() === a.accent.toLowerCase() ? ' on' : ''}`, style: `background:${c}`, 'aria-label': c, onclick: () => save(c).catch(fail) })))]),
    section(null, [
      cell({ title: 'Custom colour', right: custom }),
      cell({ title: 'Follow the icon', cls: 'action', subtitle: 'Take the colour from the icon again', onClick: () => save(null).catch(fail) }),
    ]),
  ];
}

// ── Start ───────────────────────────────────────────────────────────────────────

async function start() {
  if (!inTelegram) {
    app.replaceChildren(empty('Open in Telegram', 'This is Sunny’s agent manager. Send /manage to Sunny’s bot and tap the button, or use the menu button next to the message field.'));
    return;
  }
  try {
    await loadBoot();
  } catch (err) {
    app.replaceChildren(empty(err.status === 403 ? 'Owner only' : 'Could not load', err.message));
    return;
  }
  const page = new URLSearchParams(location.search).get('page') || tg.initDataUnsafe?.start_param?.replace(/_/g, '/') || '/';
  stack.push('/');
  if (page !== '/' && page.startsWith('/')) {
    // Deep links open on top of home, so back leads there.
    const parts = page.split('/').filter(Boolean);
    if (parts[0] === 'agent' && parts.length > 2) stack.push(`/agent/${parts[1]}`);
    stack.push(page);
  }
  render();
}

start();
