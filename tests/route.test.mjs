import test from 'node:test';
import assert from 'node:assert/strict';
import { dms, inside, describe } from '../js/geo.js';
import { AREAS } from '../js/areas/index.js';
import { VRPS, VRP_EFFECTIVE } from '../js/data/vrps.js';
import { parseRoute, planRoute, findPlace } from '../js/route.js';

const leeds = AREAS.find(a => a.id === 'leeds');
const place = id => leeds.places.find(p => p.id === id);
const volumesAt = (p, alt) => leeds.airspace.filter(v => alt >= v.base && alt < v.top && inside(p, v.poly)).map(v => v.name);

test('coordinates in AIP form', () => {
  assert.ok(Math.abs(dms('535157N') - 53.865833) < 1e-6);
  assert.ok(Math.abs(dms('0013938W') + 1.660556) < 1e-6);
  assert.ok(Math.abs(dms('534130.00N') - 53.691667) < 1e-6);
  assert.throws(() => dms('0013938N'));
});

test('Leeds VRPs come from the NATS dataset, each with a radio name', () => {
  assert.equal(VRP_EFFECTIVE, '2026-09-03');
  assert.deepEqual(VRPS.EGNM.map(v => v.code).sort(), ['ATH', 'CBR', 'DBY', 'ECP', 'HGT', 'SML']);
  const vrps = leeds.places.filter(p => p.kind === 'vrp');
  assert.equal(vrps.length, 6);
  for (const v of vrps) assert.ok(v.name && v.hear.length, v.official);
  assert.ok(!leeds.places.some(p => p.kind === 'vrp' && p.name === 'Keighley'), 'Keighley is no longer a Leeds VRP');
});

test('Leeds airspace from the AIP: what is inside what, and at which altitude', () => {
  for (const id of ['sml', 'ecp', 'ath', 'otley']) assert.deepEqual(volumesAt(place(id), 0), ['Leeds Bradford CTR'], id);
  assert.deepEqual(volumesAt(place('keighley'), 2800), [], 'Keighley is under CTA 3 at 2800 ft');
  assert.deepEqual(volumesAt(place('keighley'), 3200), ['Leeds Bradford CTA 3']);
  assert.deepEqual(volumesAt(place('riddlesden'), 2400), []);
  assert.deepEqual(volumesAt(place('riddlesden'), 2500), ['Leeds Bradford CTA 2'], 'the base belongs to the CTA');
  for (const id of ['hgt', 'wetherby', 'harewood']) assert.deepEqual(volumesAt(place(id), 4000), [], id);
});

test('positions described the way you would say them', () => {
  const k = place('keighley');
  assert.equal(describe({ x: k.x, y: k.y - 3 }, [k]).text, '3 miles south of Keighley');
  assert.equal(describe({ x: k.x + 0.2, y: k.y }, [k]).text, 'overhead Keighley');
});

test('describing a route: from, to, via, arrows and altitude', () => {
  const names = r => r.points.map(p => p.name);
  let r = parseRoute('Skipton to Wetherby via Salts Mill and Eccup at 2,800 ft', leeds);
  assert.deepEqual(names(r), ['Skipton', 'Salts Mill', 'Eccup Reservoir', 'Wetherby']);
  assert.equal(r.altitude, 2800);
  r = parseRoute('from Skipton via the Salts Mill VRP, Eccup reservoir to Wetherby', leeds);
  assert.deepEqual(names(r), ['Skipton', 'Salts Mill', 'Eccup Reservoir', 'Wetherby']);
  assert.equal(r.altitude, null);
  r = parseRoute('Halifax -> Chain Bar Roundabout -> Garforth at 2400', leeds);
  assert.deepEqual(names(r), ['Halifax', 'Chain Bar', 'Garforth']);
  assert.equal(r.altitude, 2400);
  r = parseRoute('Skipton to Harogate via Riddlesdon', leeds);
  assert.deepEqual(names(r), ['Skipton', 'Riddlesden', 'Harrogate']);
  assert.ok(r.notes.some(n => /Harogate/.test(n)), JSON.stringify(r.notes));
});

test('places it does not know are reported, with suggestions only when close', () => {
  const r = parseRoute('Keighley to Harrogate via Menwith Hill', leeds);
  assert.deepEqual(r.unknown, [{ text: 'Menwith Hill', suggestions: [] }]);
  assert.deepEqual(findPlace('Wetherbee', leeds.places).place?.name, 'Wetherby');
});

test('planning a transit: entry, exit, the clearance point and the reports', () => {
  const r = parseRoute('Skipton to Wetherby via Salts Mill and Eccup Reservoir at 2800 ft', leeds);
  const plan = planRoute(leeds, r.points, r.altitude);
  assert.deepEqual(plan.errors, []);
  const T = plan.transit;
  assert.equal(T.via.place.name, 'Salts Mill');
  assert.deepEqual(T.reports.map(x => x.place.name), ['Salts Mill', 'Eccup Reservoir']);
  assert.equal(T.exitSide, 'east');
  assert.ok(T.sIn > 5 && T.sIn < T.reports[0].s && T.reports[1].s < T.sOut && T.sOut < plan.total);
  assert.ok(plan.under.some(u => u.volume.name === 'Leeds Bradford CTA 3' && u.gap === 200));
  assert.ok(plan.warnings.some(w => /Leeds Bradford/.test(w)), 'a direct Salts Mill to Eccup line crosses the airport');
});

test('routes that cannot be flown are refused with a reason', () => {
  const plan = (text, alt) => { const r = parseRoute(text, leeds); return planRoute(leeds, r.points, alt ?? r.altitude); };
  assert.match(plan('Ilkley to Wetherby at 2000 ft').errors[0], /start inside Leeds Bradford CTR/);
  assert.match(plan('Skipton to Selby at 3200 ft').errors[0], /CTA 3 \(base 3000 ft\)/);
  assert.match(plan('Silsden to Harrogate at 2400 ft').errors[0], /at least 4 nm/);
  assert.match(plan('Skipton', 2000).errors[0], /at least two places/);
  assert.match(plan('Skipton to Wetherby', 6000).errors[0], /transition altitude/);
});

test('a route that stays outside becomes a Basic Service flight', () => {
  const r = parseRoute('Wakefield to Selby at 2000 ft', leeds);
  const plan = planRoute(leeds, r.points, r.altitude);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.transit, null);
  assert.ok(plan.closest.d > 2);
});

test('changing the route in flight: direct to skips ahead or detours, divert replaces the destination', async () => {
  const { reroutePoints } = await import('../js/route.js');
  const r = parseRoute('Skipton to Wetherby via Salts Mill and Eccup Reservoir at 2800 ft', leeds);
  const plan = planRoute(leeds, r.points, r.altitude);
  const names = pts => pts.map(p => p.name);
  const s = plan.points[1].s - 1;                                   // a mile short of Salts Mill
  assert.deepEqual(names(reroutePoints(plan, s, 'direct', place('ecp'))), ['Eccup Reservoir', 'Wetherby']);
  assert.deepEqual(names(reroutePoints(plan, s, 'direct', place('otley'))), ['Otley', 'Salts Mill', 'Eccup Reservoir', 'Wetherby']);
  assert.deepEqual(names(reroutePoints(plan, s, 'divert', place('hgt'))), ['Harrogate']);
});

test('a changed route may start inside controlled airspace, but not finish there', async () => {
  const { presentPosition } = await import('../js/route.js');
  const here = presentPosition({ ...place('sml'), x: place('sml').x + 0.5 });   // just by Salts Mill, inside the CTR
  let plan = planRoute(leeds, [here, place('wetherby')], 2800, { midFlight: true });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.transit.sIn, 0);
  assert.ok(plan.transit.sOut > 0 && plan.transit.sOut < plan.total);
  plan = planRoute(leeds, [here, place('otley')], 2800, { midFlight: true });
  assert.match(plan.errors[0], /finish inside Leeds Bradford CTR/);
});
