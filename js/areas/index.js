// Areas you can plan your own route in. Each area module holds its airspace, VRPs and landmarks; prepare() puts
// them on the area's flat grid once.
import { grid, boundary } from '../geo.js';
import leeds from './leeds.js';
import edinburgh from './edinburgh.js';
import manchester from './manchester.js';

function prepare(area) {
  const g = grid(area.origin);
  return {
    ...area, grid: g,
    airspace: area.airspace.map(v => ({ ...v, poly: boundary(v.boundary, g) })),
    places: area.places.map(p => ({ ...p, ...g.xy(p) })),
    airport: area.airport && { ...area.airport, ...g.xy(area.airport),
      runways: (area.airport.runways || []).map(([name, a, b]) => ({ name, a: g.xy(a), b: g.xy(b) })) },
    pronounce: area.places.filter(p => p.say).map(p => [new RegExp(`\\b${p.name}\\b`, 'g'), p.say]),
  };
}

export const AREAS = [leeds, edinburgh, manchester].map(prepare);
export const areaById = id => AREAS.find(a => a.id === id);
