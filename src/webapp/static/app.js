// Agent app: one chat and voice call per agent, on the same thread as its Telegram bot.
'use strict';

const AGENT = document.documentElement.dataset.agent;
const BASE = `/a/${AGENT}`;
const tg = window.Telegram?.WebApp;
const inTelegram = !!tg?.initData;
const TOKEN_KEY = 'sunny_app_token';
const PREFS_KEY = 'sunny_app_prefs';
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------- words ----------
const WORDS = {
  en: {
    placeholder: 'Message',
    online: 'online',
    shared: 'online · same chat as Telegram',
    reconnecting: 'reconnecting…',
    connecting: 'connecting…',
    working: 'working…',
    thinking: 'Thinking…',
    stop: 'Stop',
    call: 'Call',
    callName: (n) => `Call ${n}`,
    emptyText: 'Write a message, or call for a voice conversation.',
    today: 'Today',
    yesterday: 'Yesterday',
    notConnected: 'Not connected yet. Try again in a moment.',
    copy: 'Copy',
    copied: 'Copied',
    listen: 'Listen',
    approval: 'Needs your OK',
    allow: 'Allow',
    deny: 'Deny',
    always: 'Always',
    allowed: 'Allowed',
    denied: 'Denied',
    st: {
      connecting: 'Connecting…',
      listening: "I'm listening",
      hearing: 'Hearing you…',
      transcribing: 'Getting that…',
      thinking: 'Thinking…',
      speaking: 'Speaking',
      paused: 'Mic off',
      holdIdle: 'Hold to talk',
      holdRec: 'Listening… release to send',
      approval: 'Needs your OK',
      micLost: 'Mic lost',
      offline: 'Reconnecting…',
    },
    modeAuto: 'Hands-free',
    modeHold: 'Push to talk',
    talk: 'Hold\nto talk',
    hintAuto: 'Just talk: it sends after a short pause. Tap the circle to cut in.',
    hintHold: isTouch ? 'Hold the button while you talk, release to send.' : 'Hold the button or the Space bar while you talk.',
    dictHint: 'Slide ← to cancel',
    dictCancel: 'Release to cancel',
    tapHint: 'Hold the mic to dictate',
    tooShort: 'Too short: hold while you talk',
    nothingHeard: "Didn't catch anything",
    slow: 'Still on it…',
    noAnswer: "No answer came. Say it again, or tap the stop button if it's stuck.",
    noNet: 'No connection',
    sttFail: "Couldn't make out what you said",
    tapRetry: 'Tap the circle to retry',
    reconnecting2: 'Reconnecting…',
    micLost: 'Microphone lost. Tap the circle to reconnect',
    micBack: 'Microphone is back',
    readOnScreen: 'reading it on screen',
    deviceVoice: 'using the phone voice',
    emptyReply: 'Done, nothing more to say.',
    vErr: {
      quota: 'Voice credits are used up',
      auth: 'The voice service refused the key',
      voice: "This agent's voice is unavailable",
      busy: 'The voice service is busy',
      network: "Can't reach the voice service",
      none: 'No voice is set up',
      unknown: 'The voice failed',
    },
    micBlocked: 'Microphone blocked',
    waitReply: 'Wait for the reply, or stop it',
    transcribing: 'Transcribing…',
    voice: 'Voice',
    mode: 'Voice mode',
    modeHelp: 'Hands-free listens all the time. Push to talk only listens while you hold the button.',
    lang: 'Language you speak',
    langAuto: 'Auto',
    pause: 'Pause before sending',
    pauseHelp: 'How long you can pause mid-sentence (hands-free).',
    short: 'Short',
    normal: 'Normal',
    long: 'Long',
    bargeIn: 'Let me talk over the agent',
    bargeInHelp: 'Speaking interrupts its answer. Best with headphones.',
    readAloud: 'Read replies aloud',
    chat: 'Conversation',
    newChat: 'New conversation',
    newChatHelp: 'The agent starts fresh (keeps its notes).',
    app: 'App',
    theme: 'Theme',
    themeAuto: 'Auto',
    dark: 'Dark',
    light: 'Light',
    install: 'Install the app',
    installIos: 'Install: Share ▸ Add to Home Screen',
    openBrowser: 'Open in browser',
    reload: 'Reload',
    signOut: 'Sign out',
    signIn: 'Sign in',
    signInText: (n) => `Open ${n} from its Telegram bot, or send /app there to get a sign-in link for this browser.`,
    noAccess: 'No access',
    offline: 'Offline',
    retry: 'Try again',
    callOn: 'Call in progress · back',
    tapAudio: 'Tap anywhere to turn the sound on',
    limitsTitle: 'Credits',
    left: 'left',
    session: 'Session (5 h)',
    week: 'Week (7 days)',
    weekModel: (m) => `Week, ${m}`,
    resetsIn: (d) => `resets in ${d}`,
    shareNote: 'The subscription limits are shared by every agent on this Claude account.',
    plan: 'Plan',
    extraUsage: 'Extra usage',
    yourSpend: 'Spent by this agent',
    last24: 'Last 24 h',
    last7: 'Last 7 days',
    runsN: (n) => `${n} run${n === 1 ? '' : 's'}`,
    spendNote: 'On a subscription this is what the API would have charged, not what you pay.',
    noBalance: 'This provider does not show a balance to a normal key. Only what this agent spent is known.',
    limitsDown: 'Limits unavailable right now',
    limitsAccess: 'This app is not allowed to read the limits. Sign in again from Telegram (/app).',
    stale: (t) => `Anthropic is not answering right now; these numbers are from ${t}.`,
    refresh: 'Refresh',
    model: 'Model',
    notConnected: 'Provider not connected',
  },
  fr: {
    placeholder: 'Message',
    online: 'en ligne',
    shared: 'en ligne · même fil que Telegram',
    reconnecting: 'reconnexion…',
    connecting: 'connexion…',
    working: 'au travail…',
    thinking: 'Réflexion…',
    stop: 'Arrêter',
    call: 'Appeler',
    callName: (n) => `Appeler ${n}`,
    emptyText: 'Écris un message, ou lance un appel pour discuter de vive voix.',
    today: "Aujourd'hui",
    yesterday: 'Hier',
    notConnected: 'Pas encore connecté. Réessaie dans un instant.',
    copy: 'Copier',
    copied: 'Copié',
    listen: 'Écouter',
    approval: 'Attend ton accord',
    allow: 'Autoriser',
    deny: 'Refuser',
    always: 'Toujours',
    allowed: 'Autorisé',
    denied: 'Refusé',
    st: {
      connecting: 'Connexion…',
      listening: "Je t'écoute",
      hearing: "Je t'entends…",
      transcribing: "J'ai compris…",
      thinking: 'Réflexion…',
      speaking: 'Parle',
      paused: 'Micro coupé',
      holdIdle: 'Maintiens pour parler',
      holdRec: 'Je t’écoute… relâche pour envoyer',
      approval: 'Attend ton accord',
      micLost: 'Micro perdu',
      offline: 'Reconnexion…',
    },
    modeAuto: 'Écoute continue',
    modeHold: 'Maintenir pour parler',
    talk: 'Maintenir\npour parler',
    hintAuto: "Parle naturellement : j'envoie après une courte pause. Touche le cercle pour couper la parole.",
    hintHold: isTouch ? 'Maintiens le bouton pendant que tu parles, relâche pour envoyer.' : 'Maintiens le bouton ou la barre Espace pendant que tu parles.',
    dictHint: 'Glisse ← pour annuler',
    dictCancel: 'Relâche pour annuler',
    tapHint: 'Maintiens le micro pour dicter',
    tooShort: 'Trop court : maintiens pendant que tu parles',
    nothingHeard: "Je n'ai rien entendu",
    slow: 'Toujours dessus…',
    noAnswer: "Aucune réponse n'est arrivée. Redis-le, ou touche stop si c'est bloqué.",
    noNet: 'Pas de connexion',
    sttFail: "Je n'ai pas pu comprendre ce que tu as dit",
    tapRetry: 'Touche le cercle pour réessayer',
    reconnecting2: 'Reconnexion…',
    micLost: 'Micro perdu. Touche le cercle pour le reconnecter',
    micBack: 'Le micro est de retour',
    readOnScreen: 'je lis à l’écran',
    deviceVoice: 'voix du téléphone',
    emptyReply: 'Fini, rien de plus à dire.',
    vErr: {
      quota: 'Plus de crédits de voix',
      auth: 'Le service de voix a refusé la clé',
      voice: 'La voix de cet agent est indisponible',
      busy: 'Le service de voix est occupé',
      network: 'Service de voix injoignable',
      none: 'Aucune voix configurée',
      unknown: 'La voix a échoué',
    },
    micBlocked: 'Micro bloqué',
    waitReply: 'Attends la réponse, ou arrête-la',
    transcribing: 'Transcription…',
    voice: 'Voix',
    mode: 'Mode vocal',
    modeHelp: "L'écoute continue entend tout le temps. « Maintenir » n'écoute que pendant que tu tiens le bouton.",
    lang: 'Langue parlée',
    langAuto: 'Auto',
    pause: 'Pause avant envoi',
    pauseHelp: 'Le temps de silence toléré au milieu d’une phrase (écoute continue).',
    short: 'Courte',
    normal: 'Normale',
    long: 'Longue',
    bargeIn: 'Pouvoir couper la parole',
    bargeInHelp: 'Parler interrompt sa réponse. Idéal avec des écouteurs.',
    readAloud: 'Lire les réponses à voix haute',
    chat: 'Conversation',
    newChat: 'Nouvelle conversation',
    newChatHelp: "L'agent repart de zéro (il garde ses notes).",
    app: 'Application',
    theme: 'Thème',
    themeAuto: 'Auto',
    dark: 'Sombre',
    light: 'Clair',
    install: "Installer l'app",
    installIos: "Installer : Partager ▸ Sur l'écran d'accueil",
    openBrowser: 'Ouvrir dans le navigateur',
    reload: 'Recharger',
    signOut: 'Se déconnecter',
    signIn: 'Connexion',
    signInText: (n) => `Ouvre ${n} depuis son bot Telegram, ou envoie /app là-bas pour recevoir un lien de connexion pour ce navigateur.`,
    noAccess: 'Pas d’accès',
    offline: 'Hors ligne',
    retry: 'Réessayer',
    callOn: 'Appel en cours · revenir',
    tapAudio: 'Touche l\'écran pour activer le son',
    limitsTitle: 'Crédits',
    left: 'restant',
    session: 'Session (5 h)',
    week: 'Semaine (7 jours)',
    weekModel: (m) => `Semaine, ${m}`,
    resetsIn: (d) => `renouvelé dans ${d}`,
    shareNote: 'Les limites de l’abonnement sont partagées par tous les agents de ce compte Claude.',
    plan: 'Offre',
    extraUsage: 'Usage supplémentaire',
    yourSpend: 'Dépensé par cet agent',
    last24: 'Dernières 24 h',
    last7: '7 derniers jours',
    runsN: (n) => `${n} exécution${n === 1 ? '' : 's'}`,
    spendNote: 'Sur un abonnement, c’est ce que l’API aurait facturé, pas ce que tu paies.',
    noBalance: 'Ce fournisseur n’affiche pas de solde avec une clé normale. Seule la dépense de cet agent est connue.',
    limitsDown: 'Limites indisponibles pour le moment',
    limitsAccess: 'Cette app n’a pas le droit de lire les limites. Reconnecte-toi depuis Telegram (/app).',
    stale: (t) => `Anthropic ne répond pas pour le moment; ces chiffres datent de ${t}.`,
    refresh: 'Actualiser',
    model: 'Modèle',
    notConnected: 'Fournisseur non connecté',
  },
};
const LANG = /^fr/i.test(tg?.initDataUnsafe?.user?.language_code || document.documentElement.lang || navigator.language) ? 'fr' : 'en';
const T = WORDS[LANG];

// ---------- state ----------
const prefs = Object.assign({ mode: 'auto', lang: 'auto', pause: 'normal', bargeIn: false, readAloud: false, theme: 'auto' }, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
let prefsTimer;
const savePrefs = () => {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  // Also on the server, so other browsers and devices get the same settings.
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    if (S.token) postJson('/prefs', prefs).catch(() => {});
  }, 400);
};
const PAUSE_MS = { short: 750, normal: 1150, long: 1800 };

const S = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  me: null,
  ws: null,
  wsTries: 0,
  online: false,
  shared: false,
  busy: false,
  stream: null, // { row, msg, text }
  approvals: new Map(),
  lastDay: '',
  call: null,
  installPrompt: null,
};
const title = () => S.me?.agent?.title || document.title;

// ---------- helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  speaker: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = ICONS[name];
  return s;
};
const haptic = (kind = 'light') => tg?.HapticFeedback?.impactOccurred?.(kind);

let toastTimer;
function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, raw, timeoutMs) {
  const headers = {};
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  let payload;
  if (raw) {
    headers['content-type'] = raw;
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload, credentials: 'same-origin', signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined });
  } catch (e) {
    // No network, a dropped connection or a timeout: say so in words, with a code the callers can act on.
    const err = new Error(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : T.noNet);
    err.code = navigator.onLine === false ? 'offline' : e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'offline';
    throw err;
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = j.code;
    throw err;
  }
  return res;
}
const getJson = async (path) => (await api('GET', path)).json();
const postJson = async (path, body) => (await api('POST', path, body)).json();

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(T.copied, 1200);
  haptic();
}

// ---------- markdown (small and safe: everything is escaped first) ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?&#])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
const LIST_UL = /^\s*[-*•+]\s+/;
const LIST_OL = /^\s*(\d+)[.)]\s+/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function blocks(text) {
  const lines = text.split('\n');
  let html = '';
  let i = 0;
  const isStart = (l, next) => /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_UL.test(l) || LIST_OL.test(l) || (/^\s*\|/.test(l) && next !== undefined && TABLE_SEP.test(next));
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      const n = Math.min(4, m[1].length + 1);
      html += `<h${n}>${inline(m[2])}</h${n}>`;
      i++;
    } else if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${inline(q.join('\n')).replace(/\n/g, '<br>')}</blockquote>`;
    } else if (LIST_UL.test(l) || LIST_OL.test(l)) {
      const ordered = !LIST_UL.test(l);
      const re = ordered ? LIST_OL : LIST_UL;
      const start = ordered ? Number(LIST_OL.exec(l)[1]) : 1;
      const items = [];
      while (i < lines.length && (re.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i]) && !LIST_UL.test(lines[i]) && !LIST_OL.test(lines[i])))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
        else items[items.length - 1] += `\n${lines[i].trim()}`;
        i++;
      }
      const lis = items.map((t) => `<li>${inline(t).replace(/\n/g, '<br>')}</li>`).join('');
      html += ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${lis}</ol>` : `<ul>${lis}</ul>`;
    } else if (/^\s*\|/.test(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      html += `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !(p.length && isStart(lines[i], lines[i + 1]))) p.push(lines[i++]);
      html += `<p>${inline(p.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }
  }
  return html;
}
function md(src) {
  const out = [];
  const re = /```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    out.push(blocks(src.slice(last, m.index)));
    out.push(`<div class="code"><header><span>${esc(m[1] || 'code')}</span><button type="button" data-copy>${T.copy}</button></header><pre><code>${esc(m[2].replace(/\n$/, ''))}</code></pre></div>`);
    last = re.lastIndex;
  }
  out.push(blocks(src.slice(last)));
  return out.join('');
}

// ---------- thread ----------
const thread = () => $('thread');
const nearBottom = () => {
  const t = thread();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 140;
};
function scrollDown(force) {
  const t = thread();
  if (force || nearBottom()) {
    t.scrollTop = t.scrollHeight;
    $('toBottom').classList.remove('new');
  } else $('toBottom').classList.add('new');
}
const time = (d) => new Date(d).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
function dayLabel(d) {
  const day = new Date(d);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (day.toDateString() === today.toDateString()) return T.today;
  if (day.toDateString() === y.toDateString()) return T.yesterday;
  return day.toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long' });
}
function maybeDay(at) {
  const d = new Date(at || Date.now()).toDateString();
  if (d === S.lastDay) return;
  S.lastDay = d;
  thread().append(h('div', { class: 'day' }, dayLabel(at || Date.now())));
}
function showEmpty(on) {
  $('empty').hidden = !on;
}

/** A message row: bubble and a meta line (time, and for the agent: listen and copy). */
function addRow(who, text, at, opts = {}) {
  showEmpty(false);
  maybeDay(at);
  const msg = h('div', { class: `msg${opts.error ? ' err' : ''}${opts.spoken ? ' spoken' : ''}`, html: who === 'me' ? '' : md(text) });
  if (who === 'me') {
    msg.innerHTML = inline(text).replace(/\n/g, '<br>');
  }
  const meta = h('div', { class: 'meta' }, h('span', {}, time(at || Date.now())));
  const row = h('div', { class: `row ${who}` }, msg, meta);
  row._text = text;
  if (who === 'them' && !opts.error) addActions(row);
  msg.addEventListener('click', (e) => {
    if (e.target.closest('a,button')) return;
    row.classList.toggle('show');
  });
  thread().append(row);
  scrollDown(who === 'me');
  return { row, msg };
}
function addActions(row) {
  const meta = row.querySelector('.meta');
  if (meta.querySelector('button')) return;
  if (S.me?.voice?.speak) meta.append(h('button', { type: 'button', 'aria-label': T.listen, title: T.listen, onclick: (e) => readAloud(row._text, e.currentTarget) }, icon('speaker')));
  meta.append(h('button', { type: 'button', 'aria-label': T.copy, title: T.copy, onclick: () => copyText(row._text) }, icon('copy')));
}
function note(text) {
  const el = h('div', { class: 'note', html: inline(text) });
  thread().append(el);
  scrollDown();
  return el;
}

function setBusy(on, text) {
  if (S.busy !== on) hubPost({ type: 'busy', busy: on });
  S.busy = on;
  $('activity').hidden = !on;
  $('app').classList.toggle('busy', on);
  if (on) scrollDown();
  if (text !== undefined) $('activityText').textContent = text;
  else if (on && !$('activityText').textContent) $('activityText').textContent = T.thinking;
  if (!on) $('activityText').textContent = '';
  updateSub();
}
function updateSub() {
  const dot = $('dot');
  dot.className = S.busy ? 'busy' : S.online ? 'on' : '';
  $('sub').textContent = !S.online ? (S.wsTries ? T.reconnecting : T.connecting) : S.busy ? T.working : S.shared ? T.shared : T.online;
}

/** What the user typed, as shown in the thread (hints for the agent and file paths left out). */
function userText(message) {
  let spoken = /^\[Voice call/.test(message);
  let text = message.replace(/^\[[^\]\n]*\]\s*/, '');
  if (/^The user sent (this|these)/.test(text) || /\n\nThe user sent (this|these)/.test(text)) {
    const said = [...text.matchAll(/Transcript[^:\n]*: "([\s\S]*?)"(?=\n|$)/g)].map((m) => m[1]);
    const before = text.split(/\n*The user sent (?:this|these)[^\n]*/)[0].trim();
    if (said.length) {
      spoken = /🎤/.test(text);
      text = [before, ...said].filter(Boolean).join('\n');
    } else {
      const items = [...text.matchAll(/^(📎|🖼|🎬|🎵|🎤|📄)[^\n]*/gm)].map((m) => m[0].replace(/\s*\(.*$/, ''));
      text = [before, ...items].filter(Boolean).join('\n') || text;
    }
  }
  return { text, spoken };
}

async function loadHistory() {
  try {
    const { items } = await getJson('/history');
    for (const r of items) {
      if (r.message) {
        const u = userText(r.message);
        addRow('me', u.text, r.at, { spoken: u.spoken });
      }
      if (r.reply) addRow('them', r.reply, r.at, { error: r.isError });
    }
    showEmpty(!items.length);
  } catch {
    showEmpty(true);
  }
  requestAnimationFrame(() => scrollDown(true));
}

// ---------- live thread ----------
/** Redraws the thread from the server (messages may have come while the page slept), keeping open approvals. */
async function reloadThread() {
  if (S.reloading) return;
  S.reloading = true;
  try {
    const keep = new Set([$('empty'), ...S.approvals.values()]);
    for (const el of [...thread().children]) if (!keep.has(el)) el.remove();
    S.lastDay = null;
    S.stream = null;
    await loadHistory();
    for (const card of S.approvals.values()) thread().append(card);
  } finally {
    S.reloading = false;
  }
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/ws`);
  S.ws = ws;
  S.lastRx = Date.now();
  clearInterval(S.beat);
  ws.onopen = () => {
    if (S.token) ws.send(JSON.stringify({ type: 'hello', token: S.token }));
  };
  ws.onmessage = (m) => {
    S.lastRx = Date.now();
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      const back = S.everReady;
      S.everReady = true;
      S.wsTries = 0;
      S.online = true;
      S.shared = !!msg.shared;
      // The server knows whether the agent is still at work: trust it, not what we saw before sleeping.
      if (!msg.running && S.busy && !S.call) setBusy(false);
      else if (msg.running && !S.busy) setBusy(true);
      updateSub();
      // We were away for a moment: the reply to a spoken question may have come while we were gone.
      if (back) {
        S.call?.recover();
        if (!S.call) reloadThread();
      }
    } else if (msg.type === 'event') onEvent(msg.event);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    S.online = false;
    if (e.code === 4003 || e.code === 4004) return gate(T.noAccess, '');
    S.wsTries++;
    updateSub();
    setTimeout(connect, Math.min(15000, 500 * 2 ** S.wsTries));
  };
  // A phone network can drop a connection without telling anyone: ping, and reconnect when it goes quiet.
  S.beat = setInterval(() => checkLink(), 15000);
}
/** Pings the server; when nothing at all came back for a while, drops the dead socket and reconnects. */
function checkLink(force) {
  const ws = S.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const quiet = Date.now() - S.lastRx;
  if (quiet > (force ? 6000 : 45000)) {
    ws.onclose = ws.onmessage = null;
    try {
      ws.close();
    } catch {}
    S.online = false;
    S.wsTries = 0;
    updateSub();
    return connect();
  }
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
  } catch {}
  if (force) setTimeout(() => Date.now() - S.lastRx > 5000 && checkLink(true), 3500);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') return void (S.hiddenAt = Date.now());
  if (!S.ws) return;
  // After a real sleep the socket may look open but have missed events: start fresh.
  const slept = S.hiddenAt && Date.now() - S.hiddenAt > 10000;
  S.hiddenAt = 0;
  if (S.ws.readyState > 1 || slept) {
    const old = S.ws;
    old.onclose = old.onmessage = null;
    try {
      old.close();
    } catch {}
    S.online = false;
    S.wsTries = 0;
    updateSub();
    connect();
  } else checkLink(true);
});
// A page restored from the back/forward cache (closed and reopened) gets the same fresh start.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    S.hiddenAt = 1;
    document.dispatchEvent(new Event('visibilitychange'));
  }
});
window.addEventListener('online', () => S.ws && (S.ws.readyState > 1 ? connect() : checkLink(true)));

function send(text, opts = {}) {
  text = text.trim();
  if (!text) return false;
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    toast(T.notConnected);
    return false;
  }
  S.ws.send(JSON.stringify({ type: 'message', text, spoken: !!opts.spoken, call: !!opts.call }));
  if (!text.startsWith('/')) {
    addRow('me', text, Date.now(), { spoken: opts.spoken });
    setBusy(true, T.thinking);
  }
  haptic();
  return true;
}

let renderQueued = false;
function renderStream() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!S.stream) return;
    const stick = nearBottom();
    S.stream.msg.innerHTML = md(S.stream.text);
    if (stick) scrollDown(true);
  });
}

function onEvent(e) {
  S.call?.onEvent(e);
  switch (e.type) {
    case 'text': {
      if (!S.busy) setBusy(true);
      if (!S.stream) S.stream = { ...addRow('them', ''), text: '' };
      S.stream.text += e.text;
      S.stream.row._text = S.stream.text;
      renderStream();
      break;
    }
    case 'reply': {
      setBusy(false);
      if (EMBED && !hubState.visible && !e.isError) hubPost({ type: 'unread', n: ++hubState.unread });
      const st = S.stream;
      S.stream = null;
      const text = e.text || '';
      if (st) {
        if (text.trim()) {
          st.row._text = text;
          st.msg.innerHTML = md(text);
          if (e.isError) st.msg.classList.add('err');
        } else st.row.remove();
      } else if (text.trim()) addRow('them', text, Date.now(), { error: e.isError });
      scrollDown();
      setTimeout(() => refreshLimits(), 1500);
      setTimeout(() => refreshLimits(), 66_000);
      if (!S.call && prefs.readAloud && !e.isError && text.trim() && S.me?.voice?.speak) readAloud(text);
      break;
    }
    case 'status':
      if (S.busy) $('activityText').textContent = e.text;
      else if (e.text) note(e.text);
      break;
    case 'tool':
      setBusy(true, e.summary);
      // Text before a tool call is narration; the next text starts a new bubble.
      if (S.stream) {
        S.stream = null;
      }
      break;
    case 'approval': {
      const card = approvalCard(e);
      S.approvals.set(e.id, card);
      thread().append(card);
      scrollDown(true);
      haptic('medium');
      break;
    }
    case 'approval_closed': {
      const card = S.approvals.get(e.id);
      if (card) card.querySelector('.btns')?.replaceWith(h('div', { class: 'done' }, e.allowed ? `✓ ${T.allowed}` : `✕ ${T.denied}`));
      S.approvals.delete(e.id);
      break;
    }
    case 'file': {
      const box = h('div', { class: 'msg file' });
      if (e.kind === 'voice' || e.kind === 'audio') box.append(h('audio', { controls: true, src: e.url, preload: 'metadata' }));
      else if (e.kind === 'photo') box.append(h('a', { href: e.url, target: '_blank', rel: 'noopener' }, h('img', { src: e.url, alt: e.name, loading: 'lazy' })));
      else if (e.kind === 'video' || e.kind === 'animation') box.append(h('a', { class: 'doc', href: e.url, target: '_blank', rel: 'noopener' }, h('span', {}, icon('file')), e.name));
      else box.append(h('a', { class: 'doc', href: e.url, target: '_blank', rel: 'noopener', download: e.name }, h('span', {}, icon('file')), e.name));
      if (e.caption) box.append(h('div', { html: inline(e.caption), style: 'margin-top:6px' }));
      showEmpty(false);
      thread().append(h('div', { class: 'row them' }, box, h('div', { class: 'meta' }, time(Date.now()))));
      scrollDown();
      break;
    }
    case 'auth_link':
      note(`🔐 [${e.title}](${e.url})`);
      break;
    case 'notify':
      note(`🔔 ${e.text}`);
      break;
    case 'notice':
      note(e.text);
      break;
    case 'error':
      setBusy(false);
      S.stream = null;
      note(`⚠️ ${e.text}`);
      break;
  }
}

function approvalCard(e) {
  return h(
    'div',
    { class: 'approval' },
    h('div', { class: 't' }, `${e.agent} · ${T.approval}`),
    h('div', { class: 's' }, e.summary),
    e.reason ? h('div', { class: 'why' }, e.reason) : null,
    h(
      'div',
      { class: 'btns' },
      h('button', { type: 'button', onclick: () => answer(e.id, true) }, T.allow),
      h('button', { class: 'no', type: 'button', onclick: () => answer(e.id, false) }, T.deny),
      e.always ? h('button', { class: 'no', type: 'button', onclick: () => answer(e.id, true, true) }, `♾ ${T.always}`) : null,
    ),
  );
}
function answer(id, allow, always = false) {
  S.ws?.send(JSON.stringify({ type: 'approve', id, allow, always }));
  haptic('medium');
}

// ---------- read a message aloud ----------
let player = null;
let playerBtn = null;
async function readAloud(text, btn) {
  if (player && !player.paused) {
    player.pause();
    playerBtn?.classList.remove('playing');
    if (playerBtn === btn) return (playerBtn = null);
  }
  playerBtn = btn || null;
  btn?.classList.add('playing');
  try {
    const res = await api('POST', '/speak', { text });
    const url = URL.createObjectURL(await res.blob());
    player = player || Object.assign(new Audio(), { playsInline: true });
    player.src = url;
    player.onended = player.onpause = () => {
      btn?.classList.remove('playing');
      URL.revokeObjectURL(url);
    };
    await player.play();
  } catch (err) {
    btn?.classList.remove('playing');
    toast(`🔇 ${err.message}`);
  }
}

// ---------- speech to text ----------
async function transcribe(samples) {
  const wav = Voice.encodeWav(samples);
  const q = prefs.lang !== 'auto' ? `?lang=${prefs.lang}` : '';
  // A flaky mobile connection or a busy service gets a second try before we give up.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await api('POST', `/listen${q}`, wav, 'audio/wav', 30000);
      return (await res.json()).text || '';
    } catch (err) {
      const transient = err.code === 'offline' || err.code === 'timeout' || err.code === 'stt' || (err.status && err.status >= 500);
      if (attempt >= 2 || !transient) throw err;
      await sleep(700);
    }
  }
}

/** The words for an error from the server or the network. */
function errorText(err) {
  if (err.code === 'offline') return T.noNet;
  if (err.code === 'timeout') return T.slow;
  if (err.code === 'stt') return T.sttFail;
  if (T.vErr[err.code]) return T.vErr[err.code];
  return err.message || T.vErr.unknown;
}

/** One sentence of the agent's voice as audio, with a timeout and a second try on network trouble. */
async function speakAudio(text) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await (await api('POST', '/speak', { text }, undefined, 25000)).arrayBuffer();
    } catch (err) {
      const transient = err.code === 'offline' || err.code === 'timeout';
      if (attempt >= 2 || !transient) throw err;
      await sleep(500);
    }
  }
}

/** The phone's own voice: a last resort so a failing voice never means silence. */
const device = {
  get ok() {
    return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
  },
  say(text) {
    return new Promise((resolve) => {
      const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').trim();
      if (!clean) return resolve();
      const u = new SpeechSynthesisUtterance(clean);
      const french = prefs.lang === 'fr' || (prefs.lang === 'auto' && (LANG === 'fr' || /[éèêàçùôîû]|\b(le|la|je|tu|est|pas|une?|des|que|qui)\b/i.test(clean)));
      u.lang = french ? 'fr-FR' : 'en-US';
      const v = speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith(u.lang.slice(0, 2)));
      if (v) u.voice = v;
      const done = () => {
        clearTimeout(guard);
        resolve();
      };
      const guard = setTimeout(done, 25000);
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    });
  },
  cancel() {
    try {
      speechSynthesis.cancel();
    } catch {}
  },
};

// ---------- dictation: hold the mic in the composer ----------
function setupDictation() {
  const btn = $('mic');
  let d = null;
  const bars = $('dictBars');
  const stopAll = () => {
    if (!d) return;
    clearInterval(d.tick);
    d.mic?.stop();
    d.ctx?.close().catch(() => {});
    $('dictate').hidden = true;
    $('dictate').classList.remove('cancel');
    btn.classList.remove('rec');
    d = null;
  };
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', async (e) => {
    if (d || S.call) return;
    e.preventDefault();
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {}
    const cur = (d = { x: e.clientX, started: performance.now(), cancel: false, released: false, level: 0 });
    btn.classList.add('rec');
    haptic('medium');
    $('dictate').hidden = false;
    $('dictHint').textContent = T.dictHint;
    $('dictTime').textContent = '0:00';
    bars.replaceChildren();
    try {
      cur.ctx = new (window.AudioContext || window.webkitAudioContext)();
      await cur.ctx.resume();
      cur.listener = new Voice.Listener({
        onEnd: async (samples) => {
          stopAll();
          const input = $('input');
          const ph = input.placeholder;
          input.placeholder = T.transcribing;
          input.disabled = true;
          try {
            const text = await transcribe(samples);
            if (!text) toast(T.nothingHeard);
            else {
              input.value = (input.value.trim() ? `${input.value.trim()} ` : '') + text;
              input.dispatchEvent(new Event('input'));
            }
          } catch (err) {
            toast(`⚠️ ${err.message}`);
          } finally {
            input.disabled = false;
            input.placeholder = ph;
            if (!isTouch) input.focus();
          }
        },
        onDiscard: () => {
          stopAll();
          toast(T.tooShort);
        },
        onLevel: (r) => (cur.level = Math.max(cur.level, r)),
      });
      cur.listener.setMode('hold');
      cur.mic = new Voice.Mic(cur.ctx, BASE);
      cur.mic.onFrame = (f, r) => cur.listener.feed(f, r);
      await cur.mic.start();
      if (d !== cur) return cur.mic.stop();
      cur.listener.press();
      if (cur.released) cur.listener.release();
      cur.tick = setInterval(() => {
        const s = Math.floor((performance.now() - cur.started) / 1000);
        $('dictTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        bars.append(h('b', { style: `height:${Math.round(3 + Math.min(1, cur.level * 9) * 23)}px` }));
        if (bars.childElementCount > 80) bars.firstChild.remove();
        cur.level = 0;
      }, 70);
    } catch (err) {
      stopAll();
      toast(`🎙 ${T.micBlocked}: ${err.message}`);
    }
  });
  btn.addEventListener('pointermove', (e) => {
    if (!d) return;
    d.cancel = e.clientX - d.x < -70;
    $('dictate').classList.toggle('cancel', d.cancel);
    $('dictHint').textContent = d.cancel ? T.dictCancel : T.dictHint;
  });
  const up = () => {
    if (!d) return;
    const held = performance.now() - d.started;
    if (d.cancel || held < 280) {
      if (!d.cancel) toast(T.tapHint);
      d.listener?.cancel();
      return stopAll();
    }
    d.released = true;
    d.listener?.release();
  };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', () => {
    if (d) d.cancel = true;
    up();
  });
}

// ---------- voice call ----------
// ---------- hub bridge ----------
// Inside the agents hub this app runs in an iframe that the hub keeps alive when you look at another
// agent, so a call survives the switch. The hub shows the call pill and sends commands; we report state.
const EMBED = window.parent !== window && new URLSearchParams(location.search).get('embed') === '1';
if (EMBED) document.documentElement.classList.add('embed');
const hubPost = (msg) => {
  if (EMBED) parent.postMessage({ sunny: 1, agent: AGENT, ...msg }, location.origin);
};
const hubState = { visible: true, unread: 0 };
function postCall() {
  const c = S.call;
  const on = !!c && c.state !== 'ended';
  hubPost({ type: 'call', on, state: on ? c.state : 'ended', started: on ? c.started : 0, muted: !!c?.muted, shown: on && !$('call').hidden });
}
if (EMBED) {
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== parent || !e.data?.sunnyHub) return;
    const m = e.data;
    switch (m.cmd) {
      case 'visible':
        hubState.visible = !!m.v;
        if (m.v && hubState.unread) {
          hubState.unread = 0;
          hubPost({ type: 'unread', n: 0 });
        }
        if (m.v) S.call?.ctx?.resume?.().catch(() => {});
        break;
      case 'call-start':
        S.startCall?.();
        break;
      case 'call-mute':
        S.call?.toggleMute();
        break;
      case 'call-end':
        S.call?.end();
        break;
      case 'call-show':
        S.call ? S.call.hide(false) : S.startCall?.();
        break;
      case 'call-hide':
        S.call?.hide(true);
        break;
    }
  });
}

class Call {
  constructor() {
    this.mode = prefs.mode;
    this.state = 'connecting';
    this.muted = false;
    this.running = false;
    this.streamed = false;
    this.micLevel = 0;
    this.shown = 0;
    this.started = Date.now();
    this.lastEventAt = Date.now();
    this.sentAt = 0;
    this.lastText = '';
    this.sticky = ''; // a message that stays until the problem is gone
    this.retryFn = null; // what tapping the circle does after a failure
    this.micDead = 0;
    this.textOnly = false;
  }

  async start() {
    $('call').hidden = false;
    $('capYou').textContent = '';
    $('capAgent').textContent = '';
    $('callApproval').replaceChildren();
    this.set('connecting');
    this.syncMode();
    haptic('medium');
    tg?.enableClosingConfirmation?.();
    try {
      // Created inside the tap, so it may play sound later (iOS).
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Started without a tap in this frame (e.g. opened by the hub): the browser may keep the sound
      // suspended until the next touch. Don't wait for it forever; ask for a tap and carry on.
      await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 700))]);
      if (this.ctx.state !== 'running') {
        this.notice(T.tapAudio);
        const wake = () => {
          this.ctx?.resume().catch(() => {});
          if (this.sticky === T.tapAudio) this.clearNotice();
        };
        for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, wake, { once: true, capture: true });
      }
      // iOS pauses audio when another app or a phone call takes over: pick it back up.
      this.ctx.onstatechange = () => {
        if (this.state === 'ended') return;
        if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
        else if (this.sticky === T.tapAudio) this.clearNotice();
      };
      this.onVis = () => {
        if (document.visibilityState !== 'visible' || this.state === 'ended') return;
        this.ctx.resume().catch(() => {});
        setTimeout(() => this.checkMic(true), 400);
      };
      document.addEventListener('visibilitychange', this.onVis);
      this.listener = new Voice.Listener({
        endMs: PAUSE_MS[prefs.pause] ?? 1150,
        onStart: () => this.set(this.mode === 'hold' ? 'holdRec' : 'hearing'),
        onEnd: (samples) => this.utterance(samples),
        onDiscard: () => {
          if (this.mode === 'hold') this.hint(T.tooShort);
          this.idle();
        },
        onLevel: (r) => (this.micLevel = r),
        onBargeIn: () => this.interrupt(false),
      });
      this.listener.bargeIn = prefs.bargeIn;
      this.openMic();
      await this.mic.start();
    } catch (err) {
      toast(`🎙 ${T.micBlocked}: ${err.message}`, 3500);
      return this.end();
    }
    // The agent's voice. If the service has none or fails, the phone's own voice reads instead:
    // a broken voice must never mean a silent call.
    const hasVoice = !!S.me?.voice?.speak;
    if (hasVoice || device.ok) {
      const fetchAudio = hasVoice ? speakAudio : () => Promise.reject(Object.assign(new Error('none'), { code: 'none' }));
      this.speaker = new Voice.Speaker(this.ctx, fetchAudio);
      this.speaker.onStart = (text) => {
        this.set('speaking');
        $('capAgent').textContent = text.replace(/```[\s\S]*?```/g, '').replace(/[*_`#>|]/g, '');
        this.listener.setMode('speaking');
      };
      this.speaker.onIdle = () => {
        if (this.state === 'ended') return;
        if (this.running) this.set('thinking');
        else this.idle();
      };
      this.speaker.onError = (err, text) => this.voiceFailed(err, text);
      this.speaker.onOk = () => {
        if (this.voiceIssue) {
          this.voiceIssue = '';
          this.textOnly = false;
          this.clearNotice();
        }
      };
      if (device.ok) {
        this.speaker.fallback = (text) => device.say(text);
        this.speaker.fallbackCancel = () => device.cancel();
      }
    } else {
      this.voiceFailed(Object.assign(new Error('none'), { code: 'none' }));
    }
    this.sentences = new Voice.Sentences((t) => this.speaker?.say(t));
    this.wake();
    this.timer = setInterval(() => this.tick(), 1000);
    this.draw();
    this.idle();
  }

  /** Wires a fresh microphone to the listener. */
  openMic() {
    this.mic = new Voice.Mic(this.ctx, BASE);
    this.mic.onFrame = (f, r) => this.listener.feed(f, r);
    this.mic.onLost = (why) => {
      if (this.state === 'ended') return;
      if (why === 'unmuted') return void setTimeout(() => this.checkMic(true), 300);
      this.checkMic(true);
    };
  }

  /** Is the microphone really delivering audio? If not, bring it back (or say why not). */
  checkMic(force) {
    if (this.state === 'ended' || this.micFixing || !this.mic) return;
    const quiet = performance.now() - this.mic.lastFrame;
    if (!force && quiet < 2500 && this.mic.alive) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (quiet < 1500 && this.mic.alive) return;
    void this.recoverMic();
  }

  async recoverMic() {
    if (this.micFixing || this.state === 'ended') return;
    this.micFixing = true;
    try {
      this.mic?.stop();
      this.openMic();
      await this.mic.start();
      this.listener.cancel();
      this.micDead = 0;
      if (this.sticky === T.micLost) this.clearNotice();
      this.hint(T.micBack);
      if (['micLost', 'listening', 'hearing', 'holdIdle', 'paused'].includes(this.state)) this.idle();
    } catch {
      this.notice(`🎙 ${T.micLost}`, () => this.recoverMic());
      if (['listening', 'hearing', 'holdIdle', 'holdRec'].includes(this.state)) this.set('micLost');
    } finally {
      this.micFixing = false;
    }
  }

  /** A message that stays until the problem is gone; tapping the circle can retry. */
  notice(text, retry) {
    this.sticky = text;
    this.retryFn = retry ?? null;
    $('callHint').textContent = text;
    $('callHint').classList.add('warn');
    $('stage').classList.toggle('retry', !!retry);
    haptic('heavy');
  }
  clearNotice() {
    this.sticky = '';
    this.retryFn = null;
    $('callHint').classList.remove('warn');
    $('stage').classList.remove('retry');
    $('callHint').textContent = this.mode === 'hold' ? T.hintHold : T.hintAuto;
  }

  /** The agent's voice failed for one sentence: say why, and make sure the words still arrive. */
  voiceFailed(err, text) {
    const code = err?.code || 'unknown';
    this.voiceIssue = code;
    const how = this.speaker?.fallback ? T.deviceVoice : T.readOnScreen;
    this.notice(`🔇 ${T.vErr[code] ?? errorText(err)} · ${how}`);
    if (!this.speaker?.fallback) {
      // Nothing can speak: show the words instead.
      this.textOnly = true;
      if (text) $('capAgent').textContent = (`${$('capAgent').textContent} ${text}`.trim()).slice(-280);
    }
  }

  /** Once a second: the clock, a dead microphone, a reply that never comes. */
  tick() {
    if (this.state === 'ended') return;
    const sec = Math.floor((Date.now() - this.started) / 1000);
    $('callTimer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    if (this.mic && !this.micFixing) {
      if (performance.now() - this.mic.lastFrame > 2500) {
        this.micDead++;
        if (this.micDead === 1 || this.micDead % 6 === 0) this.checkMic(true);
      } else this.micDead = 0;
    }
    if (this.running) {
      const quiet = Date.now() - this.lastEventAt;
      if (quiet > 20000 && this.state === 'thinking') $('callState').textContent = T.slow;
      this.waitTicks = (this.waitTicks || 0) + 1;
      if (quiet > 45000 && this.waitTicks % 10 === 0) this.recover();
      if (quiet > 240000) this.giveUp();
    }
  }

  /** The reply may have been produced while we were disconnected: fetch it from the thread. */
  async recover() {
    if (this.recovering || !this.running || this.state === 'ended') return;
    this.recovering = true;
    try {
      checkLink(true);
      const { items } = await getJson('/history');
      const last = items[items.length - 1];
      const mine = last?.message && userText(last.message).text.trim() === this.lastText.trim();
      if (mine && last.reply && new Date(last.at).getTime() >= this.sentAt - 5000 && this.running) {
        onEvent({ type: 'reply', text: last.reply, isError: last.isError });
      }
    } catch {
      // still offline: the next tick tries again
    } finally {
      this.recovering = false;
    }
  }

  giveUp() {
    this.running = false;
    setBusy(false);
    this.speaker?.stop();
    this.sentences?.reset();
    $('capAgent').textContent = `⚠️ ${T.noAnswer}`;
    haptic('heavy');
    this.idle();
  }

  set(state, text) {
    this.state = state;
    const label = state === 'speaking' ? `${title()} · ${T.st.speaking.toLowerCase()}` : T.st[state] ?? '';
    $('callState').textContent = text ?? label;
    $('stopTalk').style.visibility = state === 'thinking' || state === 'speaking' || state === 'approval' ? 'visible' : 'hidden';
    $('talkBtn').classList.toggle('down', state === 'holdRec');
    this.updateBar();
    postCall();
  }

  hint(text) {
    $('callHint').textContent = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => ($('callHint').textContent = this.sticky || (this.mode === 'hold' ? T.hintHold : T.hintAuto)), 3500);
  }

  syncMode() {
    document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
    $('muteBtn').hidden = this.mode !== 'auto';
    $('talkBtn').hidden = this.mode !== 'hold';
    if (!this.sticky) $('callHint').textContent = this.mode === 'hold' ? T.hintHold : T.hintAuto;
  }

  setMode(mode) {
    this.mode = prefs.mode = mode;
    savePrefs();
    this.syncMode();
    if (['listening', 'hearing', 'holdIdle', 'paused'].includes(this.state)) this.idle();
    haptic();
  }

  /** Ready for the user to talk. */
  idle() {
    if (this.state === 'ended') return;
    if (this.mode === 'auto' && this.muted) {
      this.listener.setMode('off');
      return this.set('paused');
    }
    this.listener.setMode(this.mode);
    this.set(this.mode === 'auto' ? 'listening' : 'holdIdle');
  }

  async utterance(samples) {
    this.listener.setMode('off');
    this.set('transcribing');
    haptic();
    let text = '';
    try {
      text = await transcribe(samples);
    } catch (err) {
      // Keep what was said: tapping the circle sends it again.
      this.notice(`⚠️ ${errorText(err)} · ${T.tapRetry}`, () => {
        this.clearNotice();
        void this.utterance(samples);
      });
      return this.idle();
    }
    if (this.state === 'ended') return;
    if (!text.trim()) {
      this.hint(T.nothingHeard);
      haptic();
      return this.idle();
    }
    if (this.retryFn) this.clearNotice();
    $('capYou').textContent = text;
    $('capAgent').textContent = '';
    this.textOnly = false;
    await this.deliver(text);
  }

  /** Sends what the user said; if the link is down, waits a few seconds for it to come back. */
  async deliver(text) {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
      this.set('offline');
      checkLink(true);
      for (let i = 0; i < 16 && this.state !== 'ended' && (!S.ws || S.ws.readyState !== WebSocket.OPEN || !S.online); i++) await sleep(500);
      if (this.state === 'ended') return;
    }
    if (!send(text, { spoken: true, call: true })) {
      this.notice(`⚠️ ${T.noNet} · ${T.tapRetry}`, () => {
        this.clearNotice();
        void this.deliver(text);
      });
      return this.idle();
    }
    this.lastText = text;
    this.sentAt = Date.now();
    this.lastEventAt = Date.now();
    this.running = true;
    this.streamed = false;
    this.sentences.reset();
    this.set('thinking');
  }

  onEvent(e) {
    if (this.state === 'ended') return;
    if (this.running) this.lastEventAt = Date.now();
    switch (e.type) {
      case 'text':
        if (!this.running) return;
        this.streamed = true;
        if (this.speaker) this.sentences.push(e.text);
        if (!this.speaker || this.textOnly) $('capAgent').textContent = ($('capAgent').textContent + e.text).slice(-280);
        break;
      case 'tool':
        if (!this.running) return;
        this.sentences.flush();
        if (!this.speaker?.busy) $('capAgent').replaceChildren(h('span', { class: 'tool' }, `⚙ ${e.summary}`));
        break;
      case 'reply':
        if (!this.running) return;
        this.running = false;
        if (!this.streamed && e.text) this.sentences.push(e.text);
        this.sentences.flush();
        if (e.isError) $('capAgent').textContent = `⚠️ ${e.text}`;
        else if (!this.speaker || this.textOnly) $('capAgent').textContent = e.text.length > 280 ? `${e.text.slice(0, 280)}…` : e.text;
        if (!e.text?.trim() && !this.streamed) this.hint(T.emptyReply);
        if (!this.speaker?.busy) this.idle();
        break;
      case 'error':
        this.running = false;
        $('capAgent').textContent = `⚠️ ${e.text}`;
        if (!this.speaker?.busy) this.idle();
        break;
      case 'approval': {
        const card = approvalCard(e);
        card.dataset.id = e.id;
        $('callApproval').replaceChildren(card);
        this.set('approval');
        haptic('heavy');
        break;
      }
      case 'approval_closed':
        if ($('callApproval').firstChild?.dataset.id === e.id) $('callApproval').replaceChildren();
        if (this.state === 'approval') this.set(this.running ? 'thinking' : 'listening');
        break;
    }
  }

  /** Stops the agent's voice; `stopRun` also stops the agent's work. */
  interrupt(stopRun) {
    this.speaker?.stop();
    this.sentences?.reset();
    if (stopRun && this.running) {
      S.ws?.send(JSON.stringify({ type: 'message', text: '/stop' }));
      this.running = false;
      setBusy(false);
    }
    haptic('medium');
    if (!this.running) this.idle();
    else {
      this.listener.setMode('off');
      this.set('thinking');
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    $('muteBtn').classList.toggle('on', this.muted);
    postCall();
    haptic();
    if (['listening', 'hearing', 'paused'].includes(this.state)) {
      this.listener.cancel();
      this.idle();
    }
  }

  press() {
    if (this.mode !== 'hold') return;
    if (this.state === 'speaking') this.interrupt(false);
    if (this.state === 'thinking' || this.state === 'transcribing' || this.state === 'approval') return this.hint(T.waitReply);
    haptic('medium');
    this.listener.setMode('hold');
    this.listener.press();
  }
  release() {
    if (this.mode === 'hold') this.listener.release();
  }

  async wake() {
    try {
      this.lock = await navigator.wakeLock?.request('screen');
    } catch {}
  }

  hide(hidden) {
    $('call').hidden = hidden;
    this.updateBar();
    postCall();
  }
  updateBar() {
    let bar = $('callBar');
    if (EMBED || !$('call').hidden || this.state === 'ended') return bar?.remove();
    if (!bar) {
      bar = h('button', { id: 'callBar', class: 'pill accent', type: 'button', style: 'position:absolute;left:50%;transform:translateX(-50%);top:calc(64px + var(--safe-t));z-index:5', onclick: () => this.hide(false) });
      $('app').append(bar);
    }
    bar.replaceChildren(icon('phone'), `${T.callOn}`);
  }

  /** The orb: the agent's colour, breathing with whoever is talking. */
  draw() {
    const canvas = $('orb');
    const g = canvas.getContext('2d');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c83ff';
    const face = document.querySelector('.orb-face');
    let level = 0;
    let t0 = performance.now();
    const frame = (now) => {
      if (this.state === 'ended') return;
      this.raf = requestAnimationFrame(frame);
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const hgt = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(hgt * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, hgt);
      const t = (now - t0) / 1000;
      const st = this.state;
      let target = 0;
      if (st === 'speaking') target = Math.min(1, (this.speaker?.rms ?? 0) * 5);
      else if (st === 'hearing' || st === 'holdRec' || st === 'listening') target = Math.min(1, this.micLevel * 9);
      level += (target - level) * (target > level ? 0.35 : 0.12);
      const cx = w / 2;
      const cy = hgt / 2;
      const R = Math.max(60, Math.min(w, hgt) / 2 / 2.3);
      const busy = st === 'thinking' || st === 'transcribing' || st === 'connecting';
      const dim = st === 'paused' || st === 'holdIdle';
      for (let layer = 3; layer >= 0; layer--) {
        const base = R * (1 + layer * 0.16 + level * (0.35 + layer * 0.12));
        const amp = 0.025 + level * 0.09 + (busy ? 0.02 : 0);
        g.beginPath();
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          const r = base * (1 + amp * Math.sin(a * 3 + t * (1.3 + layer * 0.4) + layer) + amp * 0.6 * Math.sin(a * 5 - t * (1.7 + layer * 0.3)));
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.closePath();
        g.globalAlpha = (dim ? 0.35 : 1) * [0.55, 0.26, 0.14, 0.07][layer];
        g.fillStyle = accent;
        g.fill();
      }
      if (busy) {
        g.globalAlpha = 0.9;
        g.strokeStyle = accent;
        g.lineWidth = 3;
        g.lineCap = 'round';
        const r = R * 1.42;
        const spin = t * (st === 'transcribing' ? 5 : 2.6);
        g.beginPath();
        g.arc(cx, cy, r, spin, spin + Math.PI * 0.55);
        g.stroke();
        g.globalAlpha = 0.4;
        g.beginPath();
        g.arc(cx, cy, r, spin + Math.PI, spin + Math.PI * 1.3);
        g.stroke();
      }
      g.globalAlpha = 1;
      face.style.transform = `scale(${(1 + level * 0.08).toFixed(3)})`;
    };
    this.raf = requestAnimationFrame(frame);
  }

  end() {
    if (this.state === 'ended') return;
    this.state = 'ended';
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    this.speaker?.stop();
    device.cancel();
    document.removeEventListener('visibilitychange', this.onVis);
    this.mic?.stop();
    this.ctx?.close().catch(() => {});
    this.lock?.release?.().catch?.(() => {});
    tg?.disableClosingConfirmation?.();
    $('call').hidden = true;
    $('callBar')?.remove();
    $('callTimer').textContent = '0:00';
    S.call = null;
    postCall();
    haptic('medium');
  }
}

function setupCall() {
  const start = () => {
    if (S.call) return S.call.hide(false);
    if (!S.me?.voice?.listen) return toast('Speech-to-text is not available.');
    S.call = new Call();
    void S.call.start();
  };
  S.startCall = start;
  $('callBtn').onclick = start;
  $('emptyCall').onclick = start;
  $('hangBtn').onclick = () => S.call?.end();
  $('muteBtn').onclick = () => S.call?.toggleMute();
  $('stopTalk').onclick = () => S.call?.interrupt(true);
  $('callHide').onclick = () => S.call?.hide(true);
  $('callSettings').onclick = () => openMenu(true);
  $('stage').onclick = () => {
    const c = S.call;
    if (!c) return;
    if (c.retryFn) return c.retryFn();
    if (c.state === 'speaking') c.interrupt(false);
    else if (c.mode === 'auto' && c.state === 'paused') c.toggleMute();
  };
  document.querySelectorAll('#modeSeg button').forEach((b) => (b.onclick = () => S.call?.setMode(b.dataset.mode)));
  const talk = $('talkBtn');
  talk.querySelector('span').textContent = T.talk;
  talk.style.whiteSpace = 'pre-line';
  talk.addEventListener('contextmenu', (e) => e.preventDefault());
  talk.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      talk.setPointerCapture(e.pointerId);
    } catch {}
    S.call?.press();
  });
  const rel = () => S.call?.release();
  talk.addEventListener('pointerup', rel);
  talk.addEventListener('pointercancel', rel);
  window.addEventListener('keydown', (e) => {
    if (!S.call || $('call').hidden || e.code !== 'Space' || e.repeat) return;
    e.preventDefault();
    if (S.call.mode === 'hold') S.call.press();
    else if (S.call.state === 'speaking') S.call.interrupt(false);
  });
  window.addEventListener('keyup', (e) => {
    if (S.call && e.code === 'Space') S.call.release();
  });
}

// ---------- menu and settings ----------
function seg(options, value, onPick) {
  const box = h('div', { class: 'seg' });
  for (const [v, label] of options) {
    box.append(
      h('button', {
        type: 'button',
        class: v === value ? 'on' : '',
        onclick: (e) => {
          box.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
          e.currentTarget.classList.add('on');
          onPick(v);
          haptic();
        },
      }, label),
    );
  }
  return box;
}
function toggle(label, help, value, onChange) {
  const sw = h('button', { type: 'button', class: `switch${value ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!value), 'aria-label': label });
  sw.onclick = () => {
    const on = !sw.classList.contains('on');
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
    onChange(on);
    haptic();
  };
  return h('div', { class: 'set' }, h('div', { class: 'set inline', style: 'padding:0' }, h('label', {}, label), sw), help ? h('small', {}, help) : null);
}
function opt(iconName, label, fn, cls) {
  return h('button', { class: `opt${cls ? ` ${cls}` : ''}`, type: 'button', onclick: fn }, icon(iconName), label);
}
function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && (inTelegram ? tg.colorScheme !== 'light' : !matchMedia('(prefers-color-scheme: light)').matches));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name=theme-color]').setAttribute('content', bg);
  tg?.setHeaderColor?.(bg);
  tg?.setBackgroundColor?.(bg);
  tg?.setBottomBarColor?.(bg);
}

function openMenu(voiceOnly = false) {
  const s = $('sheet');
  s.dataset.kind = '';
  const close = () => (s.hidden = true);
  const voice = [];
  if (S.me?.voice?.listen) {
    voice.push(
      h('div', { class: 'set' }, h('label', {}, T.mode), seg([['auto', T.modeAuto], ['hold', T.modeHold]], prefs.mode, (v) => {
        prefs.mode = v;
        savePrefs();
        if (S.call) S.call.setMode(v);
      }), h('small', {}, T.modeHelp)),
      h('div', { class: 'set' }, h('label', {}, T.lang), seg([['auto', T.langAuto], ['fr', 'Français'], ['en', 'English']], prefs.lang, (v) => {
        prefs.lang = v;
        savePrefs();
      })),
      h('div', { class: 'set' }, h('label', {}, T.pause), seg([['short', T.short], ['normal', T.normal], ['long', T.long]], prefs.pause, (v) => {
        prefs.pause = v;
        savePrefs();
        if (S.call) S.call.listener.endMs = PAUSE_MS[v];
      }), h('small', {}, T.pauseHelp)),
      toggle(T.bargeIn, T.bargeInHelp, prefs.bargeIn, (on) => {
        prefs.bargeIn = on;
        savePrefs();
        if (S.call) S.call.listener.bargeIn = on;
      }),
    );
  }
  if (S.me?.voice?.speak && !voiceOnly)
    voice.push(toggle(T.readAloud, '', prefs.readAloud, (on) => {
      prefs.readAloud = on;
      savePrefs();
    }));

  const app = [];
  app.push(h('div', { class: 'set' }, h('label', {}, T.theme), seg([['auto', T.themeAuto], ['dark', T.dark], ['light', T.light]], prefs.theme, (v) => {
    prefs.theme = v;
    savePrefs();
    applyTheme();
  })));
  if (inTelegram)
    app.push(opt('globe', T.openBrowser, async () => {
      close();
      try {
        const { url } = await postJson('/browser-link');
        tg.openLink(url);
      } catch (err) {
        toast(`⚠️ ${err.message}`);
      }
    }));
  else if (S.installPrompt) app.push(opt('download', T.install, async () => (close(), S.installPrompt.prompt(), (S.installPrompt = null))));
  else if (/iphone|ipad/i.test(navigator.userAgent) && !navigator.standalone) app.push(opt('download', T.installIos, close));
  app.push(opt('reload', T.reload, () => location.reload()));
  if (!inTelegram)
    app.push(opt('out', T.signOut, async () => {
      await api('POST', '/logout').catch(() => {});
      localStorage.removeItem(TOKEN_KEY);
      location.reload();
    }, 'danger'));

  const body = [h('div', { class: 'grab' })];
  body.push(h('h3', {}, h('span', { class: 'avatar' }, h('img', { src: `${BASE}/icon.svg`, alt: '' })), voiceOnly ? T.voice : title()));
  if (voice.length) body.push(voiceOnly ? null : h('div', { class: 'grp' }, T.voice), h('div', { class: 'card' }, voice));
  if (!voiceOnly) {
    body.push(h('div', { class: 'grp' }, T.chat), h('div', { class: 'card' }, opt('plus', T.newChat, () => {
      close();
      send('/new');
      thread().querySelectorAll('.row,.day,.note,.approval').forEach((n) => n.remove());
      S.lastDay = '';
      showEmpty(true);
    }), h('small', { style: 'display:block;padding:0 14px 12px;margin-top:-6px;color:var(--muted);font-size:12.5px' }, T.newChatHelp)));
    body.push(h('div', { class: 'grp' }, T.app), h('div', { class: 'card' }, app));
  }
  s.replaceChildren(h('div', { class: 'sheet', onclick: (e) => e.stopPropagation() }, body));
  s.onclick = close;
  s.hidden = false;
  haptic();
}

// ---------- sign-in ----------
async function signIn() {
  if (inTelegram) {
    try {
      const { token } = await postJson('/session', { initData: tg.initData });
      S.token = token;
      localStorage.setItem(TOKEN_KEY, token);
    } catch (err) {
      return gate(T.signIn, err.message);
    }
  }
  try {
    S.me = await getJson('/me');
    // The server's settings win (they follow the person across devices); the first device seeds them.
    if (S.me.prefs && Object.keys(S.me.prefs).length) {
      Object.assign(prefs, S.me.prefs);
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } else {
      savePrefs();
    }
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      localStorage.removeItem(TOKEN_KEY);
      S.token = '';
      return gate(err.status === 403 ? T.noAccess : T.signIn, err.status === 403 ? err.message : T.signInText(title()));
    }
    return gate(T.offline, err.message);
  }
  return true;
}

function gate(head, text) {
  const g = $('gate');
  g.replaceChildren(
    h('div', { class: 'box' }, h('span', { class: 'avatar' }, h('img', { src: `${BASE}/icon.svg`, alt: '' })), h('h2', {}, head), text ? h('p', {}, text) : null, h('button', { class: 'pill accent', type: 'button', onclick: () => location.reload() }, T.retry)),
  );
  g.hidden = false;
  return false;
}

// ---------- start ----------
async function main() {
  applyTheme();
  if (tg) {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    tg.onEvent?.('themeChanged', applyTheme);
    // Opened from Sunny's agent manager: Telegram's back button returns there.
    if (sessionStorage.getItem('sunny_from_manager')) {
      tg.BackButton?.show();
      tg.BackButton?.onClick(() => {
        if (S.call && !$('call').hidden) return S.call.hide(true);
        sessionStorage.removeItem('sunny_from_manager');
        history.back();
      });
    }
  }
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
  if ('serviceWorker' in navigator && !inTelegram) navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    S.installPrompt = e;
  });

  const input = $('input');
  input.placeholder = T.placeholder;
  $('stopBtn').textContent = T.stop;
  $('stopBtn').onclick = () => {
    S.ws?.send(JSON.stringify({ type: 'message', text: '/stop' }));
    haptic('medium');
  };
  document.querySelector('#modeSeg [data-mode=auto]').textContent = T.modeAuto;
  document.querySelector('#modeSeg [data-mode=hold]').textContent = T.modeHold;
  const sync = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    input.classList.toggle('scroll', input.scrollHeight > 160);
    const has = !!input.value.trim();
    $('send').hidden = !has;
    $('mic').hidden = has || !S.me?.voice?.listen;
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch) {
      e.preventDefault();
      $('send').click();
    }
  });
  $('send').onclick = () => {
    if (send(input.value)) {
      input.value = '';
      sync();
    }
  };
  $('menuBtn').onclick = () => openMenu(false);
  $('limitsBtn').onclick = () => (haptic(), openLimits());
  thread().addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copyText(b.closest('.code').querySelector('pre').textContent);
  });
  thread().addEventListener('scroll', () => {
    $('toBottom').hidden = nearBottom();
    if (nearBottom()) $('toBottom').classList.remove('new');
  });
  $('toBottom').onclick = () => scrollDown(true);
  setupDictation();
  setupCall();
  updateSub();
  sync();

  if (!(await signIn())) return;
  document.title = title();
  $('name').textContent = title();
  if (S.me.agent.accent) document.documentElement.style.setProperty('--accent', S.me.agent.accent);
  $('emptyDesc').textContent = S.me.agent.description?.split(/(?<=[.!?])\s/)[0] || T.emptyText;
  const canCall = !!S.me.voice.listen;
  $('callBtn').hidden = !canCall;
  $('emptyCall').hidden = !canCall;
  $('emptyCall').replaceChildren(icon('phone'), T.callName(title()));
  sync();
  await loadHistory();
  connect();
  startLimits();
  // Opened from the hub with ?call=1: go straight into a voice call.
  if (canCall && new URLSearchParams(location.search).get('call') === '1') {
    const q = new URLSearchParams(location.search);
    q.delete('call');
    history.replaceState(null, '', location.pathname + (q.size ? `?${q}` : ''));
    $('callBtn').click();
  }
}

// ---------- credits / limits ----------
const LIMITS_EVERY_MS = 120_000;
S.limits = null;
let limitsBusy = false;
let limitsLast = 0;
let limitsTimer;

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));
const usdText = (n) => `$${Math.abs(n) < 1 && n !== 0 ? n.toFixed(3) : n.toFixed(2)}`;
const tokText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
function untilText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return LANG === 'fr' ? '1 min' : '1 min';
  const m = Math.round(ms / 60_000);
  const d = Math.floor(m / 1440);
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d} ${LANG === 'fr' ? 'j' : 'd'} ${hh} h`;
  if (hh) return `${hh} h ${String(mm).padStart(2, '0')}`;
  return `${mm} min`;
}
/** The two numbers the owner cares about: how much of the session and of the week is left. */
function limitWindows(sub) {
  const ws = sub?.windows || [];
  const session = ws.find((w) => w.kind === 'session' || w.kind === 'five_hour');
  const week = ws.find((w) => w.kind === 'weekly_all' || w.kind === 'seven_day') || ws.find((w) => /^(weekly|seven_day)/.test(w.kind));
  return { session, week, others: ws.filter((w) => w !== session && w !== week) };
}
const levelOf = (left) => (left <= 10 ? 'crit' : left <= 30 ? 'warn' : 'ok');

function meter(tag, left) {
  const l = clampPct(left);
  return h('span', { class: `meter ${levelOf(l)}` }, h('em', {}, tag), h('i', {}, h('b', { style: `width:${l}%` })), h('u', {}, `${l}%`));
}

/** A ring gauge (outer: session, inner: week) drawn like the other header icons. */
function ringGauge(session, week) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  const ring = (r, width, left, cls) => {
    const c = 2 * Math.PI * r;
    for (const [klass, dash] of [['track', c], [`val ${cls}`, (c * clampPct(left)) / 100]]) {
      const el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', '20');
      el.setAttribute('cy', '20');
      el.setAttribute('r', String(r));
      el.setAttribute('class', klass);
      el.setAttribute('stroke-width', String(width));
      el.setAttribute('transform', 'rotate(-90 20 20)');
      if (klass !== 'track') el.setAttribute('stroke-dasharray', `${dash} ${c}`);
      svg.append(el);
    }
  };
  if (session) ring(17, 3, 100 - session.percent, levelOf(100 - session.percent));
  if (week) ring(session ? 12 : 17, session ? 2.6 : 3, 100 - week.percent, levelOf(100 - week.percent));
  return svg;
}

/** The credits button in the header: same size and shape as its neighbours; tap for details. */
function renderLimitsBadge() {
  const btn = $('limitsBtn');
  const d = S.limits;
  if (!d || (d.kind !== 'subscription' && d.kind !== 'api')) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.className = 'icon-btn limits';
  btn.setAttribute('aria-label', T.limitsTitle);
  if (d.kind === 'subscription') {
    const { session, week } = limitWindows(d.subscription);
    if (!d.subscription?.ok || (!session && !week)) {
      btn.classList.add('off');
      btn.replaceChildren(h('span', { class: 'amt' }, '–'));
      return;
    }
    const lefts = [session, week].filter(Boolean).map((w) => clampPct(100 - w.percent));
    const low = Math.min(...lefts);
    btn.classList.add(levelOf(low));
    if (d.subscription.stale) btn.classList.add('old');
    btn.replaceChildren(ringGauge(session, week), h('span', { class: 'pct' }, String(low)));
    btn.title = [session && `5 h · ${clampPct(100 - session.percent)}%`, week && `7 d · ${clampPct(100 - week.percent)}%`].filter(Boolean).join('  ·  ');
    return;
  }
  const bal = d.account?.facts?.[0];
  const text = bal ? bal.value : usdText(d.spend.day.costUsd);
  btn.classList.add('money');
  btn.replaceChildren(h('span', { class: 'amt' }, text.replace(/\.00$/, '')), h('small', {}, bal ? '' : '24 h'));
}

async function refreshLimits(force = false) {
  if (limitsBusy || (!S.token && !S.me)) return;
  if (!force && Date.now() - limitsLast < 20_000) return;
  limitsBusy = true;
  try {
    S.limits = await (await api('GET', `/limits${force ? '?refresh=1' : ''}`, undefined, undefined, 15000)).json();
    limitsLast = Date.now();
    renderLimitsBadge();
    if (!$('sheet').hidden && $('sheet').dataset.kind === 'limits') openLimits();
    S.limitsError = '';
  } catch (err) {
    // The badge keeps its last numbers; the sheet says what went wrong.
    S.limitsError = err?.status === 403 || err?.status === 401 ? T.limitsAccess : err?.message || T.limitsDown;
    if (!$('sheet').hidden && $('sheet').dataset.kind === 'limits') openLimits();
  } finally {
    limitsBusy = false;
  }
}
function startLimits() {
  refreshLimits();
  clearInterval(limitsTimer);
  limitsTimer = setInterval(() => !document.hidden && refreshLimits(), LIMITS_EVERY_MS);
  document.addEventListener('visibilitychange', () => !document.hidden && refreshLimits());
}

function bigMeter(label, w) {
  const left = clampPct(100 - w.percent);
  return h('div', { class: `bm ${levelOf(left)}` },
    h('div', { class: 'bm-top' }, h('span', {}, label), h('b', {}, `${left}% ${T.left}`)),
    h('div', { class: 'bm-bar' }, h('i', { style: `width:${left}%` })),
    w.resetsAt ? h('small', {}, T.resetsIn(untilText(w.resetsAt))) : null);
}
function spendRow(label, s) {
  return h('div', { class: 'kv' }, h('span', {}, label), h('b', {}, `${usdText(s.costUsd)} · ${tokText(s.tokens)} tok · ${T.runsN(s.runs)}`));
}

function openLimits() {
  const sheet = $('sheet');
  const close = () => (sheet.hidden = true);
  const d = S.limits;
  const body = [h('div', { class: 'grab' }), h('h3', {}, h('span', { class: 'avatar' }, h('img', { src: `${BASE}/icon.svg`, alt: '' })), T.limitsTitle)];
  const cards = [];
  if (d) {
    const head = [h('div', { class: 'kv' }, h('span', {}, d.providerName), h('b', {}, d.model || ''))];
    if (d.kind === 'subscription') {
      const sub = d.subscription || {};
      const { session, week, others } = limitWindows(sub);
      if (!sub.ok) {
        cards.push(h('div', { class: 'card pad' }, h('b', {}, T.limitsDown), h('small', { class: 'muted' }, sub.error || '')));
      } else {
        const rows = [];
        if (session) rows.push(bigMeter(T.session, session));
        if (week) rows.push(bigMeter(T.week, week));
        for (const w of others) rows.push(bigMeter(/opus/i.test(w.kind) ? T.weekModel('Opus') : /sonnet/i.test(w.kind) ? T.weekModel('Sonnet') : w.label, w));
        cards.push(h('div', { class: 'card pad' }, rows));
        const meta = [];
        if (sub.plan) meta.push(h('div', { class: 'kv' }, h('span', {}, T.plan), h('b', {}, sub.plan)));
        if (sub.extraUsage?.enabled) meta.push(h('div', { class: 'kv' }, h('span', {}, T.extraUsage), h('b', {}, sub.extraUsage.monthlyLimit != null ? `${sub.extraUsage.usedCredits ?? 0} / ${sub.extraUsage.monthlyLimit} ${sub.extraUsage.currency || ''}` : 'on')));
        if (meta.length) cards.push(h('div', { class: 'card pad' }, meta));
        if (sub.stale) cards.push(h('small', { class: 'note muted' }, `${T.stale(sub.checkedAt ? new Date(sub.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')}`));
        cards.push(h('small', { class: 'note muted' }, T.shareNote));
      }
    } else {
      const facts = d.account?.facts || [];
      if (!d.account) cards.push(h('div', { class: 'card pad' }, h('b', {}, T.notConnected)));
      else if (facts.length) cards.push(h('div', { class: 'card pad' }, facts.map((f) => h('div', { class: 'kv' }, h('span', {}, f.label), h('b', {}, f.value)))));
      else cards.push(h('div', { class: 'card pad' }, h('small', { class: 'muted' }, d.account.error || T.noBalance)));
    }
    cards.push(h('div', { class: 'grp' }, T.yourSpend), h('div', { class: 'card pad' }, spendRow(T.last24, d.spend.day), spendRow(T.last7, d.spend.week)));
    if (d.kind === 'subscription') cards.push(h('small', { class: 'note muted' }, T.spendNote));
    body.push(h('div', { class: 'card pad' }, head), ...cards);
  } else body.push(h('div', { class: 'card pad' }, h('b', {}, S.limitsError ? T.limitsDown : '…'), S.limitsError ? h('small', { class: 'muted' }, S.limitsError) : null));
  body.push(h('div', { class: 'card', style: 'margin-top:12px' }, opt('reload', T.refresh, () => refreshLimits(true))));
  sheet.dataset.kind = 'limits';
  sheet.replaceChildren(h('div', { class: 'sheet', onclick: (e) => e.stopPropagation() }, body));
  sheet.onclick = () => {
    sheet.dataset.kind = '';
    close();
  };
  sheet.hidden = false;
}

main();
