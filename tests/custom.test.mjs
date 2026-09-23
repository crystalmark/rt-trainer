import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { PROFILES } from '../js/config.js';
import { AREAS } from '../js/areas/index.js';
import { parseRoute, planRoute } from '../js/route.js';
import { inside } from '../js/geo.js';
import { customScenario } from '../js/scenarios/custom.js';
import { fakeClock, fakeRadio, seeded, perfectPilot, sendWhenClear } from './helpers.mjs';

const leeds = AREAS.find(a => a.id === 'leeds');

function scenarioIn(area, text, seed = 1) {
  const r = parseRoute(text, area);
  assert.deepEqual(r.unknown, [], text);
  return customScenario(area, { points: r.points, altitude: r.altitude }, { rng: seeded(seed * 97) });
}
function scenarioFor(text, seed = 1) { return scenarioIn(leeds, text, seed); }

function fly(scenario, profile, seed, { settings = {}, pilot = perfectPilot, watch = () => {} } = {}) {
  const clock = fakeClock(4000);
  const radio = fakeRadio(clock);
  let handler = () => {};
  const engine = new Engine({ scenario, profile, radio, clock, rng: seeded(seed),
    settings: { trafficDensity: 'busy', ...settings }, onEvent: e => { watch(e, engine); handler(e); } });
  handler = pilot(engine);
  return engine.start();
}

function assertClean(events, label) {
  assert.ok(!events.some(e => e.type === 'error'), `${label}: ${JSON.stringify(events.find(e => e.type === 'error'))}`);
  const corr = events.filter(e => e.type === 'correction');
  assert.equal(corr.length, 0, `${label}: ${JSON.stringify(corr.slice(0, 3))}`);
  assert.equal(events.at(-1).type, 'end');
  assert.ok(events.at(-1).summary, `${label} ended without a summary: ${events.slice(-6).map(e => e.type).join(',')}`);
}

const ROUTES = [
  'Skipton to Wetherby via Salts Mill and Eccup Reservoir at 2800 ft',
  'Wetherby to Skipton via Eccup Reservoir and Otley at 2500 ft',
  'Halifax to Garforth via Chain Bar at 2400 ft',
  'Pateley Bridge to Hebden Bridge via Ilkley at 2000 ft',
  'Tadcaster to Bolton Abbey via Harewood and Otley at 2200 ft',
  'Wakefield to Selby at 2000 ft',
];

for (const text of ROUTES) {
  test(`your route "${text}": perfect pilot, both aircraft, no corrections`, async () => {
    for (const profile of PROFILES) {
      for (const seed of [1, 2, 3]) assertClean(await fly(scenarioFor(text, seed), profile, seed), `${profile.reg} seed ${seed}`);
    }
  });
}

test('random routes across the zone fly cleanly', async () => {
  const rng = seeded(2026);
  const candidates = leeds.places.filter(p => p.kind !== 'vrp');
  let flown = 0;
  for (let tries = 0; flown < 8 && tries < 400; tries++) {
    const a = candidates[Math.floor(rng() * candidates.length)], b = candidates[Math.floor(rng() * candidates.length)];
    const via = leeds.places.filter(p => p.kind === 'vrp')[Math.floor(rng() * 6)];
    const altitude = 1800 + 100 * Math.floor(rng() * 11);
    const points = rng() < 0.5 ? [a, b] : [a, via, b];
    if (new Set(points).size !== points.length) continue;
    if (planRoute(leeds, points, altitude).errors.length) continue;
    const scenario = customScenario(leeds, { points, altitude }, { rng: seeded(tries) });
    const profile = PROFILES[flown % 2];
    assertClean(await fly(scenario, profile, tries), `${points.map(p => p.name).join(' → ')} at ${altitude} ft, ${profile.reg}`);
    flown++;
  }
  assert.equal(flown, 8);
});

test('the aircraft holds outside controlled airspace until it is cleared in', async () => {
  for (const seed of [1, 2, 3, 4]) {
    const scenario = scenarioFor(ROUTES[0], seed);
    const sIn = scenario.plan.transit.sIn;
    let cleared = false, deepest = 0, orbited = false, heldReason = null;
    const events = await fly(scenario, PROFILES[0], seed, { settings: { refusalBias: -1 },
      watch: e => {
        if (e.kind === 'radio' && /Cleared to enter/.test(e.text)) cleared = true;
        if (e.kind === 'nav' && !cleared) { deepest = Math.max(deepest, e.s); orbited ||= e.orbiting; if (e.orbiting) heldReason = e.hold; }
      } });
    assertClean(events, `seed ${seed}`);
    assert.ok(cleared, 'a clearance was given');
    if (orbited) assert.match(heldReason || '', /clearance/i, 'a hold says why it is holding');
    assert.ok(deepest <= sIn - 0.99, `reached ${deepest.toFixed(2)} nm before the clearance; the boundary is at ${sIn.toFixed(2)}`);
  }
});

test('your route: the clearance names your VRPs and the reports follow them', async () => {
  const scenario = scenarioFor(ROUTES[0], 5);
  const events = await fly(scenario, PROFILES[1], 5, { settings: { refusalBias: -1, trafficDensity: 'quiet' } });
  assertClean(events, 'G-CZIA');
  const atc = events.filter(e => e.type === 'atc' && e.speaker === 'atc').map(e => e.text);
  const clearance = atc.find(t => /Cleared to enter/.test(t));
  assert.match(clearance, /identified (overhead [A-Z][\w ]+|\d+ miles? [a-z-]+ of [A-Z][\w ]+)\. Cleared to enter the Leeds control zone via Salts Mill, VFR, not above altitude 3000 feet, Leeds QNH \d{4}\. Route Salts Mill, Eccup Reservoir\. Report Salts Mill$/);
  assert.ok(atc.some(t => /radar control service, report Eccup Reservoir/.test(t)), atc.join('\n'));
  assert.ok(atc.some(t => /leave the zone east, not above altitude 3000 feet, report leaving controlled airspace/.test(t)));
  // Clear of their airspace the transit is over but the flight is not: the service runs on, and the pilot
  // asks to leave it near the destination. Nothing is "approved" before they have asked for it.
  const order = atc.map((t, i) => [i, t]);
  const told = order.find(([, t]) => /clear of controlled airspace, Basic Service, report changing frequency/.test(t));
  const approved = order.find(([, t]) => /squawk 7000, frequency change approved/.test(t));
  assert.ok(told, atc.join('\n'));
  assert.ok(approved && approved[0] > told[0], 'the approval comes after the pilot asks');
  const askedAt = events.findIndex(e => e.type === 'call' && e.id === 'qsy');
  assert.ok(askedAt > 0, 'the pilot asked for the frequency change');
  const calls = events.filter(e => e.type === 'call').map(e => e.id);
  assert.deepEqual(calls.filter(id => id.startsWith('report')), ['report-sml', 'report-ecp']);
});

test('your route, refused: "zone" instead of "controlled airspace" gets challenged', async () => {
  const scenario = scenarioFor(ROUTES[1], 7);
  let zoneAnswers = 0;
  const events = await fly(scenario, PROFILES[0], 7, { settings: { refusalBias: 1, trafficDensity: 'quiet' },
    pilot: engine => {
      const perfect = perfectPilot(engine);
      return ev => {
        if (ev.kind === 'awaiting' && /confirm you will not enter/.test(ev.atcText || '') && zoneAnswers < 1) {
          zoneAnswers++; sendWhenClear(engine, 'affirm I will not enter the zone G-HP'); return;
        }
        perfect(ev);
      };
    } });
  const corr = events.filter(e => e.type === 'correction');
  assert.ok(corr.some(c => /please confirm you will not enter controlled airspace/.test(c.text)), JSON.stringify(corr));
  assert.match(events.at(-1).summary, /refused/);
});

test('your route: a wrong QNH in the clearance readback gets a single correction', async () => {
  const scenario = scenarioFor(ROUTES[0], 11);
  let q = null;
  const events = await fly(scenario, PROFILES[1], 11, { settings: { refusalBias: -1, trafficDensity: 'quiet' },
    pilot: engine => {
      const perfect = perfectPilot(engine); let done = false;
      return ev => {
        const m = /Leeds QNH (\d{4})/.exec(ev.atcText || '');
        if (!done && ev.kind === 'awaiting' && m && /Cleared to enter/.test(ev.atcText)) {
          done = true; q = Number(m[1]);
          sendWhenClear(engine, `cleared to enter the zone via Salts Mill VFR not above altitude 3000 feet QNH ${q + 2} route Salts Mill Eccup wilco G-IA`);
          return;
        }
        perfect(ev);
      };
    } });
  const corr = events.filter(e => e.type === 'correction');
  assert.equal(corr.length, 1, JSON.stringify(corr));
  assert.equal(corr[0].text, `G-IA, negative, QNH ${q}`);
});

// ---------- changing the route in flight ----------
const place = id => leeds.places.find(p => p.id === id);
const atcSaid = events => events.filter(e => e.type === 'atc' && e.speaker === 'atc').map(e => e.text);

test('change of plan outside controlled airspace: divert, tell ATC, fly on with a Basic Service', async () => {
  for (const profile of PROFILES) {
    let changed = null;
    const events = await fly(scenarioFor(ROUTES[0], 3), profile, 3, { settings: { refusalBias: -1, trafficDensity: 'quiet' },
      watch: (e, engine) => {
        if (!changed && e.kind === 'radio' && e.speaker === 'atc' && /Basic Service/.test(e.text)) {
          changed = engine.changeRoute({ action: 'divert', place: place('bolton-abbey') }) ?? 'ok';
        }
      } });
    assert.equal(changed, 'ok');
    assertClean(events, profile.reg);
    assert.ok(events.some(e => e.type === 'route-change' && /Divert to Bolton Abbey/.test(e.text)));
    assert.ok(events.some(e => e.type === 'call' && e.id === 'reroute'), 'the pilot told ATC');
    assert.ok(!atcSaid(events).some(t => /Cleared to enter/.test(t)), 'no transit clearance for a route that stays outside');
    assert.equal(events.at(-1).summary, 'Basic Service flight completed');
  }
});

test('cleared inside the zone: a new route waits for approval, then the aircraft turns', async () => {
  const scenario = scenarioFor(ROUTES[0], 5);
  const sIn = scenario.plan.transit.sIn;
  let cleared = false, asked = false, approved = false, pendingUntilApproval = true, turned = false;
  const events = await fly(scenario, PROFILES[1], 5, { settings: { refusalBias: -1, trafficDensity: 'quiet' },
    watch: (e, engine) => {
      if (e.kind === 'radio' && /Cleared to enter/.test(e.text)) cleared = true;
      if (cleared && !asked && e.kind === 'nav' && e.s > sIn + 1.5) {
        asked = true;
        assert.equal(engine.changeRoute({ action: 'direct', place: place('wetherby') }), null);
        return;                                                     // this nav event came from before the request
      }
      if (asked && e.kind === 'radio' && /roger, route direct Wetherby/.test(e.text)) approved = true;
      if (asked && !approved && e.kind === 'nav' && !e.pending) pendingUntilApproval = false;
      if (approved && e.kind === 'route' && !e.pending && e.points.at(-1).name === 'Wetherby' && e.points[0].kind === 'position') turned = true;
    } });
  assertClean(events, 'G-CZIA');
  assert.ok(asked && approved, 'asked and approved');
  assert.ok(pendingUntilApproval, 'kept to the clearance until ATC approved');
  assert.ok(turned, 'flew the new route once approved');
  assert.ok(events.some(e => e.type === 'call' && e.id === 'reroute'));
  assert.equal(events.at(-1).summary, 'Transit completed');
});

test('cleared inside the zone: "unable, continue as cleared" keeps you on the old route', async () => {
  let found = false;
  for (let seed = 1; seed <= 60 && !found; seed++) {
    const scenario = scenarioFor(ROUTES[0], seed);
    const sIn = scenario.plan.transit.sIn;
    let cleared = false, asked = false;
    const events = await fly(scenario, PROFILES[1], seed, { settings: { trafficDensity: 'quiet' },
      watch: (e, engine) => {
        if (e.kind === 'radio' && /Cleared to enter/.test(e.text)) cleared = true;
        if (cleared && !asked && e.kind === 'nav' && e.s > sIn + 1.5) { asked = true; engine.changeRoute({ action: 'direct', place: place('wetherby') }); }
      } });
    if (!atcSaid(events).some(t => /unable due traffic, continue as cleared/.test(t))) continue;
    found = true;
    assertClean(events, `seed ${seed}`);
    assert.ok(events.some(e => e.type === 'call' && e.id === 'report-ecp'), 'still reported Eccup Reservoir on the old route');
    assert.equal(events.at(-1).summary, 'Transit completed');
  }
  assert.ok(found, 'ATC said unable at least once in 60 seeds');
});

test('before your first call, a new route simply replaces the plan', async () => {
  let changed = false;
  const events = await fly(scenarioFor(ROUTES[0], 2), PROFILES[0], 2, { settings: { trafficDensity: 'quiet' },
    watch: (e, engine) => {
      if (!changed && e.kind === 'nav') { changed = true; assert.equal(engine.changeRoute({ action: 'divert', place: place('bolton-abbey') }), null); }
    } });
  assertClean(events, 'G-CLHP');
  assert.ok(!events.some(e => e.type === 'call' && e.id === 'reroute'), 'nothing to tell ATC before the first call');
  assert.equal(events.at(-1).summary, 'Basic Service flight completed');
});

test('orbit holds the aircraft where it is until you carry on', async () => {
  let orbitAt = null, navs = 0, drift = 0, said = null;
  const events = await fly(scenarioFor(ROUTES[5], 4), PROFILES[1], 4, { settings: { trafficDensity: 'quiet' },
    watch: (e, engine) => {
      if (e.kind !== 'nav') return;
      if (orbitAt == null && e.s > 3) { engine.setOrbit(true); orbitAt = engine.nav.s; return; }
      if (orbitAt != null && navs < 20) {
        navs++; drift = Math.max(drift, Math.abs(e.s - orbitAt));
        if (e.pilotHold) said = e.hold;
        if (navs === 20) engine.setOrbit(false);
      }
    } });
  assertClean(events, 'G-CZIA');
  assert.equal(navs, 20);
  assert.equal(said, 'Orbiting', 'your own orbit says so');
  assert.ok(drift < 1e-9, `moved ${drift} nm while orbiting`);
});

test('a hold by ATC says why, and is not the pilot\'s to release', async () => {
  let held = null, pilotHeld = false;
  await fly(scenarioFor(ROUTES[1], 7), PROFILES[0], 7, { settings: { refusalBias: 1, trafficDensity: 'quiet' },
    watch: e => { if (e.kind === 'nav' && e.orbiting) { held = held || e.hold; pilotHeld = pilotHeld || e.pilotHold; } } });
  assert.match(held || '', /holding|orbiting/i, 'the map says why ATC is holding you');
  assert.equal(pilotHeld, false, 'it is ATC holding you, not the orbit button');
});

test('an orbit has to be flown, not just read back', async () => {
  let found = false;
  for (let seed = 1; seed <= 40 && !found; seed++) {
    const events = await fly(scenarioFor(ROUTES[0], seed), PROFILES[1], seed, { settings: { refusalBias: -1, trafficDensity: 'quiet' },
      pilot: engine => {
        const perfect = perfectPilot(engine);
        return ev => { if (ev.kind === 'action' && ev.action === 'orbit') return; perfect(ev); };   // reads it back, never turns
      } });
    if (!atcSaid(events).some(t => /orbit left at present position/.test(t))) continue;
    found = true;
    assert.ok(atcSaid(events).some(t => /confirm orbiting left/.test(t)), 'ATC chased the orbit');
    assert.ok(events.some(e => e.type === 'no-action' && /orbit/.test(e.id)), JSON.stringify(events.filter(e => e.type === 'no-action')));
  }
  assert.ok(found, 'an orbit came up within 40 seeds');
});

// "Zone" is the control zone and nothing else. Telling a pilot to ask for a "zone transit" when the route only
// crosses a CTA teaches the loose habit that gets them corrected on the radio — and it is the same word the
// refusal exchange marks you down for.
test('“zone” is used only when the control zone is what you are crossing', async () => {
  const ctx = { reg: 'G-CZIA', abbr: 'G-IA', type: 'QuikR microlight', transponder: true, speedKt: 65 };
  const cta = scenarioFor('Halifax to Garforth via Chain Bar at 2800 ft');
  const ctr = scenarioFor('Skipton to Wetherby via Salts Mill and Eccup Reservoir at 2800 ft');
  assert.equal(cta.plan.transit.intoZone, false, 'Chain Bar at 2800 ft crosses a CTA, not the CTR');
  assert.equal(ctr.plan.transit.intoZone, true);

  const brief = s => s.briefing(ctx).map(l => l[1]).join(' ');
  assert.ok(!/\bzones?\b/i.test(brief(cta)), `CTA briefing: ${(brief(cta).match(/[^.]*\bzone\b[^.]*/) || [])[0]}`);
  assert.match(brief(cta), /transit through their controlled airspace/);
  assert.match(brief(ctr), /a zone transit/);

  const model = async scenario => {
    const events = await fly(scenario, PROFILES[1], 4, { settings: { trafficDensity: 'quiet', refusalBias: -1 } });
    return events.find(e => e.type === 'call' && e.id === 'initial').model;
  };
  assert.match(await model(ctr), /request Basic Service and zone transit/);
  const m = await model(cta);
  assert.match(m, /request Basic Service and transit through your controlled airspace/);
  assert.ok(!/\bzone\b/i.test(m), m);
});

// Edinburgh and Manchester, from the same AIP transcription the app plans with. Between them these cover a CTR
// transit, a CTA-only transit, and flights that stay outside — including the Manchester transit corridor, which
// is Class G now and needs no clearance at all.
const MORE = {
  edinburgh: [
    'Dunbar to Falkirk via Musselburgh and Forth Road Bridge at 2000 ft',
    'Dunbar to Kinross via Musselburgh and Kirkcaldy Harbour at 2000 ft',
    'Peebles to Dunbar via West Linton at 2400 ft',
    'Dunbar to Peebles via Dalkeith at 3000 ft',
  ],
  manchester: [
    'Buxton to Northwich via Macclesfield and Alderley Edge at 1400 ft',
    'Chorley to Buxton via Sale Water Park and Stockport at 2000 ft',
    'Chester to Buxton via Winsford Flash and Jodrell Bank at 2400 ft',
    'Warrington to Winsford Flash via Northwich at 1400 ft',
  ],
};

for (const [id, routes] of Object.entries(MORE)) {
  const area = AREAS.find(a => a.id === id);
  for (const text of routes) {
    test(`${id} "${text}": perfect pilot, both aircraft, no corrections`, async () => {
      for (const profile of PROFILES) {
        for (const seed of [1, 2]) assertClean(await fly(scenarioIn(area, text, seed), profile, seed), `${profile.reg} seed ${seed}`);
      }
    });
  }
}

// The single most important thing about Manchester now: the old Low Level Route is gone, and what replaced it
// is Class G to 1500 ft. Below that the corridor must plan as an ordinary flight with nothing to ask for; above
// it, CTA 6 is Class D and you cannot simply set off inside it.
test('the Manchester transit corridor needs no clearance below 1500 ft', () => {
  const area = AREAS.find(a => a.id === 'manchester');
  const plan = alt => {
    const r = parseRoute(`Warrington to Winsford Flash via Northwich at ${alt} ft`, area);
    assert.deepEqual(r.unknown, []);
    return planRoute(area, r.points, r.altitude);
  };
  const low = plan(1400);
  assert.deepEqual(low.errors, []);
  assert.equal(low.transit, null, 'nothing to ask for below 1500 ft');
  assert.ok(!area.airspace.some(v => v.name.includes('EGR323') || /corridor/i.test(v.name)), 'Class G is not controlled airspace');
  assert.match(plan(2400).errors[0] || '', /CTA 6 \(base 1500 ft\)/);
  // ...and Class A above the lot is refused outright rather than offered as a transit
  const r = parseRoute('Chorley to Buxton via Sale Water Park at 4000 ft', area);
  const high = planRoute(area, r.points, r.altitude);
  assert.ok(high.errors.some(e => /Class A/.test(e) && /no transit/.test(e)), high.errors.join(' | '));
});

// The Edinburgh CTR is the first airspace in the app published as a plain circle rather than a vertex list.
test('the Edinburgh CTR is a 10 nm circle, and the CTAs tile the ring outside it', () => {
  const area = AREAS.find(a => a.id === 'edinburgh');
  const ctr = area.airspace.find(v => v.kind === 'CTR');
  const out = area.grid.xy({ lat: area.origin.lat + 10.5 / 60, lon: area.origin.lon });
  const inn = area.grid.xy({ lat: area.origin.lat + 9.5 / 60, lon: area.origin.lon });
  assert.ok(inside(inn, ctr.poly) && !inside(out, ctr.poly), '9.5 nm in, 10.5 nm out');
  assert.equal(ctr.top, 6000, 'surface to 6000 ft, not the usual 8500');
  for (const name of ['Musselburgh', 'Kirkcaldy Harbour', 'Cobbinshaw Reservoir', 'West Linton', 'Longannet']) {
    const p = area.places.find(x => x.name === name);
    assert.ok(area.airspace.some(v => inside(p, v.poly)), `${name} should be in the CTR or a CTA`);
  }
});

// A controller does not approve a frequency change nobody asked for. Go quiet on them and the service is
// terminated instead — which is both what really happens and the more useful lesson.
test('going quiet gets the service terminated, not a frequency change approved', async () => {
  const scenario = scenarioFor(ROUTES[0], 5);
  const silent = { qsy: () => '' };                   // say nothing when asked to leave the frequency
  const events = await fly(scenario, PROFILES[1], 5,
    { settings: { refusalBias: -1, trafficDensity: 'quiet' }, pilot: (e, o) => perfectPilot(e, { ...o, override: silent }) });
  const atc = events.filter(e => e.type === 'atc' && e.speaker === 'atc').map(e => e.text);
  assert.ok(atc.some(t => /Basic Service terminated/.test(t)), atc.slice(-4).join('\n'));
  assert.ok(!atc.some(t => /frequency change approved/.test(t)), 'nothing was approved');
  assert.ok(events.some(e => e.type === 'note' && /never asked for one/.test(e.text)));
});

// CAP 413 traffic information: clock code, distance, what it is doing relative to you, what it is, its level.
test('traffic information is passed the way a controller passes it', async () => {
  const seen = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const events = await fly(scenarioFor(ROUTES[0], seed), PROFILES[1], seed, { settings: { refusalBias: -1 } });
    for (const e of events) if (e.type === 'atc' && /, traffic,/.test(e.text || '')) seen.push(e.text);
  }
  assert.ok(seen.length, 'some traffic was passed across six flights');
  for (const t of seen) {
    assert.match(t, /, traffic, (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) o.clock, \d miles, /, t);
    assert.match(t, /(crossing left to right|crossing right to left|opposite direction|same direction|manoeuvring)/, t);
    assert.match(t, /(indicating \d+ feet (above|below)|similar level|no height information)$/, t);
  }
});

// The briefing says "call Leeds Radar when there is a gap", but the script only started listening for that call
// 10 nm from the zone. A call made earlier arrived as unexpected, and with "request" in it and a Claude key set,
// handed the whole flight to Claude — which is what the first speech recognition log showed, at 19 seconds.
test('calling before the script asks is your first call, not going off script', async () => {
  const scenario = scenarioFor(ROUTES[0], 3);
  const clock = fakeClock(4000);
  const radio = fakeRadio(clock);
  const asked = [];
  // Ends the session at once if it is ever reached, so the old behaviour fails this test quickly instead of
  // sitting in free mode waiting for fifteen minutes of silence.
  const claude = { atc: async () => { asked.push(1); return { transmissions: ['{CALL}, roger'], end: true, summary: 'Ended off script' }; } };
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(3),
    settings: { trafficDensity: 'quiet', refusalBias: -1 }, claude, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine);
  handler = ev => { if (ev.kind === 'awaiting' && ev.id === 'initial') return; perfect(ev); };   // already called
  const flight = engine.start();
  sendWhenClear(engine, 'Leeds Radar, golf Charlie Zulu India alpha, request Basic Service and transit');
  const events = await flight;

  assert.ok(!events.some(e => e.type === 'offscript'), 'the flight stayed on script');
  assert.equal(asked.length, 0, 'Claude was never asked');
  const init = events.find(e => e.type === 'call' && e.id === 'initial');
  assert.match(init?.text || '', /request Basic Service and transit/, 'the early call was taken as the initial call');
  assert.ok(events.some(e => e.type === 'atc' && /pass your message/.test(e.text)), 'and answered');
  assertClean(events, 'early caller');
});

test('once the first call is made, a real change of plan still goes to Claude', async () => {
  const scenario = scenarioFor(ROUTES[0], 3);
  const clock = fakeClock(4000);
  const radio = fakeRadio(clock);
  const claude = { atc: async () => ({ transmissions: ['{CALL}, roger, divert approved'], end: true, summary: 'Diverted' }) };
  let handler = () => {};
  const engine = new Engine({ scenario, profile: PROFILES[1], radio, clock, rng: seeded(3),
    settings: { trafficDensity: 'quiet', refusalBias: -1 }, claude, onEvent: e => handler(e) });
  const perfect = perfectPilot(engine);
  let diverted = false;
  handler = ev => {
    perfect(ev);
    // after the squawk is set, ask for something the script does not cover
    if (!diverted && ev.kind === 'log' && ev.event.type === 'squawk-set') {
      diverted = true;
      setTimeout(() => sendWhenClear(engine, 'G-IA, request diversion to Sherburn due weather'), 5);
    }
  };
  const events = await engine.start();
  assert.ok(events.some(e => e.type === 'offscript'), 'off script once the flight is under way');
});
