// Your own route through an area. The route plan (js/route.js) decides where you enter and leave controlled
// airspace and what you report; this turns it into a zone transit, or a Basic Service flight round the outside,
// with the same readback checks and surprises as the scripted scenarios.
// Change the route in flight (the map's Direct to / Divert) and the controller picks up from wherever the flight
// has got to: tell them, and they re-clear you or carry on with a Basic Service. Cleared inside controlled
// airspace, you ask first and the aircraft keeps to the clearance until they approve.
import { P, WILCO, QNH, SQUAWK, BASIC, NOT_ABOVE, ROS, TRAFFIC_ACK, details, initialCall, useSquawk } from './common.js';
import { planRoute, reroutePoints, presentPosition, routeText, whereIs } from '../route.js';
import { miles } from '../geo.js';

const said = p => (p.hear && p.hear[0]) || p.name.toLowerCase();
const named = (p, fix, o = {}) => P(p.name, p.hear || [said(p)], { fix, ...o });
const octal = rng => String(Math.floor(rng() * 8));
const cap = t => t[0].toUpperCase() + t.slice(1);
/** What you are asking to cross: the zone only when it really is the CTR. */
const transitWords = T => (T.intoZone ? 'zone transit' : 'transit through your controlled airspace');
const TRAFFIC = ['a Cessna 172', 'a PA28', 'a C42 microlight', 'a helicopter', 'a Robin', 'a glider'];
const HEADINGS = ['northbound', 'southbound', 'eastbound', 'westbound'];
const SIDES = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

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
  const vrps = area.places.filter(p => p.kind === 'vrp').map(p => p.name).join(', ');
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
      ['VRPs', `${vrps}. They're reporting references: pass near them rather than overhead.`],
      ...area.facts.map(f => ['Local', f]),
      T ? ['Plan B', 'If the transit is refused, route round remaining outside controlled airspace: tap a place on the map, then Direct to or Divert.'] : null,
    ].filter(Boolean);
  }

  // Fly on to `target`, dealing with any surprises scheduled before it.
  async function flyTo(s, target, label, surprises = []) {
    for (const ev of surprises.filter(e => !e.done && e.at < target).sort((a, b) => a.at - b.at)) {
      await s.reach(ev.at, { label });
      ev.done = true;
      await ev.run(s);
    }
    await s.reach(target, { label });
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
      readback: [P('resume own navigation', ['resume own navigation', 'resume'], { fix: 'resume own navigation' }), ...(to ? [named(to, `resume own navigation to ${to.name}`)] : [])],
      model: `Resume own navigation${to ? ` to ${to.name}` : ''}, {CALL}` });
    await s.action({ id: 'orbit-resume', action: 'orbit', value: false, cue: 'Stop orbiting: press Orbit again.',
      done: () => !s.orbiting(), nudge: '{CALL}, confirm resuming own navigation', timeout: 15 });
  };
  const traffic = async s => {
    const alt = Math.max(1000, altitude + s.pick([-500, -300, 300, 500, 0]));
    await s.atc(`{CALL}, traffic is ${s.pick(TRAFFIC)}, ${s.pick(['1 mile', '2 miles', '3 miles'])} ${s.pick(SIDES)} of you, ${s.pick(HEADINGS)}, altitude ${alt} feet`, {
      readback: [TRAFFIC_ACK()], model: 'Looking, {CALL}  … then: Traffic in sight, {CALL}' });
  };
  const qnhChange = async s => {
    qnh += s.pick([-1, 1]);
    s.ctx.qnh = qnh;
    await s.atc(`{CALL}, ${area.qnhName} now ${qnh}`, { readback: [QNH(qnh)], model: `QNH ${qnh}, {CALL}` });
    s.setRadio({ qnh });
  };

  // Leaving the frequency. After a transit the service drops back to Basic Service, so the controller says so.
  async function qsy(s, summary, { basic = false } = {}) {
    const x = s.ctx.transponder;
    const words = [basic ? 'Basic Service' : '', x ? 'squawk 7000' : '', 'frequency change approved'].filter(Boolean).join(', ');
    await s.atc(`{CALL}, ${words}`, {
      readback: [...(basic ? [BASIC()] : []), ...(x ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'free call', 'freecall', 'changing'], { soft: !basic, fix: 'frequency change approved' })],
      model: `${cap(words)}, {CALL}` });
    await useSquawk(s, '7000', { chase: false });
    s.end(summary);
  }

  // Asked to report changing frequency (after a refusal): the pilot calls, the controller lets them go.
  async function leaveFrequency(s, summary) {
    await s.expect({ id: 'qsy', cue: 'Well clear of controlled airspace. Leave the frequency.', nudge: '{CALL}, say intentions',
      items: [P('changing frequency', ['changing', 'frequency', 'leaving your frequency', 'request frequency change'])], model: '{CALL}, clear of your airspace, changing frequency' });
    const x = s.ctx.transponder;
    await s.atc(x ? '{CALL}, squawk 7000, frequency change approved' : '{CALL}, frequency change approved', {
      readback: [...(x ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing'], { soft: true })],
      model: (x ? 'Squawk 7000, ' : '') + 'frequency change approved, {CALL}' });
    await useSquawk(s, '7000', { chase: false });
    s.end(summary);
  }

  // ---------- the flight, phase by phase ----------

  // From the start of a plan, before you've called anyone.
  async function begin(s, P0) {
    const T = P0.transit;
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
    await s.reach(Math.max(s.position().s + 0.3, T.sIn - 2.5), { label: A ? `Towards ${A.name}` : 'Towards controlled airspace' });
    if (!ctx.transponder && A) {
      st.approaching = null;
      await s.expect({ id: 'approaching', cue: `Approaching ${A.name}, still outside controlled airspace.`, nudge: '{CALL}, report your position',
        items: [named(A)], model: `{CALL}, approaching ${A.name}, altitude ${altitude} feet` });
    }
    if (s.chance((ctx.transponder ? 0.15 : 0.35) + s.settings.refusalBias)) return refusal(s);
    if (s.chance(0.3)) {
      await s.atc('{CALL}, expect zone entry in 5 minutes due inbound traffic, remain outside controlled airspace', {
        readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
      await s.leg('Holding outside controlled airspace', ctx.speedKt * 4 / 60, { cue: 'Orbit outside controlled airspace and listen out.' });
    }
    await clearance(s, P0);
    return through(s, P0, T.reports.map(r => r.place));
  }

  async function clearance(s, P0) {
    const { ctx } = s, T = P0.transit, via = T.via && T.via.place;
    const zone = T.intoZone ? area.zone : 'controlled airspace';
    const routed = T.reports.map(r => r.place).slice(0, 3);
    const viaText = via ? ` via ${via.name}` : '';
    const ident = ctx.transponder && !st.identified ? `{CALL}, identified ${whereIs(area, s.position()).text}. ` : '{CALL}, ';
    const routeFix = `route ${routed.map(p => p.name).join(', ')}`;
    await s.atc(`${ident}Cleared to enter ${zone}${viaText}, VFR, not above altitude ${notAbove} feet, ${area.qnhName} ${qnh}.` +
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
    st.identified = st.identified || ctx.transponder;
    st.cleared = true;
    s.hold(null);
    s.setRadio({ qnh });
    if (qnh !== q0 && !st.qnhNoted) { st.qnhNoted = true; s.note(`QNH changed from ${q0} to ${qnh} in the clearance: the altimeter should be reset.`); }
  }

  // Cleared: report each place in R in turn, then leave controlled airspace and the frequency.
  async function through(s, P0, R) {
    const { ctx } = s, T = P0.transit;
    const exact = new Map(T.reports.map(r => [r.place, r.s]));
    const at = p => exact.get(p) ?? P0.nearestS(p).s;
    let i = 0;
    const from = Math.max(s.position().s, T.sIn + 0.2), to = T.sOut - 0.3;
    const surprises = to > from ? surprisesInZone(s, from, to, () => R[i] || null) : [];
    for (; i < R.length; i++) {
      const r = R[i];
      await flyTo(s, at(r), r.name, surprises);
      await s.expect({ id: `report-${r.id}`, cue: `${r.name}.`, nudge: '{CALL}, report your position', items: [named(r)], model: `{CALL}, ${r.name}` });
      const svc = st.controlSaid ? '' : `${ctx.transponder ? 'radar ' : ''}control service`;
      const svcItems = svc ? [P('control service', ['control service'], { fix: svc })] : [];
      const lead = svc ? `${svc}, ` : '', Lead = svc ? `${cap(svc)}, ` : '';
      if (i < R.length - 1) {
        await s.atc(`{CALL}, roger, ${lead}report ${R[i + 1].name}`, { readback: [...svcItems, WILCO()], model: `${Lead}wilco, {CALL}` });
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
    await flyTo(s, Math.min(P0.total, T.sOut + 0.3), 'Controlled airspace boundary', surprises);
    await s.expect({ id: 'leaving', cue: 'Leaving controlled airspace.', nudge: '{CALL}, report your position',
      items: [P('leaving controlled airspace', ['leaving controlled airspace', 'leaving the zone', 'clear of controlled airspace', 'leaving', 'clear of the zone', 'clear'])],
      model: '{CALL}, leaving controlled airspace' });
    st.left = true;
    await qsy(s, 'Transit completed', { basic: true });
  }

  async function refusal(s) {
    await s.atc('{CALL}, negative zone transit due traffic, remain outside controlled airspace', {
      readback: [P('negative transit', ['negative'], { soft: true }), ROS()], model: 'Negative transit, remain outside controlled airspace, {CALL}' });
    await s.atc('{CALL}, confirm you will not enter controlled airspace', {
      readback: [
        P('affirm', ['affirm', 'will not enter', 'not enter', 'wilco'], { fix: null }),
        P('controlled airspace', ['controlled airspace'], { substitutes: ['zone'], retry: '{CALL}, please confirm you will not enter controlled airspace',
          why: '“Zone” is the CTR only. The controller asked about controlled airspace, which includes the CTAs: answer in the same words.' }),
        P('new routing', ['routing', 'route', 'round', 'around', 'remaining outside', 'north', 'south', 'east', 'west', 'via'], { soft: true, why: 'Tell them your plan B so they know where you’re going.' }),
      ],
      model: 'Affirm, will not enter controlled airspace, routing round the zone, {CALL}' });
    st.refused = true;
    await s.atc('{CALL}, roger, Basic Service continues, report changing frequency', { readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
    s.hold(s.position().s, 'Holding outside controlled airspace');
    await s.leg('Routing round the zone', 5, { cue: 'Plan B: pick a way round on the map (tap a place, then Direct to or Divert), remaining outside controlled airspace.' });
    await leaveFrequency(s, 'Transit refused: routed round');
  }

  // Outside controlled airspace on a Basic Service: the odd report or traffic, then leave the frequency near the end.
  async function outside(s, P0) {
    const { ctx } = s;
    const end = Math.max(s.position().s + 0.5, P0.total - 1.5);
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
      await flyTo(s, r.s, report.name, surprises);
      await s.expect({ id: 'report', cue: `${report.name}.`, nudge: '{CALL}, report your position',
        items: [named(report)], model: `{CALL}, ${report.name}, altitude ${altitude} feet` });
      await s.atc('{CALL}, roger');
    }
    await flyTo(s, end, `Towards ${destination(P0).name}`, surprises);
    await s.expect({ id: 'qsy', cue: 'Nearly there. Leave the frequency.', nudge: '{CALL}, say intentions',
      items: [P('leaving frequency', ['frequency', 'changing', 'leaving', 'basic service'])], model: '{CALL}, request frequency change' });
    await qsy(s, st.refused ? 'Transit refused: routed round' : 'Basic Service flight completed');
  }

  // ---------- a change of route in flight ----------

  /** Called by the engine when you pick Direct to / Divert on the map. Throws if the new route can't be flown. */
  function routeChange({ s, pos }, { action, place }) {
    const pts = reroutePoints(plan, s, action, place);
    return { plan: planFrom(pos, pts), points: pts, approval: st.cleared && !st.left && insideNow(plan, s) };
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
      const remaining = () => plan.transit.reports.filter(r => r.s > s.position().s + 0.1).map(r => r.place);
      if (!asked) { s.dropPending(); return through(s, plan, remaining()); }
      if (s.chance(0.15 + s.settings.refusalBias)) {
        await s.atc('{CALL}, unable due traffic, continue as cleared', {
          readback: [P('continue as cleared', ['continue as cleared', 'as cleared', 'continue'], { fix: 'continue as cleared' })], model: 'Continue as cleared, {CALL}' });
        s.dropPending();
        return through(s, plan, remaining());
      }
      const next = planFrom(s.position(), change.points);                   // from where you are now
      const R = next.transit ? next.transit.reports.map(r => r.place) : [];
      await s.atc(`{CALL}, roger, route direct ${target.name}, ${R.length ? `report ${R[0].name}` : 'report leaving controlled airspace'}`, {
        readback: [named(target, `route direct ${target.name}`), WILCO()], model: `Direct ${target.name}, wilco, {CALL}` });
      plan = next;
      s.fly(next);
      return next.transit ? through(s, next, R) : outside(s, next);
    }

    plan = change.plan;                                                     // outside controlled airspace you've already turned
    const T = plan.transit;
    if (T && !st.cleared) s.hold(Math.max(s.position().s, T.sIn - 1), 'Holding for your clearance');
    await s.expect({ id: 'reroute', cue: `Tell ${area.unit} about your change of plan.`, nudge: '{CALL}, say intentions',
      items: [named(target, null, { ask: '{CALL}, say your routing' })],
      model: T ? `{CALL}, change of plan, request zone transit, route direct ${target.name}`
        : `{CALL}, change of plan, routing direct ${target.name}, remaining outside controlled airspace` });
    if (!st.service) await service(s, plan);
    if (T) {
      if (st.refused) {
        await s.atc('{CALL}, negative, remain outside controlled airspace', { readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
        await s.leg('Holding outside controlled airspace', 3, { cue: 'Still refused: pick a way round that stays outside controlled airspace.' });
        return leaveFrequency(s, 'Transit refused: routed round');
      }
      if (st.cleared) {                                                     // cleared but not in yet: a new clearance for the new way in
        st.cleared = false;
        await clearance(s, plan);
        return through(s, plan, T.reports.map(r => r.place));
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
