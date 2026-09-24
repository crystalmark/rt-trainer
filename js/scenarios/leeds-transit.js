import { P, WILCO, QNH, SQUAWK, BASIC, NOT_ABOVE, ROS, TRAFFIC_ACK, details, initialCall, leedsTraffic, useSquawk } from './common.js';
import { areaById } from '../areas/index.js';

const SALTS_MILL = ['salts mill', 'salt mill', 'saltaire'];

export default {
  id: 'leeds-transit',
  title: 'Leeds zone transit',
  subtitle: 'Salts Mill → Eccup Reservoir, en route Sherburn',
  unit: 'Leeds Radar',
  freq: '134.580',
  traffic: leedsTraffic,
  places: areaById('leeds').places,
  briefing: ctx => [
    ['Aircraft', `${ctx.reg}, ${ctx.type}, ${ctx.transponder ? 'Mode S' : 'no transponder'}, 1 POB.`],
    ['Flight', 'Kirkbride to Sherburn in Elmet, VFR. Flight details emailed to Leeds ATC this morning.'],
    ['Start', '12 nm north-west of the Leeds CTR near Skipton, 2800 ft on 1016.'],
    ['Careful', 'You are under CTA 3, base 3000 ft: only 200 ft above you.', 'warn'],
    ['Plan', 'Past Keighley, then through the zone via the Salts Mill and Eccup Reservoir VRPs.'],
    ['Plan B', 'If refused, route west of the zone via Oxenhope.'],
    ['Leeds', 'Runway 32 in use, airliners arriving from the south-east.'],
  ],
  async run(s) {
    const { ctx } = s;
    await s.leg('Skipton, 12 nm from the Leeds CTR', 2, { cue: 'Listen to the frequency, then call Leeds Radar when there is a gap.' });

    const det = details(ctx, { from: 'kirkbride', to: 'sherburn', position: ['skipton', 'miles'], altitude: 2800,
      request: ['transit', 'zone transit', 'crossing', 'cross'], emailed: true });
    const said = await initialCall(s, { unitName: 'Leeds Radar', det,
      requestItems: [P('request', ['transit', 'basic service', 'zone', 'request'], { soft: true, why: 'State your request on first contact.' })],
      model: 'Leeds Radar, {CS}, request Basic Service and zone transit',
      detailsModel: '{CS}, {TYPE}, Kirkbride to Sherburn, 3 miles south of Skipton, altitude 2800 feet, QNH 1016, VFR, ' + (ctx.transponder ? '' : 'no transponder, ') + 'request transit via Salts Mill and Eccup Reservoir, flight details emailed' });
    const saidNoXpdr = said && said.items.some(i => i.key === 'noxpdr' && i.matched);

    if (ctx.transponder) {
      await s.atc('{CALL}, Basic Service, squawk 5634, remain outside controlled airspace', {
        readback: [BASIC(), SQUAWK('5634'), ROS()], model: 'Basic Service, squawk 5634, remain outside controlled airspace, {CALL}' });
      await useSquawk(s, '5634');
      await s.leg('Inbound to Keighley', 3);
    } else {
      if (!saidNoXpdr) {
        await s.atc('{CALL}, confirm you are not transponder equipped', { reply: { id: 'xpdr', timeout: 12,
          items: [P('affirm', ['affirm', 'no transponder', 'not transponder', 'negative transponder', 'correct', 'not equipped'])], model: 'Affirm, no transponder, {CALL}' } });
      }
      await s.atc('{CALL}, Basic Service, remain outside controlled airspace, report approaching Keighley', {
        readback: [BASIC(), ROS(), WILCO()], model: 'Basic Service, remain outside controlled airspace, wilco, {CALL}' });
      await s.leg('Inbound to Keighley', 3, { early: true });
      await s.expect({ id: 'approaching', cue: 'Approaching Keighley, still outside the zone.', nudge: '{CALL}, report your position',
        items: [P('Keighley', ['keighley'])], model: '{CALL}, approaching Keighley, altitude 2800 feet' });
    }

    // The controller's decision.
    const refuse = s.chance((ctx.transponder ? 0.15 : 0.35) + s.settings.refusalBias);
    if (refuse) return refusal(s);
    if (s.chance(0.3)) {
      await s.atc('{CALL}, expect zone entry in 5 minutes due inbound traffic, remain outside controlled airspace', {
        readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
      await s.leg('Holding outside the zone near Keighley', 3, { cue: 'Orbit outside controlled airspace and listen out.' });
    }

    const rb = [
      P('cleared to enter', ['cleared to enter', 'cleared into', 'cleared'], { fix: 'cleared to enter the Leeds control zone via Salts Mill' }),
      P('control zone', ['control zone', 'zone', 'controlled airspace'], { soft: true }),
      P('via Salts Mill', SALTS_MILL, { fix: 'via Salts Mill' }),
      P('VFR', ['vfr'], { fix: 'VFR' }),
      ...NOT_ABOVE(3000),
      QNH(1017),
      P('route Eccup Reservoir', ['eccup'], { fix: 'route Salts Mill, Eccup Reservoir' }),
      WILCO(),
    ];
    await s.atc((ctx.transponder ? '{CALL}, identified 5 miles north-west of Keighley. ' : '{CALL}, ') +
      'Cleared to enter the Leeds control zone via Salts Mill, VFR, not above altitude 3000 feet, Leeds QNH 1017. Route Salts Mill, Eccup Reservoir. Report Salts Mill',
      { readback: rb, clearance: true, model: 'Cleared to enter the Leeds control zone via Salts Mill, VFR, not above altitude 3000 feet, QNH 1017, route Salts Mill, Eccup Reservoir, wilco, {CALL}' });
    s.note('QNH changed from 1016 to 1017 in the clearance: the altimeter should be reset.');

    await s.leg('Salts Mill', 4, { early: true });
    await s.expect({ id: 'salts-mill', cue: 'At Salts Mill.', nudge: '{CALL}, report your position',
      items: [P('Salts Mill', SALTS_MILL)], model: '{CALL}, Salts Mill' });
    await s.atc(`{CALL}, roger, ${ctx.transponder ? 'radar ' : ''}control service, report Eccup Reservoir`, {
      readback: [P('control service', ['control service'], { fix: `${ctx.transponder ? 'radar ' : ''}control service` }), WILCO()],
      model: `${ctx.transponder ? 'Radar c' : 'C'}ontrol service, wilco, {CALL}` });

    await s.leg('En route to Eccup Reservoir', 4);
    if (s.chance(0.45)) {
      await s.atc('{CALL}, orbit left at present position, due inbound traffic', {
        readback: [P('orbit left', ['orbit left'], { fix: 'orbit left at present position' }), P('present position', ['present position'], { soft: true })],
        model: 'Orbit left at present position, {CALL}' });
      await s.leg('Orbiting', 2, { cue: 'Orbit left and keep listening.' });
      await s.atc('{CALL}, resume own navigation to Eccup Reservoir', {
        readback: [P('resume own navigation', ['resume own navigation', 'resume'], { fix: 'resume own navigation' }), P('Eccup', ['eccup'], { fix: 'resume own navigation to Eccup Reservoir' })],
        model: 'Resume own navigation to Eccup Reservoir, {CALL}' });
    }
    if (s.chance(0.6)) {
      await s.atc('{CALL}, traffic is a Cessna 172, 2 miles south-east of you, northbound, altitude 2500 feet', {
        readback: [TRAFFIC_ACK()], model: 'Looking, {CALL}  … then: Traffic in sight, {CALL}' });
    }
    if (s.chance(0.3)) {
      await s.atc('{CALL}, Leeds QNH now 1016', { readback: [QNH(1016)], model: 'QNH 1016, {CALL}' });
    }
    await s.leg('Eccup Reservoir', 4, { early: true });
    await s.expect({ id: 'eccup', cue: 'Overhead Eccup Reservoir.', nudge: '{CALL}, report your position',
      items: [P('Eccup Reservoir', ['eccup'])], model: '{CALL}, Eccup Reservoir' });
    await s.atc('{CALL}, leave the zone south-east, not above altitude 3000 feet, report leaving controlled airspace', {
      readback: [P('leave the zone', ['leave the zone', 'leave', 'leaving'], { fix: 'leave the zone south-east' }), P('south-east', ['south east'], { fix: 'leave the zone south-east' }), ...NOT_ABOVE(3000), WILCO()],
      model: 'Leave the zone south-east, not above altitude 3000 feet, wilco, {CALL}' });
    await s.leg('South-east edge of the CTR', 3, { early: true });
    await s.expect({ id: 'leaving', cue: 'Crossing the CTR boundary.', nudge: '{CALL}, report your position',
      items: [P('leaving controlled airspace', ['leaving controlled airspace', 'leaving the zone', 'clear of controlled airspace', 'leaving', 'clear of the zone'])], model: '{CALL}, leaving controlled airspace' });
    await s.atc(ctx.transponder ? '{CALL}, Basic Service, squawk 7000, frequency change approved' : '{CALL}, Basic Service, frequency change approved', {
      readback: [BASIC(), ...(ctx.transponder ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing', 'free call', 'freecall'], { soft: true })],
      model: (ctx.transponder ? 'Basic Service, squawk 7000' : 'Basic Service') + ', frequency change approved, {CALL}' });
    await useSquawk(s, '7000', { chase: false });
    s.end('Transit completed');
  },
};

async function refusal(s) {
  await s.atc('{CALL}, negative zone transit due traffic, remain outside controlled airspace', {
    readback: [P('negative transit', ['negative'], { soft: true }), ROS()],
    model: 'Negative transit, remain outside controlled airspace, {CALL}' });
  await s.atc('{CALL}, confirm you will not enter controlled airspace', {
    readback: [
      P('affirm', ['affirm', 'will not enter', 'not enter', 'wilco'], { fix: null }),
      P('controlled airspace', ['controlled airspace'], { substitutes: ['zone'], retry: '{CALL}, please confirm you will not enter controlled airspace',
        why: '“Zone” is the CTR only. The controller asked about controlled airspace, which includes the CTAs: answer in the same words.' }),
      P('new routing', ['routing', 'route', 'direct', 'via', 'oxenhope', 'west', 'remaining'], { soft: true, why: 'Tell them your plan B so they know where you’re going.' }),
    ],
    model: 'Affirm, will not enter controlled airspace, routing west via Oxenhope, {CALL}' });
  await s.atc('{CALL}, roger, Basic Service continues, report changing frequency', { readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
  await s.leg('Routing west of the zone via Oxenhope', 5, { cue: 'Plan B: route round the west of the zone.', early: true });
  await s.expect({ id: 'qsy', cue: 'Well clear of the zone. Leave the frequency.', nudge: '{CALL}, say intentions',
    items: [P('changing frequency', ['changing', 'frequency', 'leaving your frequency', 'request frequency change'])], model: '{CALL}, clear of your airspace, changing frequency' });
  await s.atc(s.ctx.transponder ? '{CALL}, squawk 7000, frequency change approved' : '{CALL}, frequency change approved', {
    readback: [...(s.ctx.transponder ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing'], { soft: true })],
    model: (s.ctx.transponder ? 'Squawk 7000, ' : '') + 'frequency change approved, {CALL}' });
  s.end('Transit refused: routed round');
}
