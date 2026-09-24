// East Fortune to Perth through the Edinburgh zone. The CTR is a 10 nm circle round the airport (UK AIP AD 2.17 EGPH),
// and Musselburgh and Kirkcaldy Harbour both lie outside it, under CTA 2 (base 2500 ft): the crossing this used to fly,
// Musselburgh direct to Kirkcaldy Harbour at 2000 ft, never entered the zone it was cleared into. So it goes the way GA
// are routed through the zone (forth-bridges flies the first half): in via Musselburgh, Arthur's Seat, north of the
// runway 24 threshold, then over the Forth Road Bridge and out northbound up the M90. The route is planned from the area
// data, so the zone's edge is where the AIP puts it, and a route that stops making sense fails here rather than in the air.
import { P, WILCO, QNH, SQUAWK, NOT_ABOVE, ROS, TRAFFIC_ACK, FREQ, details, initialCall, edinburghTraffic, useSquawk } from './common.js';
import { AREAS } from '../areas/index.js';
import { planRoute, whereIs } from '../route.js';

const area = AREAS.find(a => a.id === 'edinburgh');
const place = name => area.places.find(p => p.name === name);
const ROUTE = ['East Fortune', 'Musselburgh', "Arthur's Seat", 'Runway 24 threshold', 'Forth Road Bridge', 'M90 Junction 4', 'Kinross'];
const ALTITUDE = 1800;                                     // under CTA 2 (base 2500) until the zone
const PLAN = planRoute(area, ROUTE.map(place), ALTITUDE);
if (PLAN.errors.length) throw new Error(`Edinburgh transit route: ${PLAN.errors[0]}`);
const T = PLAN.transit;
if (!T?.intoZone) throw new Error('Edinburgh transit route: it no longer enters the zone');
const at = name => PLAN.points.find(w => w.place.name === name).s;
const named = (name, fix) => { const p = place(name); return P(p.name, p.hear || [p.name.toLowerCase()], { fix }); };

export default {
  id: 'edinburgh-transit',
  title: 'Edinburgh zone transit',
  subtitle: 'Musselburgh → Forth Road Bridge → M90, East Fortune to Perth',
  unit: 'Edinburgh Approach',
  freq: '121.205',
  traffic: edinburghTraffic,
  plan: PLAN, places: area.places, pronounce: area.pronounce,
  where: p => whereIs(area, p).text,
  briefing: ctx => [
    ['Aircraft', `${ctx.reg}, ${ctx.type}, ${ctx.transponder ? 'Mode S' : 'no transponder'}, 1 POB.`],
    ['Flight', 'East Fortune to Perth, VFR.'],
    ['Start', `Just departed East Fortune westbound, ${ALTITUDE} ft on 1011.`],
    ['Route', `${ROUTE.join(' → ')} · ${Math.round(PLAN.total)} nm`],
    ['Plan', 'Into the CTR at Musselburgh, across the city, over the Forth Road Bridge and out northbound up the M90.'],
    ['Level', 'Under CTA 2 (base 2500 ft) until the zone; VFR in the zone is normally not above 2000 ft.'],
    ['Transit', `In to the CTR after ${Math.round(T.sIn)} nm, out after ${Math.round(T.sOut)}: its edge is a 10 nm circle round the airport.`],
    ['Edinburgh', 'Runway 24 in use.'],
    ['Careful', 'You pass just north of the runway 24 threshold, right where arrivals for 24 cross the coast: listen for the traffic they tell you about.', 'warn'],
  ],
  async run(s) {
    const { ctx } = s;
    const x = ctx.transponder;
    ctx.qnh = 1012;                                       // Edinburgh's, which the traffic uses too
    s.fly(PLAN);
    s.setRadio({ qnh: 1011 });                            // yours, until they give you theirs
    s.hold(at('Musselburgh') - 1, 'Holding outside: no clearance yet');
    await s.reach(2.5, { label: 'Westbound from East Fortune', cue: 'Call Edinburgh Approach when there is a gap.', early: true });
    const here = whereIs(area, s.position());
    const det = details(ctx, { from: 'east fortune', to: 'perth', position: [...here.hear, 'miles'], altitude: ALTITUDE,
      request: ['transit', 'zone transit', 'musselburgh', 'bridge'] });
    await initialCall(s, { unitName: 'Edinburgh Approach', det,
      requestItems: [P('request', ['transit', 'zone', 'request'], { soft: true, why: 'State your request on first contact.' })],
      model: 'Edinburgh Approach, {CS}, request zone transit',
      detailsModel: `{CS}, {TYPE}, East Fortune to Perth, ${here.text}, altitude ${ALTITUDE} feet, QNH 1011, VFR, ` +
        (x ? '' : 'no transponder, ') + 'request zone transit via Musselburgh and the Forth Road Bridge' });

    if (x) {
      await s.atc('{CALL}, squawk 6155, remain outside controlled airspace', { readback: [SQUAWK('6155'), ROS()], model: 'Squawk 6155, remain outside controlled airspace, {CALL}' });
      await useSquawk(s, '6155');
    } else {
      await s.atc('{CALL}, remain outside controlled airspace, report approaching Musselburgh', { readback: [ROS(), WILCO()], model: 'Remain outside controlled airspace, wilco, {CALL}' });
      await s.reach(Math.max(s.position().s + 0.3, at('Musselburgh') - 2.5), { label: 'Towards Musselburgh', early: true });
      await s.expect({ id: 'approaching', cue: 'Approaching Musselburgh, outside the zone.', nudge: '{CALL}, report your position',
        items: [named('Musselburgh')], model: `{CALL}, approaching Musselburgh, altitude ${ALTITUDE} feet` });
    }
    if (s.chance(0.3 + s.settings.refusalBias)) {
      await s.atc('{CALL}, hold outside controlled airspace east of Musselburgh, expect clearance in 5 minutes', {
        readback: [P('hold outside controlled airspace', ['hold outside', 'outside controlled airspace', 'remain outside'], { fix: 'hold outside controlled airspace' }), P('east of Musselburgh', ['musselburgh'], { soft: true })],
        model: 'Hold outside controlled airspace east of Musselburgh, {CALL}' });
      await s.leg('Holding east of Musselburgh', 3, { cue: 'Orbit outside controlled airspace.' });
    }
    await s.reach(Math.max(s.position().s + 0.3, at('Musselburgh') - 1.5), { label: 'Towards Musselburgh' });
    const cleared = await s.atc((x ? `{CALL}, identified ${whereIs(area, s.position()).text}. ` : '{CALL}, ') +
      'Cleared to enter the Edinburgh control zone via Musselburgh, VFR, not above altitude 2000 feet, Edinburgh QNH 1012, report Musselburgh', {
      clearance: true,
      readback: [P('cleared to enter', ['cleared to enter', 'cleared into', 'cleared'], { fix: 'cleared to enter the Edinburgh control zone via Musselburgh' }),
        named('Musselburgh', 'via Musselburgh'), P('VFR', ['vfr'], { fix: 'VFR' }), ...NOT_ABOVE(2000), QNH(1012), WILCO()],
      model: 'Cleared to enter the Edinburgh control zone via Musselburgh, VFR, not above altitude 2000 feet, QNH 1012, wilco, {CALL}' });
    // Never read back, even after "how do you read?": it never took effect, so the aircraft stays outside.
    if (cleared?.failed) { s.note('The clearance was never read back, so it never took effect: you stayed outside the zone.'); s.endNow('No clearance read back: stayed outside'); }
    s.hold(null);
    s.setRadio({ qnh: 1012 });

    // ---------- in the zone: across the city ----------
    const svc = x ? 'radar control service' : 'control service';
    await s.reach(at('Musselburgh'), { label: 'Musselburgh', early: true });
    await s.expect({ id: 'musselburgh', cue: 'Over Musselburgh Racecourse.', nudge: '{CALL}, report your position',
      items: [named('Musselburgh')], model: '{CALL}, Musselburgh' });
    await s.atc(`{CALL}, roger, ${svc}, route via Arthur's Seat, report Arthur's Seat`, {
      readback: [P('control service', ['control service'], { fix: svc }), named("Arthur's Seat", "route via Arthur's Seat"), WILCO()],
      model: `${svc[0].toUpperCase() + svc.slice(1)}, via Arthur's Seat, wilco, {CALL}` });
    await s.reach(at("Arthur's Seat"), { label: "Arthur's Seat", early: true });
    await s.expect({ id: 'arthurs-seat', cue: "Arthur's Seat.", nudge: '{CALL}, report your position',
      items: [named("Arthur's Seat")], model: "{CALL}, Arthur's Seat" });
    await s.atc('{CALL}, roger, pass north of the runway 24 threshold, report overhead', {
      readback: [P('north of the threshold', ['north of the threshold', 'north of the 24 threshold', 'threshold', 'north of'], { fix: 'pass north of the runway 24 threshold' }),
        P('runway 24', ['24'], { soft: true }), WILCO()],
      model: 'North of the runway 24 threshold, wilco, {CALL}' });
    if (s.chance(0.5)) {
      await s.reach(Math.max(s.position().s + 0.5, at('Runway 24 threshold') - 3), { label: 'Across the city' });
      await s.atc(`{CALL}, traffic, ${s.pick(['ten', 'eleven', 'one', 'two'])} o'clock, 3 miles, an Embraer on final for runway 24, indicating 1200 feet`, {
        readback: [TRAFFIC_ACK()], model: 'Traffic in sight, {CALL}' });
    }
    await s.reach(at('Runway 24 threshold'), { label: 'North of the runway 24 threshold', early: true });
    await s.expect({ id: 'overhead', cue: 'Passing north of the runway 24 threshold.', nudge: '{CALL}, report your position',
      items: [P('overhead', ['overhead', 'threshold', 'north of', 'passing'])], model: '{CALL}, overhead, north of the 24 threshold' });
    await s.atc('{CALL}, roger, route via the Forth Road Bridge, report the bridge', {
      readback: [named('Forth Road Bridge', 'route via the Forth Road Bridge'), WILCO()], model: 'Via the Forth Road Bridge, wilco, {CALL}' });

    // ---------- over the Forth, and out northbound ----------
    if (s.chance(0.6)) {
      await s.reach(Math.max(s.position().s + 0.3, at('Forth Road Bridge') - 1.5), { label: 'Towards the Forth Road Bridge' });
      await s.atc('{CALL}, traffic is a helicopter, 3 miles west of you, southbound along the Forth, altitude 1500 feet', { readback: [TRAFFIC_ACK()], model: 'Traffic in sight, {CALL}' });
    }
    await s.reach(at('Forth Road Bridge'), { label: 'Forth Road Bridge', early: true });
    await s.expect({ id: 'bridge', cue: 'Over the Forth Road Bridge.', nudge: '{CALL}, report your position',
      items: [named('Forth Road Bridge')], model: '{CALL}, Forth Road Bridge' });
    await s.atc('{CALL}, roger, leave the zone northbound via M90 Junction 4, not above altitude 2000 feet, report leaving controlled airspace', {
      readback: [P('leave the zone northbound', ['northbound', 'north', 'leave', 'leaving'], { fix: 'leave the zone northbound' }),
        named('M90 Junction 4', 'via M90 Junction 4'), ...NOT_ABOVE(2000), WILCO()],
      model: 'Leave the zone northbound via M90 Junction 4, not above altitude 2000 feet, wilco, {CALL}' });
    if (s.chance(0.3)) {
      ctx.qnh = 1011;
      await s.atc('{CALL}, Edinburgh QNH 1011', { readback: [QNH(1011)], model: 'QNH 1011, {CALL}' });
      s.setRadio({ qnh: 1011 });
    }
    await s.reach(Math.min(PLAN.total, T.sOut + 0.1), { label: 'Leaving the zone', early: true });
    await s.expect({ id: 'clear', cue: 'Crossing the CTR boundary.', nudge: '{CALL}, report your position',
      items: [P('leaving controlled airspace', ['leaving controlled airspace', 'leaving the zone', 'clear of controlled airspace', 'leaving', 'clear', 'outside'])],
      model: '{CALL}, leaving controlled airspace' });
    await s.atc((x ? '{CALL}, squawk 7000, ' : '{CALL}, ') + 'freecall Scottish Information 119.875', {
      readback: [...(x ? [SQUAWK('7000')] : []), FREQ('119.875', 'Scottish Information')],
      model: (x ? 'Squawk 7000, ' : '') + 'Scottish Information 119.875, {CALL}' });
    await useSquawk(s, '7000', { chase: false });
    s.end('Transit completed');
  },
};
