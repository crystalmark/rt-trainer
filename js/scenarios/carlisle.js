import { P, QNH, BASIC, WILCO, TRAFFIC_ACK, details, firstCall, initialCall, carlisleTraffic, londonInfoTraffic } from './common.js';

// Carlisle is an Air/Ground station: no clearances, no instructions. The pilot announces.
const AG_WARN = [
  { re: /\bcleared\b/, why: 'Carlisle Radio is Air/Ground: nobody can clear you. Don’t ask for or read back “cleared”.' },
  { re: /\brequest (landing|take ?off|taxi)\b/, why: 'At an Air/Ground field you announce intentions (“taxiing for 24”), you don’t request permission.' },
  { re: /\binstructions\b/, why: 'Air/Ground operators can’t give instructions: ask for airfield information.' },
];

// What the operator says about traffic gets an answer ("looking", or "roger" when there is none), and the answer is
// not the next call: on the early leg that follows, "Looking, G-IA" was taken for the final call and the real one then
// drew "say again". An Air/Ground operator doesn't chase an acknowledgement, so none is required.
function trafficInfo(s, id, traffic, text) {
  return s.atc(text, { reply: { id, optional: true, timeout: 8,
    items: traffic ? [{ ...TRAFFIC_ACK(), hard: false }] : [], model: traffic ? 'Looking, {CALL}' : 'Roger, {CALL}' } });
}

// Carlisle Radio, from the first call to clear of the runway: the same airfield whichever way you come in. An
// Air/Ground operator gives information and asks how you would like to join, because nobody there can tell you
// (a 2019 flight in shows exactly that: "traffic now short final runway two-four, how would you like to join?").
// Weekdays when possible, says the airport, and otherwise blind calls on the same frequency.
// Whether anyone is on the radio (ctx.blind when not) is settled before the flight reaches the frequency: settled here,
// the operator had already been heard answering other aircraft on a frequency with nobody on it.
async function arriveCarlisle(s, { from, where, position, pending = 'Call Carlisle Radio.' }) {
  const { ctx } = s;
  const det = details(ctx, { from, to: 'carlisle', position, altitude: 2500, request: ['land', 'landing', 'join', 'inbound', 'airfield information'] });
  const detSoft = det.map(d => ({ ...d, hard: false, ask: undefined }));
  const initial = [P('PPR', ['ppr', 'prior permission'], { soft: true, why: 'Mention PPR so they can match you to the booking.' }), ...detSoft];
  await firstCall(s, { id: 'initial', initial: true, timeout: 240, cue: pending, items: initial,
    model: `Carlisle Radio, {CS}, {TYPE}, ${where}, altitude 2500 feet, inbound to land, PPR, request airfield information` }, 'Carlisle Radio');
  const tag = [];
  let join = 'overhead';
  if (ctx.blind) {
    const again = await s.expect({ id: 'initial-2', optional: true, timeout: 40, items: [], model: 'Carlisle Radio, {CS}, radio check' });
    s.note(again ? 'No answer from Carlisle Radio: it wasn’t staffed.' : 'No answer from Carlisle Radio and no second call.');
    await s.expect({ id: 'blind', optional: true, timeout: 60, cue: 'Nobody is answering.', items: [P('Carlisle Traffic', ['traffic'])], model: 'Carlisle Traffic, {CS}, 6 miles out, joining overhead for runway 24, Carlisle' });
    tag.push(P('Carlisle Traffic', ['carlisle traffic', 'traffic'], { soft: true, why: 'With no Air/Ground operator, start blind calls “Carlisle Traffic” and end them “Carlisle”.' }));
  } else {
    const r = await s.atc('{CALL}, Carlisle Radio, runway 24 left-hand, QFE 1009, QNH 1016, one aircraft in the circuit, how would you like to join?', {
      readback: [P('runway 24', ['24'], { fix: 'runway 24' }), QNH(1009, 'QFE'),
        P('how you will join', ['overhead', 'downwind', 'base', 'straight in', 'long final'], { soft: true,
          why: 'An Air/Ground operator cannot tell you how to join: that is your decision, so say what it is.' })],
      model: 'Runway 24 left-hand, QFE 1009, joining overhead, {CALL}' });
    const said = (r && r.norm) || '';
    join = /\b(straight in|long final)\b/.test(said) ? 'final' : /\bbase\b/.test(said) ? 'base' : /\bdownwind\b/.test(said) ? 'downwind' : 'overhead';
  }
  const ack = () => ctx.blind ? null : s.atc('{CALL}, roger');
  if (join === 'overhead') {
    await s.leg('Inbound to the overhead', 4, { early: true });
    await s.expect({ id: 'overhead', cue: 'Overhead at 2000 ft QFE.', items: [...tag, P('overhead', ['overhead'])], model: ctx.blind ? 'Carlisle Traffic, {CALL}, overhead, joining for runway 24, Carlisle' : '{CALL}, overhead, descending deadside for runway 24' });
    await ack();
    await s.leg('Descending deadside', 1.2, { early: true });
    await s.expect({ id: 'deadside', optional: true, timeout: 25, cue: 'Descending on the deadside.', items: [...tag, P('deadside', ['deadside', 'descending'])], model: '{CALL}, descending deadside, runway 24' });
    await s.leg('Crosswind', 0.8, { early: true });
  } else if (join === 'downwind') {
    await s.leg('Joining downwind', 4, { early: true });
  }
  if (join === 'overhead' || join === 'downwind') {
    await s.expect({ id: 'downwind', cue: 'Downwind for 24.', items: [...tag, P('downwind', ['downwind']), P('runway', ['24'], { soft: true })], model: '{CALL}, downwind 24' });
    if (!ctx.blind) {
      const traffic = s.chance(0.5);
      await trafficInfo(s, 'downwind-ack', traffic, traffic ? '{CALL}, roger, one ahead, a Cessna 152 on base' : '{CALL}, roger, no reported traffic');
    }
    await s.leg('Base leg', 1.2, { early: true });
  } else if (join === 'base') {
    await s.leg('Joining on a long left base', 4, { early: true });
    await s.expect({ id: 'base', cue: 'Long left base for 24.', items: [...tag, P('base', ['base']), P('runway', ['24'], { soft: true })], model: '{CALL}, long left base 24' });
    await ack();
    await s.leg('Turning final', 1, { early: true });
  } else {
    await s.leg('Straight in for 24', 5, { early: true });
  }
  await s.expect({ id: 'final', cue: 'Final 24.', items: [...tag, P('final', ['final']), P('runway', ['24'], { soft: true })], model: '{CALL}, final 24' });
  if (!ctx.blind) {
    await s.atc('{CALL}, roger, surface wind 230 degrees 8 knots');
    await s.expect({ id: 'final-ack', optional: true, timeout: 8, items: [], model: 'Roger, {CALL}' });
  }
  await s.leg('Landing', 0.6, { early: true });
  await s.expect({ id: 'vacated', cue: 'Landed and clear of the runway.', items: [...tag, P('vacated', ['vacated', 'clear of the runway', 'runway clear', 'clear of'])], model: '{CALL}, runway vacated, taxiing to the south apron via Foxtrot' });
  if (!ctx.blind) await s.atc('{CALL}, roger, parking on the south apron');
  s.end(ctx.blind ? 'Landed: blind calls' : `Landed: ${join === 'overhead' ? 'overhead join' : join === 'final' ? 'straight in' : `joined ${join}`}`);
}

const CARLISLE = [
  ['Station', 'Carlisle Radio 123.605 is Air/Ground, staffed on weekdays when possible: information only, never a clearance.'],
  ['If no answer', 'Make blind calls on the same frequency: “Carlisle Traffic … Carlisle”.'],
  ['Joining', 'The operator will ask how you would like to join: it is your decision, so have one ready.'],
  ['Circuit', 'Left-hand at 1000 ft QFE; overhead join at 2000 ft QFE. QFE is about QNH − 7. Runways 06/24 and 01/19.'],
];

export const carlisleArrival = {
  id: 'carlisle-arrival',
  title: 'Carlisle arrival',
  subtitle: 'Carlisle Radio (Air/Ground), inbound from the north',
  unit: 'Carlisle Radio',
  freq: '123.605',
  traffic: carlisleTraffic,
  warn: AG_WARN,
  briefing: ctx => [
    ['Aircraft', `${ctx.reg}, ${ctx.type}, 1 POB.`],
    ['Flight', 'Inbound to Carlisle from the north, 10 nm out at 2500 ft. PPR done by phone (01228 573641).'],
    ...CARLISLE,
  ],
  async run(s) {
    s.ctx.blind = s.chance(0.25);                         // weekdays when possible: sometimes nobody is on
    await s.leg('10 nm north of Carlisle', 1.5, { cue: 'Call Carlisle Radio.' });
    return arriveCarlisle(s, { from: 'kirkbride', where: '10 miles north, north of the city', position: ['north', 'miles', 'city'], pending: 'Make your initial call.' });
  },
};

// From the south: up the Eden valley on a Basic Service from London Information, then over to Carlisle Radio.
// Sector I of London Information (125.475) covers the whole route from Oxenhope until north of Penrith, where
// the sector's edge turns north-east and leaves Carlisle to Scottish Information: UK AIP ENR 2.1 and ENR 6-32.
// A FISO has no radar, so there is no squawk to set and no traffic to be vectored round: only what others report.
export const carlisleSouth = {
  id: 'carlisle-south',
  title: 'Carlisle from the south',
  subtitle: 'London Information up the Eden valley, then Carlisle Radio',
  unit: 'London Information',
  freq: '125.475',
  traffic: (s, o) => /carlisle/i.test(s.ctx.unit) ? carlisleTraffic(s, o) : londonInfoTraffic(s, o),
  warn: AG_WARN,
  briefing: ctx => [
    ['Aircraft', `${ctx.reg}, ${ctx.type}, 1 POB.`],
    ['Flight', 'Oxenhope to Carlisle, VFR, about 75 nm. PPR to Carlisle done by phone (01228 573641).'],
    ['Route', 'Skipton, Settle, Ribblehead, Kirkby Stephen, Appleby, Penrith: up the Eden valley.'],
    ['Level', 'Altitude 3000 ft on the QNH over the Dales, where the tops are 2400 ft, descending to 2500 ft for Carlisle.'],
    ['En route', 'London Information 125.475 for a Basic Service: sector I, from Oxenhope to north of Penrith.'],
    ['Careful', 'A FISO has no radar. Traffic information is only what other pilots have reported: keep looking.', 'warn'],
    ...CARLISLE,
  ],
  async run(s) {
    const { ctx } = s;
    const unstaffed = s.chance(0.25);                     // Carlisle Radio, when you get there
    await s.leg('Climbing out of Oxenhope', 3, { cue: 'Call London Information for a Basic Service.', early: true });
    const det = details(ctx, { from: 'oxenhope', to: 'carlisle', position: ['skipton', 'miles', 'overhead', 'oxenhope'], altitude: 3000, request: ['basic service'] });
    await initialCall(s, { unitName: 'London Information', det,
      requestItems: [P('request basic service', ['basic service'], { soft: true, why: 'Ask for the service by name on first contact.' })],
      model: 'London Information, {CS}, request Basic Service',
      detailsModel: '{CS}, {TYPE}, Oxenhope to Carlisle, 3 miles south of Skipton, altitude 3000 feet, QNH 1016, VFR, routing Settle, Kirkby Stephen, Penrith' });
    await s.atc('{CALL}, London Information, Basic Service, report Kirkby Stephen', { readback: [BASIC(), WILCO()], model: 'Basic Service, wilco, {CALL}' });
    await s.leg('Skipton to Settle', 12, { cue: 'Long leg. Keep listening.' });
    if (s.chance(0.6)) {
      await s.atc('{CALL}, London Information, traffic information: a PA28 reported overhead Kirkby Stephen at 3000 feet, southbound', {
        readback: [P('acknowledged', ['looking', 'roger', 'traffic in sight', 'in sight', 'negative contact'], { why: 'Acknowledge it: “looking”, or “roger” if it is no factor.' })],
        model: 'Looking, {CALL}' });
    }
    await s.leg('Settle to Ribblehead', 8);
    await s.leg('Ribblehead to Kirkby Stephen', 12, { early: true });
    await s.expect({ id: 'kirkby-stephen', cue: 'Overhead Kirkby Stephen.', nudge: '{CALL}, London Information, report your position',
      items: [P('position', ['kirkby stephen', 'kirkby', 'kirby stephen']), P('altitude', ['feet', 'altitude'], { soft: true })],
      model: '{CALL}, Kirkby Stephen, altitude 3000 feet, next Penrith' });
    await s.atc('{CALL}, roger');
    await s.leg('Kirkby Stephen to Appleby', 8);
    await s.leg('Appleby to Penrith', 11, { early: true });
    const asked = await s.expect({ id: 'qsy', cue: 'Past Penrith, about 15 miles from Carlisle. Change to Carlisle Radio.',
      nudge: '{CALL}, London Information, say intentions',
      items: [P('changing frequency', ['changing', 'frequency', 'carlisle'])],
      model: '{CALL}, request frequency change to Carlisle Radio 123.605' });
    const f = asked && (asked.norm.match(/\b12[0-9]\.\d+\b/) || [])[0];
    if (f && f !== '123.605') s.note(`Carlisle Radio is 123.605, and you said ${f}.`);
    // Answered ("changing to Carlisle Radio"), that is still London's business: it used to be taken for the first
    // call to Carlisle Radio, cutting the leg short.
    await s.atc(asked ? '{CALL}, frequency change approved' : '{CALL}, Basic Service terminated', {
      reply: { id: 'qsy-ack', optional: true, timeout: 5, items: [], model: asked ? 'Changing to Carlisle Radio, {CALL}' : 'Roger, {CALL}' } });
    // A new station: a new frequency, a new voice, and the full callsign again until they shorten it.
    ctx.unit = 'Carlisle Radio'; ctx.abbreviated = false; ctx.blind = unstaffed;
    s.setRadio({ unit: 'Carlisle Radio', freq: '123.605' });
    await s.leg('Penrith towards Carlisle', 5, { cue: 'Call Carlisle Radio.', early: true });
    return arriveCarlisle(s, { from: 'oxenhope', where: '10 miles south, north of Penrith', position: ['south', 'miles', 'penrith'] });
  },
};

export const carlisleDeparture = {
  id: 'carlisle-departure',
  title: 'Carlisle departure',
  subtitle: 'Carlisle Radio, depart to the north for Scottish Information',
  unit: 'Carlisle Radio',
  freq: '123.605',
  traffic: carlisleTraffic,
  warn: AG_WARN,
  briefing: ctx => [
    ['Aircraft', `${ctx.reg}, ${ctx.type}, 1 POB. On the south apron, engine running, checks done.`],
    ['Flight', 'Home to the north, VFR.'],
    ['Plan', 'Announce your intentions: nobody will clear you. Leave the ATZ to the north.'],
    ['Then', 'Change to Scottish Information 119.875.'],
  ],
  async run(s) {
    await s.leg('South apron', 0.3, { cue: 'Make your first call.', early: true });
    await firstCall(s, { id: 'radio-check', initial: true, timeout: 180, cue: 'Radio check and departure information.',
      items: [P('radio check', ['radio check'], { soft: true }), P('departure information', ['departure information', 'airfield information', 'departure'], { soft: true }),
        P('position', ['apron', 'south'], { soft: true }), P('POB / destination', ['pob', 'person', 'to '], { soft: true })],
      model: 'Carlisle Radio, {CS}, radio check and request departure information' }, 'Carlisle Radio');
    await s.atc('{CALL}, Carlisle Radio, readability 5. Runway 24, left-hand, QNH 1016, surface wind 240 degrees 10 knots', {
      readback: [P('runway 24', ['24'], { fix: 'runway 24' }), QNH(1016)], model: 'Runway 24, QNH 1016, {CALL}' });
    await s.expect({ id: 'taxi', cue: 'Taxi for the hold.', items: [P('taxiing', ['taxiing', 'taxi']), P('runway', ['24'], { soft: true })], model: '{CALL}, taxiing for runway 24 via Foxtrot' });
    await s.atc('{CALL}, roger');
    await s.leg('Holding point, power checks', 0.4, { early: true });
    await s.expect({ id: 'lineup', cue: 'Checks complete, ready to go.', items: [P('lining up', ['lining up', 'line up', 'entering', 'departing'])], model: '{CALL}, lining up runway 24' });
    const traffic = s.chance(0.3);
    await trafficInfo(s, 'lineup-ack', traffic, traffic ? '{CALL}, roger, traffic is a Cessna 152 reported late downwind' : '{CALL}, roger, no reported traffic, surface wind 240 degrees 10 knots');
    await s.leg('Climbing out, turning north', 2.5, { early: true });
    await s.expect({ id: 'leaving', cue: 'Leaving the ATZ to the north.', items: [P('leaving', ['leaving', 'departing', 'changing']), P('frequency', ['scottish', '119.875', 'frequency'], { soft: true, why: 'Say which frequency you’re changing to.' })], model: '{CALL}, leaving the ATZ to the north, changing to Scottish Information 119.875' });
    await s.atc('{CALL}, roger');
    s.end('Departed');
  },
};
