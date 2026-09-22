import { P, WILCO, SQUAWK, BASIC, QNH, TRAFFIC_ACK, details, initialCall, scottishTraffic } from './common.js';

export default {
  id: 'scottish-info',
  title: 'Scottish Information',
  subtitle: 'Long Basic Service leg, Carlisle → East Fortune',
  unit: 'Scottish Information',
  freq: '119.875',
  traffic: scottishTraffic,
  briefing: ctx => [
    `${ctx.reg} (${ctx.type}), Carlisle to East Fortune via Langholm, Hawick and Lauder, about 75 nm.`,
    'A long listening watch: other aircraft giving position reports, broadcasts, and occasional calls to you. Get on with something else and listen for your callsign.',
    'Scottish Information 119.875 (0800–2000, surface to FL55). Basic Service only: no radar, you avoid traffic.',
  ],
  async run(s) {
    const { ctx } = s;
    await s.leg('Leaving the Carlisle ATZ to the north', 2, { cue: 'Call Scottish Information for a Basic Service.' });
    const det = details(ctx, { from: 'carlisle', to: 'east fortune', position: ['carlisle', 'miles', 'longtown'], altitude: 2500, request: ['langholm', 'hawick', 'lauder', 'next', 'routing', 'eta'] });
    await initialCall(s, { unitName: 'Scottish Information', det,
      requestItems: [P('request basic service', ['basic service'], { soft: true, why: 'Ask for the service by name.' })],
      model: 'Scottish Information, {CS}, request Basic Service',
      detailsModel: '{CS}, {TYPE}, Carlisle to East Fortune, 5 miles north of Carlisle, altitude 2500 feet, QNH 1016, VFR, routing Langholm, Hawick, Lauder, next Langholm at 25' });
    await s.atc((ctx.transponder ? '{CALL}, Basic Service, squawk 7401, ' : '{CALL}, Basic Service, ') + 'Scottish regional pressure 1011', {
      readback: [BASIC(), ...(ctx.transponder ? [SQUAWK('7401')] : []), QNH(1011, 'regional pressure')],
      model: (ctx.transponder ? 'Basic Service, squawk 7401, ' : 'Basic Service, ') + '1011, {CALL}' });
    if (ctx.transponder) s.setRadio({ squawk: '7401' });
    await s.leg('North towards Langholm', 18, { cue: 'Long leg. Keep listening.' });
    if (s.chance(0.7)) {
      await s.atc('{CALL}, Scottish Information, Danger Area 510 Spadeadam is active up to flight level 100', {
        readback: [P('acknowledged', ['roger', 'danger area', 'spadeadam', 'copied'], { soft: true })], model: 'Roger, {CALL}' });
    }
    await s.expect({ id: 'langholm', cue: 'Overhead Langholm.', nudge: '{CALL}, Scottish Information, report your position', timeout: 90,
      items: [P('position', ['langholm']), P('altitude', ['feet', 'altitude'], { soft: true }), P('next point and ETA', ['hawick', 'next'], { soft: true, why: 'Give your next point and estimate.' })],
      model: '{CALL}, Langholm, altitude 2500 feet, next Hawick at 50' });
    await s.atc('{CALL}, roger');
    await s.leg('Langholm to Hawick', 18, { cue: 'Keep listening.' });
    if (s.chance(0.5)) await s.atc('{CALL}, traffic reported is a PA28, 5 miles north of Hawick, southbound, altitude 3000 feet', { readback: [TRAFFIC_ACK()], model: 'Looking, {CALL}' });
    await s.expect({ id: 'hawick', cue: 'Overhead Hawick.', nudge: '{CALL}, Scottish Information, report your position', timeout: 90,
      items: [P('position', ['hawick']), P('altitude', ['feet', 'altitude'], { soft: true }), P('next point', ['lauder', 'next'], { soft: true })],
      model: '{CALL}, Hawick, altitude 2500 feet, next Lauder at 20' });
    await s.atc('{CALL}, roger');
    await s.leg('Hawick to Lauder', 22, { cue: 'Keep listening.' });
    if (s.chance(0.4)) await s.atc('All stations, Scottish Information, the Scottish regional pressure setting is now 1010');
    await s.expect({ id: 'lauder', cue: 'Overhead Lauder.', nudge: '{CALL}, Scottish Information, report your position', timeout: 90,
      items: [P('position', ['lauder']), P('altitude', ['feet', 'altitude'], { soft: true })], model: '{CALL}, Lauder, altitude 2500 feet, next East Fortune at 45' });
    await s.atc('{CALL}, roger');
    await s.leg('Lauder towards East Fortune', 12);
    await s.expect({ id: 'qsy', cue: 'Time to change to East Fortune’s frequency.', nudge: '{CALL}, Scottish Information, say intentions',
      items: [P('changing frequency', ['changing', 'frequency', 'leaving'])], model: '{CALL}, 8 miles south of East Fortune, changing to East Fortune' });
    await s.atc(ctx.transponder ? '{CALL}, squawk 7000, frequency change approved' : '{CALL}, frequency change approved', {
      readback: [...(ctx.transponder ? [SQUAWK('7000')] : []), P('frequency change approved', ['frequency change', 'changing'], { soft: true })],
      model: (ctx.transponder ? 'Squawk 7000, ' : '') + 'frequency change approved, {CALL}' });
    s.end('Leg completed');
  },
};
