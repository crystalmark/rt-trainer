// Browser radio: speech synthesis for every station, wrapped in VHF-style noise, squelch
// clicks and the heterodyne squeal you hear when two stations transmit at once.
// Note: the browser's speech synthesiser can't be routed through Web Audio, so the voices
// themselves aren't band-limited; the static and squelch around them do the work.

export class BrowserRadio {
  constructor({ hiss = true, volume = 0.9 } = {}) {
    this.busy = false;
    this.currentSpeaker = null;
    this.queue = Promise.resolve();
    this.voices = [];
    this.voiceMap = new Map();
    this.hissOn = hiss;
    this.volume = volume;
    this.interrupted = false;
  }

  async init() {
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    await this.ac.resume();
    const len = this.ac.sampleRate * 2;
    this.noise = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.master = this.ac.createGain(); this.master.gain.value = this.volume; this.master.connect(this.ac.destination);
    // Continuous band-limited noise: the squelch opens it up during transmissions.
    this.noiseSrc = this.ac.createBufferSource(); this.noiseSrc.buffer = this.noise; this.noiseSrc.loop = true;
    const bp = this.ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
    this.noiseGain = this.ac.createGain(); this.noiseGain.gain.value = this.hissOn ? 0.006 : 0;
    this.noiseSrc.connect(bp).connect(this.noiseGain).connect(this.master);
    this.noiseSrc.start();
    await this.loadVoices();
  }

  loadVoices() {
    return new Promise(resolve => {
      const pick = () => { this.voices = voiceChoices(); resolve(); };
      if (speechSynthesis.getVoices().length) pick();
      else { speechSynthesis.onvoiceschanged = pick; setTimeout(pick, 1500); }
    });
  }

  voiceFor(speaker) {
    if (!this.voiceMap.has(speaker)) {
      const atc = speaker === 'atc';
      // Everyone else takes the next voice along, so stations sound like different people.
      const idx = atc ? 0 : 1 + (this.voiceMap.size % Math.max(1, this.voices.length - 1));
      const voice = this.voices[idx % Math.max(1, this.voices.length)] || null;
      this.voiceMap.set(speaker, { voice, pitch: atc ? 1 : 0.94 + Math.random() * 0.12, rate: atc ? 1.08 : 1 + Math.random() * 0.12 });
    }
    return this.voiceMap.get(speaker);
  }

  /** The voice the controller uses; '' or an unknown name means the best one on this device. */
  setAtcVoice(name) {
    const v = this.voices.find(x => x.name === name) || this.voices[0] || null;
    this.voiceMap.set('atc', { voice: v, pitch: 1, rate: 1.08 });
  }

  say(speaker, display, speech) {
    const job = this.queue.then(() => this._say(speaker, speech));
    this.queue = job.catch(() => {});
    return job;
  }

  async _say(speaker, speech) {
    this.busy = true; this.currentSpeaker = speaker; this.interrupted = false;
    this.squelch(true);
    await wait(60 + Math.random() * 90);
    const voice = this.voiceFor(speaker);
    const parts = clauses(speech);
    for (let i = 0; i < parts.length; i++) {
      if (this.interrupted) break;
      if (i) await wait(40);                       // a beat between clauses, and no clipped start
      await this.speakOne(parts[i], voice);
    }
    this.squelch(false);
    const interrupted = this.interrupted;
    this.busy = false; this.currentSpeaker = null;
    return { interrupted };
  }

  speakOne(text, { voice, pitch, rate }) {
    return new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'en-GB'; u.pitch = pitch; u.rate = rate; u.volume = this.volume;
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      u.onend = finish; u.onerror = finish;
      const t = setTimeout(finish, 3000 + text.length * 150 / (rate || 1));   // Chrome sometimes never fires onend
      speechSynthesis.speak(u);
    });
  }

  squelch(open) {
    if (!this.ac) return;
    const now = this.ac.currentTime;
    this.noiseGain.gain.cancelScheduledValues(now);
    if (open) {
      this.click(0.25);
      this.noiseGain.gain.setTargetAtTime(0.05, now, 0.01);
    } else {
      // squelch tail: a short burst, then back to background hiss
      this.noiseGain.gain.setValueAtTime(0.12, now);
      this.noiseGain.gain.setTargetAtTime(this.hissOn ? 0.006 : 0, now + 0.12, 0.02);
    }
  }

  click(level = 0.3) {
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = 'square'; o.frequency.value = 180;
    g.gain.setValueAtTime(level, this.ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ac.currentTime + 0.03);
    o.connect(g).connect(this.master); o.start(); o.stop(this.ac.currentTime + 0.04);
  }

  /** Our own PTT: a click in the headset, as on a real intercom. */
  keyClick() { if (this.ac) this.click(0.12); }

  interrupt() {
    this.interrupted = true;
    speechSynthesis.cancel();
    this.startHeterodyne();
  }

  startHeterodyne() {
    if (!this.ac || this.het) return;
    const g = this.ac.createGain(); g.gain.value = 0.08;
    const a = this.ac.createOscillator(), b = this.ac.createOscillator();
    a.frequency.value = 1020; b.frequency.value = 1090;
    a.connect(g); b.connect(g); g.connect(this.master); a.start(); b.start();
    this.noiseGain.gain.setTargetAtTime(0.1, this.ac.currentTime, 0.01);
    this.het = { a, b, g };
  }

  stopHeterodyne() {
    if (!this.het) return;
    this.het.a.stop(); this.het.b.stop(); this.het.g.disconnect(); this.het = null;
    this.noiseGain.gain.setTargetAtTime(this.hissOn ? 0.006 : 0, this.ac.currentTime, 0.02);
  }

  setHiss(on) {
    this.hissOn = on;
    if (this.ac && !this.busy) this.noiseGain.gain.setTargetAtTime(on ? 0.006 : 0, this.ac.currentTime, 0.05);
  }

  stopAll() {
    speechSynthesis.cancel();
    this.stopHeterodyne();
    if (this.ac) this.noiseGain.gain.setTargetAtTime(0, this.ac.currentTime, 0.05);
  }
}

// Voices worth listening to. macOS ships a pile of novelty voices (Bubbles, Zarvox, Grandma and friends), which
// is what you get if you just take the English ones in order; Chrome adds its own network voices, which sound the
// most natural. Best first: British, then other English, preferring Google/enhanced/premium versions.
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|eddy|flo|fred|good news|grandma|grandpa|hysterical|jester|junior|kathy|organ|princess|ralph|reed|rocko|sandy|shelley|superstar|trinoids|whisper|wobble|zarvox)\b/i;
const KNOWN_GOOD = /\b(daniel|arthur|serena|kate|jamie|oliver|stephanie|martha|karen|moira|tessa|samantha|alex|aaron|nicky)\b/i;

function voiceScore(v) {
  const lang = (v.lang || '').replace('_', '-');
  let score = /^en-GB/i.test(lang) ? 40 : /^en-(IE|AU|NZ|ZA)/i.test(lang) ? 25 : 10;
  if (/google/i.test(v.name)) score += 30;
  if (/(enhanced|premium|natural|neural)/i.test(v.name)) score += 25;
  if (KNOWN_GOOD.test(v.name)) score += 15;
  if (/microsoft/i.test(v.name)) score += 10;
  return score;
}

/** English voices on this device, best first. */
export function voiceChoices() {
  return speechSynthesis.getVoices()
    .filter(v => /^en/i.test(v.lang) && !NOVELTY.test(v.name))
    .sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
}

// Chrome gives up on an utterance after about fifteen seconds, which cuts long clearances off, so speak a clause
// at a time. Splits on sentences, then on commas once a clause gets long.
function clauses(text, limit = 140) {
  const out = [];
  for (const sentence of String(text).split(/(?<=[.?!])\s+/)) {
    let line = '';
    for (const part of sentence.split(/(?<=,)\s+/)) {
      if (line && (line + ' ' + part).length > limit) { out.push(line); line = ''; }
      line = line ? `${line} ${part}` : part;
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.filter(Boolean);
}

export const realClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  tick: 250,
};

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
