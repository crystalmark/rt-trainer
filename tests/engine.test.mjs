import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { SCENARIOS } from '../js/scenarios/index.js';
import { PROFILES } from '../js/config.js';
import { fakeClock, fakeRadio, seeded, perfectPilot, sendWhenClear } from './helpers.mjs';

function run(scenario, profile, seed, { settings = {}, pilot = perfectPilot, override } = {}) {
  const clock = fakeClock(4000);
  const radio = fakeRadio(clock);
  let handler = () => {};
  const engine = new Engine({ scenario, profile, radio, clock, rng: seeded(seed),
    settings: { trafficDensity: 'busy', ...settings }, onEvent: e => handler(e) });
  handler = pilot(engine, { override });
  return engine.start().then(events => ({ events, engine, radio }));
}

for (const scenario of SCENARIOS) {
  for (const profile of PROFILES) {
    test(`${scenario.id} / ${profile.reg}: perfect pilot completes with no corrections`, async () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const { events } = await run(scenario, profile, seed);
        const types = events.map(e => e.type);
        assert.ok(!types.includes('error'), JSON.stringify(events.find(e => e.type === 'error')));
        assert.equal(events.filter(e => e.type === 'correction').length, 0,
          `seed ${seed}: ` + JSON.stringify(events.filter(e => e.type === 'correction' || e.type === 'readback').slice(0, 4)));
        const end = events.at(-1);
        assert.equal(end.type, 'end');
        assert.ok(end.summary, `seed ${seed} ended without summary: ${types.slice(-8).join(',')}`);
      }
    });
  }
}

test('Leeds refusal: saying "zone" instead of "controlled airspace" gets challenged', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const clock = fakeClock(4000); const radio = fakeRadio(clock);
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[0], radio, clock, rng: seeded(7), settings: { refusalBias: 1, trafficDensity: 'quiet' }, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine);
  let zoneAnswers = 0;
  handler = (ev) => {
    if (ev.kind === 'awaiting' && /confirm you will not enter/.test(ev.atcText || '') && zoneAnswers < 1) {
      zoneAnswers++;
      sendWhenClear(engine, 'affirm I will not enter the zone G-HP');
      return;
    }
    perfect(ev);
  };
  const events = await engine.start();
  const corr = events.filter(e => e.type === 'correction');
  assert.ok(corr.some(c => /please confirm you will not enter controlled airspace/.test(c.text)), JSON.stringify(corr));
  const rb = events.find(e => e.type === 'readback' && e.result.substitutions.length);
  assert.equal(rb.result.substitutions[0].said, 'zone');
  assert.match(events.at(-1).summary, /refused/);
});

test('Wrong QNH gets a single-item correction', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const { events } = await run(scenario, PROFILES[1], 11, {
    settings: { refusalBias: -1, trafficDensity: 'quiet' },
    pilot: (engine) => {
      const perfect = perfectPilot(engine); let done = false;
      return ev => {
        if (!done && ev.kind === 'awaiting' && /Cleared to enter/.test(ev.atcText || '')) {
          done = true;
          sendWhenClear(engine, 'cleared to enter the zone via Salts Mill VFR not above altitude 3000 feet QNH 1016 route Eccup wilco G-IA');
          return;
        }
        perfect(ev);
      };
    },
  });
  const corr = events.filter(e => e.type === 'correction');
  assert.equal(corr.length, 1);
  assert.match(corr[0].text, /negative, QNH 1017/);
});

test('Missed readback: ATC repeats, then asks how do you read', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-basic');
  const { events } = await run(scenario, PROFILES[1], 3, {
    settings: { trafficDensity: 'quiet' },
    pilot: (engine) => {
      const perfect = perfectPilot(engine); let silent = 0;
      return ev => {
        if (ev.kind === 'awaiting' && /squawk 5621/.test(ev.atcText || '') && silent < 2) { silent++; return; }
        perfect(ev);
      };
    },
  });
  const atc = events.filter(e => e.type === 'atc').map(e => e.text);
  assert.ok(atc.filter(t => /squawk 5621/.test(t)).length >= 2);
  assert.ok(atc.some(t => /how do you read/.test(t)));
  assert.equal(events.filter(e => e.type === 'missed').length, 2);
});

test('Going off script hands the frequency to Claude', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'edinburgh-transit');
  const clock = fakeClock(4000); const radio = fakeRadio(clock);
  const calls = [];
  const claude = { atc: async ({ pilot }) => { calls.push(pilot);
    return calls.length === 1
      ? { transmissions: ['G-IA, roger, leave controlled airspace eastbound, report established en route to East Fortune'], assessment: 'Clear request.' }
      : { transmissions: ['G-IA, roger, frequency change approved'], end: true, summary: 'Diverted' }; } };
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(2), claude, settings: { trafficDensity: 'quiet' }, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine);
  let diverted = false;
  handler = ev => {
    if (!diverted && ev.kind === 'awaiting' && ev.id === 'musselburgh') { diverted = true; sendWhenClear(engine, 'G-IA, request return to East Fortune due weather'); return; }
    if (diverted && ev.kind === 'radio' && ev.meta?.claude && calls.length === 1) sendWhenClear(engine, 'Leave controlled airspace eastbound, wilco, G-IA');
    if (!diverted) perfect(ev);
  };
  const events = await engine.start();
  assert.ok(events.some(e => e.type === 'offscript'));
  assert.equal(calls.length, 2);
  assert.equal(events.at(-1).summary, 'Diverted');
});
