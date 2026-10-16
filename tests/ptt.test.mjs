// Push-to-talk against a stand-in recogniser that behaves like Chrome on a Pixel: while the page holds the
// microphone for its level meter, the recogniser hears only silence — no words and no error. Which is exactly
// what a first flight on a Pixel showed: the meter moving, and "Not recognised" every time.
import test from 'node:test';
import assert from 'node:assert/strict';

const live = new Set();                          // our getUserMedia tracks that are still open
const instances = [];
let nextStartThrows = false;
const WORDS = 'golf charlie zulu india alpha';
const ANDROID_WORDS = 'golf charlie zulu india alpha microlight oxenhope ilkley skipton 1700 feet qnh 1018';
let android = false;
let gumDelay = 0;                                // how long getUserMedia takes to answer
let stopLatency = 5;                             // how long a stopped recogniser takes to finish
let said = WORDS;                                // what the desktop recogniser hears while the button is held
const sleep = ms => new Promise(r => setTimeout(r, ms));
const final = t => Object.assign([{ transcript: t }], { isFinal: true });

class FakeRecognition {
  constructor() { this.listeners = {}; this.aborted = false; this.stopped = false; instances.push(this); }
  addEventListener(ev, f) { (this.listeners[ev] ||= []).push(f); }
  fire(ev) { for (const f of this.listeners[ev] || []) f({}); }
  start() {
    if (nextStartThrows) { nextStartThrows = false; const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
    const deaf = live.size > 0;                  // the page has the microphone: silence, and no error either
    setTimeout(() => {
      if (deaf || this.aborted) return;
      this.fire('audiostart'); this.fire('soundstart'); this.fire('speechstart');
      if (!android) { this.onresult?.({ results: [final(said)] }); return; }
      // As on the Pixel: every result repeats the whole transmission so far, one word longer each time, and the
      // last words are still provisional when the button is let go.
      const words = ANDROID_WORDS.split(' '), results = [];
      for (let n = 1; n <= words.length - 2; n++) {
        results.push(Object.assign([{ transcript: words.slice(0, n).join(' ') }], { isFinal: true }));
        this.onresult?.({ results: [...results] });
      }
      this.onresult?.({ results: [...results, Object.assign([{ transcript: ANDROID_WORDS }], { isFinal: false })] });
    }, 5);
  }
  stop() { this.stopped = true; setTimeout(() => this.onend?.(), stopLatency); }
  abort() { this.aborted = true; setTimeout(() => this.onend?.(), 1); }
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  userAgent: 'node', mediaDevices: { getUserMedia: async () => {
    if (gumDelay) await sleep(gumDelay);
    const t = { stop() { live.delete(t); } }; live.add(t); return { getTracks: () => [t] };
  } },
} });
globalThis.window = {
  SpeechRecognition: FakeRecognition,
  AudioContext: class { createAnalyser() { return { fftSize: 0, getFloatTimeDomainData() {} }; } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } close() {} },
  addEventListener() {}, removeEventListener() {},
};
globalThis.document = { activeElement: null };

const { PushToTalk, continues, spoken } = await import('../js/ptt.js');

function make(opts) {
  const got = [], notices = [];
  const ptt = new PushToTalk({ button: { addEventListener() {} }, onUp: (text, meta) => got.push({ text, meta }), onNotice: t => notices.push(t), ...opts });
  return { ptt, got, notices };
}
async function press(ptt, ms = 250) { ptt.down(); await sleep(ms); await ptt.up(); }
// The one #ptt button every flight shares, keeping count of what is listening to it.
function sharedButton() {
  const on = new Set();
  return { on, addEventListener(type, f, opts) { on.add(f); opts?.signal?.addEventListener('abort', () => on.delete(f)); } };
}

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

// A flight often ends on your own last call: letting go asks for the meter's microphone back, and the flight is over
// before it arrives. It used to be kept, holding the microphone (so deafening Android's recogniser) for good.
test('a microphone that arrives after the flight has ended is let go at once', async () => {
  const button = sharedButton();
  const { ptt } = make({ exclusive: true, button });
  await ptt.init();
  assert.ok(button.on.size > 0, 'listening to the button');
  gumDelay = 50;
  await press(ptt);                              // letting go asks for the microphone back…
  ptt.destroy();                                 // …and the flight ends before it comes
  await sleep(80);
  gumDelay = 0;
  assert.equal(live.size, 0, 'nothing is left holding the microphone');
  assert.equal(button.on.size, 0, 'nor listening to the button, which the next flight uses too');
});

test('on Android, a microphone that arrives during the next press is let go, so the recogniser can hear', async () => {
  const { ptt, got } = make({ exclusive: true });
  await ptt.init();
  gumDelay = 60;
  await press(ptt);                              // letting go asks for the meter's microphone back, slowly…
  ptt.down();                                    // …and the next press comes first
  await sleep(250);
  await ptt.up();
  await sleep(80);
  gumDelay = 0;
  assert.deepEqual(got.map(g => g.text), [WORDS, WORDS], 'the second transmission is heard too');
  assert.ok(ptt.stream, 'and the meter has its microphone back afterwards');
  ptt.destroy();
  assert.equal(live.size, 0);
});

test('asking for the microphone twice at once opens it once', async () => {
  const { ptt } = make({ exclusive: true });
  await ptt.init();
  ptt.closeMic();
  gumDelay = 30;
  await Promise.all([ptt.openMic(), ptt.openMic()]);
  gumDelay = 0;
  assert.equal(live.size, 1);
  ptt.destroy();
  assert.equal(live.size, 0);
});

// The words go on arriving for a moment after you let go. A second press in that moment used to wipe them: the first
// call was lost and the second delivered twice, once while the button was still held down.
test('pressing again straight after letting go: the first call is delivered, once, before the second begins', async () => {
  const order = [];
  const { ptt } = make({ exclusive: true,
    onDown: () => order.push('down'), onRelease: () => order.push('release'), onUp: text => order.push(`up: ${text}`) });
  await ptt.init();
  stopLatency = 300;                             // the first recogniser is still finishing when the thumb comes back
  ptt.down(); await sleep(250);
  const first = ptt.up();
  await sleep(50);
  ptt.down(); await sleep(250);
  await ptt.up();
  await first;
  stopLatency = 5;
  await sleep(20);
  assert.deepEqual(order, ['down', 'release', `up: ${WORDS}`, 'down', 'release', `up: ${WORDS}`]);
  ptt.destroy();
});

// The Pixel transcript: "light light light Oxenhope light Oxenhope … light Oxenhope Ilkley Skipton Oxenhope 1,700
// feet q nh10". Every result repeated the transmission so far; joined, it repeated the lot; and the end was lost.
test('Android sends the whole transmission again with each word, and it is heard once, to the end', async () => {
  android = true;
  const { ptt, got } = make({ exclusive: true });
  await ptt.init();
  await press(ptt);
  android = false;
  assert.equal(got[0].text, ANDROID_WORDS, 'once, in full, with the provisional tail');
  ptt.destroy();
});

// "…golf India alpha": the last word is often still on its way to the recogniser when the thumb comes up. Stopping it
// there and then turned the alpha into "alph", "Elsa" or "rather", and the readback lost its callsign.
test('it goes on listening for a moment after you let go, so the last word is heard', async () => {
  let released = 0;
  const { ptt, got } = make({ exclusive: true, onRelease: () => released++ });
  await ptt.init();
  try {                                          // a failure must not leave the meter running, or the run never ends
    said = 'report leaving golf india';
    ptt.down(); await sleep(250);
    said = WORDS;
    const rec = instances.at(-1);
    const letGo = ptt.up();
    assert.equal(released, 1, 'off air the moment you let go');
    await sleep(100);
    assert.equal(rec.stopped, false, 'but still listening');
    rec.onresult({ results: [final('report leaving golf india'), final('alpha')] });
    await letGo;
    assert.equal(rec.stopped, true);
    assert.equal(got[0].text, 'report leaving golf india alpha');
  } finally { said = WORDS; ptt.destroy(); }
});

test('carrying on from the last result is told apart from saying the next thing', () => {
  assert.equal(continues('light', 'light'), true, 'the same again');
  assert.equal(continues('light oxenhope', 'light Oxenhope Ilkley'), true, 'one word more');
  assert.equal(continues('flight oxenhope', 'flight Oxenhope, Ilkley'), true, 'punctuation and case');
  assert.equal(continues('light oxen', 'light Oxenhope Ilkley'), true, 'its last word revised');
  assert.equal(continues('golf charlie zulu india alpha', 'microlight from Oxenhope'), false, 'desktop: the next phrase');
  assert.equal(continues('roger', 'golf india alpha'), false, 'a one-word phrase is held to exactly');
  assert.equal(spoken('golf charlie zulu india alpha', 'microlight'), 'golf charlie zulu india alpha microlight');
  assert.equal(spoken('light oxenhope', 'light oxenhope ilkley'), 'light oxenhope ilkley');
});

test('the click comes when the recogniser is listening, so you know when to speak', async () => {
  let listening = 0;
  const { ptt } = make({ exclusive: true, onListening: () => listening++ });
  await ptt.init();
  ptt.down();
  await sleep(60);
  assert.equal(listening, 0, 'not yet: Android is still handing the microphone over');
  await sleep(200);
  assert.equal(listening, 1);
  await ptt.up();
  ptt.destroy();
});

// Paused for an interruption: the pad is the way back, and nothing goes out on it. Talking to whoever interrupted
// you isn't a transmission either.
test('paused, a press transmits nothing', async () => {
  const downs = [];
  const { ptt, got } = make({ onDown: () => downs.push(1) });
  await ptt.init();
  try {
    ptt.paused = true;
    await press(ptt);
    assert.equal(downs.length, 0);
    assert.deepEqual(got, []);
    ptt.paused = false;
    await press(ptt);
    assert.equal(downs.length, 1, 'resumed, the next press goes out');
  } finally { ptt.destroy(); }
});
