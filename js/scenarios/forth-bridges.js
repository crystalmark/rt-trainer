// East Fortune to the Forth bridges and home again: across Edinburgh on a zone transit, orbits over the three
// bridges, and back. The route is Tim's own from flying it: East Fortune, Musselburgh, Arthur's Seat, the airport
// overhead, the bridges; five orbits, then "finished at the bridges", told to hold, then back via the overhead.
// "The overhead" in practice: GA are sent north of the runway threshold, and on this line that is 24's, at the
// north-east end (Edinburgh has one runway, 06/24; the 06 end would be twice the detour).
// Graeme Ritchie's "Edinburgh Transit RT" (2017) gives the rest of the radio: East Fortune Radio, then Edinburgh
// Approach; cleared into the zone via Musselburgh not above 2000 ft; squawk 7000, frequency change approved.
//
// East Fortune: 118.755, elevation 115 ft, runways 29L/11R and 25L/07R, overhead join 2000 ft, circuit 1000 ft
// (the flexwing school based there); 29 and 25 left-hand, 11 and 07 right-hand (Tim). Air/Ground when someone is
// on the radio, blind calls when not. Edinburgh Approach 121.205 and the CTR from the AIP (js/areas/edinburgh.js).
import { P, WILCO, QNH, SQUAWK, BASIC, NOT_ABOVE, ROS, TERMINATED_ACK, details, initialCall, useSquawk, edinburghTraffic } from './common.js';
import { AREAS } from '../areas/index.js';
import { planRoute, whereIs } from '../route.js';

const area = AREAS.find(a => a.id === 'edinburgh');
const place = name => area.places.find(p => p.name === name);
const ROUTE = ['East Fortune', 'Musselburgh', "Arthur's Seat", 'Runway 24 threshold', 'Forth Road Bridge',
  'Runway 24 threshold', "Arthur's Seat", 'Musselburgh', 'East Fortune'];
const ALTITUDE = 1500;                                     // under CTA 2 (base 2500) until the zone
const PLAN = planRoute(area, ROUTE.map(place), ALTITUDE);
if (PLAN.errors.length) throw new Error(`Forth bridges route: ${PLAN.errors[0]}`);
const T = PLAN.transit;

/** How far along the route the nth visit to a place is (most of it is flown twice, out and back). */
const at = (name, n = 0) => PLAN.points.filter(w => w.place.name === name)[n].s;
const named = (name, fix) => { const p = place(name); return P(p.name, p.hear || [p.name.toLowerCase()], { fix }); };

// A/G at East Fortune, as at Carlisle: nobody can clear you, so don't ask to be.
const AG_WARN = [
  { re: /\bcleared\b.*\beast fortune\b|\beast fortune\b.*\bcleared\b/, why: 'East Fortune Radio is Air/Ground: nobody there can clear you. Announce, don’t ask.' },
  { re: /\brequest (landing|take ?off|taxi)\b/, why: 'At an Air/Ground field you announce intentions (“lining up runway 25 left”), you don’t request permission.' },
];

export const forthBridges = {
  id: 'forth-bridges',
  title: 'East Fortune to the Forth bridges',
  subtitle: 'Across Edinburgh on a zone transit, orbits over the three bridges, and home',
  unit: 'East Fortune Radio',
  freq: '118.755',
  traffic: (s, o) => (/edinburgh/i.test(s.ctx.unit) ? edinburghTraffic(s, o) : null),   // East Fortune is quiet
  warn: AG_WARN,
  plan: PLAN, places: area.places, pronounce: area.pronounce,
  where: p => whereIs(area, p).text,
  briefing: ctx => [
    ['Aircraft', `${ctx.reg}, ${ctx.type}, ${ctx.transponder ? 'Mode S' : 'no transponder'}, 1 POB.`],
    ['Flight', 'East Fortune to East Fortune, VFR: a sightseeing trip to the Forth bridges.'],
    ['Route', `${ROUTE.join(' → ')} · ${Math.round(PLAN.total)} nm`],
    ['Level', `Altitude ${ALTITUDE} ft, under CTA 2 (base 2500 ft) until the zone.`],
    ['East Fortune', 'East Fortune Radio 118.755: Air/Ground when someone is on, otherwise blind calls as “East Fortune Traffic”.'],
    ['Airfield', 'Elevation 115 ft, runways 29L/11R and 25L/07R, overhead join 2000 ft, circuit 1000 ft QFE.'],
    ['Circuits', '29 and 25 left-hand; 11 and 07 right-hand.'],
    ['Edinburgh', 'Edinburgh Approach 121.205. Expect Musselburgh, Arthur’s Seat, then north of the runway 24 threshold, not above 2000 ft.'],
    ['Transit', `You reach the CTR after ${Math.round(T.sIn)} nm; its edge is a 10 nm circle round the airport.`],
    ['At the bridges', 'Ask for orbits. Press Orbit on the map, and call “finished at the bridges” when you have had enough: five orbits is about ten minutes.'],
    ['Careful', 'You cross just north of the runway 24 threshold both ways, right where arrivals for 24 cross the coast: listen for the traffic they tell you about.', 'warn'],
  ],

  async run(s) {
    const { ctx } = s;
    const x = ctx.transponder;
    const staffed = s.chance(0.6);                        // someone on East Fortune Radio, or not
    ctx.blind = !staffed;                                 // and if not, nobody answers anything on it
    const rwy = s.pick(['25L', '29L', '25L', '29L', '07R', '11R']), num = rwy.slice(0, 2);   // mostly westerlies
    const westerly = +num > 18, hand = westerly ? 'left-hand' : 'right-hand';
    const wind = westerly ? 'surface wind 260 degrees 10 knots' : 'surface wind 080 degrees 8 knots';
    const qnh = s.pick([1014, 1016, 1019, 1022, 1027]), qfe = qnh - 4;   // 115 ft is about 4 hPa
    const oct = () => String(s.pick([0, 1, 2, 3, 4, 5, 6, 7]));
    const squawk = area.squawks + oct() + oct();
    const side = westerly ? 'left' : 'right';
    const runwayItem = P(`runway ${rwy}`, [num, `${num}${side[0]}`, `${num} ${side}`], { fix: `runway ${rwy}` });
    const ef = staffed ? [] : [P('East Fortune Traffic', ['east fortune traffic', 'traffic'], { soft: true,
      why: 'With nobody on the radio, start blind calls “East Fortune Traffic” and end them “East Fortune”.' })];
    const efAck = () => (staffed ? s.atc('{CALL}, roger') : null);
    // A reply that can be answered ("good day"): the answer is not the next call, which the leg after it waits for.
    const efSays = (text, id, model = 'Roger, {CALL}') => s.atc(text, { reply: { id, optional: true, timeout: 5, items: [], model } });

    // ---------- on the ground at East Fortune ----------
    await s.leg('On the ground at East Fortune', 0.3, { cue: 'Make your first call.', early: true });
    await s.expect({ id: 'radio-check', initial: true, timeout: 180, cue: 'Radio check and departure information.',
      items: [P('radio check', ['radio check'], { soft: true }), P('departure information', ['departure information', 'airfield information', 'departure'], { soft: true })],
      model: 'East Fortune Radio, {CS}, radio check and departure information' });
    if (staffed) {
      await s.atc(`{CALL}, East Fortune Radio, readability 5, runway ${rwy} ${hand}, QFE ${qfe}, ${wind}`, {
        readback: [runwayItem, QNH(qfe, 'QFE')], model: `Runway ${rwy}, QFE ${qfe}, {CALL}` });
    } else {
      const again = await s.expect({ id: 'radio-check-2', optional: true, timeout: 30, items: [], model: 'East Fortune Radio, {CS}, radio check' });
      s.note(again ? 'No answer: nobody was on East Fortune Radio, so it is blind calls on 118.755.' : 'No answer from East Fortune Radio, and no second call.');
    }
    await s.leg('Holding point, power checks', 0.3, { early: true });
    await s.expect({ id: 'lineup', cue: `Checks complete: lining up on runway ${rwy}.`, items: [...ef, P('lining up', ['lining up', 'line up', 'entering', 'departing']), P('runway', [num], { soft: true })],
      model: staffed ? `{CALL}, lining up runway ${rwy}` : `East Fortune Traffic, {CS}, lining up runway ${rwy}, East Fortune` });
    if (staffed) await efSays('{CALL}, roger, no reported traffic', 'lineup-ack');

    // ---------- airborne: the moving map takes over ----------
    s.fly(PLAN);
    s.hold(T.sIn - 1, 'Holding outside: no clearance yet');
    await s.reach(1.5, { label: 'Departing East Fortune', early: true });
    await s.expect({ id: 'departing', cue: 'Airborne and heading west. Tell East Fortune you are leaving.', items: [...ef, P('departing', ['departing', 'leaving', 'changing'])],
      model: staffed ? '{CALL}, departing to the west, changing to Edinburgh Approach' : 'East Fortune Traffic, {CS}, departing to the west, East Fortune' });
    if (staffed) await efSays('{CALL}, roger, good day', 'departing-ack', 'Good day, {CALL}');

    // ---------- Edinburgh Approach ----------
    ctx.unit = 'Edinburgh Approach'; ctx.abbreviated = false; ctx.blind = false;
    s.setRadio({ unit: 'Edinburgh Approach', freq: '121.205' });
    await s.reach(3, { label: 'Edinburgh Approach 121.205', cue: 'Call Edinburgh Approach when there is a gap.', early: true });
    const here = whereIs(area, s.position());
    await initialCall(s, { unitName: 'Edinburgh Approach',
      det: details(ctx, { from: 'east fortune', to: 'east fortune', position: [...here.hear, 'miles', 'overhead'], altitude: ALTITUDE,
        request: ['transit', 'zone transit', 'bridges', 'bridge', 'orbit'] }),
      requestItems: [P('request', ['transit', 'zone', 'basic service', 'request'], { soft: true, why: 'State your request on first contact.' })],
      model: 'Edinburgh Approach, {CS}, request Basic Service and zone transit',
      detailsModel: `{CS}, {TYPE}, East Fortune to East Fortune, ${here.text}, altitude ${ALTITUDE} feet, QNH ${qnh}, VFR, ` +
        (x ? '' : 'no transponder, ') + 'request zone transit to the Forth bridges for orbits, then returning to East Fortune' });
    if (x) {
      await s.atc(`{CALL}, Basic Service, squawk ${squawk}, remain outside controlled airspace`, {
        readback: [BASIC(), SQUAWK(squawk), ROS()], model: `Basic Service, squawk ${squawk}, remain outside controlled airspace, {CALL}` });
      await useSquawk(s, squawk);
    } else {
      await s.atc('{CALL}, Basic Service, remain outside controlled airspace, report approaching Musselburgh', {
        readback: [BASIC(), ROS(), WILCO()], model: 'Basic Service, remain outside controlled airspace, wilco, {CALL}' });
      await s.reach(Math.max(s.position().s + 0.3, at('Musselburgh') - 2), { label: 'Towards Musselburgh', early: true });
      await s.expect({ id: 'approaching', cue: 'Approaching Musselburgh, still outside the zone.', nudge: '{CALL}, report your position',
        items: [named('Musselburgh')], model: `{CALL}, approaching Musselburgh, altitude ${ALTITUDE} feet` });
    }
    await s.reach(Math.max(s.position().s + 0.3, T.sIn - 2.5), { label: 'Towards Musselburgh' });
    const ident = x ? '{CALL}, identified. ' : '{CALL}, ';
    await s.atc(`${ident}Cleared to enter the Edinburgh control zone via Musselburgh, VFR, not above altitude 2000 feet, Edinburgh QNH ${qnh}. Report Musselburgh`, {
      clearance: true,
      readback: [P('cleared to enter', ['cleared to enter', 'cleared into', 'cleared'], { fix: 'cleared to enter the Edinburgh control zone via Musselburgh' }),
        P('control zone', ['control zone', 'zone'], { soft: true }), named('Musselburgh', 'via Musselburgh'),
        P('VFR', ['vfr'], { fix: 'VFR' }), ...NOT_ABOVE(2000), QNH(qnh), WILCO()],
      model: `Cleared to enter the Edinburgh control zone via Musselburgh, VFR, not above altitude 2000 feet, QNH ${qnh}, wilco, {CALL}` });
    s.hold(null);
    s.setRadio({ qnh });

    // ---------- across the city to the bridges ----------
    const svc = x ? 'radar control service' : 'control service';
    await s.reach(at('Musselburgh'), { label: 'Musselburgh', early: true });
    await s.expect({ id: 'report-musselburgh', cue: 'Musselburgh.', nudge: '{CALL}, report your position', items: [named('Musselburgh')], model: '{CALL}, Musselburgh' });
    await s.atc(`{CALL}, roger, ${svc}, route via Arthur's Seat to the Forth bridges, report Arthur's Seat`, {
      readback: [P('control service', ['control service'], { fix: svc }), named("Arthur's Seat", "route via Arthur's Seat"), WILCO()],
      model: `${svc[0].toUpperCase() + svc.slice(1)}, via Arthur's Seat to the Forth bridges, wilco, {CALL}` });
    await s.reach(at("Arthur's Seat"), { label: "Arthur's Seat", early: true });
    await s.expect({ id: 'report-arthurs-seat', cue: "Arthur's Seat.", nudge: '{CALL}, report your position', items: [named("Arthur's Seat")], model: "{CALL}, Arthur's Seat" });
    await s.atc('{CALL}, roger, pass north of the runway 24 threshold, report overhead', {
      readback: [P('north of the threshold', ['north of the threshold', 'north of the 24 threshold', 'threshold', 'north of'], { fix: 'pass north of the runway 24 threshold' }),
        P('runway 24', ['24'], { soft: true }), WILCO()],
      model: 'North of the runway 24 threshold, wilco, {CALL}' });
    if (s.chance(0.6)) {
      await s.reach(Math.max(s.position().s + 0.5, at('Runway 24 threshold') - 3), { label: 'Across the city' });
      await s.atc(`{CALL}, traffic, ${s.pick(['ten', 'eleven', 'one', 'two'])} o'clock, 3 miles, an Embraer on final for runway 24, indicating 1200 feet`, {
        readback: [P('acknowledged', ['looking', 'traffic in sight', 'in sight', 'visual', 'negative contact'],
          { why: 'Answer traffic information with “looking”, “traffic in sight” or “negative contact”.' })],
        model: 'Traffic in sight, {CALL}' });
    }
    await s.reach(at('Runway 24 threshold'), { label: 'North of the runway 24 threshold', early: true });
    await s.expect({ id: 'report-overhead', cue: 'Passing north of the runway 24 threshold.', nudge: '{CALL}, report your position',
      items: [P('overhead', ['overhead', 'threshold', 'north of', 'passing'])], model: '{CALL}, overhead, north of the 24 threshold' });
    await s.atc('{CALL}, roger, report approaching the bridges', { readback: [WILCO()], model: 'Wilco, {CALL}' });
    await s.reach(Math.max(s.position().s + 0.3, at('Forth Road Bridge') - 1), { label: 'Towards the Forth bridges', early: true });
    await s.expect({ id: 'approaching-bridges', cue: 'Approaching the bridges. Ask for your orbits.', nudge: '{CALL}, report your position',
      items: [P('the bridges', ['bridge', 'bridges', 'forth', 'crossing']),
        P('orbits', ['orbit', 'orbits'], { soft: true, why: 'Ask for what you want: orbits over the bridges.' })],
      model: '{CALL}, approaching the Forth bridges, request orbits over the bridges' });
    await s.atc('{CALL}, left-hand orbits over the Forth bridges approved, not above altitude 2000 feet, report finished at the bridges', {
      readback: [P('orbits', ['orbit', 'orbits'], { fix: 'left-hand orbits over the Forth bridges approved' }), ...NOT_ABOVE(2000), WILCO()],
      model: 'Left-hand orbits over the bridges, not above altitude 2000 feet, wilco, {CALL}' });

    // ---------- the orbits ----------
    await s.reach(at('Forth Road Bridge'), { label: 'The Forth bridges' });
    await s.action({ id: 'orbit', action: 'orbit', value: true, cue: 'Orbit the bridges: press Orbit on the map.',
      done: () => s.orbiting(), nudge: '{CALL}, confirm orbiting the bridges', timeout: 20 });
    // Five rate-one orbits is ten minutes. The leg ends the moment you call, and Skip ahead works too.
    await s.leg('Orbiting the bridges', ctx.speedKt * 10 / 60, { early: true,
      cue: 'The Forth Bridge, the Road Bridge and the Queensferry Crossing. Call “finished at the bridges” when you have had enough.' });
    await s.expect({ id: 'finished', cue: 'Report finished at the bridges.', nudge: '{CALL}, say intentions',
      items: [P('finished', ['finished', 'complete', 'ready', 'done'])], model: '{CALL}, finished at the bridges' });
    // Then, as on the day: hold where you are, and back via the overhead when there is a gap in the traffic.
    await s.atc('{CALL}, roger, hold at the bridges', {
      readback: [P('hold', ['hold', 'holding', 'orbit'], { fix: 'hold at the bridges' })], model: 'Hold at the bridges, {CALL}' });
    await s.leg('Holding at the bridges', ctx.speedKt * 2 / 60, { cue: 'Keep orbiting: they are fitting you in between arrivals.' });
    await s.atc('{CALL}, route to the overhead, pass north of the runway 24 threshold, not above altitude 2000 feet, report overhead', {
      readback: [P('the overhead', ['overhead'], { fix: 'route to the overhead' }), P('north of the threshold', ['north of the threshold', 'north of the 24 threshold', 'threshold', 'north of'], { fix: 'pass north of the runway 24 threshold' }),
        P('runway 24', ['24'], { soft: true }), ...NOT_ABOVE(2000), WILCO()],
      model: 'To the overhead, north of the runway 24 threshold, not above altitude 2000 feet, wilco, {CALL}' });
    await s.action({ id: 'orbit-stop', action: 'orbit', value: false, cue: 'Stop orbiting: press Orbit again.',
      done: () => !s.orbiting(), nudge: '{CALL}, confirm routing to the overhead', timeout: 15 });
    await s.reach(at('Runway 24 threshold', 1), { label: 'North of the runway 24 threshold', early: true });
    await s.expect({ id: 'report-overhead-2', cue: 'Passing north of the runway 24 threshold.', nudge: '{CALL}, report your position',
      items: [P('overhead', ['overhead', 'threshold', 'north of', 'passing'])], model: '{CALL}, overhead, north of the 24 threshold' });
    await s.atc(`{CALL}, roger, route via Arthur's Seat and Musselburgh, leave the zone east, not above altitude 2000 feet, report leaving controlled airspace`, {
      readback: [named("Arthur's Seat", "route via Arthur's Seat and Musselburgh"), named('Musselburgh', "route via Arthur's Seat and Musselburgh"),
        P('leave the zone', ['leave the zone', 'leave', 'leaving'], { fix: 'leave the zone east' }), ...NOT_ABOVE(2000), WILCO()],
      model: "Via Arthur's Seat and Musselburgh, leave the zone east, not above altitude 2000 feet, wilco, {CALL}" });

    // ---------- back out ----------
    await s.reach(Math.min(PLAN.total, T.sOut + 0.1), { label: 'Controlled airspace boundary', early: true });
    await s.expect({ id: 'leaving', cue: 'Leaving controlled airspace.', nudge: '{CALL}, report your position',
      items: [P('leaving controlled airspace', ['leaving controlled airspace', 'leaving the zone', 'clear of controlled airspace', 'leaving', 'clear of the zone', 'clear'])],
      model: '{CALL}, leaving controlled airspace' });
    await s.atc('{CALL}, roger, clear of controlled airspace, Basic Service, report changing frequency', {
      readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
    await s.reach(Math.max(s.position().s + 0.3, PLAN.total - 5), { label: 'Towards East Fortune', early: true });
    const asked = await s.expect({ id: 'qsy', cue: 'Coming up on East Fortune. Ask to leave the frequency.', nudge: '{CALL}, say intentions',
      items: [P('changing frequency', ['changing', 'frequency', 'east fortune'])],
      model: '{CALL}, request frequency change to East Fortune 118.755' });
    const f = asked && (asked.norm.match(/\b1\d\d\.\d+\b/) || [])[0];
    if (f && f !== '118.755') s.note(`East Fortune is 118.755, and you said ${f}.`);
    if (asked) {
      await s.atc(x ? '{CALL}, squawk 7000, frequency change approved, good day' : '{CALL}, frequency change approved, good day', {
        readback: [...(x ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing'], { soft: true })],
        model: (x ? 'Squawk 7000, ' : '') + 'frequency change approved, {CALL}' });
    } else {
      await s.atc(x ? '{CALL}, Basic Service terminated, squawk 7000' : '{CALL}, Basic Service terminated', { reply: TERMINATED_ACK(x) });
    }
    await useSquawk(s, '7000', { chase: false });

    // ---------- home: East Fortune ----------
    ctx.unit = 'East Fortune Radio'; ctx.abbreviated = false; ctx.blind = !staffed;
    s.setRadio({ unit: 'East Fortune Radio', freq: '118.755' });
    await s.expect({ id: 'rejoin', cue: 'Call East Fortune.', items: [...ef, P('rejoining', ['rejoin', 'rejoining', 'join', 'inbound', 'overhead', 'airfield information'])],
      model: staffed ? `East Fortune Radio, {CS}, 5 miles west, altitude ${ALTITUDE} feet, rejoining, request airfield information`
        : `East Fortune Traffic, {CS}, 5 miles west, joining overhead for runway ${rwy}, East Fortune` });
    if (staffed) {
      await s.atc(`{CALL}, East Fortune Radio, runway ${rwy} ${hand}, QFE ${qfe}, no reported traffic`, {
        readback: [runwayItem, QNH(qfe, 'QFE')], model: `Runway ${rwy}, QFE ${qfe}, joining overhead, {CALL}` });
    }
    await s.reach(PLAN.total, { label: 'East Fortune', early: true });
    await s.expect({ id: 'overhead', cue: 'Overhead at 2000 ft QFE.', items: [...ef, P('overhead', ['overhead'])],
      model: staffed ? `{CALL}, overhead, descending deadside for runway ${rwy}` : `East Fortune Traffic, {CS}, overhead, descending deadside for runway ${rwy}, East Fortune` });
    await efAck();
    await s.leg('Deadside and crosswind', 1.5, { early: true });
    await s.expect({ id: 'downwind', cue: `Downwind for ${rwy}.`, items: [...ef, P('downwind', ['downwind']), P('runway', [num], { soft: true })],
      model: staffed ? `{CALL}, downwind ${rwy}` : `East Fortune Traffic, {CS}, downwind ${rwy}, East Fortune` });
    await efAck();
    await s.leg('Base leg', 1.2, { early: true });
    await s.expect({ id: 'final', cue: `Final ${rwy}.`, items: [...ef, P('final', ['final']), P('runway', [num], { soft: true })],
      model: staffed ? `{CALL}, final ${rwy}` : `East Fortune Traffic, {CS}, final ${rwy}, East Fortune` });
    if (staffed) await efSays(`{CALL}, roger, ${wind}`, 'final-ack');
    await s.leg('Landing', 0.5, { early: true });
    await s.expect({ id: 'vacated', cue: 'Landed and clear of the runway.', items: [...ef, P('vacated', ['vacated', 'clear of the runway', 'runway clear', 'clear of'])],
      model: staffed ? '{CALL}, runway vacated' : `East Fortune Traffic, {CS}, runway vacated, East Fortune` });
    if (staffed) await efAck();
    s.end(staffed ? 'Home: the Forth bridges and back' : 'Home: the Forth bridges and back, on blind calls');
  },
};
