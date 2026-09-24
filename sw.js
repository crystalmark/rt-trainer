// Offline shell: the app loads without signal. Speech recognition in Chrome still needs a
// connection (it runs on Google's servers), so transmitting needs data.
const CACHE = 'rt-trainer-v5';          // v5: v4 could be holding an error page in place of a file
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/main.js', 'js/engine.js', 'js/matcher.js', 'js/normalize.js', 'js/radio.js', 'js/ptt.js', 'js/claude.js',
  'js/debrief.js', 'js/heard.js', 'js/config.js', 'js/geo.js', 'js/route.js', 'js/map.js', 'js/data/vrps.js', 'js/areas/index.js', 'js/areas/leeds.js', 'js/areas/edinburgh.js', 'js/areas/manchester.js',
  'js/scenarios/index.js', 'js/scenarios/common.js', 'js/scenarios/leeds-transit.js', 'js/scenarios/leeds-basic.js',
  'js/scenarios/edinburgh-transit.js', 'js/scenarios/carlisle.js', 'js/scenarios/scottish-info.js', 'js/scenarios/custom.js',
  'js/scenarios/listen.js', 'js/scenarios/forth-bridges.js',
];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
// Caches belong to the whole origin, and crystalmark.co.uk also hosts Flight Log and Pollyglot: only clear our own.
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('rt-trainer-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// Network first so updates show up straight away; the cache when offline, or when the server answers with an error.
// Only a good answer is kept: a CloudFront error page used to replace the good copy, and offline it was all there was.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy))); return r; }
    return r.status >= 500 ? caches.match(e.request).then(hit => hit || r) : r;
  }).catch(() => caches.match(e.request)));
});
