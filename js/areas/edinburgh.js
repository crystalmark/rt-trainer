// Edinburgh: controlled airspace, VRPs and the landmarks a controller or pilot might use around the zone.
// Airspace: UK AIP AD 2.17 EGPH (the CTR and ATZ) and ENR 2.1 (the CTAs), AIRAC 2026-09-03, copied point for
// point so it can be checked against the AIP text. Unlike Leeds, the CTR is published as a plain circle with no
// vertex list, and every CTA arc runs anti-clockwise, because the CTAs tile the ring outside that circle.
// VRPs: the NATS AIS VRP dataset (js/data/vrps.js). Landmark positions: GeoNames and OpenStreetMap, via
// scripts/places.mjs. `hear` lists what speech recognition may make of a name (the first entry is the name as
// it should be said); `say` is how the speech synthesiser should pronounce it.
import { at, circle } from '../geo.js';
import { VRPS } from '../data/vrps.js';
import { edinburghTraffic } from '../scenarios/common.js';

const ARP = at('555700N 0032221W');   // centre of the CTR, the ATZ and every CTA arc
const arc = to => ({ arc: 'ccw', radius: 10, centre: ARP, to: at(to) });

// "following the line of latitude to" (CTA 2, 3 and 4) is a constant-latitude segment: on a flat nm grid that
// is the straight line between the two points anyway, so it needs nothing special here.
const AIRSPACE = [
  { name: 'Edinburgh CTR', kind: 'CTR', cls: 'D', base: 0, top: 6000, boundary: circle(ARP, 10) },
  { name: 'Edinburgh CTA 1', kind: 'CTA', cls: 'D', base: 2500, top: 6000, boundary: [
    at('555916N 0033941W'), arc('554851N 0033235W'),
    at('554349N 0034715W'), at('554806N 0035411W'), at('555417N 0035413W')] },
  { name: 'Edinburgh CTA 2', kind: 'CTA', cls: 'D', base: 2500, top: 6000, boundary: [
    at('560700N 0032221W'), at('560700N 0025608W'), at('560008N 0024849W'),
    at('555442N 0030503W'), arc('560700N 0032221W')] },
  { name: 'Edinburgh CTA 3', kind: 'CTA', cls: 'D', base: 3500, top: 6000, boundary: [
    at('560700N 0034855W'), at('560700N 0032221W'), arc('555916N 0033941W'),
    at('555417N 0035413W'), at('555724N 0035417W')] },
  { name: 'Edinburgh CTA 4', kind: 'CTA', cls: 'D', base: 3500, top: 6000, boundary: [
    at('560008N 0024849W'), at('554125N 0025510W'), at('554125N 0034324W'),
    at('554349N 0034715W'), at('554851N 0033235W'), arc('555442N 0030503W')] },
];

// The published VRPs, by the name a controller would use on the radio. Keyed by the dataset's name, because
// the Edinburgh VRPs have no designator in the dataset.
const VRP_RT = {
  "Arthur's Seat": { name: "Arthur's Seat", hear: ['arthurs seat', 'arthur seat', 'arthur street'] },
  'Bathgate Railway Station': { name: 'Bathgate', hear: ['bathgate', 'bathgate railway station', 'bath gate'] },
  'Cobbinshaw Reservoir': { name: 'Cobbinshaw Reservoir', hear: ['cobbinshaw reservoir', 'cobbinshaw', 'cobbin shaw', 'copenshaw'] },
  'Dalkeith': { name: 'Dalkeith', hear: ['dalkeith', 'dalkieth', 'dal keith', 'dalkeath'], say: 'Dal-keeth' },
  'Forth Road Bridge (North Tower)': { name: 'Forth Road Bridge', hear: ['forth road bridge', 'fourth road bridge', 'forth bridge', 'road bridge'] },
  'Hillend Ski Slope': { name: 'Hillend', hear: ['hillend', 'hill end', 'hillend ski slope', 'ski slope'] },
  'Kirkcaldy Harbour': { name: 'Kirkcaldy Harbour', hear: ['kirkcaldy harbour', 'kirkcaldy', 'kirkaldy', 'kircoddy', 'kirk caldy'], say: 'Kir-coddy Harbour' },
  'Kirknewton Railway Station': { name: 'Kirknewton', hear: ['kirknewton', 'kirk newton', 'kirknewton railway station'] },
  'Longannet Power Station': { name: 'Longannet', hear: ['longannet', 'long annet', 'longannet power station', 'long and it'] },
  'M8 Junction 1 (Hermiston)': { name: 'M8 Junction 1', hear: ['m8 junction 1', 'm 8 junction 1', 'hermiston', 'm8 j1'] },
  'M9 Junction 1A (Kirkliston)': { name: 'M9 Junction 1A', hear: ['m9 junction 1a', 'm 9 junction 1 a', 'kirkliston', 'kirk liston'] },
  'M9 Junction 2 (Philpstoun)': { name: 'M9 Junction 2', hear: ['m9 junction 2', 'm 9 junction 2', 'philpstoun', 'philipstown'] },
  'M9 Junction 4 (Polmont)': { name: 'M9 Junction 4', hear: ['m9 junction 4', 'm 9 junction 4', 'polmont', 'pole mont'] },
  'M90 Junction 4 (Kelty)': { name: 'M90 Junction 4', hear: ['m90 junction 4', 'm 90 junction 4', 'kelty', 'kelty junction'] },
  'Musselburgh Racecourse': { name: 'Musselburgh', hear: ['musselburgh', 'mussel burgh', 'muscleboro', 'racecourse'] },
  'Penicuik': { name: 'Penicuik', hear: ['penicuik', 'penny cook', 'pennycuik', 'peni cook'], say: 'Penny-cook' },
  'West Linton Golf Course': { name: 'West Linton', hear: ['west linton', 'west lynton', 'west linton golf course'] },
};

// [name, lat, lon, kind, extra things speech recognition may hear, pronunciation]
const LANDMARKS = [
  ['Livingston', 55.9029, -3.5226, 'town'], ['Linlithgow', 55.9764, -3.6036, 'town', ['lin lithgow', 'linlithgo']],
  ['Falkirk', 56.0021, -3.7854, 'town', ['fal kirk']], ['Grangemouth', 56.0114, -3.7218, 'town', ['grange mouth']],
  ["Bo'ness", 56.0167, -3.6167, 'town', ['bo ness', 'boness', 'bonus']], ['South Queensferry', 55.9909, -3.3985, 'town', ['queensferry', 'queens ferry']],
  ['Haddington', 55.9561, -2.7833, 'town', ['had ington']], ['North Berwick', 56.0583, -2.7229, 'town', ['north berrick', 'berwick'], 'North Berrick'],
  ['Dunbar', 56.0006, -2.5142, 'town', ['dun bar']], ['Gullane', 56.0365, -2.8283, 'village', ['gillan', 'gull ane'], 'Gillan'],
  ['Tranent', 55.9444, -2.9541, 'town', ['tra nent']], ['Prestonpans', 55.9594, -2.9804, 'town', ['preston pans']],
  ['Burntisland', 56.0587, -3.2366, 'town', ['burnt island', 'burntiland'], 'Burnt-island'],
  ['Aberdour', 56.0542, -3.3006, 'village', ['aber dour', 'aberdore']], ['Inverkeithing', 56.033, -3.3956, 'town', ['inver keithing']],
  ['Dunfermline', 56.0716, -3.4589, 'town', ['dun fermline', 'dumfermline']], ['Rosyth', 56.0369, -3.438, 'town', ['ross ithe', 'rosith'], 'Ro-syth'],
  ['Kinross', 56.2047, -3.4214, 'town', ['kin ross']], ['Glenrothes', 56.1951, -3.1732, 'town', ['glen rothes', 'glenrothis']],
  ['Leven', 56.2, -3.0, 'town', ['leaven']], ['Alloa', 56.1159, -3.79, 'town', ['aloha', 'all oa']],
  ['Peebles', 55.6519, -3.1888, 'town', ['peebles hydro']], ['Broxburn', 55.9342, -3.4713, 'town', ['brox burn']],
  ['Winchburgh', 55.9579, -3.4646, 'village', ['winch burgh']], ['Ratho', 55.9216, -3.3803, 'village', ['rathoe', 'rat ho']],
  ['Balerno', 55.8844, -3.3397, 'village', ['ballerno', 'bal erno']], ['Currie', 55.8964, -3.3085, 'village', ['curry']],
  ['Loanhead', 55.8794, -3.1587, 'town', ['loan head']], ['Bonnyrigg', 55.8733, -3.1051, 'town', ['bonny rigg']],
  ['Gorebridge', 55.8459, -3.0456, 'town', ['gore bridge']], ['Longniddry', 55.9754, -2.8959, 'village', ['long niddry']],
  ['Aberlady', 56.0088, -2.8585, 'village', ['aber lady']], ['Drem', 56.0056, -2.7877, 'village', ['dream', 'drum']],
  ['Carlops', 55.7902, -3.34, 'village', ['car lops']], ['Lasswade', 55.8834, -3.115, 'village', ['lass wade']],
  ['Pathhead', 55.8667, -2.9667, 'village', ['path head']], ['Culross', 56.0555, -3.6261, 'village', ['coo ross', 'cull ross'], 'Coo-ross'],
  ['Blackford Hill', 55.9231, -3.1947, 'hill', ['blackford']], ['Torness', 55.9683, -2.4088, 'power station', ['torness power station', 'tor ness']],
  ['Harperrig Reservoir', 55.8339, -3.4416, 'reservoir', ['harperrig', 'harper rig']],
  ['Threipmuir Reservoir', 55.8609, -3.32, 'reservoir', ['threipmuir', 'threep muir', 'trip moor'], 'Threep-mure'],
  ['Loch Leven', 56.1993, -3.3689, 'loch', ['loch leaven']], ['Bass Rock', 56.0775, -2.6406, 'island', ['the bass rock']],
  ['Berwick Law', 56.0488, -2.7138, 'hill', ['north berwick law', 'berrick law'], 'Berrick Law'],
  // East Fortune: the flexwing school based there gives callsign East Fortune on 118.755, elevation 115 ft.
  ['East Fortune', 56.0001, -2.7342, 'airfield', ['east fortune airfield', 'fortune', 'east fortune radio']],
  // The airport itself, for routeing via the overhead: at the ARP (AD 2.2), 2.5 nm ATZ to 2112 ft ALT around it.
  ['Edinburgh Airport', 55.95, -3.3725, 'airfield', ['edinburgh airport', 'the airport', 'overhead the airport', 'the overhead', 'airport overhead']],
  // GA crossing the airport is sent north of the runway 24 threshold, the north-east end (AD 2.12: 555717.66N 0032128.66W).
  ['Runway 24 threshold', 55.95491, -3.35796, 'point', ['24 threshold', 'runway 24 threshold', 'the threshold', 'north of the threshold', 'overhead']],
  // The Forth Road Bridge is the VRP; the other two of the three bridges are landmarks for orbiting them.
  ['Forth Bridge', 55.9998, -3.3883, 'bridge', ['forth rail bridge', 'rail bridge', 'the bridges', 'the three bridges']],
  ['Queensferry Crossing', 56.0012, -3.4148, 'bridge', ['queensferry crossing', 'the new bridge', 'crossing']],
];

const lower = s => s.toLowerCase();
const vrps = VRPS.EGPH.map(v => {
  const rt = VRP_RT[v.name];
  if (!rt) throw new Error(`Edinburgh VRP without an RT name: ${v.name}`);
  return { id: lower(rt.name).replace(/\W+/g, '-'), kind: 'vrp', official: v.name, lat: v.lat, lon: v.lon, ...rt,
    hear: [lower(rt.name), ...rt.hear] };
});
const landmarks = LANDMARKS.map(([name, lat, lon, kind, hear = [], say]) => ({
  id: lower(name).replace(/\W+/g, '-'), kind, name, lat, lon, hear: [lower(name), ...hear], ...(say ? { say } : {}),
}));

export default {
  id: 'edinburgh',
  name: 'Edinburgh',
  icao: 'EGPH',
  unit: 'Edinburgh Approach',
  freq: '121.205',
  zone: 'the Edinburgh control zone',
  qnhName: 'Edinburgh QNH',
  transitionAltitude: 6000,           // the Scottish TMA's: route plans go up to 5900 ft here (5000 elsewhere)
  squawks: '62',                      // the first two digits of the codes the unit hands out (illustrative)
  listeningSquawk: '0440',
  origin: ARP,
  // Runway thresholds: AIP AD 2.12. One runway only. The ATZ is a 2.5 nm circle.
  airport: { name: 'Edinburgh', ...ARP, atz: 2.5, runways: [['06/24', at('555641.99N 0032313.90W'), at('555717.66N 0032128.66W')]] },
  airspace: AIRSPACE,
  places: [...vrps, ...landmarks],
  traffic: edinburghTraffic,
  facts: [
    'Edinburgh Approach and Edinburgh Radar are the same frequency, 121.205. Edinburgh Information (ATIS) 131.355.',
    'The CTR is a 10 nm circle around the airport, Class D, surface to 6000 ft.',
    'Outside it the CTAs start at 2500 ft to the north-east and west, and 3500 ft to the north-west and south.',
    'Monitoring 121.205 near the zone without a service: listening squawk 0440. Edinburgh Radar may call you blind on it.',
    'Transition altitude is 6000 ft, not the usual 3000 or 5000.',
  ],
};
