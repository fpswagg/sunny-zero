// Minimal service worker: makes the agent app installable and keeps its shell available offline.
const CACHE = 'agent-app-v2';
self.addEventListener('install', (e) => {
  const base = self.registration.scope;
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([base, `${base}app.js`, `${base}voice.js`, `${base}app.css`, `${base}icon.svg`]).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/') || url.pathname.endsWith('/ws')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
