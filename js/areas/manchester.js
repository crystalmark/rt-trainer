// Manchester: controlled airspace, VRPs and the landmarks a controller or pilot might use around the zone.
// Airspace: UK AIP AD 2.17 EGCC (the CTR and ATZ) and ENR 2.1 (the CTAs and TMA), AIRAC 2026-09-03, copied
// point for point so it can be checked against the AIP text. There is not an arc in any of it: only the ATZ is
// circular. VRPs: the NATS AIS VRP dataset (js/data/vrps.js). Landmark positions: GeoNames and OpenStreetMap,
// via scripts/places.mjs. `hear` lists what speech recognition may make of a name (the first entry is the name
// as it should be said); `say` is how the speech synthesiser should pronounce it.
//
// The Manchester Low Level Route is gone: it was withdrawn at 0001 on 20 February 2025 (AIC Y 004/2025) and
// the words do not appear in the AIP any more. What replaced it is the North West Transit Corridor, EGR323,
// which is CLASS G from the surface to 1500 ft — no clearance, no RT, nothing to ask for. So it is deliberately
// not in AIRSPACE: below 1500 ft the corridor plans as an ordinary flight outside controlled airspace, which is
// exactly what it now is. CTA 6, base 1500 ft, is its lid and shares its boundary exactly.
import { at } from '../geo.js';
import { VRPS } from '../data/vrps.js';
import { manchesterTraffic } from '../scenarios/common.js';

const ARP = at('532113N 0021630W');   // mid point of runway 05L/23R

const AIRSPACE = [
  { name: 'Manchester CTR', kind: 'CTR', cls: 'D', lower: 'SFC', upper: '3500 FT ALT', boundary: [
    at('533430N 0020400W'), at('532730N 0015400W'), at('531616N 0020131W'), at('531055N 0022207W'),
    at('531050N 0022814W'), at('531255N 0023000W'), at('532141N 0023000W'), at('532638N 0022258W')] },
  { name: 'Manchester CTA 1', kind: 'CTA', cls: 'D', lower: '2500 FT ALT', upper: '3500 FT ALT', boundary: [
    at('533430N 0020400W'), at('532734N 0030310W'), at('533200N 0025000W')] },
  { name: 'Manchester CTA 2', kind: 'CTA', cls: 'D', lower: '2500 FT ALT', upper: '3500 FT ALT', boundary: [
    at('531047N 0020459W'), at('530602N 0022246W'), at('530626N 0024349W'), at('531427N 0030140W'),
    at('531050N 0023224W'), at('531055N 0022207W'), at('531616N 0020131W')] },
  { name: 'Manchester CTA 3', kind: 'CTA', cls: 'D', lower: '3000 FT ALT', upper: '3500 FT ALT', boundary: [
    at('533650N 0015216W'), at('532719N 0014617W'), at('532656N 0015000W'), at('530732N 0020056W'),
    at('531047N 0020459W'), at('532730N 0015400W'), at('533430N 0020400W')] },
  { name: 'Manchester CTA 4', kind: 'CTA', cls: 'D', lower: '2500 FT ALT', upper: '3500 FT ALT', boundary: [
    at('533011N 0024123W'), at('532708N 0023744W'), at('531130N 0023744W'),
    at('531309N 0025059W'), at('532902N 0025059W')] },
  { name: 'Manchester CTA 5', kind: 'CTA', cls: 'D', lower: '2000 FT ALT', upper: '3500 FT ALT', boundary: [
    at('533124N 0023102W'), at('532056N 0023103W'), at('532638N 0022258W'), at('533430N 0020400W')] },
  // CTA 6 is the lid of the transit corridor: same boundary, starting where EGR323 stops at 1500 ft. The AIP
  // runs one segment "following the line of latitude", which on a flat nm grid is the straight line anyway.
  { name: 'Manchester CTA 6', kind: 'CTA', cls: 'D', lower: '1500 FT ALT', upper: '3500 FT ALT', boundary: [
    at('533124N 0023102W'), at('532056N 0023103W'), at('532141N 0023000W'), at('531255N 0023000W'),
    at('531050N 0022814W'), at('531050N 0023224W'), at('531130N 0023744W'), at('532708N 0023744W'),
    at('533011N 0024123W')] },
  // Class A above it all. No VFR in it at any height, which the route planner refuses rather than offering a
  // transit nobody could be given.
  { name: 'Manchester TMA', kind: 'TMA', cls: 'A', lower: '3500 FT ALT', upper: 'FL195', boundary: [
    at('535110N 0020348W'), at('534726N 0015913W'), at('533713N 0014830W'), at('533650N 0015216W'),
    at('532719N 0014617W'), at('532656N 0015000W'), at('530732N 0020056W'), at('530602N 0022246W'),
    at('530626N 0024349W'), at('531427N 0030140W'), at('532309N 0031205W'), at('532734N 0030310W'),
    at('533213N 0031406W'), at('533223N 0025907W')] },
];

// The published VRPs, by the name a controller would use on the radio. Keyed by the dataset's name, because
// the Manchester VRPs have no designator in the dataset.
const VRP_RT = {
  'Alderley Edge Hill': { name: 'Alderley Edge', hear: ['alderley edge', 'alderly edge', 'alderley', 'older lee edge'] },
  'Buxton': { name: 'Buxton', hear: ['buxton', 'bucks ton'] },
  'Congleton': { name: 'Congleton', hear: ['congleton', 'congelton', 'congle ton'] },
  'Dovestones Reservoirs': { name: 'Dovestones', hear: ['dovestones', 'dove stones', 'dovestone reservoir', 'dove stone'] },
  'Glossop': { name: 'Glossop', hear: ['glossop', 'gloss op'] },
  'Hilltop': { name: 'Hilltop', hear: ['hilltop', 'hill top'] },
  'Jodrell Bank': { name: 'Jodrell Bank', hear: ['jodrell bank', 'jodrel bank', 'jodrell', 'joe drell bank'] },
  'Lamaload Reservoir': { name: 'Lamaload Reservoir', hear: ['lamaload reservoir', 'lamaload', 'lama load', 'llama load'] },
  'M56 Junction 10': { name: 'M56 Junction 10', hear: ['m56 junction 10', 'm 56 junction 10', 'm56 j10'] },
  'M6 Sandbach Services': { name: 'Sandbach Services', hear: ['sandbach services', 'sandbach', 'sand batch', 'm6 sandbach'] },
  'Macclesfield South': { name: 'Macclesfield', hear: ['macclesfield', 'macklesfield', 'maxfield', 'macclesfield south'], say: 'Mackels-field' },
  'Rostherne': { name: 'Rostherne', hear: ['rostherne', 'rostern', 'ross thern', 'roster n'], say: 'Ross-thern' },
  'Sale Water Park': { name: 'Sale Water Park', hear: ['sale water park', 'sale', 'water park'] },
  'Whaley Bridge': { name: 'Whaley Bridge', hear: ['whaley bridge', 'wailey bridge', 'whale ee bridge'], say: 'Whay-lee Bridge' },
  'Winsford Flash': { name: 'Winsford Flash', hear: ['winsford flash', 'winsford', 'wins ford'] },
};

// [name, lat, lon, kind, extra things speech recognition may hear, pronunciation]
const LANDMARKS = [
  ['Stockport', 53.4098, -2.1576, 'town', ['stock port']], ['Oldham', 53.5405, -2.1183, 'town', ['old ham']],
  ['Rochdale', 53.6177, -2.1552, 'town', ['roch dale']], ['Bolton', 53.5833, -2.4333, 'town'],
  ['Bury', 53.6, -2.3, 'town', ['berry']], ['Salford', 53.4877, -2.2904, 'town', ['sal ford']],
  ['Altrincham', 53.3875, -2.3485, 'town', ['altringham', 'altrinch am'], 'Altring-am'],
  ['Wilmslow', 53.328, -2.2315, 'town', ['wilms low', 'williamslow']], ['Knutsford', 53.3029, -2.3748, 'town', ['nutsford', 'knuts ford']],
  ['Northwich', 53.2588, -2.5202, 'town', ['north wich']], ['Crewe', 53.0979, -2.4416, 'town', ['crew']],
  ['Middlewich', 53.193, -2.444, 'town', ['middle wich']], ['Sandbach', 53.1452, -2.3625, 'town', ['sand batch', 'sand bach']],
  ['Warrington', 53.3925, -2.5802, 'town', ['warring ton']], ['Widnes', 53.3618, -2.7341, 'town', ['wid nes', 'witness']],
  ['Runcorn', 53.3417, -2.7312, 'town', ['run corn']], ['Chester', 53.1905, -2.8919, 'city'],
  ['Ellesmere Port', 53.2788, -2.9013, 'town', ['ellesmere', 'elsmere port']], ['New Mills', 53.3659, -1.9999, 'town', ['newmills']],
  ['Chapel-en-le-Frith', 53.3233, -1.9148, 'town', ['chapel en le frith', 'chapel'], 'Chapel-en-le-Frith'],
  ['Ashton-under-Lyne', 53.4888, -2.0989, 'town', ['ashton under lyne', 'ashton']],
  ['Stalybridge', 53.4841, -2.0591, 'town', ['staley bridge', 'stalybridge']], ['Hyde', 53.4513, -2.0794, 'town', ['hide']],
  ['Denton', 53.4568, -2.1182, 'town', ['den ton']], ['Poynton', 53.35, -2.1167, 'town', ['point on', 'poyn ton']],
  ['Bramhall', 53.358, -2.1654, 'town', ['bram hall']], ['Cheadle', 53.4, -2.2167, 'town', ['cheedle', 'chee dle'], 'Cheedle'],
  ['Holmes Chapel', 53.2014, -2.3574, 'village', ['homes chapel', 'holmes chappell']],
  ['Lymm', 53.3811, -2.4776, 'village', ['limb', 'lim']], ['Leigh', 53.4964, -2.5197, 'town', ['lee']],
  ['Wigan', 53.543, -2.6371, 'town', ['wiggan']], ['Chorley', 53.65, -2.6167, 'town', ['chor lee']],
  ['Blackburn', 53.75, -2.4833, 'town', ['black burn']], ['Darwen', 53.698, -2.4649, 'town', ['darwin']],
  ['Ramsbottom', 53.6479, -2.3168, 'town', ['rams bottom']], ['Marple', 53.3945, -2.0629, 'town', ['maple', 'mar ple']],
  ['Nantwich', 53.0688, -2.5205, 'town', ['nant wich']], ['Tarporley', 53.1592, -2.6687, 'village', ['tar porley']],
  ['Frodsham', 53.2948, -2.7275, 'town', ['frod sham']], ['Helsby', 53.274, -2.7691, 'village', ['hels by']],
  ['Chelford', 53.2709, -2.2833, 'village', ['chel ford']], ['Goostrey', 53.2273, -2.3392, 'village', ['goose tree', 'goostry']],
  ['Mobberley', 53.3167, -2.3167, 'village', ['mobber lee']], ['Disley', 53.3586, -2.0385, 'village', ['dis lee']],
  ['Bollington', 53.2945, -2.1096, 'town', ['bolling ton']], ['Prestbury', 53.2833, -2.15, 'village', ['prest bury']],
  ['Hazel Grove', 53.3833, -2.1167, 'town', ['hazelgrove']], ['Tatton Park', 53.3248, -2.3771, 'park', ['tatton']],
  ['Kinder Scout', 53.3848, -1.8739, 'hill', ['kinder']], ['Combs Reservoir', 53.3123, -1.944, 'reservoir', ['combs']],
  ['Beeston Castle', 53.1287, -2.6932, 'castle', ['beeston']], ['Delamere Forest', 53.2423, -2.6923, 'forest', ['delamere']],
  ['City Airport Manchester', 53.471, -2.3912, 'airfield', ['barton', 'city airport', 'manchester barton']],
];

const lower = s => s.toLowerCase();
const vrps = VRPS.EGCC.map(v => {
  const rt = VRP_RT[v.name];
  if (!rt) throw new Error(`Manchester VRP without an RT name: ${v.name}`);
  return { id: lower(rt.name).replace(/\W+/g, '-'), kind: 'vrp', official: v.name, lat: v.lat, lon: v.lon, ...rt,
    hear: [lower(rt.name), ...rt.hear] };
});
const landmarks = LANDMARKS.map(([name, lat, lon, kind, hear = [], say]) => ({
  id: lower(name).replace(/\W+/g, '-'), kind, name, lat, lon, hear: [lower(name), ...hear], ...(say ? { say } : {}),
}));

export default {
  id: 'manchester',
  name: 'Manchester',
  icao: 'EGCC',
  unit: 'Manchester Radar',           // there is no "Manchester Approach" callsign in the AIP
  freq: '118.580',
  zone: 'the Manchester control zone',
  qnhName: 'Manchester QNH',
  squawks: '46',                      // the first two digits of the codes the unit hands out (illustrative)
  listeningSquawk: '7366',
  origin: ARP,
  // Runway thresholds: AIP AD 2.12, two parallel runways. The ATZ is a 2.5 nm circle.
  airport: { name: 'Manchester', ...ARP, atz: 2.5, runways: [
    ['05L/23R', at('532051.20N 0021715.95W'), at('532140.75N 0021533.41W')],
    ['05R/23L', at('531955.11N 0021838.38W'), at('532053.35N 0021637.94W')]] },
  airspace: AIRSPACE,
  places: [...vrps, ...landmarks],
  traffic: manchesterTraffic,
  facts: [
    'Manchester Radar 118.580 is the frequency for a VFR transit: there is no "Manchester Approach" — the radar service is Radar, or Director. Manchester Arrival Information (ATIS) 128.180.',
    'The CTR is Class D, surface to 3500 ft. The CTAs around it come down to 3000, 2500, 2000 or 1500 ft depending on which side you are.',
    'The Low Level Route closed on 20 February 2025. In its place the North West Transit Corridor (EGR323) is Class G, surface to 1500 ft.',
    'In the corridor, below 1500 ft, you need no clearance and need call nobody: at 140 kt or less, in 5 km visibility, on the Manchester or Liverpool QNH.',
    'Above 3500 ft over the zone is the Manchester TMA, Class A: no VFR at all, at any height.',
    'Staying outside the zone: listening squawk 7366 (7367 student solo), monitoring 118.580.',
    'Transition altitude is 5000 ft. Inbound to Barton, do not assume anyone has coordinated your entry to the Barton ATZ.',
  ],
};
