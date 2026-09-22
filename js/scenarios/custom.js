// Your own route through an area. The route plan (js/route.js) decides where you enter and leave controlled
// airspace and what you report; this turns it into a zone transit, or a Basic Service flight round the outside,
// with the same readback checks and surprises as the scripted scenarios.
import { P, WILCO, QNH, SQUAWK, BASIC, NOT_ABOVE, ROS, TRAFFIC_ACK, details, initialCall } from './common.js';
import { planRoute, routeText, whereIs } from '../route.js';
import { miles } from '../geo.js';

const said = p => (p.hear && p.hear[0]) || p.name.toLowerCase();
const named = (p, fix, o = {}) => P(p.name, p.hear || [said(p)], { fix, ...o });
const octal = rng => String(Math.floor(rng() * 8));
const TRAFFIC = ['a Cessna 172', 'a PA28', 'a C42 microlight', 'a helicopter', 'a Robin', 'a glider'];
const HEADINGS = ['northbound', 'southbound', 'eastbound', 'westbound'];
const SIDES = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Build a scenario for `points` (area places) at `altitude`. Throws with the plan's first error if it can't be flown. */
export function customScenario(area, { points, altitude }, { rng = Math.random } = {}) {
  const plan = planRoute(area, points, altitude);
  if (plan.errors.length) throw new Error(plan.errors[0]);
  const T = plan.transit;
  const first = points[0], last = points[points.length - 1];
  const q0 = 1006 + Math.floor(rng() * 18);                          // what you set before you call
  const q1 = rng() < 0.4 ? q0 + (rng() < 0.5 ? 1 : -1) : q0;         // what ATC gives you
  const squawk = area.squawks + octal(rng) + octal(rng);
  const notAbove = Math.ceil(altitude / 500) * 500;
  const vrps = area.places.filter(p => p.kind === 'vrp').map(p => p.name).join(', ');

  function briefing(ctx) {
    const mins = Math.round(plan.total / ctx.speedKt * 60);
    const base = v => v.base ? `from ${v.base} ft` : 'from the surface';
    return [
      `${ctx.reg} (${ctx.type}${ctx.transponder ? ', Mode S' : ', no transponder'}), ${first.name} to ${last.name}, 1 POB.`,
      `Route ${routeText(points)}: ${Math.round(plan.total)} nm, about ${mins} min at ${ctx.speedKt} kt. Planned altitude ${altitude} ft, QNH ${q0}.`,
      T ? `You reach ${T.entryVolume.name} (Class ${T.entryVolume.cls}, ${base(T.entryVolume)}) after ${Math.round(T.sIn)} nm and leave controlled airspace to the ${T.exitSide} after ${Math.round(T.sOut)} nm. Ask ${area.unit} for a transit.`
        : `At ${altitude} ft the route stays outside controlled airspace, ${miles(plan.closest.d)} from ${plan.closest.volume.name} at the closest. Ask ${area.unit} for a Basic Service.`,
      ...plan.under.map(u => `You pass under ${u.volume.name}: its base is ${u.volume.base} ft, only ${u.gap} ft above you.`),
      ...plan.warnings,
      `${area.name} VRPs: ${vrps}. They're reporting references: pass near them rather than overhead.`,
      ...area.facts,
      T ? 'Plan B if the transit is refused: route round, remaining outside controlled airspace.' : '',
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

  let qnh = q1;
  const orbit = nextReport => async s => {
    await s.atc('{CALL}, orbit left at present position, due inbound traffic', {
      readback: [P('orbit left', ['orbit left'], { fix: 'orbit left at present position' }), P('present position', ['present position'], { soft: true })],
      model: 'Orbit left at present position, {CALL}' });
    s.hold(s.position().s);
    await s.leg('Orbiting', s.ctx.speedKt * 2 / 60, { cue: 'Orbit left and keep listening.' });
    const to = nextReport();
    s.hold(null);
    await s.atc(`{CALL}, resume own navigation${to ? ` to ${to.name}` : ''}`, {
      readback: [P('resume own navigation', ['resume own navigation', 'resume'], { fix: 'resume own navigation' }), ...(to ? [named(to, `resume own navigation to ${to.name}`)] : [])],
      model: `Resume own navigation${to ? ` to ${to.name}` : ''}, {CALL}` });
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

  async function call(s, request, requestItems, requestModel) {
    const { ctx } = s;
    const here = whereIs(area, s.position());
    const det = details(ctx, { from: said(first), to: said(last), position: [...here.hear, 'miles', 'overhead'], altitude, request });
    return initialCall(s, { unitName: area.unit, det, requestItems,
      model: `${area.unit}, {CS}, ${requestModel}`,
      detailsModel: `{CS}, {TYPE}, ${first.name} to ${last.name}, ${here.text}, altitude ${altitude} feet, QNH ${q0}, VFR, ${ctx.transponder ? '' : 'no transponder, '}${requestModel}` });
  }

  // Leaving the frequency. After a transit the service drops back to Basic Service, so the controller says so.
  async function qsy(s, summary, { basic = false } = {}) {
    const x = s.ctx.transponder;
    const words = [basic ? 'Basic Service' : '', x ? 'squawk 7000' : '', 'frequency change approved'].filter(Boolean).join(', ');
    await s.atc(`{CALL}, ${words}`, {
      readback: [...(basic ? [BASIC()] : []), ...(x ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'free call', 'freecall', 'changing'], { soft: !basic, fix: 'frequency change approved' })],
      model: `${words[0].toUpperCase()}${words.slice(1)}, {CALL}` });
    s.setRadio({ squawk: x ? '7000' : null });
    s.end(summary);
  }

  async function transit(s) {
    const { ctx } = s;
    s.fly(plan);
    ctx.qnh = q1;                                        // the unit's QNH: background traffic uses it too
    s.setRadio({ qnh: q0 });
    await s.reach(Math.max(0.5, T.sIn - 10), { label: `${area.unit} ${area.freq}`, cue: `Listen to the frequency, then call ${area.unit} when there is a gap.` });
    const via = T.via && T.via.place;
    const init = await call(s, ['transit', 'zone transit', 'crossing', 'cross'],
      [P('request', ['transit', 'basic service', 'zone', 'request'], { soft: true, why: 'State your request on first contact.' })],
      `request Basic Service and zone transit${via ? ` via ${via.name}` : ''}`);
    const noXpdrSaid = init && init.items.some(i => i.key === 'noxpdr' && i.matched);

    s.hold(T.sIn - 1);                                   // not into controlled airspace without a clearance
    const approaching = whereIs(area, plan.posAt(Math.max(0, T.sIn - 2))).place || via || first;
    if (ctx.transponder) {
      await s.atc(`{CALL}, Basic Service, squawk ${squawk}, remain outside controlled airspace`, {
        readback: [BASIC(), SQUAWK(squawk), ROS()], model: `Basic Service, squawk ${squawk}, remain outside controlled airspace, {CALL}` });
      s.setRadio({ squawk });
    } else {
      if (!noXpdrSaid) {
        await s.atc('{CALL}, confirm you are not transponder equipped', { reply: { id: 'xpdr', timeout: 12,
          items: [P('affirm', ['affirm', 'no transponder', 'not transponder', 'negative transponder', 'correct', 'not equipped'])], model: 'Affirm, no transponder, {CALL}' } });
      }
      await s.atc(`{CALL}, Basic Service, remain outside controlled airspace, report approaching ${approaching.name}`, {
        readback: [BASIC(), ROS(), WILCO()], model: 'Basic Service, remain outside controlled airspace, wilco, {CALL}' });
    }
    await s.reach(Math.max(s.position().s + 0.3, T.sIn - 2.5), { label: `Towards ${approaching.name}` });
    if (!ctx.transponder) {
      await s.expect({ id: 'approaching', cue: `Approaching ${approaching.name}, still outside controlled airspace.`, nudge: '{CALL}, report your position',
        items: [named(approaching)], model: `{CALL}, approaching ${approaching.name}, altitude ${altitude} feet` });
    }

    if (s.chance((ctx.transponder ? 0.15 : 0.35) + s.settings.refusalBias)) return refusal(s);
    if (s.chance(0.3)) {
      await s.atc('{CALL}, expect zone entry in 5 minutes due inbound traffic, remain outside controlled airspace', {
        readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
      await s.leg('Holding outside controlled airspace', ctx.speedKt * 4 / 60, { cue: 'Orbit outside controlled airspace and listen out.' });
    }

    const zone = T.intoZone ? area.zone : 'controlled airspace';
    const R = T.reports.map(r => r.place);
    const routed = R.slice(0, 3);
    const viaText = via ? ` via ${via.name}` : '';
    const ident = ctx.transponder ? `{CALL}, identified ${whereIs(area, s.position()).text}. ` : '{CALL}, ';
    const routeFix = `route ${routed.map(p => p.name).join(', ')}`;
    await s.atc(`${ident}Cleared to enter ${zone}${viaText}, VFR, not above altitude ${notAbove} feet, ${area.qnhName} ${q1}.` +
      (routed.length > 1 ? ` Route ${routed.map(p => p.name).join(', ')}.` : '') + ` Report ${R.length ? R[0].name : 'leaving controlled airspace'}`, {
      clearance: true,
      readback: [
        P('cleared to enter', ['cleared to enter', 'cleared into', 'cleared'], { fix: `cleared to enter ${zone}${viaText}` }),
        P(T.intoZone ? 'control zone' : 'controlled airspace', T.intoZone ? ['control zone', 'zone', 'controlled airspace'] : ['controlled airspace'], { soft: true }),
        ...(via ? [named(via, `via ${via.name}`)] : []),
        P('VFR', ['vfr'], { fix: 'VFR' }),
        ...NOT_ABOVE(notAbove),
        QNH(q1),
        ...(routed.length > 1 ? routed.filter(p => p !== via).map(p => P(`route ${p.name}`, p.hear || [said(p)], { fix: routeFix })) : []),
        WILCO(),
      ],
      model: `Cleared to enter ${zone}${viaText}, VFR, not above altitude ${notAbove} feet, QNH ${q1}${routed.length > 1 ? `, ${routeFix}` : ''}, wilco, {CALL}` });
    s.hold(null);
    s.setRadio({ qnh: q1 });
    if (q1 !== q0) s.note(`QNH changed from ${q0} to ${q1} in the clearance: the altimeter should be reset.`);

    let i = 0;
    const from = Math.max(s.position().s, T.sIn + 0.2), to = T.sOut - 0.3;
    const surprises = to > from ? surprisesInZone(s, from, to, () => R[i] || null) : [];
    for (; i < R.length; i++) {
      const r = T.reports[i];
      await flyTo(s, r.s, r.place.name, surprises);
      await s.expect({ id: `report-${i}`, cue: `${r.place.name}.`, nudge: '{CALL}, report your position',
        items: [named(r.place)], model: `{CALL}, ${r.place.name}` });
      const svc = i === 0 ? `${ctx.transponder ? 'radar ' : ''}control service` : '';
      const svcItems = svc ? [P('control service', ['control service'], { fix: svc })] : [];
      const lead = svc ? `${svc}, ` : '';
      const Lead = svc ? `${svc[0].toUpperCase()}${svc.slice(1)}, ` : '';
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
    }
    await flyTo(s, Math.min(plan.total, T.sOut + 0.3), 'Controlled airspace boundary', surprises);
    await s.expect({ id: 'leaving', cue: 'Leaving controlled airspace.', nudge: '{CALL}, report your position',
      items: [P('leaving controlled airspace', ['leaving controlled airspace', 'leaving the zone', 'clear of controlled airspace', 'leaving', 'clear of the zone', 'clear'])],
      model: '{CALL}, leaving controlled airspace' });
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
    await s.atc('{CALL}, roger, Basic Service continues, report changing frequency', { readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
    s.hold(s.position().s);
    await s.leg('Routing round the zone', 5, { cue: 'Plan B: route round, remaining outside controlled airspace.' });
    await s.expect({ id: 'qsy', cue: 'Well clear of controlled airspace. Leave the frequency.', nudge: '{CALL}, say intentions',
      items: [P('changing frequency', ['changing', 'frequency', 'leaving your frequency', 'request frequency change'])], model: '{CALL}, clear of your airspace, changing frequency' });
    const x = s.ctx.transponder;
    await s.atc(x ? '{CALL}, squawk 7000, frequency change approved' : '{CALL}, frequency change approved', {
      readback: [...(x ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing'], { soft: true })],
      model: (x ? 'Squawk 7000, ' : '') + 'frequency change approved, {CALL}' });
    s.setRadio({ squawk: x ? '7000' : null });
    s.end('Transit refused: routed round');
  }

  async function outside(s) {
    const { ctx } = s;
    s.fly(plan);
    ctx.qnh = q1;
    s.setRadio({ qnh: q0 });
    await s.reach(Math.min(1.5, plan.total / 4), { label: `${area.unit} ${area.freq}`, cue: `Call ${area.unit} for a Basic Service.` });
    await call(s, ['basic service'], [P('request basic service', ['basic service'], { soft: true, why: 'Ask for the service by name on first contact.' })], 'request Basic Service');
    const next = plan.points.find(w => w.s > s.position().s + 1 && w.s < plan.total - 2);
    if (ctx.transponder) {
      await s.atc(`{CALL}, Basic Service, squawk ${squawk}`, { readback: [BASIC(), SQUAWK(squawk)], model: `Basic Service, squawk ${squawk}, {CALL}` });
      s.setRadio({ squawk });
    } else {
      await s.atc(`{CALL}, Basic Service${next ? `, report ${next.place.name}` : ''}`, {
        readback: [BASIC(), ...(next ? [WILCO()] : [])], model: `Basic Service${next ? ', wilco' : ''}, {CALL}` });
    }
    const end = Math.max(s.position().s + 0.5, plan.total - 1.5);
    const at = () => s.position().s + (end - s.position().s) * s.pick([0.3, 0.5, 0.7]);
    const surprises = [];
    if (s.chance(0.6)) surprises.push({ at: at(), run: traffic });
    if (s.chance(0.5)) surprises.push({ at: at(), run: async s2 => {
      await s2.atc(`{CALL}, ${area.unit}, report your position and altitude`, { reply: { id: 'posrep', timeout: 12,
        items: [P('position', ['miles', 'overhead', ...area.places.map(said)], { ask: '{CALL}, say position' }), P('altitude', ['feet', 'altitude'], { ask: '{CALL}, say altitude' })],
        model: `{CALL}, ${whereIs(area, s2.position()).text}, altitude ${altitude} feet` } });
      await s2.atc('{CALL}, roger');
    } });
    const close = plan.closest && plan.closest.d < 2 ? plan.closest : null;
    if (close && close.s > s.position().s + 0.5) surprises.push({ at: Math.max(s.position().s + 0.3, close.s - 1), run: async s2 => {
      await s2.atc(`{CALL}, you are ${miles(close.d)} from controlled airspace, confirm you are remaining outside`, {
        readback: [P('affirm', ['affirm', 'remaining outside', 'will remain']),
          P('controlled airspace', ['controlled airspace'], { substitutes: ['zone'], retry: '{CALL}, confirm you are remaining outside controlled airspace',
            why: 'Answer with the controller’s words: “remaining outside controlled airspace”.' })],
        model: 'Affirm, remaining outside controlled airspace, {CALL}' });
    } });
    if (!ctx.transponder && next) {
      await flyTo(s, next.s, next.place.name, surprises);
      await s.expect({ id: 'report', cue: `${next.place.name}.`, nudge: '{CALL}, report your position',
        items: [named(next.place)], model: `{CALL}, ${next.place.name}, altitude ${altitude} feet` });
      await s.atc('{CALL}, roger');
    }
    await flyTo(s, end, `Towards ${last.name}`, surprises);
    await s.expect({ id: 'qsy', cue: 'Nearly there. Leave the frequency.', nudge: '{CALL}, say intentions',
      items: [P('leaving frequency', ['frequency', 'changing', 'leaving', 'basic service'])], model: '{CALL}, request frequency change' });
    await qsy(s, 'Basic Service flight completed');
  }

  return {
    id: `custom-${area.id}`, custom: area.id,
    title: `${area.name}: ${first.name} to ${last.name}`,
    subtitle: routeText(points, altitude),
    unit: area.unit, freq: area.freq,
    traffic: area.traffic, places: area.places, pronounce: area.pronounce, plan,
    briefing,
    run: s => (T ? transit(s) : outside(s)),
  };
}
