// Push-to-talk: hold the on-screen button (or the space bar) to transmit.
// Speech recognition runs while the button is held, like a real transmitter, and for a moment after: see TAIL_MS.
// A separate level meter watches the microphone: talking for more than ~1.2 s without the
// button pressed is reported as "not transmitted".
//
// Android: the page's own microphone stream (for that meter) and Chrome's speech recogniser cannot both have the
// microphone. On a Pixel the meter moved while the recogniser heard only silence — no words and no error — so on
// Android the meter's stream is let go while the button is held and taken back afterwards; anywhere else it is let
// go the first time a transmission shows the recogniser heard nothing at all. Each press also gets a fresh
// recogniser: one left believing it is still running makes start() throw, and that used to be swallowed.
//
// Each press keeps its own record of what its recogniser heard. The words go on arriving for a second after you let
// go, and a press straight after the last one used to wipe them and take its place: the first call was lost and the
// second delivered twice.

const ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
const EVENTS = ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch'];
const SOUND = ['soundstart', 'speechstart', 'result'];
// The last word is often still on its way to the recogniser when the thumb comes up, and stopping it there and then
// cut it short: the "alpha" ending a readback came back as "alph", "Alta", "Elsa", "oven", "rather" or nothing, and
// the callsign was lost. So it goes on listening this long after you let go. You are off air from the release all
// the same, and nothing else can transmit until your words are in.
const TAIL_MS = 400;

// Chrome on a desktop sends each finished phrase once. Chrome on Android sends the whole transmission again each
// time it adds a word — "light", "light Oxenhope", "light Oxenhope Ilkley" — and joining those repeated it all,
// dozens of times over. A result that carries on from the one before replaces it rather than following it; the
// last word of the earlier one may have been revised meanwhile, so it is not held to.
const plain = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function continues(prev, next) {
  const p = plain(prev).split(' '), n = plain(next).split(' ');
  if (!p[0] || n.length < p.length) return false;
  const keep = p.length > 1 ? p.length - 1 : p.length;
  for (let i = 0; i < keep; i++) if (p[i] !== n[i]) return false;
  return true;
}
/** What was said so far: the finished part and the provisional tail, however this Chrome reports them. */
export function spoken(fin, interim) {
  fin = fin.trim(); interim = interim.trim();
  return !interim ? fin : !fin ? interim : continues(fin, interim) ? interim : `${fin} ${interim}`;
}

export class PushToTalk {
  constructor({ button, onDown, onRelease, onUp, onInterim, onHotMic, onLevel, isRadioBusy, onNotice, onListening, exclusive = ANDROID }) {
    Object.assign(this, { button, onDown, onRelease, onUp, onInterim, onHotMic, onLevel, isRadioBusy, onNotice, onListening, exclusive });
    this.keyed = false;
    this.press = null;             // this transmission, or the last one while its words are still arriving
    this.enabled = false;
    this.paused = false;           // the flight is paused: no transmitting, and no hot-mic warnings
  }

  static supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition) && !!navigator.mediaDevices?.getUserMedia;
  }

  async init({ hotMic = true } = {}) {
    this.hotMicOn = hotMic;
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ac.createAnalyser(); this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.floor = 0.01; this.loudSince = 0; this.lastHot = 0;
    await this.openMic();
    if (this.destroyed) return;                     // the flight was abandoned while the permission prompt was up
    this.meterTimer = setInterval(() => this.meter(), 100);
    this.bindInputs();
    this.enabled = true;
  }

  /**
   * The meter's own microphone stream: held between transmissions, let go during one when exclusive. One request at
   * a time, and a stream that arrives when it is no longer wanted is let go at once: the flight ended while
   * getUserMedia was answering (a flight often ends on your own last call), or on Android the next press has begun
   * and the recogniser needs the microphone. Kept, it held the microphone for the rest of the session.
   */
  openMic() {
    if (this.stream) return Promise.resolve();
    return this.opening ||= navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(stream => {
        this.opening = null;
        if (this.destroyed || this.stream || (this.exclusive && this.keyed)) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        this.src = this.ac.createMediaStreamSource(stream);
        this.src.connect(this.analyser);
      }, err => { this.opening = null; throw err; });
  }

  closeMic() {
    this.src?.disconnect(); this.src = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
  }

  /** A fresh recogniser for one press, writing what it hears to that press's own record. */
  recognizer(p) {
    const rec = new this.SR();
    rec.lang = 'en-GB';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    const current = () => this.press === p;   // a previous press's stragglers reach its own record and no further
    for (const ev of EVENTS) {
      rec.addEventListener(ev, () => {
        p.trace.push(ev);
        if (!current()) return;
        // The recogniser is only listening from here. On Android that is well after the press, and anything said
        // before it is lost: the callsign, usually. So this is when to tell the pilot to speak.
        if (ev === 'audiostart' && this.keyed) this.onListening?.();
        if (ev === 'soundstart' || ev === 'speechstart') this.hearing = true;
        if (ev === 'soundend' || ev === 'speechend') this.hearing = false;
      });
    }
    rec.onresult = e => {
      const finals = [];                         // each finished piece, with the alternatives Chrome offers for it
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i], best = r[0].transcript.trim();
        if (!r.isFinal) { interim = spoken(interim, best); continue; }
        const alts = [];
        for (let a = 0; a < r.length; a++) { const t = r[a].transcript.trim(); if (t && !alts.includes(t)) alts.push(t); }
        const sofar = finals.map(f => f.text).join(' ');
        if (finals.length && continues(sofar, best)) finals.splice(0, finals.length, { text: best, alts });   // Android
        else finals.push({ text: best, alts });
      }
      p.final = finals.map(f => f.text).join(' ');
      p.interim = interim;
      p.segments = finals.map(f => f.alts);
      if (!p.trace.includes('result')) p.trace.push('result');
      if (current() && !p.delivered) this.onInterim?.(spoken(p.final, interim));
    };
    rec.onerror = e => { p.error = e.error; p.trace.push(`error:${e.error}`); };
    rec.onend = () => { p.trace.push('end'); if (current()) this.hearing = false; p.ended(); };
    return rec;
  }

  // The button is the same one for every flight, and each flight has its own PushToTalk: destroy() takes these off.
  bindInputs() {
    const b = this.button, on = { signal: (this.inputs = new AbortController()).signal };
    const down = (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); this.down(); };
    const up = (e) => { e.preventDefault(); this.up(); };
    b.addEventListener('pointerdown', down, on);
    b.addEventListener('pointerup', up, on);
    b.addEventListener('pointercancel', up, on);
    b.addEventListener('contextmenu', e => e.preventDefault(), on);
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat || /input|textarea|select/i.test(document.activeElement?.tagName)) return;
      e.preventDefault(); this.down();
    }, on);
    window.addEventListener('keyup', (e) => { if (e.code === 'Space' && this.keyed) { e.preventDefault(); this.up(); } }, on);
  }

  down() {
    if (!this.enabled || this.paused || this.keyed) return;
    // Pressed again before the last transmission's words were all in: hand that one over now, with what it has,
    // rather than lose it, and before this press is announced so the two can't cross.
    if (this.press && !this.press.delivered) this.deliver(this.press, { reopen: false });
    this.keyed = true;
    const p = this.press = { keyAt: performance.now(), final: '', interim: '', segments: [], trace: [], error: null, delivered: false };
    p.done = new Promise(r => { p.ended = r; });
    this.hearing = false;
    this.onDown?.();
    const hadMic = !!(this.stream || this.opening);
    if (this.exclusive) this.closeMic();
    try { this.rec?.abort(); } catch { /* already finished */ }
    const rec = this.rec = p.rec = this.recognizer(p);
    const start = () => {
      if (this.rec !== rec || !this.keyed) return;
      try { rec.start(); p.trace.push('start'); }
      catch (err) { p.error = `could not start: ${err.name || err.message || err}`; p.trace.push('start-threw'); }
    };
    // Give Android a moment to release the microphone before the recogniser asks for it. You pause a beat
    // after pressing anyway ("press, pause, speak"), so nothing you say is lost to it.
    if (this.exclusive && hadMic) setTimeout(start, 120); else start();
  }

  async up() {
    if (!this.keyed) return;
    this.keyed = false;
    const p = this.press;
    p.heldMs = Math.round(performance.now() - p.keyAt);
    this.onRelease?.();
    // A second press meanwhile hands this one over at once, and End aborts it: either way the stop below is harmless.
    if (p.trace.includes('start') && !p.trace.includes('end')) await new Promise(r => setTimeout(r, TAIL_MS));
    try { p.rec.stop(); } catch { /* not running */ }
    if (p.trace.includes('start') && !p.trace.includes('end')) await Promise.race([p.done, new Promise(r => setTimeout(r, 1500))]);
    this.deliver(p);
  }

  /** Hand a transmission over, once: when its recogniser has finished, or sooner if the next press can't wait. */
  deliver(p, { reopen = true } = {}) {
    if (p.delivered || this.destroyed) return;
    p.delivered = true;
    // Keep the provisional tail too: on Android your last words are often still provisional when you let go, and
    // keeping only the finished part cut transmissions off mid-word ("QNH 10").
    const text = spoken(p.final, p.interim);
    const heard = p.trace.some(t => SOUND.includes(t)), listening = p.trace.includes('audiostart');
    const error = text ? null : p.error
      || (heard ? 'heard sound but no words' : listening ? 'listening, but heard no speech' : 'no sound reached the speech recogniser');
    if (!text && !heard && !this.exclusive) {
      // The meter can hear you and the recogniser can't: they are fighting over the microphone. Let it have it.
      this.exclusive = true;
      this.onNotice?.('Speech recognition heard nothing, so the app now lets go of the microphone while you transmit. Try again.');
    }
    if (reopen && this.exclusive && this.enabled) this.openMic().catch(() => { /* the hot-mic check stops; transmitting still works */ });
    this.onUp?.(text, { heldMs: p.heldMs, error, trace: p.trace.join(' '), alternatives: this.candidates(text, p.segments) });
  }

  /**
   * Everything the recogniser thought it heard, best first. Chrome often puts the right words second or third
   * ("escort" for "squawk"), so the engine matches all of them against what the controller is expecting.
   */
  candidates(primary, segments, limit = 8) {
    let out = [''];
    for (const alts of segments || []) {
      const next = [];
      for (const sofar of out) for (const alt of alts) if (next.length < limit) next.push(sofar ? `${sofar} ${alt}` : alt);
      out = next.length ? next : out;
    }
    return out.map(t => t.trim()).filter(t => t && t !== primary);
  }

  meter() {
    // Without our own stream (transmitting, on Android) the recogniser's own events are all there is to show.
    if (!this.stream) { this.onLevel?.(this.hearing ? 0.06 : 0, this.keyed); return; }
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0; for (const v of this.buf) sum += v * v;
    const rms = Math.sqrt(sum / this.buf.length);
    this.onLevel?.(rms, this.keyed);
    const busy = this.isRadioBusy?.();
    if (!this.keyed && !busy) this.floor = this.floor * 0.98 + Math.min(rms, 0.05) * 0.02;
    const threshold = Math.max(0.03, this.floor * 4);
    const now = performance.now();
    if (this.hotMicOn && !this.paused && !this.keyed && !busy && rms > threshold) {
      if (!this.loudSince) this.loudSince = now;
      if (now - this.loudSince > 1200 && now - this.lastHot > 6000) { this.lastHot = now; this.onHotMic?.(); }
    } else this.loudSince = 0;
  }

  destroy() {
    this.destroyed = true;                                 // a microphone still on its way is let go when it arrives
    this.enabled = false;
    clearInterval(this.meterTimer);
    this.inputs?.abort();
    try { this.rec?.abort(); } catch { /* finished */ }   // a recogniser outliving its flight holds the service
    this.rec = null;
    this.closeMic();
    this.ac?.close();
  }
}
