import { P, QNH, details, carlisleTraffic } from './common.js';

// Carlisle is an Air/Ground station: no clearances, no instructions. The pilot announces.
const AG_WARN = [
  { re: /\bcleared\b/, why: 'Carlisle Radio is Air/Ground: nobody can clear you. Don’t ask for or read back “cleared”.' },
  { re: /\brequest (landing|take ?off|taxi)\b/, why: 'At an Air/Ground field you announce intentions (“taxiing for 24”), you don’t request permission.' },
  { re: /\binstructions\b/, why: 'Air/Ground operators can’t give instructions: ask for airfield information.' },
];

export const carlisleArrival = {
  id: 'carlisle-arrival',
  title: 'Carlisle arrival',
  subtitle: 'Carlisle Radio (Air/Ground), overhead join runway 24',
  unit: 'Carlisle Radio',
  freq: '123.605',
  traffic: carlisleTraffic,
  warn: AG_WARN,
  briefing: ctx => [
    `${ctx.reg} (${ctx.type}), inbound to Carlisle from the north. PPR done by phone (01228 573641).`,
    'Carlisle Radio is Air/Ground, staffed on weekdays when possible. If nobody answers, make blind calls: “Carlisle Traffic … Carlisle”.',
    'Left-hand circuits at 1000 ft QFE; overhead join at 2000 ft QFE. QFE is about QNH − 7.',
  ],
  async run(s) {
    const { ctx } = s;
    ctx.blind = s.chance(0.25);
    await s.leg('10 nm north of Carlisle', 1.5, { cue: 'Call Carlisle Radio.' });
    const det = details(ctx, { from: 'kirkbride', to: 'carlisle', position: ['north', 'miles', 'city'], altitude: 2500, request: ['land', 'landing', 'join', 'inbound', 'airfield information'] });
    const detSoft = det.map(d => ({ ...d, hard: false, ask: undefined }));
    const initial = [P('PPR', ['ppr', 'prior permission'], { soft: true, why: 'Mention PPR so they can match you to the booking.' }), ...detSoft];
    await s.expect({ id: 'initial', initial: true, timeout: 240, cue: 'Make your initial call.', items: initial,
      model: 'Carlisle Radio, {CS}, {TYPE}, 10 miles north, north of the city, altitude 2500 feet, inbound to land, PPR, request airfield information' });
    const tag = [];
    if (ctx.blind) {
      const again = await s.expect({ id: 'initial-2', optional: true, timeout: 40, items: [], model: 'Carlisle Radio, {CS}, radio check' });
      s.note(again ? 'No answer from Carlisle Radio: it wasn’t staffed.' : 'No answer from Carlisle Radio and no second call.');
      await s.expect({ id: 'blind', optional: true, timeout: 60, cue: 'Nobody is answering.', items: [P('Carlisle Traffic', ['traffic'])], model: 'Carlisle Traffic, {CS}, 6 miles north, joining overhead for runway 24, Carlisle' });
      tag.push(P('Carlisle Traffic', ['carlisle traffic', 'traffic'], { soft: true, why: 'With no Air/Ground operator, start blind calls “Carlisle Traffic” and end them “Carlisle”.' }));
    } else {
      await s.atc('{CALL}, Carlisle Radio, runway 24 left-hand, QFE 1009, QNH 1016, one aircraft in the circuit', {
        readback: [P('runway 24', ['24'], { fix: 'runway 24' }), QNH(1009, 'QFE')],
        model: 'Runway 24 left-hand, QFE 1009, joining overhead, {CALL}' });
    }
    const ack = () => ctx.blind ? null : s.atc('{CALL}, roger');
    await s.leg('Inbound to the overhead', 4);
    await s.expect({ id: 'overhead', cue: 'Overhead at 2000 ft QFE.', items: [...tag, P('overhead', ['overhead'])], model: ctx.blind ? 'Carlisle Traffic, {CALL}, overhead, joining for runway 24, Carlisle' : '{CALL}, overhead, descending deadside for runway 24' });
    await ack();
    await s.leg('Descending deadside', 1.2);
    await s.expect({ id: 'deadside', optional: true, timeout: 25, cue: 'Descending on the deadside.', items: [...tag, P('deadside', ['deadside', 'descending'])], model: '{CALL}, descending deadside, runway 24' });
    await s.leg('Crosswind', 0.8);
    await s.expect({ id: 'downwind', cue: 'Downwind for 24.', items: [...tag, P('downwind', ['downwind']), P('runway', ['24'], { soft: true })], model: '{CALL}, downwind 24' });
    if (!ctx.blind) await s.atc(s.chance(0.5) ? '{CALL}, roger, one ahead, a Cessna 152 on base' : '{CALL}, roger, no reported traffic');
    await s.leg('Base leg', 1.2);
    await s.expect({ id: 'final', cue: 'Final 24.', items: [...tag, P('final', ['final']), P('runway', ['24'], { soft: true })], model: '{CALL}, final 24' });
    if (!ctx.blind) {
      await s.atc('{CALL}, roger, surface wind 230 degrees 8 knots');
      await s.expect({ id: 'final-ack', optional: true, timeout: 8, items: [], model: 'Roger, {CALL}' });
    }
    await s.leg('Landing', 0.6);
    await s.expect({ id: 'vacated', cue: 'Landed and clear of the runway.', items: [...tag, P('vacated', ['vacated', 'clear of the runway', 'runway clear', 'clear of'])], model: '{CALL}, runway vacated, taxiing to the south apron via Foxtrot' });
    if (!ctx.blind) await s.atc('{CALL}, roger, parking on the south apron');
    s.end(ctx.blind ? 'Landed: blind calls' : 'Landed');
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
    `${ctx.reg} (${ctx.type}) on the south apron, ready to go home to the north. Engine running, checks done.`,
    'Announce your intentions: nobody will clear you. Leave the ATZ to the north, then change to Scottish Information 119.875.',
  ],
  async run(s) {
    await s.leg('South apron', 0.3, { cue: 'Make your first call.' });
    await s.expect({ id: 'radio-check', initial: true, timeout: 180, cue: 'Radio check and departure information.',
      items: [P('radio check', ['radio check'], { soft: true }), P('departure information', ['departure information', 'airfield information', 'departure'], { soft: true }),
        P('position', ['apron', 'south'], { soft: true }), P('POB / destination', ['pob', 'person', 'to '], { soft: true })],
      model: 'Carlisle Radio, {CS}, radio check and request departure information' });
    await s.atc('{CALL}, Carlisle Radio, readability 5. Runway 24, left-hand, QNH 1016, surface wind 240 degrees 10 knots', {
      readback: [P('runway 24', ['24'], { fix: 'runway 24' }), QNH(1016)], model: 'Runway 24, QNH 1016, {CALL}' });
    await s.expect({ id: 'taxi', cue: 'Taxi for the hold.', items: [P('taxiing', ['taxiing', 'taxi']), P('runway', ['24'], { soft: true })], model: '{CALL}, taxiing for runway 24 via Foxtrot' });
    await s.atc('{CALL}, roger');
    await s.leg('Holding point, power checks', 0.4);
    await s.expect({ id: 'lineup', cue: 'Checks complete, ready to go.', items: [P('lining up', ['lining up', 'line up', 'entering', 'departing'])], model: '{CALL}, lining up runway 24' });
    await s.atc(s.chance(0.3) ? '{CALL}, roger, traffic is a Cessna 152 reported late downwind' : '{CALL}, roger, no reported traffic, surface wind 240 degrees 10 knots');
    await s.leg('Climbing out, turning north', 2.5);
    await s.expect({ id: 'leaving', cue: 'Leaving the ATZ to the north.', items: [P('leaving', ['leaving', 'departing', 'changing']), P('frequency', ['scottish', '119.875', 'frequency'], { soft: true, why: 'Say which frequency you’re changing to.' })], model: '{CALL}, leaving the ATZ to the north, changing to Scottish Information 119.875' });
    await s.atc('{CALL}, roger');
    s.end('Departed');
  },
};
