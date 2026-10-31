// Service worker: cache the app shell so LifeOS opens offline. Bump VERSION when files change.
const VERSION = 'lifeos-v1.1.1';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/db.js', './js/ui.js', './js/report.js', './js/modules/index.js',
  './js/modules/dreams.js', './js/modules/weight.js', './js/modules/photos.js', './js/modules/notes.js',
  './js/modules/calendar.js', './js/modules/finances.js', './js/modules/tasks.js', './js/modules/goals.js',
  './js/modules/habits.js', './js/modules/ai.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache. Hosts like GitHub Pages serve files with max-age=600, so a plain
  // addAll() after a deploy can precache the previous version's files for up to ten minutes.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch API calls
  // stale-while-revalidate for same-origin shell files. The revalidation asks the server (cache: 'no-cache' =
  // conditional request) instead of trusting the HTTP cache, so a fresh deploy reaches the next load, not 10 minutes later.
  e.respondWith(caches.match(e.request).then((cached) => {
    const network = e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' });
    const fetched = network.then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone())); return res; }).catch(() => cached);
    return cached || fetched;
  }));
});
