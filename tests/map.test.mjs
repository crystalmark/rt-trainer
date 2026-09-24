// The moving map against a stand-in for the SVG DOM, counting what it writes: how often the picture is redrawn is
// the battery on a phone held awake for a whole flight, which is not something a Node test can see any other way.
import test from 'node:test';
import assert from 'node:assert/strict';

let writes = 0;
const view = { w: 341, h: 300 };                 // the map's size on screen: 0 × 0 while its screen is hidden
class El {
  constructor(tag) {
    this.tag = tag; this.attrs = {}; this.children = []; this.style = {}; this.isConnected = true;
    const on = new Set();
    this.classList = { add: (...c) => c.forEach(x => on.add(x)), remove: (...c) => c.forEach(x => on.delete(x)),
      toggle: (c, force) => ((force ?? !on.has(c)) ? on.add(c) : on.delete(c)), contains: c => on.has(c) };
  }
  setAttribute(k, v) { writes++; this.attrs[k] = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; }
  addEventListener() {}
  setPointerCapture() {}
  querySelector() { return null; }
  getBoundingClientRect() { return { width: view.w, height: view.h, left: 0, top: 0 }; }
}
globalThis.document = { createElementNS: (ns, tag) => new El(tag) };
const observers = [];
globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
const resized = (w, h) => { view.w = w; view.h = h; for (const o of observers) o.cb([]); };
let frames = [], id = 0, ticks = 0;
globalThis.requestAnimationFrame = cb => { frames.push({ id: ++id, cb }); return id; };
globalThis.cancelAnimationFrame = n => { frames = frames.filter(f => f.id !== n); };

// Animation frames at 60 Hz, as a browser gives them to a page on screen, for ms of real time.
const play = ms => new Promise(resolve => {
  const end = performance.now() + ms;
  const iv = setInterval(() => {
    const due = frames; frames = [];
    for (const f of due) { ticks++; f.cb(performance.now()); }
    if (performance.now() >= end) { clearInterval(iv); resolve(); }
  }, 1000 / 60);
});
const counted = async (ms, during = () => {}) => { writes = 0; ticks = 0; await Promise.all([play(ms), during()]); return { writes, ticks }; };

const { MovingMap } = await import('../js/map.js');
const { areaById } = await import('../js/areas/index.js');

function newMap() {
  const svg = new El('svg'), root = new El('div');
  root.querySelector = sel => (sel === 'svg' ? svg : null);
  Object.defineProperty(root, 'offsetParent', { get: () => (view.w ? {} : null) });     // display: none has none
  const map = new MovingMap(root);
  map.setArea(areaById('leeds'));
  return map;
}
// A microlight at 45 kt, straight and level, with a fix once a second as the engine sends them.
const fix = (x, extra = {}) => ({ x, y: 0, track: 90, speedKt: 45, rate: 1, orbiting: false, ...extra });
const cruise = (map, ms) => async () => {
  for (let t = 0, x = 0; t < ms; t += 1000, x += 45 / 3600) { map.update(fix(x)); await new Promise(r => setTimeout(r, 1000)); }
};

test('flying straight, the map is redrawn only when the aircraft has moved a quarter of a pixel', async () => {
  resized(341, 300);
  const map = newMap();
  map.update(fix(0));
  await play(300);                                         // the first picture, the area's labels and all
  const { writes: w, ticks: t } = await counted(2000, cruise(map, 2000));
  // 45 kt at 12 nm across 341 px is a third of a pixel a second. It was 3 writes a frame, every frame: 360 in these 2 s.
  assert.ok(w <= 20, `${w} attribute writes in 2 s`);
  assert.ok(t <= 40, `${t} frames asked for in 2 s`);
  const [, x] = map.ac.attrs.transform.match(/translate\(([-\d.]+)/);
  assert.ok(Math.abs(Number(x) - map.position(performance.now()).x) <= 0.25 * 12 / 341 + 1e-3, 'drawn within a quarter of a pixel');
  map.destroy();
});

test('a map on a hidden screen stops asking for frames, and draws again when shown', async () => {
  resized(341, 300);
  const map = newMap();
  map.update(fix(0));
  await play(300);
  resized(0, 0);                                           // another screen: this one is display: none
  const hidden = await counted(1000, cruise(map, 1000));
  assert.ok(hidden.ticks <= 1 && hidden.writes <= 1, `hidden: ${JSON.stringify(hidden)}`);     // it used to go on at 60 a second
  resized(341, 300);
  const shown = await counted(300);
  assert.ok(shown.ticks >= 1 && shown.writes >= 1, `shown again: ${JSON.stringify(shown)}`);
  map.destroy();
});

test('a turn is drawn on every frame, and the map settles on the new track', async () => {
  resized(341, 300);
  const map = newMap();
  map.update(fix(0));
  await play(300);
  map.update(fix(0.001, { track: 180 }));                  // a waypoint: 90° to turn, at 90° a second
  const turning = await counted(900);
  assert.ok(turning.ticks >= 40, `${turning.ticks} frames in the turn`);
  await play(400);
  assert.equal(map.heading, 180);
  const settled = await counted(1000);
  assert.ok(settled.ticks <= 20, `${settled.ticks} frames a second after the turn`);
  map.destroy();
});
