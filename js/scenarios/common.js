// Building blocks for scenario scripts.
// P(label, phrases, opts) makes one readback item. Hard items trigger an ATC correction if missing;
// soft items ({ soft: true }) only show up in the debrief, with `why` as the teaching point.

export const P = (label, any, o = {}) => ({ label, any: [].concat(any), hard: !o.soft, ...o });

export const WILCO = () => P('wilco', ['wilco'], { soft: true, why: 'Instructions to report later are acknowledged with “wilco”.' });
export const QNH = (v, name = 'QNH') => P(`${name} ${v}`, [String(v)], { fix: `${name} ${v}` });
export const SQUAWK = v => P(`squawk ${v}`, [String(v)], { fix: `squawk ${v}` });
export const FREQ = (v, name) => P(`${name} ${v}`, [String(v)], { fix: `${name} ${v}` });
export const BASIC = () => P('Basic Service', ['basic service', 'basic'], { fix: 'Basic Service', why: 'The type of service must be read back.' });
export const NOT_ABOVE = v => [
  P('not above', ['not above'], { fix: `not above altitude ${v} feet` }),
  P(`altitude ${v} feet`, [String(v)], { fix: `not above altitude ${v} feet` }),
];
export const ROS = () => P('remain outside controlled airspace', ['remain outside controlled airspace'], {
  substitutes: ['zone', 'outside the zone', 'remain outside'],
  fix: 'remain outside controlled airspace',
  why: 'Read back the controller’s exact words. Controlled airspace includes the CTAs, not just the zone.',
});
export const TRAFFIC_ACK = () => P('traffic acknowledged', ['traffic in sight', 'in sight', 'looking', 'visual', 'negative contact', 'not sighted', 'no contact'], {
  why: 'Answer traffic information with “looking”, “traffic in sight” or “negative contact”.',
});

/** Items for the "pass your message" details call. */
export function details(ctx, { from, to, position, altitude, request, emailed = false }) {
  const items = [
    P('aircraft type', [ctx.type, 'microlight', 'flexwing', 'flex wing', 'quik', 'quikr', 'quick r', 'fox'], { soft: true, why: 'Type tells ATC your speed and performance.' }),
    P('departure and destination', [from, to], { soft: true, why: 'Give where you’re from and to.' }),
    P('position', [].concat(position), { ask: '{CALL}, say position', why: 'Position against something ATC can find on their screen.' }),
    P('altitude', [String(altitude), 'altitude', 'feet'], { ask: '{CALL}, say altitude', why: 'Altitude and pressure setting are essential.' }),
    P('pressure setting', ['qnh', 'regional', 'qfe', 'rps'], { soft: true, why: 'Say which pressure setting your altitude is on.' }),
    P('flight rules', ['vfr'], { soft: true, why: 'State VFR.' }),
    P('request', [].concat(request), { soft: true, why: 'End with what you want.' }),
  ];
  if (!ctx.transponder) items.push(P('no transponder', ['no transponder', 'non transponder', 'not transponder', 'transponder not fitted', 'negative transponder', 'without transponder', 'no mode'], { soft: true, key: 'noxpdr', why: 'Say you have no transponder up front: it changes how ATC can handle you.' }));
  if (emailed) items.push(P('flight details emailed', ['emailed', 'email', 'details sent', 'flight plan'], { soft: true, key: 'emailed', why: 'Mention the pre-notified flight details so they look for your strip.' }));
  return items;
}

export function abbr(reg) {
  const l = reg.replace(/[^A-Z]/g, '');
  return `${l[0]}-${l.slice(-2)}`;
}

// ---------- background traffic ----------
const GA = ['G-BSXY', 'G-OJAB', 'G-CDFK', 'G-BYNK', 'G-EGLE', 'G-SACR', 'G-BOTE', 'G-CFMW'];
const GA_TYPES = ['PA28', 'Cessna 172', 'C42', 'Robin', 'Eurostar', 'Grumman'];

function pick(s, a) { return s.pick(a); }

export function leedsTraffic(s, { similar }) {
  const qnh = s.ctx.qnh || 1017;              // your route sets the flight's QNH; the scripted Leeds flights use 1017
  const air = pick(s, ['Channex 47', 'Easy 64 Kilo', 'Ryanair 2 Kilo Papa', 'Tomjet 5 Charlie', 'KLM 17 Mike', 'Channex 12']);
  const ga = pick(s, GA); const gab = abbr(ga);
  const hdg = pick(s, ['140', '100', '350', '210']);
  const options = [
    [[air, `Leeds Radar, ${air}, descending flight level 70, information Delta`],
     ['atc', `${air}, Leeds Radar, identified, descend to altitude 4000 feet, QNH ${qnh}, vectors ILS runway 32`],
     [air, `Descend altitude 4000 feet, QNH ${qnh}, vectors ILS 32, ${air}`]],
    [['atc', `${air}, turn left heading ${hdg}, reduce speed 180 knots`], [air, `Left heading ${hdg}, speed 180 knots, ${air}`]],
    [['atc', `${air}, contact Leeds Tower 120.305`], [air, `Tower 120.305, ${air}`]],
    [[air, `Leeds Radar, ${air}, passing altitude 3500 feet, climbing flight level 70`],
     ['atc', `${air}, Leeds Radar, identified, climb flight level 110`], [air, `Climb flight level 110, ${air}`]],
    [[ga, `Leeds Radar, ${ga}, request Basic Service`], ['atc', `${ga}, Leeds Radar, pass your message`],
     [ga, `${ga}, ${pick(s, GA_TYPES)}, Sherburn to Blackpool, overhead Wetherby, altitude 2400 feet, QNH ${qnh}, VFR, remaining outside controlled airspace`],
     ['atc', `${gab}, Basic Service, squawk 5626`], [ga, `Basic Service, squawk 5626, ${gab}`]],
    [['atc', `${gab}, traffic is a helicopter, 3 miles north of you, southbound, altitude 1500 feet`], [ga, `Looking, ${gab}`]],
    [['atc', `${similar}, report Harrogate`, { similar }], [similar, `Wilco, ${similar}`]],
    [['Police 51', 'Leeds Radar, Police 51, lifted Carr Gate, request zone entry to operate over Bradford, not above altitude 2000 feet'],
     ['atc', `Police 51, cleared to enter the Leeds control zone, not above altitude 2000 feet, QNH ${qnh}, report operating`],
     ['Police 51', `Cleared to enter, not above altitude 2000 feet, QNH ${qnh}, wilco, Police 51`]],
    [['atc', `${air}, radar vectors complete, cleared ILS approach runway 32, report established`], [air, `Cleared ILS 32, wilco, ${air}`]],
  ];
  return pick(s, options);
}

export function edinburghTraffic(s, { similar }) {
  const air = pick(s, ['Loganair 6 Hotel', 'Easy 12 Tango', 'Ryanair 8 Echo Kilo', 'KLM 17 Mike', 'Speedbird 1488', 'Jet2 61']);
  const ga = pick(s, GA); const gab = abbr(ga);
  const options = [
    [[air, `Edinburgh Approach, ${air}, descending flight level 80, information Kilo`],
     ['atc', `${air}, Edinburgh Approach, descend to altitude 4000 feet, QNH 1012, vectors ILS runway 24`],
     [air, `Descend altitude 4000 feet, QNH 1012, vectors ILS 24, ${air}`]],
    [['atc', `${air}, turn right heading 270, descend to altitude 3000 feet`], [air, `Right heading 270, descend altitude 3000 feet, ${air}`]],
    [['atc', `${air}, contact Edinburgh Tower 118.705`], [air, `Tower 118.705, ${air}`]],
    [[ga, `Edinburgh Approach, ${ga}, request zone transit`], ['atc', `${ga}, Edinburgh Approach, standby`]],
    [['atc', `${gab}, cleared to leave controlled airspace via Cobbinshaw Reservoir, not above altitude 2000 feet`], [ga, `Cleared to leave via Cobbinshaw, not above altitude 2000 feet, ${gab}`]],
    [['atc', `${similar}, report Kelty`, { similar }], [similar, `Wilco, ${similar}`]],
    [['Rescue 199', 'Edinburgh Approach, Rescue 199, 5 miles south of Dalkeith, altitude 1500 feet, request transit to the Forth Road Bridge'],
     ['atc', 'Rescue 199, cleared to enter the Edinburgh control zone, route direct Forth Road Bridge, not above altitude 1500 feet, QNH 1012'],
     ['Rescue 199', 'Cleared direct Forth Road Bridge, not above altitude 1500 feet, QNH 1012, Rescue 199']],
  ];
  return pick(s, options);
}

export function scottishTraffic(s, { similar }) {
  const ga = pick(s, GA); const gab = abbr(ga);
  const pos = pick(s, ['overhead Perth', '5 miles south of Crieff', 'overhead Pitlochry', 'abeam Montrose', 'overhead Glenrothes', '10 miles north of Stirling']);
  const options = [
    [[ga, `Scottish Information, ${ga}, request Basic Service`], ['atc', `${ga}, Scottish Information, pass your message`],
     [ga, `${ga}, ${pick(s, GA_TYPES)}, Cumbernauld to Inverness, ${pos}, altitude 3000 feet, QNH 1011, VFR, next Aviemore at 45`],
     ['atc', `${gab}, Basic Service, squawk 7401, Scottish Regional Pressure 1008`], [ga, `Basic Service, squawk 7401, 1008, ${gab}`]],
    [[ga, `${gab}, position ${pos}, altitude 2500 feet`], ['atc', `${gab}, roger`]],
    [['atc', 'All stations, Scottish Information, the Tay area regional pressure setting is 1009']],
    [['atc', `${gab}, Scottish Information, parachuting active at Strathallan, up to flight level 150`], [ga, `Roger, ${gab}`]],
    [[ga, `${gab}, leaving your frequency, squawking 7000`], ['atc', `${gab}, roger`]],
    [['atc', `${similar}, Scottish Information, report your position`, { similar }], [similar, `${similar}, 4 miles north of Kinross, altitude 2000 feet`], ['atc', `${similar}, roger`]],
  ];
  return pick(s, options);
}

export function carlisleTraffic(s) {
  const options = [
    [['G-BOTE', 'G-TE, downwind 24, touch and go'], ['atc', 'G-TE, roger']],
    [['G-BOTE', 'G-TE, final 24'], ['atc', 'G-TE, roger, surface wind 230 degrees 8 knots']],
    [['Coastguard 199', 'Carlisle Radio, Coastguard 199, lifting from the northern apron, departing to the west, 4 POB'], ['atc', 'Coastguard 199, roger, runway 24 in use, QNH 1016, no reported traffic to the west']],
    [['G-CFMW', 'Carlisle Radio, G-CFMW, radio check and request departure information'], ['atc', 'G-CFMW, readability 5, runway 24 left-hand, QNH 1016, surface wind 240 degrees 10 knots'], ['G-CFMW', 'Runway 24, QNH 1016, G-MW']],
    [['G-CFMW', 'G-MW, lining up runway 24'], ['atc', 'G-MW, roger']],
  ];
  const ex = pick(s, options);
  if (!s.ctx.blind) return ex;
  // No Air/Ground operator: other pilots make blind calls and nobody answers.
  return ex.filter(l => l[0] !== 'atc' && !/radio check/.test(l[1]))
    .map(l => [l[0], `Carlisle Traffic, ${l[1].replace(/^Carlisle Radio, /, '')}, Carlisle`]);
}

/**
 * Initial call + "pass your message". If the pilot gives full details on first contact the
 * controller skips straight on, and the debrief notes it.
 */
export async function initialCall(s, { unitName, requestItems = [], det, model, detailsModel }) {
  const init = await s.expect({ id: 'initial', initial: true, timeout: 240, cue: 'Make your initial call.',
    items: [...requestItems, ...det.map(d => ({ ...d, hard: false, ask: undefined }))], model });
  const gave = init && ['position', 'altitude'].every(l => init.items.some(i => i.label === l && i.matched));
  if (gave) {
    s.note('Full details on first contact: fine on a quiet frequency. On a busy one, make a short initial call and wait for “pass your message”.');
    return init;
  }
  return s.atc(`{CS}, ${unitName}, pass your message`, { reply: { id: 'details', items: det, timeout: 20, model: detailsModel } });
}
