// The debrief's numbers, from engine event logs: what counts as a reply, what counts as a late report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { SCENARIOS } from '../js/scenarios/index.js';
import { PROFILES } from '../js/config.js';
import { computeDebrief } from '../js/debrief.js';
import { fakeClock, fakeRadio, seeded, perfectPilot, sendWhenClear } from './helpers.mjs';

function fly(id, seed, { settings = {}, pilot = perfectPilot } = {}) {
  const clock = fakeClock(4000), radio = fakeRadio(clock);
  let handler = () => {};
  const engine = new Engine({ scenario: SCENARIOS.find(s => s.id === id), profile: PROFILES[1], radio, clock, rng: seeded(seed),
    settings: { trafficDensity: 'quiet', ...settings }, onEvent: e => handler(e) });
  handler = pilot(engine);
  return engine.start();
}

// Reply time is how long the pilot takes to answer ATC. Reports made unprompted were timed from whatever ATC had last
// said, and at a faster time scale a pilot who answered everything at once was told they were slow.
test('reply time counts answers to ATC, not reports made unprompted', async () => {
  for (const seed of [1, 2, 3]) {
    const events = await fly('carlisle-arrival', seed, { settings: { timeScale: 2 } });
    const reports = events.filter(e => e.type === 'call' && ['overhead', 'downwind', 'final', 'vacated'].includes(e.id));
    assert.ok(reports.length, 'the circuit calls were made');
    assert.ok(reports.every(e => e.latency == null), JSON.stringify(reports.map(e => [e.id, e.latency])));
    const d = computeDebrief(events);
    assert.ok(d.stats.medianResponseSec == null || d.stats.medianResponseSec < 6, `seed ${seed}: median ${d.stats.medianResponseSec} s`);
    assert.ok(!d.issues.some(i => /Slow to answer/.test(i.title)));
  }
});

// A report never made was chased twice and then given up on: counted once per chase, one report was three.
test('a late report counts once, however often it was chased', () => {
  const d = computeDebrief([{ type: 'late', id: 'kirkby' }, { type: 'late', id: 'kirkby' }, { type: 'no-call', id: 'kirkby' }, { type: 'late', id: 'penrith' }]);
  assert.equal(d.stats.lateReports, 2);
});

// "Pass your message" left unanswered is a missed call, not a position report: it was counted as both.
test('an unanswered "pass your message" is a missed call, not a late report', async () => {
  const events = await fly('leeds-basic', 1, { pilot: engine => {
    const perfect = perfectPilot(engine);
    return ev => { if (ev.kind === 'awaiting' && ev.id === 'initial') { sendWhenClear(engine, 'Leeds Radar, golf charlie zulu india alpha'); return; }
      if (ev.kind === 'awaiting' && ev.id === 'details') return;        // never answered
      perfect(ev); };
  } });
  // One missed call for each time ATC asked, the last included, as an unanswered readback counts them.
  const asked = events.filter(e => e.type === 'atc' && e.toPilot && /pass your message/.test(e.text)).length;
  const missed = events.filter(e => e.type === 'missed' && /pass your message/.test(e.atcText)).length;
  assert.equal(asked, 3);
  assert.equal(missed, asked);
  assert.ok(events.some(e => e.type === 'no-reply'));
  assert.ok(!events.some(e => e.type === 'no-call' && e.id === 'details'), 'not a report that never came');
  assert.equal(computeDebrief(events).stats.lateReports, 0);
});

// The first readback after the controller starts using {CALL} was quoted, and its model answer filled, with the
// abbreviated callsign ATC had not yet used: the "Better:" line taught abbreviating first, and the timeline showed the
// controller's line twice because the quote and the line no longer matched.
test('the first readback is quoted, and modelled, with the callsign ATC used', async () => {
  const events = await fly('leeds-transit', 5, { settings: { refusalBias: -1 } });
  const first = events.find(e => e.type === 'readback');
  const said = events.find(e => e.type === 'atc' && e.toPilot && /Basic Service, squawk/.test(e.text));
  assert.equal(first.atcText, said.text);
  assert.match(said.text, /^G-CZIA, /);
  assert.match(first.model, /G-CZIA$/, first.model);
  const shown = computeDebrief(events).timeline.filter(e => e.type === 'atc' && e.text === said.text);
  assert.equal(shown.length, 0, 'the line appears once, with its readback');
});
