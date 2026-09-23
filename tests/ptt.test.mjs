// Push-to-talk against a stand-in recogniser that behaves like Chrome on a Pixel: while the page holds the
// microphone for its level meter, the recogniser hears only silence — no words and no error. Which is exactly
// what a first flight on a Pixel showed: the meter moving, and "Not recognised" every time.
import test from 'node:test';
import assert from 'node:assert/strict';

const live = new Set();                          // our getUserMedia tracks that are still open
const instances = [];
let nextStartThrows = false;
const WORDS = 'golf charlie zulu india alpha';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakeRecognition {
  constructor() { this.listeners = {}; this.aborted = false; instances.push(this); }
  addEventListener(ev, f) { (this.listeners[ev] ||= []).push(f); }
  fire(ev) { for (const f of this.listeners[ev] || []) f({}); }
  start() {
    if (nextStartThrows) { nextStartThrows = false; const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
    const deaf = live.size > 0;                  // the page has the microphone: silence, and no error either
    setTimeout(() => {
      if (deaf || this.aborted) return;
      this.fire('audiostart'); this.fire('soundstart'); this.fire('speechstart');
      this.onresult?.({ results: [Object.assign([{ transcript: WORDS }], { isFinal: true })] });
    }, 5);
  }
  stop() { setTimeout(() => this.onend?.(), 5); }
  abort() { this.aborted = true; setTimeout(() => this.onend?.(), 1); }
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  userAgent: 'node', mediaDevices: { getUserMedia: async () => { const t = { stop() { live.delete(t); } }; live.add(t); return { getTracks: () => [t] }; } },
} });
globalThis.window = {
  SpeechRecognition: FakeRecognition,
  AudioContext: class { createAnalyser() { return { fftSize: 0, getFloatTimeDomainData() {} }; } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } close() {} },
  addEventListener() {}, removeEventListener() {},
};
globalThis.document = { activeElement: null };

const { PushToTalk } = await import('../js/ptt.js');

function make(opts) {
  const got = [], notices = [];
  const ptt = new PushToTalk({ button: { addEventListener() {} }, onUp: (text, meta) => got.push({ text, meta }), onNotice: t => notices.push(t), ...opts });
  return { ptt, got, notices };
}
async function press(ptt, ms = 250) { ptt.down(); await sleep(ms); await ptt.up(); }

test('on Android the recogniser gets the microphone, and each press gets a fresh one', async () => {
  const { ptt, got } = make({ exclusive: true });
  await ptt.init();
  const before = instances.length;
  await press(ptt); await press(ptt);
  assert.deepEqual(got.map(g => g.text), [WORDS, WORDS]);
  assert.equal(instances.length - before, 2, 'a fresh recogniser for each press');
  await sleep(10);
  assert.ok(ptt.stream, 'the meter has its microphone back between transmissions');
  ptt.destroy();
});

test('elsewhere, a recogniser starved of sound is noticed and given the microphone', async () => {
  const { ptt, got, notices } = make({ exclusive: false });
  await ptt.init();
  await press(ptt, 60);
  assert.equal(got[0].text, '');
  assert.equal(got[0].meta.error, 'no sound reached the speech recogniser');
  assert.ok(ptt.exclusive && notices.length === 1, 'it says what it has done');
  await press(ptt);
  assert.equal(got[1].text, WORDS, 'and the next transmission is heard');
  ptt.destroy();
});

test('a recogniser that will not start says so, instead of failing silently', async () => {
  const { ptt, got } = make({ exclusive: true });
  await ptt.init();
  nextStartThrows = true;
  await press(ptt);
  assert.match(got[0].meta.error, /could not start: InvalidStateError/);
  assert.match(got[0].meta.trace, /start-threw/);
  ptt.destroy();
});

test('ending a flight stops its recogniser and lets go of the microphone', async () => {
  const { ptt } = make({ exclusive: true });
  await ptt.init();
  ptt.down(); await sleep(200);
  const rec = instances.at(-1);
  ptt.destroy();
  assert.equal(rec.aborted, true, 'a recogniser outliving its flight would hold the service');
  assert.equal(ptt.stream, null);
  assert.equal(live.size, 0);
});
