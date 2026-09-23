// Cheap structural checks on the one file the Node tests otherwise never see. Neither of these needs a DOM:
// they are here because a missing id and a toast nobody can see both look exactly like "the button does nothing".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
