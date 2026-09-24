// Cheap structural checks on the one file the Node tests otherwise never see. Neither of these needs a DOM:
// they are here because a missing id and a toast nobody can see both look exactly like "the button does nothing".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');

test('every element main.js reaches for exists in index.html', () => {
  const ids = new Set([...main.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
  const present = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));
  const missing = [...ids].filter(id => !present.has(id));
  assert.deepEqual(missing, [], `main.js uses ids that are not in the page: ${missing.join(', ')}`);
});

test('the toast is outside the screens, so it can be seen from any of them', () => {
  // [hidden] { display: none !important } is applied to every screen but the current one, so a toast raised
  // from the debrief while it sat inside <main id="flight"> was invisible: the button "did nothing".
  const screens = [...html.matchAll(/<main id="([\w-]+)"[^>]*class="screen[^"]*"[\s\S]*?<\/main>/g)];
  assert.ok(screens.length >= 4, 'found the screens');
  for (const [block, id] of screens) assert.ok(!/id="toast"/.test(block), `the toast is trapped inside #${id}`);
  assert.match(html, /id="toast"/, 'and it still exists');
});

test('a toast never takes a press meant for what is under it', () => {
  // It sat on the PTT button for 4.5 s and a press there did nothing, "try again" toasts included.
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const rule = css.match(/^\.toast\s*\{[^}]*\}/m)?.[0] || '';
  assert.match(rule, /pointer-events:\s*none/);
});

// The page runs under a Content-Security-Policy, which it can only because nothing in it is inline: no inline scripts
// or event handlers, no style attributes, no eval. Add one and the browser quietly refuses it, and a button stops working.
test('the page has a CSP ahead of what it governs, and nothing inline for it to refuse', () => {
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] || '';
  assert.match(csp, /(^|; )script-src 'self'(;|$)/);
  assert.match(csp, /(^|; )connect-src https:\/\/api\.anthropic\.com(;|$)/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.search(/<link|<script/), 'before the first stylesheet or script');
  const body = html.replace(/<meta[^>]*>/g, '');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(body), 'an inline script');
  assert.ok(!/\son[a-z]+\s*=/i.test(body), 'an inline event handler');
  assert.ok(!/\sstyle\s*=/i.test(body), 'a style attribute');
  const dir = new URL('../js/', import.meta.url);
  for (const f of readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/\sstyle=["'$]|setAttribute\(\s*['"]style|\son[a-z]+=["']|\beval\(|new Function\(/.test(src), `${f}: something the CSP would refuse`);
  }
});

test('storage is reached one way, which survives site data being blocked', () => {
  // Reading window.localStorage itself throws when site data is blocked: done directly, it took the debrief down.
  const direct = main.split('\n').filter(l => /\blocalStorage\b/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(direct.map(l => l.trim()), ['const LS = (() => { try { return window.localStorage; } catch { return null; } })();']);
});
