// Areas you can plan your own route in. Each area module holds its airspace, VRPs and landmarks; prepare() puts
// them on the area's flat grid once.
import { grid, boundary } from '../geo.js';
import leeds from './leeds.js';
import edinburgh from './edinburgh.js';
import manchester from './manchester.js';

// Vertical limits are written as the AIP writes them: "SFC", an altitude ("2500 FT ALT", on QNH) or a flight level
// ("FL85", on 1013.2 hPa), so every volume can be checked against the AIP and none loses its unit. They were numbers,
// and the map, which can't tell 6000 ft from FL60, labelled every top a flight level. Anything else is refused. The
// planner works in feet and takes a flight level as its nominal height (FL85 as 8500 ft): nothing it plans comes near.
export function parseLimit(text) {
  const m = /^(?:(SFC)|(\d+) FT ALT|FL(\d+))$/.exec(text ?? '');
  if (!m) throw new Error(`Airspace limits are written as the AIP writes them (SFC, 2500 FT ALT, FL85), not ${JSON.stringify(text)}`);
  return m[1] ? 0 : m[2] ? Number(m[2]) : Number(m[3]) * 100;
}

function prepare(area) {
  const g = grid(area.origin);
  return {
    ...area, grid: g,
    airspace: area.airspace.map(v => ({ ...v, base: parseLimit(v.lower), top: parseLimit(v.upper), poly: boundary(v.boundary, g) })),
    places: area.places.map(p => ({ ...p, ...g.xy(p) })),
    airport: area.airport && { ...area.airport, ...g.xy(area.airport),
      runways: (area.airport.runways || []).map(([name, a, b]) => ({ name, a: g.xy(a), b: g.xy(b) })) },
    pronounce: area.places.filter(p => p.say).map(p => [new RegExp(`\\b${p.name}\\b`, 'g'), p.say]),
  };
}

export const AREAS = [leeds, edinburgh, manchester].map(prepare);
export const areaById = id => AREAS.find(a => a.id === id);
