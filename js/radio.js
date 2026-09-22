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
      const pick = () => {
        const all = speechSynthesis.getVoices();
        const en = all.filter(v => /^en/i.test(v.lang));
        const gb = en.filter(v => /GB|UK/i.test(v.lang) || /UK|British|Daniel|Kate|Serena|Arthur|Martha/i.test(v.name));
        this.voices = gb.length >= 2 ? gb.concat(en.filter(v => !gb.includes(v))) : en.length ? en : all;
        resolve();
      };
      if (speechSynthesis.getVoices().length) pick();
      else { speechSynthesis.onvoiceschanged = pick; setTimeout(pick, 1500); }
    });
  }

  voiceFor(speaker) {
    if (!this.voiceMap.has(speaker)) {
      const idx = speaker === 'atc' ? 0 : 1 + (this.voiceMap.size % Math.max(1, this.voices.length - 1));
      const voice = this.voices[idx % Math.max(1, this.voices.length)] || null;
      const atc = speaker === 'atc';
      this.voiceMap.set(speaker, { voice, pitch: atc ? 1 : 0.8 + Math.random() * 0.45, rate: atc ? 1.12 : 1.02 + Math.random() * 0.15 });
    }
    return this.voiceMap.get(speaker);
  }

  setAtcVoice(name) {
    const v = this.voices.find(x => x.name === name);
    if (v) this.voiceMap.set('atc', { voice: v, pitch: 1, rate: 1.12 });
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
    const parts = speech.split(/(?<=[.?!])\s+/).filter(Boolean);
    for (const p of parts) {
      if (this.interrupted) break;
      await this.speakOne(p, this.voiceFor(speaker));
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
      const t = setTimeout(finish, 2500 + text.length * 110);   // Chrome sometimes never fires onend
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

export const realClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  tick: 250,
};

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
