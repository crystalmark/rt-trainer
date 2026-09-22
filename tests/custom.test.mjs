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
    settings: { trafficDensity: 'busy', ...settings }, onEvent: e => { watch(e); handler(e); } });
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
    let cleared = false, deepest = 0, orbited = false;
    const events = await fly(scenario, PROFILES[0], seed, { settings: { refusalBias: -1 },
      watch: e => {
        if (e.kind === 'radio' && /Cleared to enter/.test(e.text)) cleared = true;
        if (e.kind === 'nav' && !cleared) { deepest = Math.max(deepest, e.s); orbited ||= e.orbiting; }
      } });
    assertClean(events, `seed ${seed}`);
    assert.ok(cleared, 'a clearance was given');
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
  assert.deepEqual(calls.filter(id => id.startsWith('report')), ['report-0', 'report-1']);
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
