// Agents hub. A full-screen carousel (one agent centred), and a workspace that keeps every opened agent's
// app alive in its own iframe, so a voice call keeps running while you look at another agent.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const FR = document.documentElement.lang === 'fr';
  const T = FR
    ? { hint: 'Tape pour ouvrir · glisse vers le haut · maintiens pour appeler', open: 'Ouvrir', call: 'Appeler', back: 'Retour aux agents', search: 'Rechercher un agent', theme: 'Thème', install: 'Installer', signin: "Connecte-toi d'abord : ouvre le lien de connexion d'un agent depuis Telegram (« /app »), puis reviens ici.", offline: 'Hors ligne', none: 'Aucun agent disponible.', mute: 'Micro', hang: 'Raccrocher', swap: 'Changer de destinataire', ret: "Revenir à l'appel", working: 'En train de répondre', unread: 'Nouveau message', close: 'Fermer', ph: 'Rechercher…', release: 'Relâche pour ouvrir', callTo: 'Appeler', inCall: 'En appel', connecting: 'Connexion…', states: { connecting: 'Connexion…', listening: 'À l’écoute', hearing: 'T’entend', transcribing: 'Écoute…', thinking: 'Réfléchit…', speaking: 'Parle', paused: 'En pause', holdIdle: 'Maintiens pour parler', holdRec: 'T’entend', approval: 'Attend ton accord', micLost: 'Micro perdu' } }
    : { hint: 'Tap to open · swipe up · hold to call', open: 'Open', call: 'Call', back: 'Back to agents', search: 'Search agents', theme: 'Theme', install: 'Install', signin: 'Sign in first: open an agent\'s sign-in link from Telegram ("/app"), then come back here.', offline: 'Offline', none: 'No agents available.', mute: 'Mute', hang: 'Hang up', swap: 'Switch who you talk to', ret: 'Back to the call', working: 'Answering', unread: 'New message', close: 'Close', ph: 'Search…', release: 'Release to open', callTo: 'Call', inCall: 'In call', connecting: 'Connecting…', states: { connecting: 'Connecting…', listening: 'Listening', hearing: 'Hearing you', transcribing: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', paused: 'Paused', holdIdle: 'Hold to talk', holdRec: 'Hearing you', approval: 'Waiting for your OK', micLost: 'Mic lost' } };

  const S = { agents: [], idx: 0, panes: new Map(), active: null, workOpen: false, call: null, canCall: true };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const buzz = (ms = 10) => { try { navigator.vibrate?.(ms); } catch {} };
  const say = (t) => { $('live').textContent = ''; setTimeout(() => ($('live').textContent = t), 30); };
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k === 'class' ? (n.className = v) : n.setAttribute(k, v);
    n.append(...kids);
    return n;
  };
  const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = d; return s; };
  const PHONE = '<path d="M6.6 3h3l1.5 4-2 1.3a11 11 0 0 0 5.6 5.6l1.3-2 4 1.5v3A2.6 2.6 0 0 1 17.4 19 14 14 0 0 1 5 6.6 2.6 2.6 0 0 1 6.6 3z"/>';
  const agentOf = (n) => S.agents.find((a) => a.name === n);

  // ---- theme ----
  const themePref = () => localStorage.getItem('hub_theme') || 'auto';
  const applyTheme = () => {
    const p = themePref();
    const dark = p === 'dark' || (p === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name=theme-color]').content = dark ? '#0b0b0f' : '#f3f3f7';
  };
  $('themeBtn').onclick = () => {
    const next = { auto: 'dark', dark: 'light', light: 'auto' }[themePref()];
    localStorage.setItem('hub_theme', next);
    applyTheme(); buzz(); say(`${T.theme}: ${next}`);
  };
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
  applyTheme();
  for (const [id, label] of [['themeBtn', T.theme], ['searchBtn', T.search], ['backBtn', T.back], ['addBtn', T.search], ['pillMute', T.mute], ['pillEnd', T.hang], ['pillSwitch', T.swap]]) $(id).setAttribute('aria-label', label);
  $('hint').textContent = T.hint;
  $('q').placeholder = T.ph;
  $('q').setAttribute('aria-label', T.search);
  $('track').setAttribute('aria-label', 'Agents');

  // ---- load ----
  const cachedKey = 'hub_agents';
  async function load() {
    let data;
    try {
      const res = await fetch('/a/api/agents', { credentials: 'same-origin' });
      if (res.status === 401) return showMsg(T.signin);
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
      localStorage.setItem(cachedKey, JSON.stringify(data));
    } catch {
      try { data = JSON.parse(localStorage.getItem(cachedKey) || ''); } catch {}
      if (!data) return showMsg(T.offline);
    }
    // The server decides the order and the main agent (set in Sunny's Mini App), so every device agrees.
    S.agents = data.agents;
    S.main = data.main;
    S.canCall = data.canCall !== false;
    if (!S.agents.length) return showMsg(T.none);
    $('msg').hidden = true;
    build();
    resume();
  }
  const showMsg = (t) => { $('msg').textContent = t; $('msg').hidden = false; };
  const netState = () => { $('offline').hidden = navigator.onLine; $('offline').textContent = T.offline; };
  addEventListener('online', () => { netState(); if (!S.agents.length) load(); });
  addEventListener('offline', netState);
  netState();

  // ---- carousel ----
  // Endless: three identical sets of slides, the user always rests in the middle one. When a scroll settles in
  // the first or last set, the track jumps one set sideways (instant, invisible: the slides are identical).
  const SETS = 3;
  const loops = () => S.agents.length > 1;
  function build() {
    const track = $('track'), bgs = $('bgs'), dots = $('dots');
    track.replaceChildren(); bgs.replaceChildren(); dots.replaceChildren();
    const n = S.agents.length;
    S.n = n;
    const sets = loops() ? SETS : 1;
    S.agents.forEach((a, i) => {
      const bg = el('div', { class: 'bg' });
      bg.style.setProperty('--a', a.accent);
      bgs.append(bg);
      const dot = el('button', { class: 'dot', type: 'button', role: 'tab', 'aria-label': a.title, 'aria-selected': 'false' });
      dot.onclick = () => go(i);
      dots.append(dot);
    });
    for (let c = 0; c < sets; c++) S.agents.forEach((a, i) => {
      const orb = el('button', { class: 'orb', type: 'button', 'aria-label': `${T.open} ${a.title}` }, el('img', { src: a.icon, alt: '', draggable: 'false' }));
      const ring = svg('<circle cx="50" cy="50" r="48" pathLength="100"/>');
      ring.setAttribute('class', 'ring'); ring.setAttribute('viewBox', '0 0 100 100');
      const wrap = el('div', { class: 'orbwrap' }, el('div', { class: 'glow' }), orb, ring);
      const open = el('button', { class: 'open', type: 'button' }, T.open);
      const call = el('button', { class: 'callbtn', type: 'button', 'aria-label': `${T.callTo} ${a.title}` });
      call.append(svg(PHONE));
      call.hidden = !S.canCall;
      const slide = el('article', { class: 'slide', 'data-i': String(i), role: 'group', 'aria-roledescription': 'slide', 'aria-label': `${a.title}, ${i + 1} / ${n}` },
        wrap, el('h2', { class: 'name' }, a.title), el('p', { class: 'desc' }, a.description), el('div', { class: 'actions' }, open, call));
      slide.style.setProperty('--a', a.accent);
      slide.style.setProperty('--ink', a.ink);
      // Only the middle set is for assistive tech and the keyboard; the others are copies.
      if (sets > 1 && c !== 1) { slide.setAttribute('aria-hidden', 'true'); for (const b of [orb, open, call]) b.tabIndex = -1; }
      track.append(slide);
      open.onclick = () => openAgent(a.name, { origin: rectCentre(orb) });
      call.onclick = () => callAgent(a.name, rectCentre(orb));
      gesture(orb, a);
    });
    S.slides = [...track.children]; S.bgEls = [...bgs.children]; S.dotEls = [...dots.children];
    S.shown = false;
    if (!S.wired) {
      S.wired = true;
      track.addEventListener('scroll', () => { S.raf ||= requestAnimationFrame(frame); clearTimeout(S.settle); S.settle = setTimeout(recenter, 140); }, { passive: true });
      track.addEventListener('scrollend', recenter);
      addEventListener('resize', () => go(S.idx, true));
    }
    track.scrollTo({ left: (loops() ? n : 0) * track.clientWidth, behavior: 'instant' });
    frame();
    refreshAll();
  }
  const slideOf = (i) => S.slides[(loops() ? S.n : 0) + i];
  const rectCentre = (n) => { const r = n.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  function frame() {
    S.raf = 0;
    const track = $('track'), w = track.clientWidth || 1;
    const pos = track.scrollLeft / w;
    const n = S.n, bg = new Array(n).fill(0);
    S.slides.forEach((s, j) => {
      const d = j - pos, ad = Math.min(1.5, Math.abs(d));
      s.style.setProperty('--d', d.toFixed(3));
      s.style.setProperty('--ad', ad.toFixed(3));
      const i = j % n;
      bg[i] = Math.max(bg[i], Math.max(0, 1 - Math.abs(d) * 1.1));
    });
    S.bgEls.forEach((b, i) => (b.style.opacity = String(bg[i])));
    const idx = ((Math.round(pos) % n) + n) % n;
    if (idx !== S.idx || !S.shown) {
      const first = !S.shown;
      S.idx = idx; S.shown = true;
      S.dotEls.forEach((d, i) => d.setAttribute('aria-selected', String(i === idx)));
      const a = S.agents[idx];
      document.documentElement.style.setProperty('--a', a.accent);
      document.querySelector('meta[name=theme-color]').content = getComputedStyle(document.body).backgroundColor;
      if (!first) { buzz(8); say(`${a.title}. ${a.description}`); }
      localStorage.setItem('hub_last', JSON.stringify({ agent: a.name, open: S.workOpen }));
    }
  }
  // Brings agent i to the centre, through the nearest copy so the carousel takes the short way round.
  function go(i, instant) {
    const n = S.agents.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    const w = $('track').clientWidth || 1;
    let j = i;
    if (loops()) {
      const pos = $('track').scrollLeft / w;
      j = instant ? n + i : [i, n + i, 2 * n + i].reduce((best, c) => (Math.abs(c - pos) < Math.abs(best - pos) ? c : best));
    }
    $('track').scrollTo({ left: j * w, behavior: instant || reduce ? 'instant' : 'smooth' });
  }
  // One step sideways from where the carousel is; wraps at either end.
  function step(delta) {
    const w = $('track').clientWidth || 1;
    const j = Math.round($('track').scrollLeft / w) + delta;
    const max = loops() ? S.n * SETS - 1 : S.n - 1;
    $('track').scrollTo({ left: Math.max(0, Math.min(max, j)) * w, behavior: reduce ? 'instant' : 'smooth' });
  }
  // Once a scroll has settled outside the middle set, jump one set back: same picture, so no visible change.
  function recenter() {
    if (!loops()) return;
    const track = $('track'), w = track.clientWidth || 1, n = S.n;
    const pos = track.scrollLeft / w;
    if (Math.abs(pos - Math.round(pos)) > 0.02) return; // still moving
    const j = Math.round(pos);
    if (j >= n && j < 2 * n) return;
    track.style.scrollSnapType = 'none';
    track.scrollTo({ left: (j < n ? j + n : j - n) * w, behavior: 'instant' });
    requestAnimationFrame(() => (track.style.scrollSnapType = ''));
  }
  // A mouse wheel scrolls up and down: turn it into a step sideways.
  let wheelLock = 0;
  $('track').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || Math.abs(e.deltaY) < 8) return;
    e.preventDefault();
    if (Date.now() - wheelLock < 380) return;
    wheelLock = Date.now();
    step(Math.sign(e.deltaY));
  }, { passive: false });

  // Gestures on the centred agent: tap = open, swipe up = open, hold = call. Sideways swipes scroll the carousel.
  function gesture(orb, a) {
    let g;
    const ring = orb.nextElementSibling;
    const reset = () => {
      if (!g) return;
      clearTimeout(g.timer);
      orb.classList.remove('holding', 'pulling', 'armed');
      orb.style.transform = '';
      orb.parentElement.style.zIndex = '';
      g = undefined;
    };
    orb.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      g = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: '', t: Date.now() };
      if (S.canCall) {
        g.timer = setTimeout(() => {
          if (!g || g.mode) return;
          g.mode = 'call';
          buzz([20, 40, 30]);
          const origin = rectCentre(orb);
          reset();
          callAgent(a.name, origin);
        }, 650);
        // The ring starts filling after a short beat, so a plain tap never flashes it.
        g.ringTimer = setTimeout(() => g && !g.mode && orb.classList.add('holding'), 140);
      }
    });
    addEventListener('pointermove', (e) => {
      if (!g || e.pointerId !== g.id || g.mode === 'call') return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.mode) {
        if (Math.hypot(dx, dy) < 9) return;
        clearTimeout(g.timer); clearTimeout(g.ringTimer);
        orb.classList.remove('holding');
        if (Math.abs(dy) > Math.abs(dx) && dy < 0) { g.mode = 'pull'; orb.classList.add('pulling'); orb.parentElement.style.zIndex = '5'; try { orb.setPointerCapture(g.id); } catch {} }
        else return reset(); // sideways: the carousel takes over
      }
      const up = Math.max(0, -dy);
      orb.style.transform = `translateY(${-up * .9}px) scale(${1 + Math.min(up, 220) / 520})`;
      const armed = up > 110;
      if (armed !== orb.classList.contains('armed')) { orb.classList.toggle('armed', armed); buzz(armed ? 14 : 6); $('hint').textContent = armed ? T.release : T.hint; }
    });
    const up = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const was = g, armed = orb.classList.contains('armed');
      const origin = rectCentre(orb);
      const quick = Date.now() - was.t < 500 && !was.mode && Math.hypot(e.clientX - was.x, e.clientY - was.y) < 9;
      reset();
      $('hint').textContent = T.hint;
      if (e.type === 'pointercancel') return;
      if (was.mode === 'pull' && armed) { buzz([12, 24, 12]); openAgent(a.name, { origin }); }
      else if (quick) openAgent(a.name, { origin });
    };
    orb.addEventListener('pointerup', up);
    orb.addEventListener('pointercancel', up);
    orb.addEventListener('contextmenu', (e) => e.preventDefault());
    orb.addEventListener('click', (e) => e.detail === 0 && openAgent(a.name, { origin: rectCentre(orb) })); // keyboard / screen reader
  }

  function refreshAll() {
    S.slides?.forEach((slide) => {
      const a = S.agents[+slide.dataset.i];
      if (!a) return;
      const p = S.panes.get(a.name);
      const wrap = slide.querySelector('.orbwrap');
      wrap.querySelectorAll('.badge, .live').forEach((n) => n.remove());
      if (p?.unread) wrap.append(el('span', { class: 'badge', 'aria-label': T.unread }, String(p.unread)));
      else if (p?.busy) wrap.append(el('span', { class: 'live', 'aria-label': T.working }));
      const onCall = S.call?.agent === a.name;
      const cb = slide.querySelector('.callbtn');
      cb.classList.toggle('on', onCall);
      cb.setAttribute('aria-label', `${onCall ? T.ret : T.callTo} ${a.title}`);
      slide.querySelector('.open').textContent = onCall ? T.inCall : T.open;
    });
    renderChips();
    renderPill();
  }

  // ---- workspace (persistent iframes) ----
  function ensurePane(name, call) {
    let p = S.panes.get(name);
    if (p) return p;
    const a = agentOf(name);
    const frame = el('iframe', { title: a.title, allow: 'microphone; autoplay; clipboard-write; fullscreen' });
    frame.src = `/a/${name}/?embed=1${call ? '&call=1' : ''}`;
    const node = el('div', { class: 'pane' }, frame, el('div', { class: 'loading' }, el('img', { src: a.icon, alt: '' })));
    p = { name, node, frame, busy: false, unread: 0, ready: false };
    frame.addEventListener('load', () => { p.ready = true; node.classList.add('ready'); send(name, { cmd: 'visible', v: S.active === name && S.workOpen }); });
    $('panes').append(node);
    S.panes.set(name, p);
    return p;
  }
  const send = (name, msg) => { try { S.panes.get(name)?.frame.contentWindow?.postMessage({ sunnyHub: 1, ...msg }, location.origin); } catch {} };

  function showPane(name) {
    S.active = name;
    for (const [n, p] of S.panes) {
      p.node.classList.toggle('active', n === name);
      send(n, { cmd: 'visible', v: n === name && S.workOpen });
    }
    const p = S.panes.get(name);
    if (p) { p.unread = 0; }
    const a = agentOf(name);
    $('work').style.setProperty('--a', a.accent);
    document.querySelector('meta[name=theme-color]').content = getComputedStyle($('work').querySelector('.strip')).backgroundColor;
    refreshAll();
    chipsScroll();
  }

  function reveal(origin, closing) {
    const w = $('work');
    if (reduce || !origin || !w.animate) return Promise.resolve();
    const [x, y] = origin;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 20;
    const frames = [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`];
    return w.animate({ clipPath: closing ? frames.reverse() : frames }, { duration: closing ? 380 : 560, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {});
  }

  async function openAgent(name, { origin, call, silent } = {}) {
    if (!agentOf(name)) return;
    const fresh = !S.panes.has(name);
    const callNow = !!call && S.canCall;
    const wasOpen = S.workOpen;
    // A call on another agent keeps going: its iframe stays alive, hidden.
    ensurePane(name, callNow && fresh);
    S.workOpen = true;
    document.body.classList.add('working');
    $('work').classList.add('on'); $('work').inert = false;
    showPane(name);
    $('stage').classList.add('under');
    if (!wasOpen) {
      if (!silent) history.pushState({ agent: name }, '', `#${name}`);
      reveal(origin);
    } else history.replaceState({ agent: name }, '', `#${name}`);
    if (callNow && !fresh) {
      if (S.call?.agent === name) send(name, { cmd: 'call-show' });
      else send(name, { cmd: 'call-start' });
    }
    localStorage.setItem('hub_last', JSON.stringify({ agent: name, open: true }));
    say(agentOf(name).title);
    buzz(10);
  }

  async function callAgent(name, origin) {
    if (!S.canCall) return;
    if (S.call && S.call.agent !== name) { send(S.call.agent, { cmd: 'call-end' }); await new Promise((r) => setTimeout(r, 250)); }
    if (S.call?.agent === name) return openAgent(name, { origin });
    S.pending = name; // the pane reports the call as soon as it starts
    return openAgent(name, { origin, call: true });
  }

  async function closeWork(fromPop) {
    if (!S.workOpen) return;
    S.workOpen = false;
    document.body.classList.remove('working');
    for (const n of S.panes.keys()) send(n, { cmd: 'visible', v: false });
    $('stage').classList.remove('under');
    const a = S.active && S.slides ? S.agents.findIndex((x) => x.name === S.active) : -1;
    if (a >= 0) go(a, true);
    const origin = a >= 0 ? rectCentre(slideOf(a).querySelector('.orb')) : [innerWidth / 2, innerHeight / 2];
    document.documentElement.style.setProperty('--a', agentOf(S.active)?.accent ?? '');
    await reveal(origin, true);
    $('work').classList.remove('on'); $('work').inert = true;
    document.querySelector('meta[name=theme-color]').content = getComputedStyle(document.body).backgroundColor;
    localStorage.setItem('hub_last', JSON.stringify({ agent: S.active, open: false }));
    if (!fromPop && location.hash) history.back();
    refreshAll();
  }
  $('backBtn').onclick = () => (buzz(), closeWork());
  addEventListener('popstate', () => {
    const n = location.hash.slice(1);
    if (n && agentOf(n)) openAgent(n, { silent: true }); else closeWork(true);
  });

  function closePane(name) {
    const p = S.panes.get(name);
    if (!p || S.call?.agent === name) return;
    p.node.remove(); S.panes.delete(name);
    if (S.active === name) {
      const next = [...S.panes.keys()].pop();
      if (next) showPane(next); else closeWork();
    }
    refreshAll();
  }

  function renderChips() {
    const box = $('chips');
    box.replaceChildren();
    for (const [name, p] of S.panes) {
      const a = agentOf(name);
      const chip = el('button', { class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(S.active === name), 'aria-label': a.title }, el('img', { src: a.icon, alt: '' }), el('span', { class: 'nm' }, a.title));
      chip.style.setProperty('--a', a.accent);
      const inCall = S.call?.agent === name;
      if (inCall) chip.append(el('i', { class: 'st call', 'aria-label': T.inCall }));
      else if (p.unread) chip.append(el('i', { class: 'st unread' }, String(p.unread)));
      else if (p.busy) chip.append(el('i', { class: 'st busy', 'aria-label': T.working }));
      if (S.active === name && S.panes.size > 1 && !inCall) {
        const x = el('span', { class: 'x', role: 'button', 'aria-label': T.close }, '×');
        x.onclick = (ev) => { ev.stopPropagation(); buzz(); closePane(name); };
        chip.append(x);
      }
      chip.onclick = () => { if (S.active !== name) { buzz(8); showPane(name); history.replaceState({ agent: name }, '', `#${name}`); } };
      box.append(chip);
    }
  }
  const chipsScroll = () => $('chips').querySelector('[aria-selected=true]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduce ? 'instant' : 'smooth' });
  $('addBtn').onclick = () => openSearch();

  // ---- call pill ----
  let pillTimer;
  function renderPill() {
    const c = S.call;
    // Hidden when the call screen itself is what you're looking at.
    const watching = c && S.workOpen && S.active === c.agent && c.shown;
    $('pill').hidden = !c || watching;
    document.body.classList.toggle('pilled', !!c && !watching);
    if (!c) return clearInterval(pillTimer);
    const a = agentOf(c.agent);
    $('pill').style.setProperty('--a', a.accent);
    $('pill').querySelector('img').src = a.icon;
    $('pill').querySelector('b').textContent = a.title;
    $('pillMute').classList.toggle('muted', !!c.muted);
    $('pillMute').setAttribute('aria-pressed', String(!!c.muted));
    const tick = () => {
      const sec = Math.max(0, Math.floor((Date.now() - (c.started || Date.now())) / 1000));
      $('pill').querySelector('small').textContent = `${T.states[c.state] ?? T.inCall} · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    };
    tick(); clearInterval(pillTimer); pillTimer = setInterval(tick, 1000);
  }
  $('pillMain').onclick = () => { if (S.call) { buzz(); openAgent(S.call.agent, { origin: [innerWidth / 2, 40] }); send(S.call.agent, { cmd: 'call-show' }); } };
  $('pillMute').onclick = () => { if (S.call) { buzz(); send(S.call.agent, { cmd: 'call-mute' }); } };
  $('pillEnd').onclick = () => { if (S.call) { buzz([10, 30, 10]); send(S.call.agent, { cmd: 'call-end' }); } };
  $('pillSwitch').onclick = () => openSearch('call');

  // ---- messages from the agent apps ----
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data?.sunny) return;
    const m = e.data;
    const p = S.panes.get(m.agent);
    if (!p || e.source !== p.frame.contentWindow) return;
    switch (m.type) {
      case 'call':
        if (m.on) S.call = { agent: m.agent, state: m.state, started: m.started, muted: m.muted, shown: m.shown };
        else if (S.call?.agent === m.agent) { S.call = null; buzz([10, 30, 10]); }
        refreshAll();
        break;
      case 'busy': p.busy = !!m.busy; refreshAll(); break;
      case 'unread': p.unread = m.n; if (m.n) buzz([8, 30, 8]); refreshAll(); break;
    }
  });

  // ---- quick search ----
  let results = [], sel = 0, searchMode = 'open';
  function openSearch(mode = 'open') {
    searchMode = mode;
    $('search').hidden = false; $('q').value = ''; $('q').focus();
    filter(); buzz(6);
  }
  const closeSearch = () => { $('search').hidden = true; $('q').blur(); };
  function filter() {
    const q = $('q').value.trim().toLowerCase();
    results = S.agents.filter((a) => !q || a.title.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    sel = 0; drawResults();
  }
  function drawResults() {
    const ul = $('results');
    ul.replaceChildren();
    results.forEach((a, i) => {
      const li = el('li', { role: 'option', 'aria-selected': String(i === sel) }, el('img', { src: a.icon, alt: '' }), el('div', {}, el('b', {}, a.title), el('small', {}, a.description)));
      li.style.setProperty('--a', a.accent);
      if (S.canCall) { const ph = el('button', { class: 'ph', type: 'button', 'aria-label': `${T.callTo} ${a.title}` }); ph.append(svg(PHONE)); ph.onclick = (ev) => { ev.stopPropagation(); choose(a, 'call'); }; li.append(ph); }
      li.onclick = () => choose(a, searchMode);
      ul.append(li);
    });
  }
  function choose(a, mode) {
    closeSearch();
    const origin = [innerWidth / 2, innerHeight / 3];
    if (!S.workOpen) go(S.agents.indexOf(a), true);
    mode === 'call' ? callAgent(a.name, origin) : openAgent(a.name, { origin });
  }
  $('q').addEventListener('input', filter);
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length); drawResults(); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); choose(results[sel], e.shiftKey ? 'call' : searchMode); }
  });
  $('search').addEventListener('pointerdown', (e) => e.target === $('search') && closeSearch());
  $('searchBtn').onclick = () => openSearch();

  // ---- keyboard ----
  addEventListener('keydown', (e) => {
    const k = e.key;
    if (!$('search').hidden) return k === 'Escape' ? closeSearch() : undefined;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'k') { e.preventDefault(); return openSearch(); }
    if (e.target.closest?.('input, textarea')) return;
    if (k === '/') { e.preventDefault(); return openSearch(); }
    if (S.workOpen) {
      if (k === 'Escape') return closeWork();
      if (e.altKey && (k === 'ArrowRight' || k === 'ArrowLeft')) {
        const names = [...S.panes.keys()], i = names.indexOf(S.active);
        const n = names[(i + (k === 'ArrowRight' ? 1 : -1) + names.length) % names.length];
        if (n) { e.preventDefault(); showPane(n); }
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const a = S.agents[S.idx];
    if (!a) return;
    if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (k === 'Home') go(0); else if (k === 'End') go(S.agents.length - 1);
    else if (/^[1-9]$/.test(k) && S.agents[+k - 1]) go(+k - 1);
    else if (k === 'Enter' && document.activeElement?.tagName !== 'BUTTON') openAgent(a.name, { origin: rectCentre(slideOf(S.idx).querySelector('.orb')) });
    else if (k.toLowerCase() === 'c') callAgent(a.name, rectCentre(slideOf(S.idx).querySelector('.orb')));
  });

  // ---- start: pick up where you left off ----
  function resume() {
    let last; try { last = JSON.parse(localStorage.getItem('hub_last') || ''); } catch {}
    const hash = location.hash.slice(1);
    // A link wins, then the main agent chosen on this device, then where you left off.
    const target = agentOf(hash) ? hash : (agentOf(S.main) ? S.main : undefined) ?? last?.agent;
    if (target && agentOf(target)) go(S.agents.indexOf(agentOf(target)), true);
    if (agentOf(hash)) openAgent(hash, { silent: true });
    else if (last?.open && agentOf(last.agent)) { history.pushState({ agent: last.agent }, '', `#${last.agent}`); openAgent(last.agent, { silent: true }); }
  }

  // ---- install + service worker ----
  let installEvent;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('installBtn').textContent = T.install; $('installBtn').hidden = false; });
  $('installBtn').onclick = async () => { installEvent?.prompt(); await installEvent?.userChoice.catch(() => {}); installEvent = undefined; $('installBtn').hidden = true; };
  addEventListener('appinstalled', () => ($('installBtn').hidden = true));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/a/hub-sw.js', { scope: '/a/' }).catch(() => {});
  load();
})();
