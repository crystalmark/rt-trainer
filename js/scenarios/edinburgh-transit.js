import { P, WILCO, QNH, SQUAWK, NOT_ABOVE, ROS, TRAFFIC_ACK, FREQ, details, initialCall, edinburghTraffic } from './common.js';

export default {
  id: 'edinburgh-transit',
  title: 'Edinburgh zone transit',
  subtitle: 'Musselburgh → Kirkcaldy Harbour, East Fortune to Perth',
  unit: 'Edinburgh Approach',
  freq: '121.205',
  traffic: edinburghTraffic,
  briefing: ctx => [
    `${ctx.reg} (${ctx.type}${ctx.transponder ? ', Mode S' : ', no transponder'}), East Fortune to Perth, 1 POB.`,
    'Departed East Fortune, 4 nm east of Haddington, 1800 ft on 1011. Plan: into the CTR at Musselburgh, across the Forth to Kirkcaldy Harbour.',
    'VFR in the zone is normally not above 2000 ft. Over the water you may want more height for glide range: ask if you do.',
    'Edinburgh Approach 121.205. Runway 24 in use.',
  ],
  async run(s) {
    const { ctx } = s;
    await s.leg('East of Haddington', 1.5, { cue: 'Call Edinburgh Approach when there is a gap.' });
    const det = details(ctx, { from: 'east fortune', to: 'perth', position: ['haddington', 'miles'], altitude: 1800,
      request: ['transit', 'zone transit', 'musselburgh', 'kirkcaldy'] });
    await initialCall(s, { unitName: 'Edinburgh Approach', det,
      requestItems: [P('request', ['transit', 'zone', 'request'], { soft: true, why: 'State your request on first contact.' })],
      model: 'Edinburgh Approach, {CS}, request zone transit',
      detailsModel: '{CS}, {TYPE}, East Fortune to Perth, 4 miles east of Haddington, altitude 1800 feet, QNH 1011, VFR, ' + (ctx.transponder ? '' : 'no transponder, ') + 'request transit Musselburgh to Kirkcaldy Harbour' });

    if (ctx.transponder) {
      await s.atc('{CALL}, squawk 6155, remain outside controlled airspace', { readback: [SQUAWK('6155'), ROS()], model: 'Squawk 6155, remain outside controlled airspace, {CALL}' });
      s.setRadio({ squawk: '6155' });
    } else {
      await s.atc('{CALL}, remain outside controlled airspace, report approaching Musselburgh', { readback: [ROS(), WILCO()], model: 'Remain outside controlled airspace, wilco, {CALL}' });
    }
    await s.leg('Westbound towards Musselburgh', 3);
    if (!ctx.transponder) {
      await s.expect({ id: 'approaching', cue: 'Approaching Musselburgh, outside the zone.', nudge: '{CALL}, report your position',
        items: [P('Musselburgh', ['musselburgh'])], model: '{CALL}, approaching Musselburgh, altitude 1800 feet' });
    }
    if (s.chance(0.3 + s.settings.refusalBias)) {
      await s.atc('{CALL}, hold outside controlled airspace east of Musselburgh, expect clearance in 5 minutes', {
        readback: [P('hold outside controlled airspace', ['hold outside', 'outside controlled airspace', 'remain outside'], { fix: 'hold outside controlled airspace' }), P('east of Musselburgh', ['musselburgh'], { soft: true })],
        model: 'Hold outside controlled airspace east of Musselburgh, {CALL}' });
      await s.leg('Holding east of Musselburgh', 3, { cue: 'Orbit outside controlled airspace.' });
    }
    await s.atc((ctx.transponder ? '{CALL}, identified 6 miles east of Musselburgh. ' : '{CALL}, ') +
      'Cleared to enter the Edinburgh control zone via Musselburgh, VFR, not above altitude 2000 feet, Edinburgh QNH 1012, report Musselburgh', {
      clearance: true,
      readback: [P('cleared to enter', ['cleared to enter', 'cleared into', 'cleared'], { fix: 'cleared to enter the Edinburgh control zone via Musselburgh' }),
        P('via Musselburgh', ['musselburgh'], { fix: 'via Musselburgh' }), P('VFR', ['vfr'], { fix: 'VFR' }), ...NOT_ABOVE(2000), QNH(1012), WILCO()],
      model: 'Cleared to enter the Edinburgh control zone via Musselburgh, VFR, not above altitude 2000 feet, QNH 1012, wilco, {CALL}' });
    await s.leg('Musselburgh', 3);
    await s.expect({ id: 'musselburgh', cue: 'Over Musselburgh Racecourse.', nudge: '{CALL}, report your position',
      items: [P('Musselburgh', ['musselburgh'])], model: '{CALL}, Musselburgh' });
    await s.atc('{CALL}, route direct Kirkcaldy Harbour, report Kirkcaldy Harbour', {
      readback: [P('direct Kirkcaldy Harbour', ['kirkcaldy'], { fix: 'direct Kirkcaldy Harbour' }), WILCO()], model: 'Direct Kirkcaldy Harbour, wilco, {CALL}' });
    const asked = await s.expect({ id: 'climb', optional: true, timeout: 50, cue: 'Coast ahead: 7 nm of water. Ask for more height now if you want it.',
      items: [P('request higher', ['request', 'climb', '2500', '3000', 'higher'])], model: '{CALL}, request altitude 2500 feet for the Forth crossing' });
    if (asked) {
      if (s.chance(0.7)) await s.atc('{CALL}, climb to altitude 2500 feet, VFR', { readback: [P('climb', ['climb'], { soft: true }), P('altitude 2500 feet', ['2500'], { fix: 'climb to altitude 2500 feet' })], model: 'Climb to altitude 2500 feet, VFR, {CALL}' });
      else await s.atc('{CALL}, unable due traffic, maintain not above altitude 2000 feet', { readback: NOT_ABOVE(2000), model: 'Not above altitude 2000 feet, {CALL}' });
    } else s.note('You crossed 7 nm of the Forth without asking for more height: consider glide range over water.');
    await s.leg('Crossing the Forth', 4);
    if (s.chance(0.6)) await s.atc('{CALL}, traffic is a helicopter, 3 miles west of you, southbound, altitude 1500 feet', { readback: [TRAFFIC_ACK()], model: 'Traffic in sight, {CALL}' });
    if (s.chance(0.3)) await s.atc('{CALL}, Edinburgh QNH 1011', { readback: [QNH(1011)], model: 'QNH 1011, {CALL}' });
    await s.leg('Kirkcaldy Harbour', 4);
    await s.expect({ id: 'kirkcaldy', cue: 'Over Kirkcaldy Harbour.', nudge: '{CALL}, report your position',
      items: [P('Kirkcaldy Harbour', ['kirkcaldy'])], model: '{CALL}, Kirkcaldy Harbour' });
    await s.atc('{CALL}, leave the zone northbound, report clear', {
      readback: [P('leave the zone northbound', ['northbound', 'north', 'leave'], { fix: 'leave the zone northbound' }), WILCO()], model: 'Leave the zone northbound, wilco, {CALL}' });
    await s.leg('North of Kirkcaldy', 3);
    await s.expect({ id: 'clear', cue: 'Crossing the CTR boundary.', nudge: '{CALL}, report your position',
      items: [P('clear of controlled airspace', ['clear', 'leaving', 'outside'])], model: '{CALL}, clear of controlled airspace' });
    await s.atc((ctx.transponder ? '{CALL}, squawk 7000, ' : '{CALL}, ') + 'freecall Scottish Information 119.875', {
      readback: [...(ctx.transponder ? [SQUAWK('7000')] : []), FREQ('119.875', 'Scottish Information')],
      model: (ctx.transponder ? 'Squawk 7000, ' : '') + 'Scottish Information 119.875, {CALL}' });
    s.setRadio({ squawk: ctx.transponder ? '7000' : null });
    s.end('Transit completed');
  },
};
