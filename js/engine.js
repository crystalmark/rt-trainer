// Scenario engine: runs one scripted flight against a radio, with background traffic,
// readback checking, corrections, missed calls, blocked transmissions and an optional
// hand-over to Claude when the pilot leaves the script.
// No DOM access here: the browser app and the Node tests both drive it through adapters.
import { match, isSayAgain, looksLikeRequest } from './matcher.js';
import { speakable, phoneticCallsign, callsignForms, tokens } from './normalize.js';

class OffScript extends Error { constructor(tx) { super('off-script'); this.tx = tx; } }
class Ended extends Error { constructor() { super('ended'); } }

// Names the speech synthesiser gets wrong.
const PRONOUNCE = [
  [/\bKirkcaldy\b/g, 'Kir-coddy'], [/\bKeighley\b/g, 'Keethly'], [/\bMusselburgh\b/g, 'Mussel-burra'],
  [/\bEdinburgh\b/g, 'Edin-burra'], [/\bGlenrothes\b/g, 'Glen-rothiss'], [/\bOxenhope\b/g, 'Oxen-hope'],
  [/\bQNH\b/g, 'Q N H'], [/\bQFE\b/g, 'Q F E'], [/\bVFR\b/g, 'V F R'], [/\bATZ\b/g, 'A T Z'],
  [/\bCTR\b/g, 'C T R'], [/\bPOB\b/g, 'P O B'], [/\bPPR\b/g, 'P P R'],
];

export const DEFAULT_SETTINGS = {
  timeScale: 1,              // 1 = real flight time; 2 = legs pass twice as fast
  trafficDensity: 'normal',  // quiet | normal | busy
  atcDelay: [0.4, 1.6],      // seconds before the controller answers you
  replyTimeout: 9,           // seconds ATC waits for your readback before repeating
  reportTimeout: 45,         // seconds after reaching a reporting point before ATC chases you
  refusalBias: 0,            // add to the scenario's refusal chance (0..1)
};

const DENSITY_GAP = { quiet: [70, 150], normal: [25, 70], busy: [8, 30] };

export class Engine {
  constructor({ scenario, profile, settings = {}, radio, clock, rng = Math.random, claude = null, onEvent = () => {} }) {
    this.scenario = scenario;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.radio = radio;
    this.clock = clock;
    this.rng = rng;
    this.claude = claude;
    this.onEvent = onEvent;
    const forms = callsignForms(profile.reg);
    const abbr = `${forms.abbr[0].toUpperCase()}-${forms.abbr.slice(1).toUpperCase()}`;
    this.ctx = {
      reg: profile.reg.toUpperCase(), abbr, type: profile.type, transponder: !!profile.transponder,
      speedKt: profile.speedKt || 55, unit: scenario.unit, freq: scenario.freq,
      abbreviated: false,       // becomes true once ATC abbreviates the callsign
    };
    this.events = [];
    this.running = false;
    this.paused = false;
    this.mode = 'script';
    this.waiter = null;
    this.channel = Promise.resolve();
    this.channelLocked = false;
    this.exchangeActive = false;
    this.trafficHoldUntil = 0;
    this.lastToPilot = null;
    this.similarWindow = null;
    this.standbyPending = false;
    this.blocked = null;
    this.keyed = false;
    this.freeHistory = [];
    this.t0 = 0;
    this.abortReason = null;
  }

  // ---------- helpers ----------
  now() { return this.clock.now(); }
  elapsed() { return Math.round((this.now() - this.t0) / 1000); }
  log(type, data = {}) {
    const e = { t: this.elapsed(), type, ...data };
    this.events.push(e);
    this.onEvent({ kind: 'log', event: e });
    return e;
  }
  emit(kind, data = {}) { this.onEvent({ kind, ...data }); }
  rand(a, b) { return a + (b - a) * this.rng(); }
  chance(p) { return this.rng() < Math.min(1, Math.max(0, p)); }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  similarAbbr() {
    const a = this.ctx.abbr; const last = a.slice(-1);
    const alt = 'TKRNPSXL'.split('').find(c => c !== last && c !== a.slice(-2, -1));
    return a.slice(0, -1) + alt;
  }

  fill(text) {
    const c = this.ctx;
    const cs = c.abbreviated ? c.abbr : c.reg;
    return text
      .replace(/\{CS\}/g, c.reg).replace(/\{AB\}/g, c.abbr).replace(/\{CALL\}/g, cs)
      .replace(/\{TYPE\}/g, c.type).replace(/\{UNIT\}/g, c.unit).replace(/\{SIM\}/g, this.similarAbbr());
  }
  toSpeech(display) {
    let s = display.replace(/\b([A-Z])-([A-Z]{2,4})\b/g, (m) => phoneticCallsign(m));
    for (const [re, rep] of [...PRONOUNCE, ...(this.scenario.pronounce || [])]) s = s.replace(re, rep);
    return speakable(s);
  }

  async sleep(ms) {
    let left = ms;
    while (left > 0) {
      this.checkAbort();
      const step = Math.min(left, this.clock.tick || 250);
      await this.clock.sleep(step);
      if (!this.paused) left -= step;
    }
    this.checkAbort();
  }
  checkAbort() {
    if (!this.running) throw new Ended();
    if (this.abortReason) { const r = this.abortReason; this.abortReason = null; throw r; }
  }

  async withChannel(fn) {
    const prev = this.channel;
    let release;
    this.channel = new Promise(r => { release = r; });
    await prev;
    this.channelLocked = true;
    try { return await fn(); } finally { this.channelLocked = false; release(); }
  }

  async transmit(speaker, text, meta = {}) {
    const display = this.fill(text);
    this.log(speaker === 'atc' ? 'atc' : 'traffic', { speaker, text: display, ...meta });
    this.emit('radio', { speaker, text: display, meta });
    const res = await this.radio.say(speaker, display, this.toSpeech(display), meta);
    return { display, interrupted: !!(res && res.interrupted) };
  }

  // ---------- pilot input (called by the UI) ----------
  pilotKeyDown() {
    this.keyed = true;
    this.keyDownAt = this.now();
    if (this.radio.busy) {
      this.blocked = { speaker: this.radio.currentSpeaker };
      this.radio.interrupt();
    } else if (this.exchangeActive && (!this.waiter || this.lastWaitKind !== 'readback')) {
      this.steppedIn = true;
    }
  }

  /** Pilot released PTT; text is the recognised speech ('' if nothing heard). */
  pilotTransmission(text, meta = {}) {
    this.keyed = false;
    if (!this.running) return;
    text = String(text || '').trim();
    const tx = { text, at: this.now(), latency: this.lastToPilotAt ? (this.keyDownAt || this.now()) - this.lastToPilotAt : null, ...meta };
    if (this.blocked) {
      const b = this.blocked; this.blocked = null;
      this.log('blocked', { text, over: b.speaker });
      this.emit('toast', { level: 'warn', text: 'Blocked: you transmitted over another station.' });
      if (b.speaker && b.speaker !== 'atc') {
        this.queueAtc('Blocked, say again', { delay: 0.8 });
      }
      return;
    }
    if (!text) {
      this.log('empty-tx', {});
      this.emit('toast', { level: 'info', text: 'Nothing recognised: try again, speaking after the click.' });
      return;
    }
    this.log('pilot', { text });
    this.emit('radio', { speaker: 'pilot', text });
    if (this.steppedIn) {
      this.steppedIn = false;
      this.log('stepped-in', { text });
      this.standbyPending = true;
      this.queueAtc('{CALL}, standby', { delay: 0.5, bypassLock: true });
      return;
    }
    if (this.similarWindow && this.now() < this.similarWindow.until &&
        (!this.waiter || (this.lastWaitKind === 'call' && match(text, this.currentSpec || [], this.ctx).hardRatio < 0.5))) {
      this.log('wrong-callsign', { text, forCall: this.similarWindow.call });
      this.queueAtc(`{CALL}, negative, that was for ${this.similarWindow.call}`, { delay: 0.8 });
      this.similarWindow = null;
      return;
    }
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(tx); return; }
    this.unsolicited(tx);
  }

  hotMic() {
    this.log('hot-mic', {});
    this.emit('toast', { level: 'warn', text: 'Not transmitted: you spoke without pressing PTT.' });
  }

  queueAtc(text, { delay = 0.6, bypassLock = false } = {}) {
    const run = async () => {
      try {
        await this.sleep(delay * 1000);
        await this.transmit('atc', text, { toPilot: true });
      } catch (e) { if (!(e instanceof Ended)) throw e; }
    };
    if (bypassLock) run(); else this.withChannel(run).catch(() => {});
  }

  unsolicited(tx) {
    if (isSayAgain(tx.text) && this.lastToPilot) {
      this.queueAtc(`{CALL}, I say again, ${stripCallsign(this.lastToPilot)}`);
      return;
    }
    if (this.mode === 'free') { this.freeQueue.push(tx); this.freeKick?.(); return; }
    if (this.claude && looksLikeRequest(tx.text)) { this.abortReason = new OffScript(tx); return; }
    this.log('unexpected', { text: tx.text });
    this.queueAtc(looksLikeRequest(tx.text) ? '{CALL}, unable, continue as cleared' : '{CALL}, say again');
  }

  /** Wait for the pilot's next transmission. Timer only runs while the frequency is quiet. */
  waitPilot(timeoutSec) {
    return new Promise((resolve, reject) => {
      let waited = 0, done = false;
      this.waiter = (tx) => { done = true; resolve(tx); };
      const tick = async () => {
        while (!done) {
          await this.clock.sleep(250);
          if (!this.running) { done = true; this.waiter = null; reject(new Ended()); return; }
          if (this.abortReason) { done = true; this.waiter = null; const r = this.abortReason; this.abortReason = null; reject(r); return; }
          if (!this.paused && !this.radio.busy && !this.keyed && !this.channelLocked) waited += 250;
          if (timeoutSec != null && waited >= timeoutSec * 1000) { done = true; this.waiter = null; resolve(null); return; }
        }
      };
      tick();
    });
  }

  // ---------- scenario API ----------
  api() {
    const e = this;
    return {
      ctx: e.ctx,
      chance: p => e.chance(p),
      pick: a => e.pick(a),
      fill: t => e.fill(t),
      setRadio: r => { Object.assign(e.radioState ||= {}, r); e.emit('radioState', { state: e.radioState }); },
      setUnit: (unit, freq) => { e.ctx.unit = unit; e.ctx.freq = freq; e.emit('radioState', { state: Object.assign(e.radioState ||= {}, { unit, freq }) }); },
      note: text => e.log('note', { text }),
      atc: (text, o) => e.atc(text, o),
      expect: o => e.expect(o),
      leg: (label, nm, o) => e.leg(label, nm, o),
      at: (label, cue) => { e.emit('position', { label, cue }); e.log('position', { label }); },
      fly: plan => e.fly(plan),
      reach: (s, o) => e.reach(s, o),
      hold: s => { if (e.nav) e.nav.limit = s == null ? Infinity : Math.max(0, s); },
      position: () => e.nav ? { ...e.nav.plan.posAt(e.nav.s), s: e.nav.s } : null,
      pause: sec => e.sleep(sec * 1000),
      end: summary => { e.summary = summary; },
      settings: e.settings,
    };
  }

  async leg(label, nm, { cue } = {}) {
    const minutes = (nm / this.ctx.speedKt) * 60;
    const ms = (minutes * 60000) / this.settings.timeScale;
    this.emit('leg', { label, nm, ms, cue, startedAt: this.now() });
    if (cue) this.log('cue', { text: cue });
    await this.sleep(ms);
  }

  // ---------- flying a planned route (your own routes) ----------
  // The aircraft moves continuously: at the chosen time scale while the frequency is quiet, in real time while
  // anyone is talking, so an exchange costs the flight time it would in the air. hold(s) stops it short of a
  // point along the route, where it orbits (outside the zone until cleared, say).
  fly(plan) {
    const looping = !!this.nav;
    this.nav = { plan, s: 0, limit: Infinity, last: this.now(), emitted: -Infinity, orbiting: false };
    if (!looping) this.navLoop();
  }

  async navLoop() {
    while (this.running && this.nav) {
      await this.clock.sleep(this.clock.tick || 250);
      this.navStep();
    }
  }

  navStep() {
    const n = this.nav, now = this.now(), dt = now - n.last;
    n.last = now;
    if (this.paused || !this.running) return;
    const busy = this.radio.busy || this.channelLocked || this.waiter || this.keyed || this.exchangeActive;
    const cap = Math.min(n.limit, n.plan.total);
    if (n.s < cap) n.s = Math.min(cap, n.s + this.ctx.speedKt * (busy ? 1 : this.settings.timeScale) * dt / 3600000);
    n.orbiting = n.s >= cap - 1e-6 && cap < n.plan.total;
    if (now - n.emitted >= 1000) { n.emitted = now; this.emit('nav', this.navState()); }
  }

  /** Where the aircraft is, what's next and how long until it (flight time at your speed). */
  navState() {
    const n = this.nav, p = n.plan.posAt(n.s);
    const next = n.plan.points.find(w => w.s > n.s + 0.05);
    const left = next ? next.s - n.s : 0;
    return { s: n.s, total: n.plan.total, lat: p.lat, lon: p.lon, x: p.x, y: p.y, track: p.track, orbiting: n.orbiting,
      altitude: n.plan.altitude, next: next ? { name: next.place.name, nm: left, sec: left / this.ctx.speedKt * 3600 } : null };
  }

  /** Wait until the aircraft is s nm along the route (or at its hold point, if that comes first). */
  async reach(s, { label, cue } = {}) {
    const n = this.nav, goal = Math.min(s, n.plan.total, n.limit);
    const left = Math.max(0, goal - n.s);
    this.emit('leg', { label, nm: left, ms: left / this.ctx.speedKt * 3600000 / this.settings.timeScale, cue, nav: true });
    if (cue) this.log('cue', { text: cue });
    while (n.s < goal - 1e-6) await this.sleep(this.clock.tick || 250);
  }

  async atc(text, { readback = null, model = null, timeout, clearance = false, reply = null, hold = true } = {}) {
    if (hold) this.trafficHoldUntil = this.now() + 12000;
    await this.withChannel(async () => {
      await this.sleep(this.rand(...this.settings.atcDelay) * 1000);
      await this.transmit('atc', text, { toPilot: true });
    });
    if (/\{AB\}|\{CALL\}/.test(text)) this.ctx.abbreviated = true;
    this.lastToPilot = this.fill(text);
    this.lastToPilotAt = this.now();
    if (readback) return this.readback(readback, text, { model, timeout, clearance });
    if (reply) return this.expect({ ...reply, afterAtc: true });
    return null;
  }

  async readback(spec, original, { model, timeout, clearance } = {}) {
    let attempts = 0, misses = 0, current = spec;
    const atcText = this.fill(original);
    while (true) {
      this.trafficHoldUntil = this.now() + 15000;
      this.emit('awaiting', { waitKind: 'readback', spec: current, atcText });
      this.lastWaitKind = 'readback'; this.currentSpec = current;
      const tx = await this.waitPilot(timeout ?? this.settings.replyTimeout);
      if (!tx) {
        misses++;
        this.log('missed', { atcText, misses });
        if (misses === 1) { await this.atc(original, { hold: true }); continue; }
        if (misses === 2) { await this.atc('{CALL}, {UNIT}, how do you read?'); continue; }
        this.log('no-reply', { atcText });
        return { failed: true };
      }
      if (isSayAgain(tx.text)) {
        this.log('say-again', { text: tx.text });
        await this.atc(`{CALL}, I say again, ${stripCallsign(original)}`);
        continue;
      }
      const r = match(tx.text, current, this.ctx, { kind: 'readback' });
      for (const w of this.scenario.warn || []) if (w.re.test(tx.text.toLowerCase())) r.fillers.push(w.why);
      if (r.hardRatio < 0.35 && looksLikeRequest(tx.text) && this.claude) throw new OffScript(tx);
      const ev = this.log('readback', { atcText, text: tx.text, attempt: attempts + 1, latency: tx.latency, result: summarise(r), model: model ? this.fill(model) : null });
      if (!r.callsign) {
        await this.atc('Station reading back, say callsign');
        const tx2 = await this.waitPilot(this.settings.replyTimeout);
        if (tx2) this.log('callsign-given', { text: tx2.text });
      }
      if (!r.hardMissing.length) return r;
      attempts++;
      if (attempts >= 3) { this.log('gave-up', { atcText }); return r; }
      const miss = r.hardMissing;
      let correction;
      if (miss.length === 1 && miss[0].retry) { correction = miss[0].retry; current = [miss[0]]; }
      else if (miss.length === 1 && miss[0].fix && r.hardRatio >= 0.5) { correction = `{CALL}, negative, ${miss[0].fix}`; current = [miss[0]]; }
      else if (r.hardRatio === 0 && clearance) { correction = '{CALL}, read back the clearance'; current = spec; }
      else { correction = `{CALL}, negative, I say again, ${stripCallsign(original)}`; current = spec; }
      ev.corrected = true;
      this.log('correction', { text: this.fill(correction), missing: miss.map(i => i.label) });
      await this.atc(correction);
    }
  }

  async expect({ id, cue, items = [], timeout, nudge, optional = false, initial = false, model = null, afterAtc = false, warn = [] }) {
    if (cue) { this.emit('cue', { text: cue }); this.log('cue', { text: cue }); }
    this.emit('awaiting', { waitKind: 'call', id, spec: items, cue });
    this.lastWaitKind = 'call'; this.currentSpec = items;
    let nudged = 0, tries = 0;
    while (true) {
      const tx = await this.waitPilot(timeout ?? (afterAtc ? this.settings.replyTimeout : this.settings.reportTimeout));
      if (!tx) {
        if (optional) return null;
        if (nudge && nudged < 2) { nudged++; this.log('late', { id }); await this.atc(nudge); continue; }
        if (afterAtc && nudged < 2) { nudged++; this.log('missed', { atcText: this.lastToPilot }); await this.atc(this.lastToPilot.replace(/^[^,]*,\s*/, '{CALL}, ')); continue; }
        this.log('no-call', { id });
        return null;
      }
      if (isSayAgain(tx.text) && this.lastToPilot) {
        await this.atc(`{CALL}, I say again, ${stripCallsign(this.lastToPilot)}`);
        continue;
      }
      const r = match(tx.text, items, this.ctx, { kind: 'call' });
      for (const w of warn.concat(this.scenario.warn || [])) if (w.re.test(tx.text.toLowerCase())) r.fillers.push(w.why);
      if (!initial && r.hardRatio < 0.35 && looksLikeRequest(tx.text) && this.claude) throw new OffScript(tx);
      this.log('call', { id, text: tx.text, latency: tx.latency, result: summarise(r), model: model ? this.fill(model) : null });
      if (!r.callsign) {
        await this.atc(initial ? 'Station calling {UNIT}, say again your callsign' : 'Station calling, say again callsign');
        continue;
      }
      // Ask for missing essentials, as a controller would ("say altitude").
      for (const item of r.hardMissing.filter(i => i.ask)) {
        await this.atc(item.ask);
        const tx2 = await this.waitPilot(this.settings.replyTimeout * 2);
        const r2 = tx2 ? match(tx2.text, [item], this.ctx) : null;
        this.log('answer', { text: tx2?.text || '', asked: item.label, ok: !!(r2 && !r2.hardMissing.length) });
        if (r2 && !r2.hardMissing.length) { item.matched = true; }
      }
      const still = r.hardMissing.filter(i => !i.ask && !i.matched);
      if (still.length && tries < 1) { tries++; await this.atc('{CALL}, say again'); continue; }
      r.hasAll = (key) => r.items.some(i => i.key === key && i.matched);
      return r;
    }
  }

  // ---------- run ----------
  async start() {
    this.running = true;
    this.t0 = this.now();
    this.log('start', { scenario: this.scenario.id, reg: this.ctx.reg, transponder: this.ctx.transponder });
    this.emit('radioState', { state: (this.radioState = { unit: this.ctx.unit, freq: this.ctx.freq, squawk: this.ctx.transponder ? '7000' : null }) });
    this.trafficLoop();
    try {
      await this.scenario.run(this.api());
    } catch (e) {
      if (e instanceof OffScript) await this.freeMode(e.tx);
      else if (!(e instanceof Ended)) { this.log('error', { text: String(e && e.stack || e) }); console.error(e); }
    }
    return this.finish();
  }

  stop() { if (this.running) { this.log('stopped', {}); this.running = false; this.radio.stopAll?.(); } }

  finish() {
    this.running = false;
    if (this.waiter) { this.waiter = null; }
    this.log('end', { summary: this.summary || null });
    this.emit('end', { events: this.events, ctx: this.ctx, summary: this.summary });
    return this.events;
  }

  async trafficLoop() {
    const gen = this.scenario.traffic;
    if (!gen) return;
    try {
      await this.sleep(this.rand(4, 10) * 1000);
      while (this.running) {
        const [a, b] = DENSITY_GAP[this.settings.trafficDensity] || DENSITY_GAP.normal;
        await this.sleep(this.rand(a, b) * 1000);
        while (this.running && (this.now() < this.trafficHoldUntil || this.waiter && this.lastWaitKind === 'readback' || this.keyed)) await this.sleep(1000);
        const ex = gen(this.api(), { similar: this.similarAbbr(), rng: this.rng });
        if (!ex || !ex.length) continue;
        await this.withChannel(async () => {
          this.exchangeActive = true;
          try {
            for (let i = 0; i < ex.length; i++) {
              const line = ex[i];
              if (i) await this.sleep(this.rand(0.5, 1.4) * 1000);
              await this.transmit(line[0], line[1], { traffic: true });
              if (line[2] && line[2].similar) this.similarWindow = { until: this.now() + 8000, call: line[2].similar };
            }
          } finally { this.exchangeActive = false; }
        });
        if (this.standbyPending) {
          this.standbyPending = false;
          await this.withChannel(async () => { await this.sleep(700); await this.transmit('atc', '{CALL}, pass your message', { toPilot: true }); });
        }
      }
    } catch (e) { if (!(e instanceof Ended) && !(e instanceof OffScript)) console.error(e); }
  }

  async freeMode(firstTx) {
    this.mode = 'free';
    this.log('offscript', { text: firstTx.text });
    this.emit('toast', { level: 'info', text: 'Off script: Claude is now the controller (replies take 1–3 s).' });
    this.freeQueue = [firstTx];
    let quiet = 0;
    while (this.running) {
      if (!this.freeQueue.length) {
        await new Promise(r => { this.freeKick = r; setTimeout(r, 1000); });
        this.freeKick = null;
        quiet++;
        if (quiet > 900) break;       // 15 minutes of silence ends the session
        continue;
      }
      quiet = 0;
      const tx = this.freeQueue.shift();
      this.freeHistory.push({ role: 'pilot', text: tx.text });
      let resp;
      try {
        resp = await this.claude.atc({ scenario: this.scenario, ctx: this.ctx, events: this.events, history: this.freeHistory, pilot: tx.text });
      } catch (err) {
        this.log('claude-error', { text: String(err.message || err) });
        await this.transmit('atc', '{CALL}, say again', { toPilot: true });
        continue;
      }
      this.log('free-assessment', { text: tx.text, assessment: resp.assessment || null });
      for (const t of resp.transmissions || []) {
        await this.withChannel(async () => { await this.transmit('atc', t, { toPilot: true, claude: true }); });
        this.freeHistory.push({ role: 'atc', text: t });
        this.lastToPilot = t; this.lastToPilotAt = this.now();
      }
      if (resp.position) this.emit('position', { label: resp.position });
      if (resp.end) { this.summary = resp.summary || 'Ended off script'; break; }
      // route the next transmissions into the queue
      while (this.running && !this.freeQueue.length) {
        const nxt = await this.waitPilot(null).catch(() => null);
        if (!nxt) break;
        this.freeQueue.push(nxt);
      }
    }
  }
}

function stripCallsign(text) {
  return String(text).replace(/^\s*(\{CALL\}|\{AB\}|\{CS\}|[A-Z]-[A-Z]{2,4})\s*,\s*/, '');
}

function summarise(r) {
  return {
    score: r.score, orderOk: r.orderOk, fillers: r.fillers,
    callsign: r.callsign ? r.callsign.form : null, callsignPlacement: r.callsignPlacement,
    missing: r.hardMissing.map(i => i.label), softMissing: r.softMissing.map(i => ({ label: i.label, why: i.why || null })),
    substitutions: r.substitutions.map(i => ({ label: i.label, said: i.substituted, why: i.why || null })),
    forbidden: r.items.filter(i => i.forbidden).map(i => ({ label: i.label, said: i.forbidden, why: i.why || null })),
    matched: r.items.filter(i => i.matched).map(i => i.label),
  };
}

export { OffScript, Ended, stripCallsign };
