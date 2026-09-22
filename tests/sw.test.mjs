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
