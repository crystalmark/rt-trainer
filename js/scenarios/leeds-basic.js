import { P, WILCO, SQUAWK, BASIC, ROS, TRAFFIC_ACK, details, initialCall, leedsTraffic } from './common.js';

export default {
  id: 'leeds-basic',
  title: 'Leeds Basic Service',
  subtitle: 'Skirting the west of the zone, Skipton → Burnley',
  unit: 'Leeds Radar',
  freq: '134.580',
  traffic: leedsTraffic,
  briefing: ctx => [
    `${ctx.reg} (${ctx.type}${ctx.transponder ? ', Mode S' : ', no transponder'}), local flight from home towards Burnley, staying outside controlled airspace.`,
    'You want a Basic Service from Leeds Radar while you pass close to the western edge of the CTR.',
    'Mostly listening: expect long gaps, other traffic, and the odd call to you. Don’t miss your callsign.',
  ],
  async run(s) {
    const { ctx } = s;
    await s.leg('North of Skipton', 1.5, { cue: 'Call Leeds Radar for a Basic Service.' });
    const det = details(ctx, { from: 'skipton', to: 'burnley', position: ['skipton', 'miles'], altitude: 2500,
      request: ['basic service'] });
    await initialCall(s, { unitName: 'Leeds Radar', det,
      requestItems: [P('request basic service', ['basic service'], { soft: true, why: 'Ask for the service by name on first contact.' })],
      model: 'Leeds Radar, {CS}, request Basic Service',
      detailsModel: '{CS}, {TYPE}, local flight to Burnley, 2 miles north of Skipton, altitude 2500 feet, QNH 1016, VFR, ' + (ctx.transponder ? '' : 'no transponder, ') + 'routing west of your zone' });
    if (ctx.transponder) {
      await s.atc('{CALL}, Basic Service, squawk 5621', { readback: [BASIC(), SQUAWK('5621')], model: 'Basic Service, squawk 5621, {CALL}' });
      s.setRadio({ squawk: '5621' });
    } else {
      await s.atc('{CALL}, Basic Service, report passing Oxenhope', { readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
    }
    await s.leg('South over Skipton moor', 5);
    if (s.chance(0.7)) {
      await s.atc('{CALL}, traffic is a glider, 2 miles west of you, manoeuvring, height unknown', { readback: [TRAFFIC_ACK()], model: 'Looking, {CALL}' });
    }
    await s.leg('Towards Oxenhope, close to the CTR boundary', 5);
    if (ctx.transponder) {
      await s.atc('{CALL}, you are 1 mile from controlled airspace, confirm you are remaining outside', {
        readback: [P('affirm', ['affirm', 'remaining outside', 'will remain']),
          P('controlled airspace', ['controlled airspace'], { substitutes: ['zone'], retry: '{CALL}, confirm you are remaining outside controlled airspace',
            why: 'Answer with the controller’s words: “remaining outside controlled airspace”.' })],
        model: 'Affirm, remaining outside controlled airspace, {CALL}' });
    } else {
      await s.expect({ id: 'oxenhope', cue: 'Passing Oxenhope.', nudge: '{CALL}, report your position',
        items: [P('Oxenhope', ['oxenhope'])], model: '{CALL}, passing Oxenhope, altitude 2500 feet' });
      await s.atc('{CALL}, roger. The Leeds CTR boundary is 2 miles east of you, remain outside controlled airspace', {
        readback: [ROS()], model: 'Remain outside controlled airspace, {CALL}' });
    }
    await s.leg('South-west towards Burnley', 8, { cue: 'Keep listening out.' });
    if (s.chance(0.5)) {
      await s.atc('{CALL}, Leeds Radar, report your position and altitude', { reply: { id: 'posrep', timeout: 12,
        items: [P('position', ['miles', 'overhead', 'burnley', 'hebden', 'colne', 'nelson', 'north', 'south', 'east', 'west'], { ask: '{CALL}, say position' }), P('altitude', ['feet', 'altitude'], { ask: '{CALL}, say altitude' })],
        model: '{CALL}, 4 miles north-east of Burnley, altitude 2500 feet' } });
      await s.atc('{CALL}, roger');
    }
    await s.leg('Approaching Burnley, leaving Leeds’ area', 4);
    await s.expect({ id: 'qsy', cue: 'Leave the frequency.', nudge: '{CALL}, say intentions',
      items: [P('leaving frequency', ['frequency', 'changing', 'leaving', 'basic service'])], model: '{CALL}, request frequency change' });
    await s.atc(ctx.transponder ? '{CALL}, squawk 7000, frequency change approved' : '{CALL}, frequency change approved', {
      readback: [...(ctx.transponder ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing'], { soft: true })],
      model: (ctx.transponder ? 'Squawk 7000, ' : '') + 'frequency change approved, {CALL}' });
    s.setRadio({ squawk: ctx.transponder ? '7000' : null });
    s.end('Basic Service leg completed');
  },
};
