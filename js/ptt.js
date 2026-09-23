// Push-to-talk: hold the on-screen button (or the space bar) to transmit.
// Speech recognition only runs while the button is held, like a real transmitter.
// A separate level meter watches the microphone: talking for more than ~1.2 s without the
// button pressed is reported as "not transmitted".
//
// Android: the page's own microphone stream (for that meter) and Chrome's speech recogniser cannot both have the
// microphone. On a Pixel the meter moved while the recogniser heard only silence — no words and no error — so on
// Android the meter's stream is let go while the button is held and taken back afterwards; anywhere else it is let
// go the first time a transmission shows the recogniser heard nothing at all. Each press also gets a fresh
// recogniser: one left believing it is still running makes start() throw, and that used to be swallowed.

const ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
const EVENTS = ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch'];
const HEARD = ['audiostart', 'soundstart', 'speechstart', 'result'];

export class PushToTalk {
  constructor({ button, onDown, onUp, onInterim, onHotMic, onLevel, isRadioBusy, onNotice, exclusive = ANDROID }) {
    Object.assign(this, { button, onDown, onUp, onInterim, onHotMic, onLevel, isRadioBusy, onNotice, exclusive });
    this.keyed = false;
    this.finalText = '';
    this.interimText = '';
    this.segments = [];
    this.trace = [];
    this.enabled = false;
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
    this.meterTimer = setInterval(() => this.meter(), 100);
    this.bindInputs();
    this.enabled = true;
  }

  /** The meter's own microphone stream: held between transmissions, let go during one when exclusive. */
  async openMic() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.src = this.ac.createMediaStreamSource(this.stream);
    this.src.connect(this.analyser);
  }

  closeMic() {
    this.src?.disconnect(); this.src = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
  }

  /** A fresh recogniser for one transmission, reporting what it heard to this.trace. */
  recognizer() {
    const rec = new this.SR();
    rec.lang = 'en-GB';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    const mine = f => (...a) => { if (this.rec === rec) f(...a); };   // ignore a previous press's stragglers
    for (const ev of EVENTS) {
      rec.addEventListener(ev, mine(() => {
        this.trace.push(ev);
        if (ev === 'soundstart' || ev === 'speechstart') this.hearing = true;
        if (ev === 'soundend' || ev === 'speechend') this.hearing = false;
      }));
    }
    rec.onresult = mine(e => {
      let fin = '', interim = '';
      const segments = [];                       // each final piece, with the alternatives Chrome offers for it
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          fin += r[0].transcript + ' ';
          const alts = [];
          for (let a = 0; a < r.length; a++) { const t = r[a].transcript.trim(); if (t && !alts.includes(t)) alts.push(t); }
          segments.push(alts);
        } else interim += r[0].transcript + ' ';
      }
      this.finalText = fin; this.interimText = interim; this.segments = segments;
      if (!this.trace.includes('result')) this.trace.push('result');
      this.onInterim?.((fin + interim).trim());
    });
    rec.onerror = mine(e => { this.lastError = e.error; this.trace.push(`error:${e.error}`); });
    rec.onend = mine(() => { this.trace.push('end'); this.hearing = false; this.endResolve?.(); });
    return rec;
  }

  bindInputs() {
    const b = this.button;
    const down = (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); this.down(); };
    const up = (e) => { e.preventDefault(); this.up(); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', e => e.preventDefault());
    this.keydown = (e) => {
      if (e.code !== 'Space' || e.repeat || /input|textarea|select/i.test(document.activeElement?.tagName)) return;
      e.preventDefault(); this.down();
    };
    this.keyup = (e) => { if (e.code === 'Space' && this.keyed) { e.preventDefault(); this.up(); } };
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
  }

  down() {
    if (!this.enabled || this.keyed) return;
    this.keyed = true;
    this.keyAt = performance.now();
    this.finalText = ''; this.interimText = ''; this.segments = [];
    this.trace = []; this.lastError = null; this.hearing = false;
    this.onDown?.();
    const hadMic = !!this.stream;
    if (this.exclusive) this.closeMic();
    try { this.rec?.abort(); } catch { /* already finished */ }
    const rec = this.rec = this.recognizer();
    const start = () => {
      if (this.rec !== rec || !this.keyed) return;
      try { rec.start(); this.trace.push('start'); }
      catch (err) { this.lastError = `could not start: ${err.name || err.message || err}`; this.trace.push('start-threw'); }
    };
    // Give Android a moment to release the microphone before the recogniser asks for it. You pause a beat
    // after pressing anyway ("press, pause, speak"), so nothing you say is lost to it.
    if (this.exclusive && hadMic) setTimeout(start, 120); else start();
  }

  async up() {
    if (!this.keyed) return;
    this.keyed = false;
    const held = performance.now() - this.keyAt;
    const ended = new Promise(r => { this.endResolve = r; });
    try { this.rec?.stop(); } catch { /* not running */ }
    if (this.trace.includes('start') && !this.trace.includes('end')) await Promise.race([ended, new Promise(r => setTimeout(r, 1500))]);
    const text = (this.finalText || this.interimText).trim();
    const heard = this.trace.some(t => HEARD.includes(t));
    const error = text ? null : this.lastError || (heard ? 'heard sound but no words' : 'no sound reached the speech recogniser');
    if (!text && !heard && !this.exclusive) {
      // The meter can hear you and the recogniser can't: they are fighting over the microphone. Let it have it.
      this.exclusive = true;
      this.onNotice?.('Speech recognition heard nothing, so the app now lets go of the microphone while you transmit. Try again.');
    }
    if (this.exclusive && this.enabled) this.openMic().catch(() => { /* the hot-mic check stops; transmitting still works */ });
    this.onUp?.(text, { heldMs: Math.round(held), error, trace: this.trace.join(' '), alternatives: this.candidates(text) });
  }

  /**
   * Everything the recogniser thought it heard, best first. Chrome often puts the right words second or third
   * ("escort" for "squawk"), so the engine matches all of them against what the controller is expecting.
   */
  candidates(primary, limit = 8) {
    let out = [''];
    for (const alts of this.segments || []) {
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
    if (this.hotMicOn && !this.keyed && !busy && rms > threshold) {
      if (!this.loudSince) this.loudSince = now;
      if (now - this.loudSince > 1200 && now - this.lastHot > 6000) { this.lastHot = now; this.onHotMic?.(); }
    } else this.loudSince = 0;
  }

  destroy() {
    clearInterval(this.meterTimer);
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    try { this.rec?.abort(); } catch { /* finished */ }   // a recogniser outliving its flight holds the service
    this.rec = null;
    this.closeMic();
    this.ac?.close();
    this.enabled = false;
  }
}
