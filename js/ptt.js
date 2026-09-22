// Push-to-talk: hold the on-screen button (or the space bar) to transmit.
// Speech recognition only runs while the button is held, like a real transmitter.
// A separate level meter watches the microphone: talking for more than ~1.2 s without the
// button pressed is reported as "not transmitted".

export class PushToTalk {
  constructor({ button, onDown, onUp, onInterim, onHotMic, onLevel, isRadioBusy }) {
    Object.assign(this, { button, onDown, onUp, onInterim, onHotMic, onLevel, isRadioBusy });
    this.keyed = false;
    this.finalText = '';
    this.interimText = '';
    this.enabled = false;
  }

  static supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition) && !!navigator.mediaDevices?.getUserMedia;
  }

  async init({ hotMic = true } = {}) {
    this.hotMicOn = hotMic;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    this.ac = ac;
    const src = ac.createMediaStreamSource(this.stream);
    this.analyser = ac.createAnalyser(); this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.floor = 0.01; this.loudSince = 0; this.lastHot = 0;
    this.meterTimer = setInterval(() => this.meter(), 100);

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.rec = new SR();
    this.rec.lang = 'en-GB';
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.maxAlternatives = 3;
    this.rec.onresult = (e) => {
      let fin = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript + ' ';
        else interim += r[0].transcript + ' ';
      }
      this.finalText = fin; this.interimText = interim;
      this.onInterim?.((fin + interim).trim());
    };
    this.rec.onend = () => { this.recRunning = false; this.endResolve?.(); };
    this.rec.onerror = (e) => { this.lastError = e.error; };
    this.bindInputs();
    this.enabled = true;
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
    this.finalText = ''; this.interimText = '';
    this.onDown?.();
    try { this.rec.start(); this.recRunning = true; } catch { /* already running */ }
  }

  async up() {
    if (!this.keyed) return;
    this.keyed = false;
    const held = performance.now() - this.keyAt;
    const ended = new Promise(r => { this.endResolve = r; });
    try { this.rec.stop(); } catch { /* not running */ }
    await Promise.race([ended, new Promise(r => setTimeout(r, 1500))]);
    const text = (this.finalText || this.interimText).trim();
    this.onUp?.(text, { heldMs: Math.round(held), error: this.lastError || null });
    this.lastError = null;
  }

  meter() {
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
    this.stream?.getTracks().forEach(t => t.stop());
    this.ac?.close();
    this.enabled = false;
  }
}
