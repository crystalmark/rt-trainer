import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../js/engine.js';
import { PROFILES } from '../js/config.js';
import { AREAS } from '../js/areas/index.js';
import { parseRoute, planRoute } from '../js/route.js';
import { customScenario } from '../js/scenarios/custom.js';
import { fakeClock, fakeRadio, seeded, perfectPilot, sendWhenClear } from './helpers.mjs';

const leeds = AREAS.find(a => a.id === 'leeds');

function scenarioFor(text, seed = 1) {
  const r = parseRoute(text, leeds);
  assert.deepEqual(r.unknown, [], text);
  return customScenario(leeds, { points: r.points, altitude: r.altitude }, { rng: seeded(seed * 97) });
}

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
  assert.ok(atc.some(t => /Basic Service, squawk 7000, frequency change approved/.test(t)));
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
