import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

// Run sw.js against a fake service-worker global holding the given caches.
function load(cacheNames = []) {
  const handlers = {}, deleted = [];
  const ctx = vm.createContext({
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { keys: async () => cacheNames, delete: async k => { deleted.push(k); return true; } },
    location: { origin: 'https://crystalmark.co.uk' }, URL,
  });
  vm.runInContext(readFileSync(new URL('sw.js', root), 'utf8'), ctx);
  return { handlers, deleted, CACHE: vm.runInContext('CACHE', ctx), FILES: vm.runInContext('FILES', ctx) };
}

test("service worker: activating leaves the other crystalmark.co.uk apps' caches alone", async () => {
  const { handlers, deleted, CACHE } = load(['flightlog-shell-v2', 'pollyglot-v5', 'rt-trainer-old', 'rt-trainer-v1']);
  assert.ok(CACHE.startsWith('rt-trainer-'), 'the cache name must carry the prefix the clean-up looks for');
  let done;
  handlers.activate({ waitUntil: p => { done = p; } });
  await done;
  assert.deepEqual(deleted, ['rt-trainer-old', 'rt-trainer-v1'].filter(k => k !== CACHE));
});

test('service worker: precaches every app file, and only files that exist', () => {
  const { FILES } = load();
  for (const f of FILES.filter(f => f !== './')) assert.ok(existsSync(new URL(f, root)), `sw.js precaches ${f}, which is missing`);
  const modules = readdirSync(new URL('js/', root), { recursive: true }).filter(f => f.endsWith('.js')).map(f => `js/${f}`);
  for (const m of modules) assert.ok(FILES.includes(m), `${m} is not in sw.js FILES, so the app breaks offline`);
});

// Run sw.js's fetch handler against a fake network and cache.
function serve(network) {
  const kept = new Map(), handlers = {};
  const ctx = vm.createContext({
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { keys: async () => [], delete: async () => true, match: async req => kept.get(req.url),
      open: async () => ({ put: async (req, res) => { kept.set(req.url, res); }, addAll: async () => {} }) },
    fetch: async req => network(req), location: { origin: 'https://crystalmark.co.uk' }, URL,
  });
  vm.runInContext(readFileSync(new URL('sw.js', root), 'utf8'), ctx);
  return async path => {
    let response; const waits = [];
    handlers.fetch({ request: { url: `https://crystalmark.co.uk/rt/${path}`, method: 'GET' }, respondWith: p => { response = p; }, waitUntil: p => waits.push(p) });
    const r = await response; await Promise.all(waits); return r;
  };
}
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, body, clone: () => answer(status, body) });

// One CloudFront hiccup while online replaced the good copy with the error page, and offline that was all there was:
// the app would not start without signal.
test('service worker: an error from the server never replaces the good copy, and gets the cached one instead', async () => {
  let net = () => answer(200, 'good');
  const get = serve(req => net(req));
  assert.equal((await get('js/engine.js')).body, 'good');
  net = () => answer(503, 'CloudFront error page');
  assert.equal((await get('js/engine.js')).body, 'good', 'a server error gets the cached copy');
  net = () => { throw new TypeError('offline'); };
  assert.equal((await get('js/engine.js')).body, 'good', 'and offline, the good copy is still there');
  net = () => answer(404, 'not found');
  assert.equal((await get('js/nothing.js')).status, 404, 'a file that is not there is passed on as it is');
});
