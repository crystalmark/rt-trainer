import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { SCENARIOS } from '../js/scenarios/index.js';
import { PROFILES } from '../js/config.js';
import { fakeClock, fakeRadio, seeded, perfectPilot, sendWhenClear } from './helpers.mjs';
import { listenScenario, LISTEN_UNITS } from '../js/scenarios/listen.js';
import { computeDebrief } from '../js/debrief.js';

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

test('listen out: the frequency fills with traffic, and nothing is expected of you', async () => {
  for (const { id, unit } of LISTEN_UNITS) {
    const scenario = listenScenario(id);
    assert.equal(scenario.unit, unit);
    assert.ok(scenario.briefing().length >= 3);
    const clock = fakeClock(4000);
    const radio = fakeRadio(clock);
    const engine = new Engine({ scenario, profile: PROFILES[0], radio, clock, rng: seeded(3), settings: { trafficDensity: 'busy' } });
    const run = engine.start();
    await new Promise(r => setTimeout(r, 400));
    engine.stop();
    const events = await run;
    assert.ok(!events.some(e => e.type === 'error'), unit);
    assert.ok(events.filter(e => e.type === 'traffic').length >= 2, `${unit}: only ${events.filter(e => e.type === 'traffic').length} transmissions`);
    assert.ok(!events.some(e => ['readback', 'call', 'missed', 'no-call'].includes(e.type)), `${unit}: nothing should be asked of the pilot`);
    assert.equal(events.at(-1).type, 'end');
  }
});

test('a squawk read back but never set: ATC chases it, then asks for a reset and ident', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const clock = fakeClock(4000);
  const radio = fakeRadio(clock);
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(5),
    settings: { trafficDensity: 'quiet', refusalBias: -1 }, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine);
  handler = ev => { if (ev.kind === 'action') return; perfect(ev); };   // says everything, touches nothing
  const events = await engine.start();
  const atc = events.filter(e => e.type === 'atc').map(e => e.text);
  assert.ok(atc.some(t => /confirm squawk 5634/.test(t)), 'chased once');
  assert.ok(atc.some(t => /reset squawk 5634 and ident/.test(t)), 'then asked for a reset and ident');
  assert.ok(events.some(e => e.type === 'no-action'), 'recorded as not done');
  assert.ok(computeDebrief(events).issues.some(i => /didn’t carry/.test(i.title)), 'and it reaches the debrief');
});

test('setting the squawk keeps the controller happy', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const { events } = await run(scenario, PROFILES[1], 5, { settings: { trafficDensity: 'quiet', refusalBias: -1 } });
  assert.ok(events.some(e => e.type === 'squawk-set' && e.text === 'Squawk 5634'), 'the code went in');
  assert.ok(!events.some(e => e.type === 'no-action'), 'nothing left undone');
  assert.ok(!events.filter(e => e.type === 'atc').some(t => /confirm squawk/.test(t.text)), 'so no chasing');
});

test("the recogniser's other guesses are matched too", async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const clock = fakeClock(4000);
  const radio = fakeRadio(clock);
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(9),
    settings: { trafficDensity: 'quiet', refusalBias: -1 }, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine);
  let sent = false;
  handler = ev => {
    if (!sent && ev.kind === 'awaiting' && /squawk 5634/.test(ev.atcText || '')) {
      sent = true;
      sendWhenClear(engine, 'basic service 1000 remaining outside controlled airspace golf india alpha',
        { alternatives: ['basic service squawk 5634 remaining outside controlled airspace golf india alpha'] });
      return;
    }
    perfect(ev);
  };
  const events = await engine.start();
  const rb = events.find(e => e.type === 'readback' && /squawk 5634/.test(e.atcText || ''));
  assert.ok(rb, 'the squawk readback happened');
  assert.match(rb.text, /squawk 5634/, 'the better guess was used');
  assert.match(rb.heard || '', /1000/, 'and the first one is kept for the debrief');
  assert.equal(events.filter(e => e.type === 'correction').length, 0, 'so no correction was needed');
});
