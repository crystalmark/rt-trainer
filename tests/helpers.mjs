// Headless adapters so the engine can run a whole scenario in milliseconds.
export function fakeClock(speedup = 2000) {
  const start = Date.now();
  return {
    tick: 5000,
    now: () => start + (Date.now() - start) * speedup,
    sleep: ms => new Promise(r => setTimeout(r, Math.max(0, ms / speedup))),
  };
}
export function fakeRadio(clock) {
  return {
    busy: false, currentSpeaker: null, lines: [],
    async say(speaker, display) {
      this.busy = true; this.currentSpeaker = speaker; this.lines.push([speaker, display]);
      await clock.sleep(1500 + display.length * 60);
      this.busy = false; this.currentSpeaker = null;
      return { interrupted: false };
    },
    interrupt() { this.busy = false; },
    stopAll() {},
  };
}
export function seeded(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
/** The flawless pilot also does as they are told: sets the code, presses ident, starts and stops the orbit. */
function doAsTold(engine, ev) {
  setTimeout(() => {
    if (ev.action === 'squawk' || ev.action === 'squawk-ident') engine.setSquawk(ev.value);
    if (ev.action === 'squawk-ident') engine.ident();
    if (ev.action === 'orbit') engine.setOrbit(ev.value);
  }, 1);
}

/** A pilot who answers every expectation with the first acceptable phrase of every item. */
export function perfectPilot(engine, { override = {} } = {}) {
  return (ev) => {
    if (ev.kind === 'action') { if (ev.pending) doAsTold(engine, ev); return; }
    if (ev.kind !== 'awaiting') return;
    const ab = engine.ctx.abbr, reg = engine.ctx.reg;
    const words = (ev.spec || []).map(i => i.any[0]).filter(Boolean);
    let text;
    if (override[ev.id]) text = override[ev.id](engine, ev);
    else if (ev.kind === 'awaiting' && ev.spec && ev.id === 'initial') text = `${engine.ctx.unit}, ${reg}, ${words.join(', ')}`;
    else if (ev.id) text = `${engine.ctx.abbreviated ? ab : reg}, ${words.join(', ')}`;
    else text = `${words.join(', ')}, ${engine.ctx.abbreviated ? ab : reg}`;
    sendWhenClear(engine, text);
  };
}

/** Like a real pilot: wait for a gap on the frequency, then transmit. */
export function sendWhenClear(engine, text) {
  const go = () => {
    if (engine.radio.busy || engine.exchangeActive) return setTimeout(go, 1);
    engine.pilotKeyDown(); engine.pilotTransmission(text);
  };
  setImmediate(go);
}
