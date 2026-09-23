// Leeds Bradford: controlled airspace, VRPs and the landmarks a controller or pilot might use around the zone.
// Airspace: UK AIP AD 2.17 EGNM and ENR 2.1, AIRAC 2026-09-03, copied point for point so it can be checked
// against the AIP text. VRPs: the NATS AIS VRP dataset (js/data/vrps.js). Landmark positions: GeoNames, via the
// Open-Meteo geocoder. `hear` lists what speech recognition may make of a name (the first entry is the name as
// it should be said); `say` is how the speech synthesiser should pronounce it.
import { at } from '../geo.js';
import { VRPS } from '../data/vrps.js';
import { leedsTraffic } from '../scenarios/common.js';

const ARP = at('535157N 0013938W');   // centre of the CTR and CTA arcs
const arc = (dir, radius, to) => ({ arc: dir, radius, centre: ARP, to: at(to) });

const AIRSPACE = [
  { name: 'Leeds Bradford CTR', kind: 'CTR', cls: 'D', base: 0, top: 8500, boundary: [
    at('535955N 0014027W'), at('535348N 0013100W'), at('534904N 0012703W'), arc('cw', 8, '534359N 0013847W'),
    at('535312N 0015259W'), arc('cw', 8, '535955N 0014027W')] },
  { name: 'Leeds Bradford CTA 1', kind: 'CTA', cls: 'D', base: 2500, top: 8500, boundary: [
    at('534904N 0012703W'), at('534445N 0012327W'), arc('cw', 12, '534032N 0013331W'),
    at('534359N 0013847W'), arc('ccw', 8, '534904N 0012703W')] },
  { name: 'Leeds Bradford CTA 2', kind: 'CTA', cls: 'D', base: 2500, top: 8500, boundary: [
    at('535312N 0015259W'), at('534359N 0013847W'), arc('cw', 8, '535312N 0015259W')] },
  { name: 'Leeds Bradford CTA 3', kind: 'CTA', cls: 'D', base: 3000, top: 8500, boundary: [
    at('540236N 0014900W'), at('535955N 0014027W'), arc('ccw', 8, '534359N 0013847W'),
    at('534032N 0013331W'), arc('ccw', 12, '534445N 0012327W'),
    at('534007N 0011937W'), at('533713N 0014830W'), at('534726N 0015913W'), at('535539N 0020919W')] },
];

// The published VRPs, by the name a controller would use on the radio.
const VRP_RT = {
  ATH: { name: 'Arthington Viaduct', hear: ['arthington viaduct', 'arthington', 'viaduct'] },
  CBR: { name: 'Chain Bar', hear: ['chain bar', 'chainbar', 'chain bar roundabout', 'chain ball'] },
  DBY: { name: 'Dewsbury', hear: ['dewsbury', 'dews bury', 'jewsbury'] },
  ECP: { name: 'Eccup Reservoir', hear: ['eccup reservoir', 'eccup', 'eckup', 'e cup', 'ecup'] },
  HGT: { name: 'Harrogate', hear: ['harrogate', 'harrogate railway station', 'harrow gate'] },
  SML: { name: 'Salts Mill', hear: ['salts mill', 'salt mill', 'saltaire', 'salts mil', 'saltmill'] },
};

// [name, lat, lon, kind, extra things speech recognition may hear, pronunciation]
const LANDMARKS = [
  ['Skipton', 53.9614, -2.0168, 'town'], ['Keighley', 53.8679, -1.9066, 'town', ['keithley', 'keithly', 'keighly', 'keeley', 'keely', 'keith lee', 'keith ley'], 'Keethly'],
  ['Riddlesden', 53.8777, -1.8811, 'village', ['riddles den', 'ridlesden', 'riddlesdon']], ['Silsden', 53.9144, -1.938, 'town', ['sils den', 'silsdon']],
  ['Steeton', 53.8833, -1.95, 'village', ['steton']], ['Bingley', 53.8486, -1.8386, 'town', ['bingly']],
  ['Shipley', 53.8333, -1.7667, 'town'], ['Haworth', 53.8291, -1.9483, 'village', ['hayworth', 'howarth'], 'Howerth'],
  ['Oxenhope', 53.8123, -1.952, 'village', ['oxen hope', 'auction hope', 'ox and hope'], 'Oxen-hope'], ['Denholme', 53.8019, -1.895, 'village', ['denholm']],
  ['Queensbury', 53.7666, -1.8491, 'village', ['queensberry']], ['Addingham', 53.9445, -1.8842, 'village', ['adding ham', 'adding them']],
  ['Ilkley', 53.9245, -1.8233, 'town', ['ilkly', 'ilk lee']], ['Burley in Wharfedale', 53.9102, -1.758, 'village', ['burley', 'burly', 'burleigh']],
  ['Menston', 53.8904, -1.7439, 'village', ['menstone']], ['Otley', 53.9055, -1.6938, 'town', ['ottley', 'oatley']],
  ['Pool in Wharfedale', 53.9, -1.6167, 'village', ['pool']], ['Bolton Abbey', 53.9815, -1.8917, 'village'],
  ['Hebden Bridge', 53.7409, -2.0134, 'town', ['hebden']], ['Halifax', 53.7167, -1.85, 'town'],
  ['Bradford', 53.7939, -1.7521, 'city'], ['Pudsey', 53.7954, -1.6613, 'town', ['pudsy']],
  ['Kirkstall', 53.8158, -1.6021, 'suburb', ['kirk stall']], ['Horsforth', 53.8426, -1.6375, 'town', ['horse forth']],
  ['Guiseley', 53.8756, -1.7123, 'town', ['guisely', 'guys lee'], 'Guys-lee'], ['Morley', 53.7401, -1.5988, 'town', ['morely']],
  ['Batley', 53.7029, -1.6337, 'town', ['batly']], ['Cleckheaton', 53.724, -1.7129, 'town', ['cleck heaton']],
  ['Brighouse', 53.7032, -1.7843, 'town', ['brig house'], 'Brig-house'], ['Huddersfield', 53.649, -1.7842, 'town'],
  ['Crosland Moor', 53.6208, -1.8327, 'airfield', ['crossland moor']], ['Holmfirth', 53.5697, -1.7878, 'town', ['holm firth']],
  ['Emley', 53.614, -1.6313, 'village', ['emley moor', 'emily moor']], ['Wakefield', 53.6833, -1.4977, 'city'],
  ['Castleford', 53.7259, -1.3626, 'town', ['castle ford']], ['Pontefract', 53.6911, -1.3127, 'town'],
  ['Ferrybridge', 53.7106, -1.2795, 'village', ['ferry bridge']], ['Garforth', 53.7917, -1.3807, 'town'],
  ['Sherburn in Elmet', 53.7952, -1.2466, 'airfield', ['sherburn', 'sherbourne']], ['Church Fenton', 53.8263, -1.2189, 'airfield', ['leeds east', 'fenton']],
  ['Selby', 53.7833, -1.0667, 'town'], ['Drax', 53.7284, -0.9809, 'power station', ['drax power station']],
  ['Tadcaster', 53.8832, -1.2634, 'town', ['tad caster']], ['Bramham', 53.8812, -1.3545, 'village', ['bram ham']],
  ['Boston Spa', 53.9042, -1.3452, 'village'], ['Wetherby', 53.9284, -1.3867, 'town', ['weatherby']],
  ['Collingham', 53.9117, -1.4117, 'village'], ['Harewood', 53.9012, -1.512, 'village', ['harewood house', 'harwood'], 'Har-wood'],
  ['Knaresborough', 54.0091, -1.4685, 'town', ['naresborough', 'nares borough'], 'Nairs-bruh'], ['Ripon', 54.1358, -1.5283, 'city', ['rippon']],
  ['Pateley Bridge', 54.0862, -1.7598, 'town', ['pately bridge', 'pateley']], ['Blubberhouses', 53.9937, -1.746, 'village', ['blubber houses']],
  ['Fewston', 53.9839, -1.7096, 'village', ['fewston reservoir', 'few stone']], ['Thruscross', 54.0221, -1.7689, 'village', ['thruscross reservoir', 'thrus cross']],
  ['York', 53.9576, -1.0827, 'city'], ['Rufforth', 53.9545, -1.1929, 'airfield', ['ruff forth']],
];

const lower = s => s.toLowerCase();
const vrps = VRPS.EGNM.map(v => ({ id: lower(v.code), kind: 'vrp', code: v.code, official: v.name, lat: v.lat, lon: v.lon, ...VRP_RT[v.code] }));
const missing = VRPS.EGNM.filter(v => !VRP_RT[v.code]);
if (missing.length) throw new Error(`Leeds VRPs without an RT name: ${missing.map(v => v.official).join(', ')}`);
const landmarks = LANDMARKS.map(([name, lat, lon, kind, hear = [], say]) => ({
  id: lower(name).replace(/\W+/g, '-'), kind, name, lat, lon, hear: [lower(name), ...hear], ...(say ? { say } : {}),
}));

export default {
  id: 'leeds',
  name: 'Leeds',
  icao: 'EGNM',
  unit: 'Leeds Radar',
  freq: '134.580',
  zone: 'the Leeds control zone',
  qnhName: 'Leeds QNH',
  squawks: '56',                      // the first two digits of the codes the unit hands out (illustrative)
  listeningSquawk: '2677',
  origin: ARP,
  // Runway thresholds: AIP AD 2.12. The ATZ is a 2.5 nm circle.
  airport: { name: 'Leeds Bradford', ...ARP, atz: 2.5, runways: [['14/32', at('535217.15N 0014008.68W'), at('535137.31N 0013907.44W')]] },
  airspace: AIRSPACE,
  places: [...vrps, ...landmarks],
  traffic: leedsTraffic,
  facts: [
    'Leeds Radar 134.580 (also listed as Leeds Approach). Leeds Information (ATIS) 118.030.',
    'The CTR is Class D, surface to FL85. CTA 1 (south-east) and CTA 2 (south-west) start at 2500 ft, CTA 3 (west and south) at 3000 ft.',
    'Monitoring 134.580 near Leeds Bradford without a service: listening squawk 2677.',
    'Transition altitude in the CTR/CTA is 5000 ft.',
  ],
};
