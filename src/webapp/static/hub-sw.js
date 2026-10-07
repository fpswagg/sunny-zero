// Hub service worker: keeps the hub shell (page, script, style, icon) available offline.
// Agent apps have their own, more specific workers under /a/<agent>/.
const CACHE = 'agents-hub-v2';
const SHELL = ['/a/', '/a/hub.js', '/a/hub.css', '/a/hub-icon.svg', '/a/hub.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) =>
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('agents-hub-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())),
);
const own = (p) => SHELL.includes(p) || /^\/a\/hub-icon[-\w]*\.(png|svg)$/.test(p);
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Agent icons and the agent list are cached so the grid still shows offline.
  const cacheable = own(url.pathname) || /^\/a\/[a-z][a-z0-9-]+\/icon\.svg$/.test(url.pathname) || url.pathname === '/a/api/agents';
  if (!cacheable) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('/a/') : undefined)).then((r) => r || Response.error())),
  );
});
