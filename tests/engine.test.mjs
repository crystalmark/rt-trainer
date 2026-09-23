import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { SCENARIOS } from '../js/scenarios/index.js';
import { PROFILES } from '../js/config.js';
import { fakeClock, fakeRadio, seeded, perfectPilot, sendWhenClear } from './helpers.mjs';
import { listenScenario, LISTEN_UNITS } from '../js/scenarios/listen.js';
import { computeDebrief } from '../js/debrief.js';
import { briefLine, P } from '../js/scenarios/common.js';
import { AREAS } from '../js/areas/index.js';
import { parseRoute } from '../js/route.js';
import { customScenario } from '../js/scenarios/custom.js';

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

// The briefing screen puts one fact on each row, so each entry must be a labelled one-liner. A three-sentence
// entry is the bunched-up prose this replaced.
test('every briefing is a list of labelled items, one fact each', () => {
  const leeds = AREAS.find(a => a.id === 'leeds');
  const ctx = { reg: 'G-CZIA', abbr: 'G-IA', type: 'QuikR microlight', transponder: true, speedKt: 65 };
  const own = customScenario(leeds, parseRoute('Skipton to Wetherby via Salts Mill and Eccup Reservoir at 2800 ft', leeds));
  const all = [...SCENARIOS, own, listenScenario('leeds')];
  for (const s of all) {
    const lines = s.briefing(ctx);
    assert.ok(lines.length >= 4, `${s.id}: only ${lines.length} briefing items`);
    const labels = new Set();
    for (const l of lines) {
      const { label, text, kind } = briefLine(l);
      assert.ok(label, `${s.id}: unlabelled briefing item "${text}"`);
      assert.ok(label.length <= 14, `${s.id}: label too long for the column: "${label}"`);
      assert.ok(text.length <= 190, `${s.id}: "${label}" is a paragraph, not an item`);
      assert.ok(!kind || kind === 'warn', `${s.id}: unknown kind "${kind}"`);
      labels.add(label);
    }
    assert.ok(labels.has('Aircraft') || s.listen, `${s.id}: no aircraft line`);
  }
});

// Holding the details back until "pass your message" is correct RT, not six omissions. The debrief used to
// list every detail as something to add, on the one call where it is right to leave them out.
test('a short initial call is correct: the details count when ATC asks for them, not before', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const short = { initial: e => `Leeds Radar, ${e.ctx.reg}, request Basic Service and zone transit` };
  const { events } = await run(scenario, PROFILES[1], 5, { settings: { refusalBias: -1, trafficDensity: 'quiet' }, override: short });
  const init = events.find(e => e.type === 'call' && e.id === 'initial');
  assert.deepEqual(init.result.softMissing, [], 'nothing is missing from a short first call');
  assert.ok(init.result.score >= 90, `short first call scored only ${init.result.score}`);
  assert.ok(events.some(e => e.type === 'call' && e.id === 'details'), 'ATC asks for the details');
  const issues = computeDebrief(events).issues;
  assert.ok(!issues.some(i => /add to your calls/i.test(i.title)), JSON.stringify(issues.find(i => /add to your calls/i.test(i.title))));
});

test('...but a pilot who gives it all at once is still marked on it', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const all = { initial: e => `Leeds Radar, ${e.ctx.reg}, microlight, Kirkbride to Sherburn, ` +
    '3 miles south of Skipton, altitude 2800 feet, request zone transit' };   // no QNH, no VFR
  const { events } = await run(scenario, PROFILES[1], 5, { settings: { refusalBias: -1, trafficDensity: 'quiet' }, override: all });
  const init = events.find(e => e.type === 'call' && e.id === 'initial');
  assert.ok(!events.some(e => e.id === 'details'), 'ATC does not ask for the details again');
  assert.ok(events.some(e => e.type === 'note' && /Full details on first contact/.test(e.text)));
  const missed = init.result.softMissing.map(i => i.label);
  assert.ok(missed.includes('pressure setting') && missed.includes('flight rules'), missed.join(', '));
});

// Keying up used to be no protection: the script transmitted over the pilot, and then answered a call it could
// never have heard. Nothing goes out while the PTT is down.
test('nobody transmits over the pilot', async () => {
  const clock = fakeClock(20);                      // near real time, because the hold has a 15 s cap
  const radio = fakeRadio(clock);
  const scenario = {
    id: 'ptt-hold', title: 'PTT', unit: 'Leeds Radar', freq: '134.580',
    briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) { await s.atc('{CALL}, report your position'); await s.pause(600); },
  };
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(2), settings: { trafficDensity: 'quiet' } });
  engine.pilotKeyDown();
  const flight = engine.start();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(radio.lines.length, 0, `spoke over the pilot: ${JSON.stringify(radio.lines)}`);
  engine.pilotTransmission('G-CZIA, overhead Ilkley');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(radio.lines.length, 1, 'and transmits as soon as the PTT comes up');
  engine.stop();
  await flight;
});

// The controller speaks to you and waits: that gap is yours. Traffic that had already decided to transmit used
// to queue on the channel and take it the instant the controller stopped.
test('traffic does not take the gap the controller left for you', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const { events } = await run(scenario, PROFILES[1], 7, { settings: { trafficDensity: 'busy', refusalBias: -1 } });
  const toPilot = events.filter(e => e.type === 'atc' && e.toPilot);
  const others = events.filter(e => e.traffic);
  assert.ok(toPilot.length > 3 && others.length > 3, 'the flight had both');
  for (const a of toPilot) {                                   // event times are in seconds
    const reply = events.find(e => e.type === 'pilot' && e.t >= a.t);
    const end = Math.min(reply ? reply.t : Infinity, a.t + 12);
    const jumped = others.find(o => o.t >= a.t && o.t < end);
    assert.ok(!jumped, `“${jumped && jumped.text}” came ${jumped && jumped.t - a.t} s after “${a.text}”`);
  }
});

// Skipping ahead must never carry you past something. It is only offered on a leg, and only while the frequency
// is clear and nothing is expected of you.
test('skip ahead runs the leg out fast, and is refused when it would skip a call', async () => {
  const clock = fakeClock(100);
  const radio = fakeRadio(clock);
  let engine;
  const scenario = {
    id: 'skip-test', title: 'Skip', unit: 'Leeds Radar', freq: '134.580',
    briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) {
      await s.leg('A long quiet leg', 12);                   // 11 minutes of flight: ~6 s here, or 0.3 s skipped
      await s.atc('{CALL}, report your position', { reply: { id: 'pos', timeout: 120,
        items: [P('position', ['overhead'])], model: '{CALL}, overhead Ilkley' } });
      await s.pause(600);
    },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(2), settings: { trafficDensity: 'quiet' } });
  const flight = engine.start();

  await new Promise(r => setTimeout(r, 80));
  assert.equal(engine.canSkip(), true, 'a leg is skippable');
  assert.equal(engine.skip(), true);
  assert.equal(engine.boost, 20);

  // the leg runs out far sooner than its 6 s, the controller calls, and the skip switches itself off
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(engine.boost, 1, 'the skip ends with the leg');
  assert.ok(radio.lines.some(l => /report your position/.test(l[1])), 'the call still happened');
  assert.equal(engine.canSkip(), false, 'nothing to skip while the controller is waiting for you');
  assert.equal(engine.skip(), false);

  engine.stop();
  await flight;
});

test('a second press of skip puts it back to real time', async () => {
  const clock = fakeClock(100);
  const radio = fakeRadio(clock);
  const scenario = {
    id: 'skip-off', title: 'Skip', unit: 'Leeds Radar', freq: '134.580',
    briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) { await s.leg('A long quiet leg', 60); },
  };
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(2), settings: { trafficDensity: 'quiet' } });
  const flight = engine.start();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(engine.skip(), true);
  assert.equal(engine.boost, 20);
  assert.equal(engine.skip(), false, 'pressing it again turns it off');
  assert.equal(engine.boost, 1);
  engine.stop();
  await flight;
});

// At an Air/Ground field nobody can tell you how to join, so the operator asks and your answer is what you fly.
test('Carlisle Radio asks how you would like to join, and flies the join you choose', async () => {
  const scenario = SCENARIOS.find(x => x.id === 'carlisle-arrival');
  for (const [answer, ids, summary] of [
    ['joining overhead', ['overhead', 'downwind', 'final'], /overhead join/],
    ['joining downwind', ['downwind', 'final'], /joined downwind/],
    ['joining on a long left base', ['base', 'final'], /joined base/],
    ['straight in', ['final'], /straight in/],
  ]) {
    let staffed = true;
    const pilot = engine => {
      const perfect = perfectPilot(engine);
      return ev => {
        if (ev.kind === 'awaiting' && ev.waitKind === 'readback' && /how would you like to join/.test(ev.atcText || '')) {
          sendWhenClear(engine, `runway 24, QFE 1009, ${answer}, G-IA`); return;
        }
        perfect(ev);
      };
    };
    let events;
    for (let seed = 1; seed < 30; seed++) {                 // a quarter of the time nobody is there: find a staffed one
      ({ events } = await run(scenario, PROFILES[1], seed, { pilot, settings: { trafficDensity: 'quiet' } }));
      if (events.some(e => e.type === 'atc' && /how would you like to join/.test(e.text))) break;
    }
    const calls = events.filter(e => e.type === 'call').map(e => e.id);
    for (const id of ids) assert.ok(calls.includes(id), `${answer}: no ${id} call in ${calls.join(', ')}`);
    if (!ids.includes('overhead')) assert.ok(!calls.includes('overhead'), `${answer}: flew the overhead anyway`);
    assert.match(events.at(-1).summary, summary);
  }
});
