// Your own route through an area. The route plan (js/route.js) decides where you enter and leave controlled
// airspace and what you report; this turns it into a zone transit, or a Basic Service flight round the outside,
// with the same readback checks and surprises as the scripted scenarios.
// Change the route in flight (the map's Direct to / Divert) and the controller picks up from wherever the flight
// has got to: tell them, and they re-clear you or carry on with a Basic Service. Cleared inside controlled
// airspace, you ask first and the aircraft keeps to the clearance until they approve.
import { P, WILCO, QNH, SQUAWK, BASIC, NOT_ABOVE, ROS, RESUME, TRAFFIC_ACK, TERMINATED_ACK, details, initialCall, useSquawk } from './common.js';
import { planRoute, reroutePoints, presentPosition, routeText, whereIs } from '../route.js';
import { miles } from '../geo.js';

const said = p => (p.hear && p.hear[0]) || p.name.toLowerCase();
const named = (p, fix, o = {}) => P(p.name, p.hear || [said(p)], { fix, ...o });
const octal = rng => String(Math.floor(rng() * 8));
const cap = t => t[0].toUpperCase() + t.slice(1);
/** What you are asking to cross: the zone only when it really is the CTR. */
const transitWords = T => (T.intoZone ? 'zone transit' : 'transit through your controlled airspace');
const TRAFFIC = ['a Cessna 172', 'a PA28', 'a C42 microlight', 'a helicopter', 'a Robin', 'a glider'];
const SIDES = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
// Traffic information as CAP 413 has it: position by clock code, distance, what it is doing relative to you,
// what it is, and its level — or honestly that there is none. Spelled in words so the synthesiser says
// "eleven o'clock" instead of reading out a number.
const CLOCK = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const CROSSING = ['crossing left to right', 'crossing right to left', 'opposite direction', 'same direction', 'manoeuvring'];

/** Build a scenario for `points` (area places) at `altitude`. Throws with the plan's first error if it can't be flown. */
export function customScenario(area, { points, altitude }, { rng = Math.random } = {}) {
  const planned = planRoute(area, points, altitude);
  if (planned.errors.length) throw new Error(planned.errors[0]);
  let plan = planned;                                                // the plan being flown; a change of route replaces it
  const first = points[0];
  const q0 = 1006 + Math.floor(rng() * 18);                          // what you set before you call
  const q1 = rng() < 0.4 ? q0 + (rng() < 0.5 ? 1 : -1) : q0;         // what ATC gives you
  const squawk = area.squawks + octal(rng) + octal(rng);
  const notAbove = Math.ceil(altitude / 500) * 500;
  // The VRPs on the way, in the order you pass them. Every one in the area made a paragraph of names on a phone, most of
  // them nowhere near the route.
  const vrps = area.places.filter(p => p.kind === 'vrp').map(p => ({ p, n: planned.nearestS?.(p) }))
    .filter(v => v.n && v.n.d <= 5).sort((a, b) => a.n.s - b.n.s).map(v => v.p.name).join(', ');
  // How far the flight has got, so a change of route can pick up from there.
  const st = { service: false, approaching: null, report: null, identified: false, cleared: false, controlSaid: false,
    left: false, refused: false, qnhNoted: false };
  let qnh = q1;

  const destination = P0 => P0.points[P0.points.length - 1].place;
  const planFrom = (pos, pts) => {
    const next = planRoute(area, [presentPosition(pos), ...pts], altitude, { midFlight: true });
    if (next.errors.length) throw new Error(next.errors[0]);
    return next;
  };
  const insideNow = (P0, s) => P0.cas.some(c => s >= c.s0 - 0.05 && s <= c.s1 + 0.05);
  const nextWaypoint = (s, P0) => P0.points.find(w => w.s > s.position().s + 1 && w.s < P0.total - 2 && w.place.kind !== 'position') || null;

  function briefing(ctx) {
    const T = planned.transit;
    const mins = Math.round(planned.total / ctx.speedKt * 60);
    const base = v => v.base ? `from ${v.base} ft` : 'from the surface';
    return [
      ['Aircraft', `${ctx.reg}, ${ctx.type}, ${ctx.transponder ? 'Mode S' : 'no transponder'}, 1 POB.`],
      ['Flight', `${first.name} to ${destination(planned).name}, VFR.`],
      ['Route', `${routeText(points)} · ${Math.round(planned.total)} nm · about ${mins} min at ${ctx.speedKt} kt`],
      ['Level', `Altitude ${altitude} ft, QNH ${q0}.`],
      T ? ['Transit', `You reach ${T.entryVolume.name} (Class ${T.entryVolume.cls}, ${base(T.entryVolume)}) after ${Math.round(T.sIn)} nm, and leave controlled airspace to the ${T.exitSide} after ${Math.round(T.sOut)} nm.`]
        : ['Airspace', `At ${altitude} ft the route stays outside controlled airspace, ${miles(planned.closest.d)} from ${planned.closest.volume.name} at the closest.`],
      ['Ask for', T ? `A Basic Service from ${area.unit}, and ${T.intoZone ? 'a zone transit' : 'a transit through their controlled airspace'}.` : `A Basic Service from ${area.unit}.`],
      ...planned.under.map(u => ['Careful', `You pass under ${u.volume.name}: its base is ${u.volume.base} ft, only ${u.gap} ft above you.`, 'warn']),
      ...planned.warnings.map(w => ['Careful', w, 'warn']),
      vrps ? ['VRPs', `${vrps}.`] : null,
      vrps ? ['VRPs', 'They’re reporting references: pass near them rather than overhead.'] : null,
      ...area.facts.map(f => ['Local', f]),
      T ? ['Plan B', 'If the transit is refused, route round remaining outside controlled airspace: tap a place on the map, then Direct to or Divert.'] : null,
    ].filter(Boolean);
  }

  // Fly on to `target`, dealing with any surprises scheduled before it.
  // `early`: the leg ends with a call of yours, so a call made a little before the point is kept for it.
  async function flyTo(s, target, label, surprises = [], { early = false } = {}) {
    for (const ev of surprises.filter(e => !e.done && e.at < target).sort((a, b) => a.at - b.at)) {
      await s.reach(ev.at, { label });
      ev.done = true;
      await ev.run(s);
    }
    await s.reach(target, { label, early });
  }

  function surprisesInZone(s, from, to, nextReport) {
    const at = () => from + (to - from) * s.pick([0.25, 0.4, 0.55, 0.7]);
    const list = [];
    if (s.chance(0.45)) list.push({ at: at(), run: orbit(nextReport) });
    if (s.chance(0.6)) list.push({ at: at(), run: traffic });
    if (s.chance(0.3)) list.push({ at: at(), run: qnhChange });
    return list;
  }

  const orbit = nextReport => async s => {
    await s.atc('{CALL}, orbit left at present position, due inbound traffic', {
      readback: [P('orbit left', ['orbit left'], { fix: 'orbit left at present position' }), P('present position', ['present position'], { soft: true })],
      model: 'Orbit left at present position, {CALL}' });
    const orbiting = await s.action({ id: 'orbit', action: 'orbit', value: true, cue: 'Orbit left: press Orbit on the map.',
      done: () => s.orbiting(), nudge: '{CALL}, confirm orbiting left', timeout: 15 });
    await s.leg('Orbiting', s.ctx.speedKt * 2 / 60, { cue: orbiting ? 'Orbit left and keep listening.' : 'ATC believes you are orbiting.' });
    const to = nextReport();
    await s.atc(`{CALL}, resume own navigation${to ? ` to ${to.name}` : ''}`, {
      readback: [RESUME(), ...(to ? [named(to, `resume own navigation to ${to.name}`)] : [])],
      model: `Resume own navigation${to ? ` to ${to.name}` : ''}, {CALL}` });
    await s.action({ id: 'orbit-resume', action: 'orbit', value: false, cue: 'Stop orbiting: press Orbit again.',
      done: () => !s.orbiting(), nudge: '{CALL}, confirm resuming own navigation', timeout: 15 });
  };
  const traffic = async s => {
    const level = s.chance(0.2) ? 'no height information'
      : s.chance(0.3) ? 'similar level'
      : `indicating ${s.pick([200, 300, 500])} feet ${s.pick(['above', 'below'])}`;
    const what = s.chance(0.25) ? 'type unknown' : s.pick(TRAFFIC);
    await s.atc(`{CALL}, traffic, ${s.pick(CLOCK)} o'clock, ${s.pick([1, 2, 3, 4, 5])} miles, ${s.pick(CROSSING)}, ${what}, ${level}`, {
      readback: [TRAFFIC_ACK()], model: 'Looking, {CALL}  … then: Traffic in sight, {CALL}' });
  };
  const qnhChange = async s => {
    qnh += s.pick([-1, 1]);
    s.ctx.qnh = qnh;
    await s.atc(`{CALL}, ${area.qnhName} now ${qnh}`, { readback: [QNH(qnh)], model: `QNH ${qnh}, {CALL}` });
    s.setRadio({ qnh });
  };

  // The last few miles. The service runs on until you ask to leave it: a controller does not approve a
  // frequency change nobody asked for, and SAFETYCOM is only usable within 10 nm of where you are landing.
  async function runHome(s, P0, summary) {
    const end = Math.max(s.position().s + 0.3, P0.total - 5);
    await s.reach(end, { label: `Towards ${destination(P0).name}`, early: true });   // ask when you are ready
    return leaveFrequency(s, summary);
  }

  // The pilot asks to go and the controller lets them. If they never ask, nothing is approved: the service is
  // terminated instead, which is what a controller does with an aircraft that has gone quiet on them.
  // `asked` is the request already made, when it came in place of another call (see rejoin).
  async function leaveFrequency(s, summary, asked) {
    const x = s.ctx.transponder, to = destination(plan).name;
    if (asked === undefined) asked = await s.expect({ ...qsyCall(s), cue: `Coming up on ${to}. Ask to leave the frequency.`, nudge: '{CALL}, say intentions' });
    // SafetyCom moved from 135.475 to 135.480 with 8.33 kHz spacing, and near misses are common. A controller
    // will not correct a frequency that is not theirs, so the debrief does.
    const f = asked && (asked.norm.match(/\b135\.4\d*\b/) || [])[0];
    if (f && f !== '135.48') s.note(`SafetyCom is 135.480, and you said ${Number(f).toFixed(3)}. The controller will not correct a frequency that is not theirs.`);
    if (!asked) {
      await s.atc(x ? '{CALL}, Basic Service terminated, squawk 7000' : '{CALL}, Basic Service terminated', { reply: TERMINATED_ACK(x) });
      s.note('The controller terminated the service rather than approving a frequency change: you never asked for one.');
    } else {
      await s.atc(x ? '{CALL}, squawk 7000, frequency change approved' : '{CALL}, frequency change approved', {
        readback: [...(x ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing'], { soft: true })],
        model: (x ? 'Squawk 7000, ' : '') + 'frequency change approved, {CALL}' });
    }
    await useSquawk(s, '7000', { chase: false });
    s.end(summary);
  }

  function qsyCall(s) {
    return { id: 'qsy', items: [P('changing frequency', ['changing', 'frequency', 'leaving your frequency', 'request frequency change', 'safetycom'])],
      model: `{CALL}, ${miles(Math.max(1, plan.total - s.position().s))} from ${destination(plan).name}, request frequency change` };
  }

  // ---------- the flight, phase by phase ----------

  // From the start of a plan, before you've called anyone.
  async function begin(s, P0) {
    const T = P0.transit;
    // Not in without a clearance, whether or not you have called yet: leave it late and you orbit at the edge,
    // as you would have to in the air. It used to hold only after the first call, so a late one flew straight in.
    if (T) s.hold(Math.max(s.position().s, T.sIn - 1), 'Holding outside: no clearance yet');
    await s.reach(T ? Math.max(0.5, T.sIn - 10) : Math.min(1.5, P0.total / 4), { label: `${area.unit} ${area.freq}`,
      cue: T ? `Listen to the frequency, then call ${area.unit} when there is a gap.` : `Call ${area.unit} for a Basic Service.` });
    const { ctx } = s, here = whereIs(area, s.position()), via = T && T.via && T.via.place;
    // "Zone" means the control zone and nothing else. Ask for a zone transit only when the CTR is what you are
    // crossing; for a CTA it is controlled airspace, and calling that "the zone" is how pilots come unstuck.
    const request = T ? `request Basic Service and ${transitWords(T)}` : 'request Basic Service';
    const asked = request + (via ? ` via ${via.name}` : '');           // the routing belongs in the details call
    const det = details(ctx, { from: said(first), to: said(destination(P0)), position: [...here.hear, 'miles', 'overhead'], altitude,
      request: T ? ['transit', 'zone transit', 'crossing', 'cross'] : ['basic service'] });
    const init = await initialCall(s, { unitName: area.unit, det,
      requestItems: T ? [P('request', ['transit', 'basic service', 'zone', 'request'], { soft: true, why: 'State your request on first contact.' })]
        : [P('request basic service', ['basic service'], { soft: true, why: 'Ask for the service by name on first contact.' })],
      model: `${area.unit}, {CS}, ${request}`,
      detailsModel: `{CS}, {TYPE}, ${first.name} to ${destination(P0).name}, ${here.text}, altitude ${altitude} feet, QNH ${q0}, VFR, ${ctx.transponder ? '' : 'no transponder, '}${asked}` });
    await service(s, P0, { noXpdrSaid: !!init && init.items.some(i => i.key === 'noxpdr' && i.matched) });
    return T ? approach(s, P0) : outside(s, P0);
  }

  // Basic Service, and a squawk (or, without a transponder, something to report).
  async function service(s, P0, { noXpdrSaid = false } = {}) {
    const { ctx } = s, T = P0.transit;
    if (T) s.hold(Math.max(s.position().s, T.sIn - 1), 'Holding for your clearance');   // not in without one
    const outside = T ? ', remain outside controlled airspace' : '';
    if (ctx.transponder) {
      await s.atc(`{CALL}, Basic Service, squawk ${squawk}${outside}`, {
        readback: [BASIC(), SQUAWK(squawk), ...(T ? [ROS()] : [])], model: `Basic Service, squawk ${squawk}${outside}, {CALL}` });
      await useSquawk(s, squawk);
    } else if (T) {
      if (!noXpdrSaid) {
        await s.atc('{CALL}, confirm you are not transponder equipped', { reply: { id: 'xpdr', timeout: 12,
          items: [P('affirm', ['affirm', 'no transponder', 'not transponder', 'negative transponder', 'correct', 'not equipped'])], model: 'Affirm, no transponder, {CALL}' } });
      }
      const A = whereIs(area, P0.posAt(Math.max(0, T.sIn - 2))).place || P0.points[1].place;
      await s.atc(`{CALL}, Basic Service, remain outside controlled airspace, report approaching ${A.name}`, {
        readback: [BASIC(), ROS(), WILCO()], model: 'Basic Service, remain outside controlled airspace, wilco, {CALL}' });
      st.approaching = A;
    } else {
      const next = nextWaypoint(s, P0);
      await s.atc(`{CALL}, Basic Service${next ? `, report ${next.place.name}` : ''}`, {
        readback: [BASIC(), ...(next ? [WILCO()] : [])], model: `Basic Service${next ? ', wilco' : ''}, {CALL}` });
      st.report = next && next.place;
    }
    st.service = true;
  }

  // Heading for controlled airspace, not cleared yet: report approaching, perhaps wait or be refused, then the clearance.
  async function approach(s, P0) {
    const { ctx } = s, T = P0.transit, A = st.approaching;
    s.hold(Math.max(s.position().s, T.sIn - 1), 'Holding for your clearance');
    await s.reach(Math.max(s.position().s + 0.3, T.sIn - 2.5), { label: A ? `Towards ${A.name}` : 'Towards controlled airspace',
      early: !ctx.transponder && !!A });                                  // then you report approaching
    if (!ctx.transponder && A) {
      st.approaching = null;
      await s.expect({ id: 'approaching', cue: `Approaching ${A.name}, still outside controlled airspace.`, nudge: '{CALL}, report your position',
        items: [named(A)], model: `{CALL}, approaching ${A.name}, altitude ${altitude} feet` });
    }
    if (s.chance((ctx.transponder ? 0.15 : 0.35) + s.settings.refusalBias)) return refusal(s, T);
    if (s.chance(0.3)) {
      await s.atc(`{CALL}, expect ${T.intoZone ? 'zone entry' : 'entry into controlled airspace'} in 5 minutes due inbound traffic, remain outside controlled airspace`, {
        readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
      await s.leg('Holding outside controlled airspace', ctx.speedKt * 4 / 60, { cue: 'Orbit outside controlled airspace and listen out.' });
    }
    if (!await clearance(s, P0)) return notReadBack(s);
    return through(s, P0, T.reports);
  }

  // Returns false when the clearance was never read back, even after "how do you read?". Then it never took effect.
  async function clearance(s, P0) {
    const { ctx } = s, T = P0.transit, via = T.via && T.via.place;
    const zone = T.intoZone ? area.zone : 'controlled airspace';
    const routed = T.reports.map(r => r.place).slice(0, 3);
    const viaText = via ? ` via ${via.name}` : '';
    const ident = ctx.transponder && !st.identified ? `{CALL}, identified ${whereIs(area, s.position()).text}. ` : '{CALL}, ';
    const routeFix = `route ${routed.map(p => p.name).join(', ')}`;
    const rb = await s.atc(`${ident}Cleared to enter ${zone}${viaText}, VFR, not above altitude ${notAbove} feet, ${area.qnhName} ${qnh}.` +
      (routed.length > 1 ? ` Route ${routed.map(p => p.name).join(', ')}.` : '') + ` Report ${routed.length ? routed[0].name : 'leaving controlled airspace'}`, {
      clearance: true,
      readback: [
        P('cleared to enter', ['cleared to enter', 'cleared into', 'cleared'], { fix: `cleared to enter ${zone}${viaText}` }),
        P(T.intoZone ? 'control zone' : 'controlled airspace', T.intoZone ? ['control zone', 'zone', 'controlled airspace'] : ['controlled airspace'], { soft: true }),
        ...(via ? [named(via, `via ${via.name}`)] : []),
        P('VFR', ['vfr'], { fix: 'VFR' }),
        ...NOT_ABOVE(notAbove),
        QNH(qnh),
        ...(routed.length > 1 ? routed.filter(p => p !== via).map(p => P(`route ${p.name}`, p.hear || [said(p)], { fix: routeFix })) : []),
        WILCO(),
      ],
      model: `Cleared to enter ${zone}${viaText}, VFR, not above altitude ${notAbove} feet, QNH ${qnh}${routed.length > 1 ? `, ${routeFix}` : ''}, wilco, {CALL}` });
    if (rb?.failed) return false;
    st.identified = st.identified || ctx.transponder;
    st.cleared = true;
    st.left = false;                          // cleared in again: a change of route inside needs approval once more
    s.hold(null);
    s.setRadio({ qnh });
    if (qnh !== q0 && !st.qnhNoted) { st.qnhNoted = true; s.note(`QNH changed from ${q0} to ${qnh} in the clearance: the altimeter should be reset.`); }
    return true;
  }

  // A clearance nobody acknowledged isn't one, so the aircraft stays outside: it used to fly in all the same.
  async function notReadBack(s) {
    s.note('The clearance was never read back, so it never took effect: you stayed outside controlled airspace.');
    await s.leg('Holding outside controlled airspace', 3, { cue: 'No clearance read back: stay outside controlled airspace.', early: true });
    return leaveFrequency(s, 'No clearance read back: stayed outside');
  }

  // Cleared: report each of R (the plan's reports, { place, s }) in turn, then leave controlled airspace and the
  // frequency. Each is cued at its own point. Looked up by place, a place flown past twice (out and back) cued both
  // reports at the second visit: the first came 18 nm late, and one made on time drew "say again".
  async function through(s, P0, R) {
    const { ctx } = s, T = P0.transit;
    let i = 0;
    const from = Math.max(s.position().s, T.sIn + 0.2), to = T.sOut - 0.3;
    const surprises = to > from ? surprisesInZone(s, from, to, () => R[i]?.place || null) : [];
    for (; i < R.length; i++) {
      const r = R[i].place, visit = R.slice(0, i).filter(x => x.place === r).length;
      await flyTo(s, R[i].s, r.name, surprises, { early: true });
      await s.expect({ id: `report-${r.id}${visit ? `-${visit + 1}` : ''}`, cue: `${r.name}.`, nudge: '{CALL}, report your position', items: [named(r)], model: `{CALL}, ${r.name}` });
      const svc = st.controlSaid ? '' : `${ctx.transponder ? 'radar ' : ''}control service`;
      const svcItems = svc ? [P('control service', ['control service'], { fix: svc })] : [];
      const lead = svc ? `${svc}, ` : '', Lead = svc ? `${cap(svc)}, ` : '';
      if (i < R.length - 1) {
        await s.atc(`{CALL}, roger, ${lead}report ${R[i + 1].place.name}`, { readback: [...svcItems, WILCO()], model: `${Lead}wilco, {CALL}` });
      } else if (T.leaveDirect) {
        await s.atc(`{CALL}, roger, ${lead}route direct ${T.leaveDirect.name}, report leaving controlled airspace`, {
          readback: [...svcItems, named(T.leaveDirect, `route direct ${T.leaveDirect.name}`), WILCO()],
          model: `${Lead}direct ${T.leaveDirect.name}, wilco, {CALL}` });
      } else {
        const leave = T.exitVolume.kind === 'CTR' ? 'leave the zone' : 'leave controlled airspace';
        await s.atc(`{CALL}, roger, ${lead}${leave} ${T.exitSide}, not above altitude ${notAbove} feet, report leaving controlled airspace`, {
          readback: [...svcItems, P(leave, ['leave the zone', 'leave controlled airspace', 'leave', 'leaving'], { fix: `${leave} ${T.exitSide}` }),
            P(T.exitSide, [T.exitSide], { fix: `${leave} ${T.exitSide}` }), ...NOT_ABOVE(notAbove), WILCO()],
          model: `${Lead}${leave} ${T.exitSide}, not above altitude ${notAbove} feet, wilco, {CALL}` });
      }
      st.controlSaid = true;
    }
    // At the boundary: you report leaving as you leave. It waited 0.3 nm past the line, well after the whole
    // aircraft symbol had cleared it on the map. 0.1 keeps it just clear of insideNow()'s 0.05 margin.
    await flyTo(s, Math.min(P0.total, T.sOut + 0.1), 'Controlled airspace boundary', surprises, { early: true });
    await s.expect({ id: 'leaving', cue: 'Leaving controlled airspace.', nudge: '{CALL}, report your position',
      items: [P('leaving controlled airspace', ['leaving controlled airspace', 'leaving the zone', 'clear of controlled airspace', 'leaving', 'clear of the zone', 'clear'])],
      model: '{CALL}, leaving controlled airspace' });
    st.left = true;
    await s.atc('{CALL}, roger, clear of controlled airspace, Basic Service, report changing frequency', {
      readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
    return runHome(s, P0, 'Transit completed');
  }

  // "Zone" only when it is the CTR being crossed, as everywhere else: refused a CTA transit, you were told "negative zone
  // transit", and taught to answer "routing round the zone".
  async function refusal(s, T) {
    const round = T.intoZone ? 'the zone' : 'controlled airspace';
    await s.atc(`{CALL}, negative ${T.intoZone ? 'zone transit' : 'transit'} due traffic, remain outside controlled airspace`, {
      readback: [P('negative transit', ['negative'], { soft: true }), ROS()], model: 'Negative transit, remain outside controlled airspace, {CALL}' });
    await s.atc('{CALL}, confirm you will not enter controlled airspace', {
      readback: [
        P('affirm', ['affirm', 'will not enter', 'not enter', 'wilco', 'remaining outside', 'remain outside', 'will remain'], { fix: null }),
        P('controlled airspace', ['controlled airspace'], { substitutes: ['zone'], retry: '{CALL}, please confirm you will not enter controlled airspace',
          why: '“Zone” is the CTR only. The controller asked about controlled airspace, which includes the CTAs: answer in the same words.' }),
        P('new routing', ['routing', 'route', 'round', 'around', 'remaining outside', 'north', 'south', 'east', 'west', 'via'], { soft: true, why: 'Tell them your plan B so they know where you’re going.' }),
      ],
      model: `Affirm, will not enter controlled airspace, routing round ${round}, {CALL}` });
    st.refused = true;
    await s.atc('{CALL}, roger, Basic Service continues, report changing frequency', { readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
    s.hold(s.position().s, 'Holding outside controlled airspace');
    // Told to report changing frequency: asking to on the way round is that call. It went to Claude, or drew
    // "unable, continue as cleared" and then a service terminated because "you never asked".
    await s.leg(`Routing round ${round}`, 5, { cue: 'Plan B: pick a way round on the map (tap a place, then Direct to or Divert), remaining outside controlled airspace.', early: true });
    await leaveFrequency(s, 'Transit refused: routed round');
  }

  // Outside controlled airspace on a Basic Service: the odd report or traffic, then leave the frequency near the end.
  async function outside(s, P0) {
    const { ctx } = s;
    const end = Math.max(s.position().s + 0.5, P0.total - 5);    // ask to leave the frequency with a few miles to run
    const at = () => s.position().s + (end - s.position().s) * s.pick([0.3, 0.5, 0.7]);
    const surprises = [];
    if (s.chance(0.6)) surprises.push({ at: at(), run: traffic });
    if (s.chance(0.5)) surprises.push({ at: at(), run: async s2 => {
      await s2.atc(`{CALL}, ${area.unit}, report your position and altitude`, { reply: { id: 'posrep', timeout: 12,
        items: [P('position', ['miles', 'overhead', ...area.places.map(said)], { ask: '{CALL}, say position' }), P('altitude', ['feet', 'altitude'], { ask: '{CALL}, say altitude' })],
        model: `{CALL}, ${whereIs(area, s2.position()).text}, altitude ${altitude} feet` } });
      await s2.atc('{CALL}, roger');
    } });
    const close = P0.closest && P0.closest.d < 2 && P0.closest.s > s.position().s + 0.5 ? P0.closest : null;
    if (close) surprises.push({ at: Math.max(s.position().s + 0.3, close.s - 1), run: async s2 => {
      await s2.atc(`{CALL}, you are ${miles(close.d)} from controlled airspace, confirm you are remaining outside`, {
        readback: [P('affirm', ['affirm', 'remaining outside', 'will remain']),
          P('controlled airspace', ['controlled airspace'], { substitutes: ['zone'], retry: '{CALL}, confirm you are remaining outside controlled airspace',
            why: 'Answer with the controller’s words: “remaining outside controlled airspace”.' })],
        model: 'Affirm, remaining outside controlled airspace, {CALL}' });
    } });
    const report = st.report;
    st.report = null;
    const r = report && P0.nearestS(report);
    if (!ctx.transponder && r && r.d < 1.5 && r.s > s.position().s) {
      await flyTo(s, r.s, report.name, surprises, { early: true });
      await s.expect({ id: 'report', cue: `${report.name}.`, nudge: '{CALL}, report your position',
        items: [named(report)], model: `{CALL}, ${report.name}, altitude ${altitude} feet` });
      await s.atc('{CALL}, roger');
    }
    await flyTo(s, end, `Towards ${destination(P0).name}`, surprises, { early: true });
    await leaveFrequency(s, st.refused ? 'Transit refused: routed round' : 'Basic Service flight completed');
  }

  // ---------- a change of route in flight ----------

  /**
   * Called by the engine when you pick Direct to / Divert on the map. Throws if the new route can't be flown. Worked out
   * from the plan the engine is flying: off script, where this scenario's own record stops, a second change of route was
   * built on the first plan, and flew back to places already passed.
   */
  function routeChange({ s, pos, plan: flying = plan }, { action, place }) {
    const pts = reroutePoints(flying, s, action, place);
    return { plan: planFrom(pos, pts), points: pts, approval: st.cleared && !st.left && insideNow(flying, s) };
  }

  // You changed the route: pick up from wherever the flight has got to.
  async function rejoin(s, change) {
    const { ctx } = s, target = change.points[0];
    if (!s.said('initial')) { plan = change.plan; return begin(s, plan); }   // not talking to anyone yet: just fly it
    if (change.approval) {
      const asked = await s.expect({ id: 'reroute', cue: `Ask ${area.unit} for the new routing: in controlled airspace you need approval before you turn.`,
        items: [P('request', ['request'], { soft: true, why: 'Inside controlled airspace a change of route is a request: keep to your clearance until ATC approves it.' }),
          named(target, null, { ask: '{CALL}, say your routing' })],
        model: `{CALL}, request route direct ${target.name}` });
      const remaining = () => plan.transit.reports.filter(r => r.s > s.position().s + 0.1);
      if (!asked) { s.dropPending(); return through(s, plan, remaining()); }
      if (s.chance(0.15 + s.settings.refusalBias)) {
        await s.atc('{CALL}, unable due traffic, continue as cleared', {
          readback: [P('continue as cleared', ['continue as cleared', 'as cleared', 'continue'], { fix: 'continue as cleared' })], model: 'Continue as cleared, {CALL}' });
        s.dropPending();
        return through(s, plan, remaining());
      }
      const next = planFrom(s.position(), change.points);                   // from where you are now
      const R = next.transit ? next.transit.reports : [];
      await s.atc(`{CALL}, roger, route direct ${target.name}, ${R.length ? `report ${R[0].place.name}` : 'report leaving controlled airspace'}`, {
        readback: [named(target, `route direct ${target.name}`), WILCO()], model: `Direct ${target.name}, wilco, {CALL}` });
      plan = next;
      s.fly(next);
      return next.transit ? through(s, next, R) : outside(s, next);
    }

    plan = change.plan;                                                     // outside controlled airspace you've already turned
    const T = plan.transit;
    // Not in on the new route without a clearance for it: cleared for the old one, the aircraft flew in before the new
    // clearance came.
    if (T) s.hold(Math.max(s.position().s, T.sIn - 1), 'Holding for your clearance');
    // Told to report changing frequency (refused, or through and out), on a way round that stays outside: asking to
    // change frequency answers as well as telling them the new route. It went to Claude, after the app's own cue had
    // sent you to the map to pick that way round.
    const told = (st.refused || st.left) && (!T || st.refused);
    const reroute = await s.expect({ id: 'reroute', cue: `Tell ${area.unit} about your change of plan.`, nudge: '{CALL}, say intentions',
      items: [named(target, null, { ask: '{CALL}, say your routing' })], instead: told ? qsyCall(s) : null,
      model: T ? `{CALL}, change of plan, request ${transitWords(T)}, route direct ${target.name}`
        : `{CALL}, change of plan, routing direct ${target.name}, remaining outside controlled airspace` });
    if (reroute && reroute.instead) return leaveFrequency(s, st.refused ? 'Transit refused: routed round' : 'Transit completed', reroute);
    if (!st.service) await service(s, plan);
    if (T) {
      if (st.refused) {
        await s.atc('{CALL}, negative, remain outside controlled airspace', { readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
        await s.leg('Holding outside controlled airspace', 3, { cue: 'Still refused: pick a way round that stays outside controlled airspace.', early: true });
        return leaveFrequency(s, 'Transit refused: routed round');
      }
      if (st.cleared) {                                                     // cleared but not in yet: a new clearance for the new way in
        st.cleared = false;
        if (!await clearance(s, plan)) return notReadBack(s);
        return through(s, plan, T.reports);
      }
      await s.atc('{CALL}, roger, remain outside controlled airspace', { readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
      return approach(s, plan);
    }
    const wasCleared = st.cleared;                                          // the new route stays outside
    st.cleared = false;
    const next = !ctx.transponder ? nextWaypoint(s, plan) : null;
    const words = [wasCleared ? 'remain outside controlled airspace' : '', next ? `report ${next.place.name}` : ''].filter(Boolean);
    await s.atc(`{CALL}, roger${words.length ? `, ${words.join(', ')}` : ''}`, {
      readback: words.length ? [...(wasCleared ? [ROS()] : []), ...(next ? [WILCO()] : [])] : null,   // a bare "roger" needs no reply
      model: words.length ? `${cap(words.join(', ')).replace(/report [^,]+$/, 'wilco')}, {CALL}` : '{CALL}' });
    st.report = next && next.place;
    return outside(s, plan);
  }

  return {
    id: `custom-${area.id}`, custom: area.id,
    title: `${area.name}: ${first.name} to ${destination(planned).name}`,
    subtitle: routeText(points, altitude),
    unit: area.unit, freq: area.freq,
    traffic: area.traffic, places: area.places, pronounce: area.pronounce, plan: planned,
    briefing,
    where: p => whereIs(area, p).text,
    run: s => { s.fly(plan); s.ctx.qnh = q1; s.setRadio({ qnh: q0 }); return begin(s, plan); },
    routeChange,
    resume: rejoin,
  };
}
