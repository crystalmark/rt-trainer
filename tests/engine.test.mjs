import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { SCENARIOS } from '../js/scenarios/index.js';
import { PROFILES } from '../js/config.js';
import { fakeClock, fakeRadio, seeded, perfectPilot, sendWhenClear } from './helpers.mjs';
import { listenScenario, LISTEN_UNITS } from '../js/scenarios/listen.js';
import { computeDebrief } from '../js/debrief.js';
import { briefLine, P, SQUAWK, useSquawk } from '../js/scenarios/common.js';
import { AREAS } from '../js/areas/index.js';
import { parseRoute, planRoute } from '../js/route.js';
import { customScenario } from '../js/scenarios/custom.js';
import { inside } from '../js/geo.js';

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
  const calls = [], seen = [];
  const claude = { atc: async ({ pilot, history }) => { calls.push(pilot); seen.push(history.map(h => `${h.role}: ${h.text}`));
    return calls.length === 1
      ? { transmissions: ['{CALL}, roger, leave controlled airspace eastbound, report established en route to East Fortune'], assessment: 'Clear request.' }
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
  // Claude is given the conversation so far, its own part as it went out on the radio.
  assert.deepEqual(seen[1], ['pilot: G-IA, request return to East Fortune due weather',
    'atc: G-IA, roger, leave controlled airspace eastbound, report established en route to East Fortune',
    'pilot: Leave controlled airspace eastbound, wilco, G-IA']);
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

// A scripted transit is only practice if it goes where its clearance says. Edinburgh's was cleared into the control zone
// via Musselburgh and then flown direct to Kirkcaldy Harbour: both outside the CTR (a 10 nm circle, AD 2.17), and the
// whole line under CTA 2's 2500 ft base, so at 2000 ft it never touched controlled airspace at all.
test('every scripted zone transit goes into the zone it is cleared into', async () => {
  // Flown as legs there is no route to check, so each such scenario lists here the points it flies that are in the zone.
  const legs = { 'leeds-transit': { area: 'leeds', inZone: ['Salts Mill', 'Eccup Reservoir'] } };
  for (const scenario of SCENARIOS) {
    const { events } = await run(scenario, PROFILES[1], 1, { settings: { refusalBias: -1, trafficDensity: 'quiet' } });
    for (const e of events.filter(e => e.type === 'atc' && /control zone via/i.test(e.text))) {
      const via = e.text.match(/control zone via ([^,.]+)/i)[1];
      if (scenario.plan) {                                         // flown on the map: the plan says where it goes
        const T = scenario.plan.transit, point = scenario.plan.points.find(w => w.place.name === via);
        assert.ok(T?.intoZone, `${scenario.id}: cleared into the zone, but the route never enters it`);
        assert.ok(point && point.s <= T.sIn && T.sIn - point.s < 2, `${scenario.id}: cleared via ${via}, but the zone starts ${(T.sIn - point?.s).toFixed(1)} nm after it`);
        continue;
      }
      const known = legs[scenario.id];
      assert.ok(known, `${scenario.id}: cleared into the zone via ${via}, with no route to check that it goes in: fly it on the map, or list its points here`);
      const area = AREAS.find(a => a.id === known.area), ctr = area.airspace.find(v => v.kind === 'CTR');
      for (const name of known.inZone) assert.ok(inside(area.places.find(p => p.name === name), ctr.poly), `${scenario.id}: ${name} is outside the zone`);
    }
  }
});

// The briefing screen puts one fact on each row, so each entry must be a labelled one-liner. A three-sentence
// entry is the bunched-up prose this replaced.
test('every briefing is a list of labelled items, one fact each', () => {
  const ctx = { reg: 'G-CZIA', abbr: 'G-IA', type: 'QuikR microlight', transponder: true, speedKt: 65 };
  // Your own route in every area: only Leeds used to be checked, and Edinburgh's and Manchester's broke the rule.
  const own = Object.entries({
    leeds: 'Skipton to Wetherby via Salts Mill and Eccup Reservoir at 2800 ft',
    edinburgh: 'Dunbar to Falkirk via Musselburgh and Forth Road Bridge at 2000 ft',
    manchester: 'Buxton to Northwich via Macclesfield and Alderley Edge at 1400 ft',
  }).map(([id, text]) => { const area = AREAS.find(a => a.id === id); return customScenario(area, parseRoute(text, area)); });
  const all = [...SCENARIOS, ...own, listenScenario('leeds')];
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

// Taking the channel waited for the PTT, but the controller's pause before answering came after that, and so did the
// gaps in an exchange: a pilot who keyed in either was talked over.
test('the controller waits for a pilot who keys while it is about to answer', async () => {
  const clock = fakeClock(20);
  const radio = fakeRadio(clock);
  const scenario = {
    id: 'ptt-late', title: 'PTT', unit: 'Leeds Radar', freq: '134.580',
    briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) { await s.atc('{CALL}, report your position'); await s.pause(600); },
  };
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(2), settings: { trafficDensity: 'quiet', atcDelay: [1.5, 1.6] } });
  const flight = engine.start();
  await new Promise(r => setTimeout(r, 30));      // the controller has the channel, and is 1.5 s from answering
  engine.pilotKeyDown();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(radio.lines.length, 0, `spoke over the pilot: ${JSON.stringify(radio.lines)}`);
  engine.pilotTransmission('G-CZIA, overhead Ilkley');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(radio.lines.length, 1, 'and answers once the PTT comes up');
  engine.stop();
  await flight;
});

test('an exchange waits for a pilot who keys between its lines', async () => {
  const clock = fakeClock(100);
  const radio = fakeRadio(clock);
  let engine, keyedAt = null, n = 0;
  const over = [];
  const say = radio.say.bind(radio);
  radio.say = async (speaker, display, ...rest) => {
    if (engine.keyed) over.push(display);
    const res = await say(speaker, display, ...rest);
    if (/turn left heading 140/.test(display)) { engine.pilotKeyDown(); keyedAt = Date.now(); }   // into the gap
    return res;
  };
  const scenario = {
    id: 'ptt-gap', title: 'PTT', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    traffic: () => (n++ ? null : [['atc', 'Channex 47, turn left heading 140'], ['Channex 47', 'Left heading 140, Channex 47']]),
    async run(s) { await s.pause(600); },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'busy' } });
  const flight = engine.start();
  while (keyedAt === null) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 60));      // 6 s: the reply would have come in 0.5–1.4
  assert.deepEqual(over, [], 'nobody spoke over the pilot');
  engine.pilotTransmission('Leeds Radar, golf charlie zulu india alpha, request basic service');
  await new Promise(r => setTimeout(r, 100));
  assert.ok(radio.lines.some(l => /Left heading 140/.test(l[1])), 'and the exchange carries on afterwards');
  engine.stop();
  const events = await flight;
  assert.ok(events.some(e => e.type === 'stepped-in'), 'calling in the middle of it is still noticed');
});

// Keying between the lines of someone else's exchange marks the transmission as stepping in. One that came to nothing
// (Android often hears nothing) left the mark behind, and the pilot's next call, a correct readback minutes later,
// was answered "standby" and thrown away.
test('an empty transmission in the middle of an exchange does not cost the next call', async () => {
  const clock = fakeClock(400);
  const radio = fakeRadio(clock);
  let engine, n = 0, keyed = false;
  const scenario = {
    id: 'stepped', title: 'Stepped in', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    traffic: () => (n++ ? null : [['Channex 47', 'Leeds Radar, Channex 47, descending flight level 70'],
      ['atc', 'Channex 47, Leeds Radar, descend altitude 4000 feet'], ['Channex 47', 'Descend 4000 feet, Channex 47']]),
    async run(s) {
      await s.leg('Waiting', 3);
      await s.atc('{CS}, squawk 5634', { readback: [SQUAWK('5634')], model: 'Squawk 5634, {CS}' });
      s.end('Done');
    },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'busy' },
    onEvent: ev => {
      if (!keyed && ev.kind === 'radio' && ev.speaker === 'Channex 47') {   // in the exchange, and nothing heard
        keyed = true; engine.pilotKeyDown(); engine.pilotTransmission('', { error: 'listening, but heard no speech' });
      }
      if (ev.kind === 'awaiting' && ev.waitKind === 'readback') sendWhenClear(engine, 'squawk 5634, golf charlie zulu india alpha');
    } });
  const events = await engine.start();
  assert.ok(events.some(e => e.type === 'empty-tx'), 'the empty transmission happened');
  assert.ok(!events.some(e => e.type === 'stepped-in'), JSON.stringify(events.filter(e => e.type === 'stepped-in')));
  assert.ok(!events.some(e => e.type === 'missed'), 'the readback was taken first time');
  assert.equal(events.filter(e => e.type === 'readback').length, 1);
  assert.equal(events.at(-1).summary, 'Done');
});

// Calling in the middle of someone else's exchange draws "standby", and "pass your message" once it is over: but only
// then, and only while it is still wanted.
function steppedInto({ hold = 0, afterStandby = null } = {}) {
  const clock = fakeClock(100), radio = fakeRadio(clock);
  let engine, n = 0;
  const say = radio.say.bind(radio);
  radio.say = async (speaker, display, ...rest) => {
    const res = await say(speaker, display, ...rest);
    if (/turn left heading 140/.test(display)) {                    // into the gap before the reply
      engine.pilotKeyDown();
      clock.sleep(hold).then(() => engine.pilotTransmission('Leeds Radar, golf charlie zulu india alpha, request basic service'));
    }
    if (/standby/.test(display) && afterStandby) afterStandby(engine);
    return res;
  };
  const scenario = {
    id: 'standby', title: 'Standby', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    traffic: () => (n++ ? null : [['atc', 'Channex 47, turn left heading 140'], ['Channex 47', 'Left heading 140, Channex 47']]),
    async run(s) { await s.pause(120); s.end('Done'); },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'busy' } });
  return engine.start();
}
const heardAt = (events, re) => events.find(e => (e.type === 'atc' || e.type === 'traffic') && re.test(e.text))?.t;
const onFrequency = events => JSON.stringify(events.filter(e => ['atc', 'traffic', 'pilot'].includes(e.type)).map(e => `${e.t} ${e.text}`));

test('after "standby", "pass your message" comes once the exchange is over', async () => {
  const events = await steppedInto();
  assert.ok(events.some(e => e.type === 'stepped-in'));
  const reply = heardAt(events, /Left heading 140/), back = heardAt(events, /pass your message/);
  assert.ok(back != null && back >= reply && back - reply < 10, onFrequency(events));
});

// It used to be settled when queued: a pilot who called again after "standby" was then asked for the message anyway.
test('"pass your message" is not asked of a pilot who has called again since "standby"', async () => {
  const events = await steppedInto({ afterStandby: engine => sendWhenClear(engine, 'Leeds Radar, golf charlie zulu india alpha, request basic service') });
  assert.equal(events.filter(e => e.type === 'pilot').length, 2, 'they called again');
  assert.equal(heardAt(events, /pass your message/), undefined, onFrequency(events));
});

// The controller holds the rest of the exchange for a pilot who is transmitting, but only for 15 s. A call still going
// after that, and after the reply, ended with the exchange over: "pass your message" then waited for the next one.
test('a call that outlasts the exchange it stepped into is still asked for straight away', async () => {
  const events = await steppedInto({ hold: 20000 });
  const stepped = events.find(e => e.type === 'stepped-in')?.t, back = heardAt(events, /pass your message/);
  assert.ok(stepped != null && back != null && back - stepped < 10, `${stepped} → ${back}: ${onFrequency(events)}`);
});

// Off script, a failure (here a reply that isn't what was asked for) escaped past finish(): no end, no debrief, and
// End did nothing.
test('off script, a flight that fails still ends with a debrief', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'edinburgh-transit');
  const clock = fakeClock(4000); const radio = fakeRadio(clock);
  const claude = { atc: async () => ({ transmissions: [{ text: 'G-IA, roger' }] }) };
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(2), claude, settings: { trafficDensity: 'quiet' }, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine);
  let diverted = false;
  handler = ev => {
    if (!diverted && ev.kind === 'awaiting' && ev.id === 'musselburgh') { diverted = true; sendWhenClear(engine, 'G-IA, request return to East Fortune due weather'); return; }
    if (!diverted) perfect(ev);
  };
  const events = await engine.start();
  assert.ok(events.some(e => e.type === 'offscript'));
  assert.ok(events.some(e => e.type === 'error'), 'the failure is recorded');
  assert.equal(events.at(-1).type, 'end');
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

// A controller's call to a similar callsign is a trap: answering it is the mistake. Judged by timing alone, it also
// caught the pilot's own calls made in the gap after that exchange, which is where the briefing says to make them.
function trapScenario(run) {
  let n = 0;
  return {
    id: 'trap', title: 'Trap', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    traffic: (s, { similar }) => (n++ ? null : [['atc', `${similar}, report Harrogate`, { similar }], [similar, `Wilco, ${similar}`]]),
    run,
  };
}

test('a call made just after a call to a similar callsign is taken as the call it is', async () => {
  const clock = fakeClock(400), radio = fakeRadio(clock);
  let engine, called = false;
  const scenario = trapScenario(async s => {
    await s.leg('Inbound', 10);
    await s.expect({ id: 'initial', initial: true, timeout: 240, items: [P('request', ['request'])] });
    s.end('Done');
  });
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'busy' },
    onEvent: ev => {
      if (!called && ev.kind === 'radio' && /^Wilco/.test(ev.text)) {      // the other aircraft's reply: call straight after it
        called = true;
        sendWhenClear(engine, 'Leeds Radar, golf charlie zulu india alpha, request basic service');
      }
    } });
  const events = await engine.start();
  assert.ok(called, 'the exchange happened');
  assert.ok(!events.some(e => e.type === 'wrong-callsign'), JSON.stringify(events.find(e => e.type === 'wrong-callsign')));
  assert.ok(events.some(e => e.type === 'call' && e.id === 'initial'), 'it was the initial call');
  assert.equal(events.at(-1).summary, 'Done');
});

test('answering a call meant for a similar callsign is caught, even before the other aircraft replies', async () => {
  const clock = fakeClock(400), radio = fakeRadio(clock);
  let engine;
  const say = radio.say.bind(radio);
  radio.say = async (...a) => {
    const res = await say(...a);
    if (/report Harrogate/.test(a[1])) setImmediate(() => { engine.pilotKeyDown(); engine.pilotTransmission('Wilco, golf india alpha'); });
    return res;
  };
  engine = new Engine({ scenario: trapScenario(async s => { await s.leg('Inbound', 10); s.end('Done'); }), profile: PROFILES[1],
    radio, clock, rng: seeded(1), settings: { trafficDensity: 'busy' } });
  const events = await engine.start();
  assert.ok(events.some(e => e.type === 'wrong-callsign'), 'taken for what it was');
  assert.ok(!events.some(e => e.type === 'stepped-in'), 'not merely a call in the middle of an exchange');
  assert.ok(radio.lines.some(l => /negative, that was for G-IT/.test(l[1])));
});

// "I say again" is the pilot repeating their message: it was taken for a request to repeat, the message was thrown
// away, and each repeat carried the last one's "I say again" with it.
test('repeats do not pile up, and a pilot saying "I say again" is heard', async () => {
  const clock = fakeClock(400), radio = fakeRadio(clock);
  let engine, n = 0;
  const replies = ['say again, golf india alpha', 'say again, golf india alpha', 'golf india alpha, I say again, altitude 2000 feet'];
  const scenario = {
    id: 'repeat', title: 'Repeat', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) {
      s.ctx.abbreviated = true;
      await s.atc('{CALL}, report your altitude', { reply: { id: 'altitude', items: [P('altitude', ['feet'])] } });
      s.end('Done');
    },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'quiet' },
    onEvent: ev => { if (ev.kind === 'radio' && ev.speaker === 'atc' && n < replies.length) sendWhenClear(engine, replies[n++]); } });
  const events = await engine.start();
  const repeats = radio.lines.map(l => l[1]).filter(t => /I say again/.test(t));
  assert.deepEqual(repeats, ['G-IA, I say again, report your altitude', 'G-IA, I say again, report your altitude']);
  assert.ok(events.some(e => e.type === 'call' && e.id === 'altitude' && /I say again/.test(e.text)), 'the repeated message was the answer');
});

// "Confirm squawk 5634" asks a question. The answer went nowhere, was logged as unexpected and drew "say again".
test('the answer to "confirm squawk" is taken, not met with "say again"', async () => {
  const clock = fakeClock(400), radio = fakeRadio(clock);
  let engine;
  const scenario = {
    id: 'confirm', title: 'Confirm', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) {
      await s.expect({ id: 'initial', initial: true, items: [] });
      s.ctx.abbreviated = true;
      await useSquawk(s, '5634');
      await s.pause(30);
      s.end('Done');
    },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'quiet' },
    onEvent: ev => {
      if (ev.kind === 'awaiting' && ev.id === 'initial') sendWhenClear(engine, 'Leeds Radar, golf charlie zulu india alpha');
      // Slow to set it, and chased: sets it and says so.
      if (ev.kind === 'radio' && /confirm squawk 5634/.test(ev.text)) { engine.setSquawk('5634'); sendWhenClear(engine, 'squawking 5634, golf india alpha'); }
    } });
  const events = await engine.start();
  assert.ok(events.some(e => e.type === 'late-action'), 'chased');
  assert.ok(!events.some(e => e.type === 'unexpected'), JSON.stringify(events.filter(e => e.type === 'unexpected')));
  assert.ok(!radio.lines.some(l => /say again/.test(l[1])), 'no "say again"');
  assert.ok(events.some(e => e.type === 'action' && e.id === 'squawk-5634'), 'and the squawk counts as set');
});

// Carlisle's "frequency change approved" and traffic information get an answer, and the leg after them takes an early
// call: the answer was taken for that call, the leg cut short, and the real call then met with "say again".
test('at Carlisle, an acknowledgement is not taken for the next call', async () => {
  const ACK = /frequency change approved|Basic Service terminated|one ahead|traffic is a Cessna|no reported traffic/;
  for (const id of ['carlisle-south', 'carlisle-arrival', 'carlisle-departure']) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const clock = fakeClock(4000), radio = fakeRadio(clock);
      let handler = () => {};
      const engine = new Engine({ scenario: SCENARIOS.find(s => s.id === id), profile: PROFILES[1], radio, clock, rng: seeded(seed),
        settings: { trafficDensity: 'quiet' }, onEvent: e => handler(e) });
      const perfect = perfectPilot(engine);
      handler = ev => {
        // Like a pilot: answered when heard, not when the script is ready for the answer.
        if (ev.kind === 'radio' && ev.meta?.toPilot && ACK.test(ev.text)) {
          sendWhenClear(engine, /one ahead|traffic is/.test(ev.text) ? 'Looking, golf india alpha' : 'Roger, golf india alpha');
          return;
        }
        if (ev.kind === 'awaiting' && /-ack$|^terminated$/.test(ev.id || '')) return;    // already answered
        perfect(ev);
      };
      const events = await engine.start();
      const taken = events.filter(e => e.type === 'call' && /^(Looking|Roger), golf india alpha$/.test(e.text));
      assert.ok(taken.every(e => /-ack$|^terminated$/.test(e.id)), `${id} seed ${seed}: taken as ${taken.map(e => e.id)}`);
      assert.ok(!events.some(e => e.type === 'unexpected'), `${id} seed ${seed}: ${JSON.stringify(events.filter(e => e.type === 'unexpected'))}`);
    }
  }
});

// Off script, the wait for the pilot was taken for a readback wait whenever the script had last been waiting for one:
// the traffic stopped for good, and with no timeout on that wait a silent pilot was never let go.
test('off script, the frequency stays busy and a silent pilot is let go after fifteen minutes', { timeout: 30000 }, async () => {
  const clock = fakeClock(4000), radio = fakeRadio(clock);
  let engine;
  const scenario = {
    id: 'free', title: 'Free', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    traffic: () => [['Channex 47', 'Leeds Radar, Channex 47, descending flight level 70'], ['atc', 'Channex 47, roger']],
    async run(s) {
      s.ctx.abbreviated = true;
      await s.atc('{CALL}, squawk 5634', { readback: [SQUAWK('5634')], model: 'Squawk 5634, {CALL}' });
      await s.pause(3600);
    },
  };
  const claude = { atc: async () => ({ transmissions: ['G-IA, roger, report ready'] }) };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), claude, settings: { trafficDensity: 'busy' },
    onEvent: ev => { if (ev.kind === 'awaiting' && ev.waitKind === 'readback') sendWhenClear(engine, 'golf india alpha, request diversion to Harrogate due weather'); } });
  const events = await engine.start();
  const off = events.findIndex(e => e.type === 'offscript');
  assert.ok(off > 0, 'off script from the readback');
  assert.ok(events.slice(off).some(e => e.type === 'traffic'), 'and the traffic carried on');
  assert.equal(events.at(-1).type, 'end', 'and fifteen minutes of silence ended it');
});

// The map's Direct to, a moment after the pilot's reply: the reply's wait, still asleep, woke to find the change and
// took it, on a promise already settled. The change was lost and the script carried on along the old route.
test('a change of route made just after a reply is not lost', async () => {
  const leeds = AREAS.find(a => a.id === 'leeds');
  const r = parseRoute('Skipton to Harrogate at 2000 ft', leeds);
  const plan = planRoute(leeds, r.points, r.altitude);
  let resumed = null;
  const scenario = {
    id: 'reroute', title: 'Reroute', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    routeChange: () => ({ plan, points: [], approval: false }),
    async run(s) {
      s.fly(plan);
      await s.expect({ id: 'report', items: [], timeout: 60 });
      await s.pause(10);                                  // on to whatever comes next when the change is made
      s.end('The change of route was lost');
    },
    async resume(s, change) { resumed = change; s.end('Rerouted'); },
  };
  const clock = fakeClock(20), radio = fakeRadio(clock);
  let engine;
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'quiet' },
    onEvent: ev => {
      if (ev.kind === 'awaiting' && ev.id === 'report') setImmediate(() => {
        engine.pilotKeyDown(); engine.pilotTransmission('golf charlie zulu india alpha, overhead Skipton');
        setTimeout(() => engine.changeRoute({ action: 'direct', place: r.points.at(-1) }), 2);
      });
    } });
  const events = await engine.start();
  assert.ok(resumed, events.at(-1).summary);
  assert.equal(events.at(-1).summary, 'Rerouted');
});

// Carlisle Radio and East Fortune Radio are not always staffed, and with nobody on, nothing answers. The operator used
// to be heard answering other aircraft until the flight found out, and blind calls drew "say again" from nobody.
test('with nobody on the radio at Carlisle or East Fortune, nothing answers', async () => {
  for (const id of ['carlisle-arrival', 'carlisle-south', 'forth-bridges']) {
    let unstaffed = 0;
    for (let seed = 1; seed <= 40 && unstaffed < 3; seed++) {
      const clock = fakeClock(4000), radio = fakeRadio(clock);
      let handler = () => {};
      const engine = new Engine({ scenario: SCENARIOS.find(s => s.id === id), profile: PROFILES[1], radio, clock, rng: seeded(seed),
        settings: { trafficDensity: 'busy' }, onEvent: e => handler(e) });
      const perfect = perfectPilot(engine);
      const heard = [];
      let blind = false;
      handler = ev => {
        if (engine.ctx.blind) blind = true;
        if (engine.ctx.blind && ev.kind === 'radio' && ev.speaker === 'atc') heard.push(ev.text);
        // Blind calls, with the callsign lost, as the recogniser often loses it.
        if (engine.ctx.blind && ev.kind === 'awaiting') { sendWhenClear(engine, (ev.spec || []).map(i => i.any[0]).join(', ') || 'radio check'); return; }
        perfect(ev);
      };
      const events = await engine.start();
      if (!blind) continue;
      unstaffed++;
      assert.deepEqual(heard, [], `${id} seed ${seed}`);
      assert.match(events.at(-1).summary || '', /blind/, `${id} seed ${seed}: ${events.at(-1).summary}`);
    }
    assert.ok(unstaffed > 0, `${id}: no unstaffed run in 40 seeds`);
  }
});

// Change frequency and the rest of an exchange on the old one isn't heard. It went on playing: Edinburgh's clearances,
// heard on East Fortune's frequency.
test('an exchange on a frequency you have just left is not heard to the end', async () => {
  const clock = fakeClock(400), radio = fakeRadio(clock);
  let engine, n = 0;
  const scenario = {
    id: 'left', title: 'Left', unit: 'Edinburgh Approach', freq: '121.205', briefing: () => [['Aircraft', 'G-CZIA']],
    traffic: () => (n++ ? null : [['Rescue 199', 'Edinburgh Approach, Rescue 199, request zone entry'],
      ['atc', 'Rescue 199, cleared to enter the Edinburgh control zone']]),
    async run(s) { await s.pause(120); s.end('Done'); },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'busy' },
    onEvent: ev => { if (ev.kind === 'radio' && ev.speaker === 'Rescue 199') engine.ctx.unit = 'East Fortune Radio'; } });   // the pilot changes frequency
  await engine.start();
  assert.ok(radio.lines.some(l => /request zone entry/.test(l[1])), 'the exchange began');
  assert.ok(!radio.lines.some(l => /cleared to enter/.test(l[1])), 'and the rest of it was not heard on the new frequency');
});

// Off script, End did nothing while a request to Claude had stalled, and a key that would never work met every call
// from then on with "say again", unexplained.
function offScript(claude) {
  const scenario = SCENARIOS.find(s => s.id === 'edinburgh-transit');
  const clock = fakeClock(4000), radio = fakeRadio(clock);
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(2), claude, settings: { trafficDensity: 'quiet' }, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine), toasts = [];
  let diverted = false;
  handler = ev => {
    if (ev.kind === 'toast') toasts.push(ev.text);
    if (!diverted && ev.kind === 'awaiting' && ev.id === 'musselburgh') { diverted = true; sendWhenClear(engine, 'G-IA, request return to East Fortune due weather'); return; }
    if (!diverted) perfect(ev);
  };
  return { engine, radio, toasts, flight: engine.start() };
}

test('End ends a flight even while Claude is being asked', async () => {
  let asking = false;
  const claude = { atc: () => new Promise((_, reject) => { asking = true; claude.cancel = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }) };
  const { engine, flight } = offScript(claude);
  while (!asking) await new Promise(r => setTimeout(r, 5));
  engine.stop();
  const events = await Promise.race([flight, new Promise(r => setTimeout(() => r(null), 2000))]);
  assert.ok(events, 'the flight ended');
  assert.equal(events.at(-1).type, 'end');
});

test('a Claude key that will never work ends the flight with the reason, not "say again" for ever', async () => {
  const reason = 'the API key was refused: check it on the setup screen';
  const claude = { atc: async () => { throw Object.assign(new Error('Claude API 401'), { status: 401, permanent: true, reason }); } };
  const { radio, toasts, flight } = offScript(claude);
  const events = await flight;
  assert.equal(events.at(-1).summary, `Ended off script: ${reason}`);
  assert.ok(toasts.some(t => t.includes(reason)), JSON.stringify(toasts));
  assert.ok(!radio.lines.some(l => /say again/.test(l[1])), 'no "say again"');
  assert.ok(events.some(e => e.type === 'claude-error' && e.text === reason), 'and the debrief shows it');
});

// A pause used up the time allowed to set the squawk: the controller chased the pilot the moment they resumed.
test('pausing while a squawk is wanted does not use up the time to set it', async () => {
  const clock = fakeClock(20), radio = fakeRadio(clock);
  let engine, wanted = false;
  const scenario = {
    id: 'pause', title: 'Pause', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) { await s.expect({ id: 'initial', initial: true, items: [] }); s.ctx.abbreviated = true; await useSquawk(s, '5634'); s.end('Done'); },
  };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'quiet' },
    onEvent: ev => {
      if (ev.kind === 'awaiting' && ev.id === 'initial') sendWhenClear(engine, 'Leeds Radar, golf charlie zulu india alpha');
      if (ev.kind === 'action' && ev.pending) wanted = true;
    } });
  const flight = engine.start();
  while (!wanted) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 100));        // 2 s in: the pilot pauses to find the transponder
  engine.setPaused(true);
  await new Promise(r => setTimeout(r, 2000));       // 40 s paused: twice the 20 s allowed to set it
  engine.setPaused(false);
  await new Promise(r => setTimeout(r, 100));
  engine.setSquawk('5634');                          // 4 s of flying after the call to set it
  const events = await flight;
  assert.ok(!events.some(e => e.type === 'late-action'), JSON.stringify(events.filter(e => e.type === 'late-action')));
  assert.ok(events.some(e => e.type === 'action' && e.id === 'squawk-5634'));
});

// Edinburgh's and Manchester's traffic had a QNH of their own: the pilot was given one and heard another, on the same
// frequency from the same controller.
test('the traffic on a frequency uses the same QNH as the pilot is given', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'forth-bridges');
  for (const seed of [1, 2, 3, 4]) {
    const { events, engine } = await run(scenario, PROFILES[1], seed, { settings: { trafficDensity: 'busy' } });
    const heard = events.filter(e => e.type === 'traffic' || (e.type === 'atc' && e.traffic)).flatMap(e => [...e.text.matchAll(/QNH (\d{4})/g)].map(m => m[1]));
    assert.ok(heard.every(q => q === String(engine.ctx.qnh)), `seed ${seed}: given ${engine.ctx.qnh}, heard ${heard.join(', ')}`);
  }
});

// Leaving the Leeds zone, "Basic Service, squawk 7000, changing frequency" was corrected with "negative, frequency
// change approved": the only readback of it anywhere that took "changing" as wrong.
test('reading back a frequency change as "changing frequency" is fine', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'leeds-transit');
  const { events } = await run(scenario, PROFILES[1], 5, { settings: { trafficDensity: 'quiet', refusalBias: -1 },
    pilot: engine => { const perfect = perfectPilot(engine); return ev => {
      if (ev.kind === 'awaiting' && /frequency change approved/.test(ev.atcText || '')) { sendWhenClear(engine, 'Basic Service, squawk 7000, changing frequency, golf india alpha'); return; }
      perfect(ev);
    }; } });
  assert.ok(events.some(e => e.type === 'readback' && /changing frequency/.test(e.text)), 'the readback was made');
  assert.ok(!events.some(e => e.type === 'correction'), JSON.stringify(events.filter(e => e.type === 'correction')));
});

// "Rescued by the mishearing table" is a transmission that passed only because of a fold. Any transmission a fold had
// touched used to count, "ft" for "feet" included, which overstated what patching the table buys.
test('a transmission is rescued only when the fold made the difference', async () => {
  const { rowsFrom, stats } = await import('../js/heard.js');
  const clock = fakeClock(400), radio = fakeRadio(clock);
  let engine;
  const scenario = {
    id: 'rescued', title: 'Rescued', unit: 'Leeds Radar', freq: '134.580', briefing: () => [['Aircraft', 'G-CZIA']],
    async run(s) {
      s.ctx.abbreviated = true;
      await s.atc('{CALL}, confirm you are not transponder equipped', { reply: { id: 'xpdr', items: [P('affirm', ['affirm'])] } });
      await s.atc('{CALL}, squawk 5634', { readback: [SQUAWK('5634')] });
      s.end('Done');
    },
  };
  const answers = { xpdr: 'affirmative, golf india alpha', readback: 'escort 5634, golf india alpha' };
  engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(1), settings: { trafficDensity: 'quiet' },
    onEvent: ev => { if (ev.kind === 'awaiting') sendWhenClear(engine, answers[ev.id || ev.waitKind]); } });
  const events = await engine.start();
  const rows = rowsFrom(events);
  assert.deepEqual(rows.map(r => [r.kind, r.folded, r.rescued]), [['call', true, true], ['readback', true, false]],
    '"affirmative" needed its fold; "escort" was folded but the code alone would have done');
  assert.equal(stats(rows).rescued, 1);
});
