// The browser radio against stand-ins for Web Audio and the speech synthesiser: enough to check that when a
// flight ends the radio goes quiet and stays quiet, which is not something anyone can hear in a Node test.
import test from 'node:test';
import assert from 'node:assert/strict';

const spoken = [];
let speakMs = 5, current = null;                  // how long an utterance takes; the one being spoken
const sleep = ms => new Promise(r => setTimeout(r, ms));
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
globalThis.speechSynthesis = {
  speak(u) { spoken.push(u.text); current = u; u.timer = setTimeout(() => { if (current === u) current = null; u.onend?.(); }, speakMs); },
  cancel() { const u = current; current = null; if (u) { clearTimeout(u.timer); u.onerror?.({ error: 'interrupted' }); } },   // as Chrome: at once
  getVoices: () => [{ name: 'Daniel', lang: 'en-GB' }],
};
class Param {
  constructor(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; } setValueAtTime(v) { this.value = v; }
  cancelScheduledValues() {} exponentialRampToValueAtTime() {}
}
const node = extra => ({ connect: n => n, disconnect() {}, ...extra });
let contexts = [];
globalThis.window = { AudioContext: class {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 8000; contexts.push(this); }
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  createGain() { return node({ gain: new Param(1) }); }
  createBiquadFilter() { return node({ frequency: new Param(0), Q: new Param(0) }); }
  createBufferSource() { const s = node({ start() { s.playing = true; }, stop() { s.playing = false; } }); return s; }
  createOscillator() { return node({ frequency: new Param(0), start() {}, stop() {} }); }
  get destination() { return node(); }
} };

const { BrowserRadio } = await import('../js/radio.js');

test('ending a flight turns the radio off, not just down', async () => {
  contexts = []; spoken.length = 0;
  const radio = new BrowserRadio({ noise: 'normal' });
  await radio.init();
  const [ac] = contexts;
  assert.ok(radio.noiseSrc.playing, 'the hiss runs during a flight');

  // A transmission is still being spoken when the flight ends, and another is queued behind it.
  const last = radio.say('atc', 'G-IA, roger', 'G-IA, roger');
  const queued = radio.say('atc', 'G-IA, one more', 'G-IA, one more');
  radio.stopAll();
  await last; await queued;

  assert.equal(ac.state, 'closed', 'the audio context is closed');
  assert.equal(radio.noiseSrc.playing, false, 'the noise source is stopped');
  assert.equal(radio.noiseGain.gain.value !== radio.noise.idle || ac.state === 'closed', true);
  assert.ok(!spoken.includes('G-IA, one more'), 'nothing queued is spoken after the end');

  // and nothing that runs late can bring the hiss back
  radio.squelch(false); radio.setNoise('normal'); radio.startHeterodyne(); radio.click();
  assert.equal(radio.het, undefined);
});

const CALL = 'G-HP, Carlisle Radio, readability 5. Runway 24, left-hand, QNH 1016, surface wind 240 degrees 10 knots';

// End used to cancel only the clause being spoken: the rest of the call went on, over the debrief.
test('End stops a call under way, not just the clause being spoken', async () => {
  const radio = new BrowserRadio();
  await radio.init();
  spoken.length = 0; speakMs = 80;
  const call = radio.say('atc', CALL, CALL);
  while (!spoken.length) await sleep(5);
  radio.stopAll();
  await call;
  speakMs = 5;
  assert.deepEqual(spoken.slice(1), [], 'nothing more after End');
});

// speechSynthesis.pause() was no use: Chrome on Android ignores it, and elsewhere the clause's safety timer ran on, so
// the radio went quiet with half the call still to come after Resume.
test('Pause holds a call where it is, and Resume says the rest', async () => {
  const radio = new BrowserRadio();
  await radio.init();
  spoken.length = 0; speakMs = 80;
  const call = radio.say('atc', CALL, CALL);
  while (!spoken.length) await sleep(5);
  radio.pause();
  await sleep(300);
  assert.equal(spoken.length, 1, 'nothing more while paused');
  assert.equal(radio.busy, true, 'and the frequency stays taken');
  radio.resume();
  await call;
  speakMs = 5;
  assert.equal(spoken.length, 3, JSON.stringify(spoken));
  assert.equal(spoken[1], spoken[0], 'the clause cut off by Pause is said again, from its start');
  assert.match(spoken[2], /^Runway 24/, 'then the rest');
  radio.stopAll();
});
