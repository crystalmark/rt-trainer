// Browser radio: speech synthesis for every station, wrapped in VHF-style noise, squelch
// clicks and the heterodyne squeal you hear when two stations transmit at once.
// Note: the browser's speech synthesiser can't be routed through Web Audio, so the voices
// themselves aren't band-limited; the static and squelch around them do the work.

// How loud the noise is: between transmissions, while someone is speaking, and the burst as the squelch closes.
// The voice comes from the speech synthesiser, which can't be mixed into Web Audio, so on some devices (Android
// especially) it is much quieter than the noise. Hence: barely any hiss under the voice, and the radio character
// comes from the clicks and the squelch tail instead.
const NOISE = {
  off: { idle: 0, open: 0, tail: 0 },
  low: { idle: 0.003, open: 0.006, tail: 0.03 },
  normal: { idle: 0.006, open: 0.014, tail: 0.05 },
};

export class BrowserRadio {
  constructor({ noise = 'low', volume = 1 } = {}) {
    this.busy = false;
    this.currentSpeaker = null;
    this.queue = Promise.resolve();
    this.voices = [];
    this.voiceMap = new Map();
    this.noise = NOISE[noise] || NOISE.low;
    this.volume = volume;
    this.interrupted = false;
    this.paused = false;
    this.onResume = [];
  }

  async init() {
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    await this.ac.resume();
    const len = this.ac.sampleRate * 2;
    this.noiseBuffer = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.master = this.ac.createGain(); this.master.gain.value = this.volume; this.master.connect(this.ac.destination);
    // Continuous band-limited noise: the squelch opens it up during transmissions.
    this.noiseSrc = this.ac.createBufferSource(); this.noiseSrc.buffer = this.noiseBuffer; this.noiseSrc.loop = true;
    const bp = this.ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
    this.noiseGain = this.ac.createGain(); this.noiseGain.gain.value = this.noise.idle;
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
    if (speaker === 'atc') {
      if (!this.voiceMap.has('atc')) this.voiceMap.set('atc', { voice: voiceForUnit(this.unit, this.atcChoice, this.voices), pitch: 1, rate: 1.08 });
      return this.voiceMap.get('atc');
    }
    if (!this.voiceMap.has(speaker)) {
      // Everyone else takes the next voice along, so stations sound like different people.
      const atc = this.voiceFor('atc').voice;
      const others = this.voices.filter(v => v !== atc);
      const voice = others[this.voiceMap.size % Math.max(1, others.length)] || atc || null;
      this.voiceMap.set(speaker, { voice, pitch: 0.94 + Math.random() * 0.12, rate: 1 + Math.random() * 0.12 });
    }
    return this.voiceMap.get(speaker);
  }

  /** The voice the controller uses; '' means a different one per unit. */
  setAtcVoice(name) {
    this.atcChoice = name || '';
    this.voiceMap.delete('atc');
  }

  /** Which unit is on frequency: a different unit is a different controller, so a different voice. */
  setUnit(unit) {
    if (unit === this.unit) return;
    this.unit = unit || '';
    this.voiceMap.delete('atc');
  }

  say(speaker, display, speech) {
    const job = this.queue.then(() => this._say(speaker, speech));
    this.queue = job.catch(() => {});
    return job;
  }

  async _say(speaker, speech) {
    if (this.closed) return { interrupted: true };     // queued before the flight ended: say nothing
    this.busy = true; this.currentSpeaker = speaker; this.interrupted = false;
    this.squelch(true);
    await wait(60 + Math.random() * 90);
    const voice = this.voiceFor(speaker);
    const parts = clauses(speech);
    // Checked before every clause: End used to cancel only the clause being spoken, and the rest of the call went on
    // over the debrief.
    for (let i = 0; i < parts.length && !this.interrupted && !this.closed; i++) {
      if (i) await wait(40);                       // a beat between clauses, and no clipped start
      await this.whilePaused();
      if (this.interrupted || this.closed) break;
      await this.speakOne(parts[i], voice);
      if (this.paused) i--;                        // cut off by Pause: said again, from its start, on Resume
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
    if (!this.ac || this.closed) return;
    const now = this.ac.currentTime;
    this.noiseGain.gain.cancelScheduledValues(now);
    if (open) {
      this.click(0.22);
      this.noiseGain.gain.setTargetAtTime(this.noise.open, now, 0.01);
    } else {
      // squelch tail: a short burst, then back to the background
      this.noiseGain.gain.setValueAtTime(this.noise.tail, now);
      this.noiseGain.gain.setTargetAtTime(this.noise.idle, now + 0.12, 0.02);
    }
  }

  click(level = 0.3) {
    if (!this.ac || this.closed) return;
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

  // Pause holds a transmission where it is: the clause being spoken stops, and is said again from its start on Resume,
  // with the radio busy all the while. speechSynthesis.pause() was no use: Chrome on Android ignores it, and elsewhere
  // the clause's safety timer ran on, so the radio went quiet with half a call still to come after Resume.
  pause() { if (this.paused) return; this.paused = true; speechSynthesis.cancel(); }
  resume() { if (!this.paused) return; this.paused = false; this.wake(); }
  whilePaused() { return this.paused ? new Promise(r => this.onResume.push(r)) : null; }
  wake() { const w = this.onResume; this.onResume = []; for (const r of w) r(); }

  startHeterodyne() {
    if (!this.ac || this.closed || this.het) return;
    const g = this.ac.createGain(); g.gain.value = 0.08;
    const a = this.ac.createOscillator(), b = this.ac.createOscillator();
    a.frequency.value = 1020; b.frequency.value = 1090;
    a.connect(g); b.connect(g); g.connect(this.master); a.start(); b.start();
    this.noiseGain.gain.setTargetAtTime(Math.max(this.noise.open, 0.01), this.ac.currentTime, 0.01);
    this.het = { a, b, g };
  }

  stopHeterodyne() {
    if (!this.het) return;
    this.het.a.stop(); this.het.b.stop(); this.het.g.disconnect(); this.het = null;
    this.noiseGain.gain.setTargetAtTime(this.noise.idle, this.ac.currentTime, 0.02);
  }

  /** 'off' | 'low' | 'normal', changeable in flight. */
  setNoise(level) {
    this.noise = NOISE[level] || NOISE.low;
    if (this.ac && !this.closed && !this.busy) this.noiseGain.gain.setTargetAtTime(this.noise.idle, this.ac.currentTime, 0.05);
  }

  // Off, not merely quiet. Turning the noise down was undone by the last transmission finishing afterwards —
  // its squelch tail sets the hiss back to idle — and every flight makes a new radio with its own audio
  // context, so one left hissing went on over the debrief and into the next flight.
  stopAll() {
    speechSynthesis.cancel();
    this.stopHeterodyne();
    this.closed = true;
    this.wake();                                   // a call held by Pause ends too
    if (!this.ac) return;
    try { this.noiseSrc?.stop(); } catch { /* already stopped */ }
    this.ac.close?.().catch(() => {});
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

const CONTROLLERS = 4;        // the controller's voice comes from the best few, fixed per unit

function hash(text) { let h = 0; for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

/** The voice a unit's controller speaks with: your choice if you made one, otherwise one of the best few. */
export function voiceForUnit(unit, chosen = '', voices = voiceChoices()) {
  const pick = chosen && voices.find(v => v.name === chosen);
  if (pick) return pick;
  return voices.length ? voices[hash(unit) % Math.min(CONTROLLERS, voices.length)] : null;
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
