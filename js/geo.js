// Geometry for routes and airspace. Positions go onto a flat grid in nautical miles around an area's reference
// point (x east, y north), which is accurate to well under 0.1 nm within 40 nm: plenty for VFR training.
// Airspace comes straight from the AIP's wording: points like '535955N 0014027W' and "thence clockwise by the arc
// of a circle radius 8 NM centred on ...".

/** '535955N' / '0014027W' / '534130.00N' -> decimal degrees */
export function dms(s) {
  const m = /^(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])$/.exec(String(s).trim());
  if (!m || (m[1].length === 3) !== /[EW]/.test(m[4])) throw new Error(`Bad coordinate ${s}`);
  const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  return /[SW]/.test(m[4]) ? -v : v;
}

/** at('535955N 0014027W') -> { lat, lon } */
export function at(text) {
  const [lat, lon] = String(text).trim().split(/\s+/);
  return { lat: dms(lat), lon: dms(lon) };
}

/** A flat grid centred on `origin` ({ lat, lon }). */
export function grid(origin) {
  const k = Math.cos(origin.lat * Math.PI / 180);
  return {
    origin,
    xy: p => ({ x: (p.lon - origin.lon) * 60 * k, y: (p.lat - origin.lat) * 60 }),
    ll: q => ({ lat: origin.lat + q.y / 60, lon: origin.lon + q.x / (60 * k) }),
  };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** True bearing from a to b, degrees. */
export const bearing = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compass = deg => POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/**
 * Polygon from AIP-style boundary parts: grid points, or arcs { arc: 'cw' | 'ccw', radius, centre, to }
 * running from the previous point to `to`. Arcs are drawn every 3 degrees.
 */
export function boundary(parts, g) {
  const out = [];
  for (const part of parts) {
    if (!part.arc) { out.push(g.xy(part)); continue; }
    const c = g.xy(part.centre), from = out[out.length - 1], to = g.xy(part.to);
    const a0 = Math.atan2(from.x - c.x, from.y - c.y);
    let a1 = Math.atan2(to.x - c.x, to.y - c.y);
    if (part.arc === 'cw') while (a1 <= a0) a1 += 2 * Math.PI;
    else while (a1 >= a0) a1 -= 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 60)));
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (a1 - a0) * i / steps;
      out.push({ x: c.x + part.radius * Math.sin(a), y: c.y + part.radius * Math.cos(a) });
    }
  }
  return out;
}

export function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function toSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from p to the nearest edge of the polygon. */
export function edgeDistance(p, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, toSegment(p, poly[j], poly[i]));
  return d;
}

/** "1 mile", "3 miles" */
export const miles = d => { const n = Math.max(1, Math.round(d)); return `${n} mile${n === 1 ? '' : 's'}`; };

/**
 * Where p is, the way a pilot or controller says it: "overhead Otley" or "3 miles south of Skipton".
 * places: [{ name, x, y }]. Returns { text, place, d } or null when nothing is within `range` nm.
 */
export function describe(p, places, { range = 12, overhead = 0.7 } = {}) {
  let best = null;
  for (const pl of places) { const d = dist(p, pl); if (!best || d < best.d) best = { place: pl, d }; }
  if (!best || best.d > range) return null;
  const text = best.d < overhead ? `overhead ${best.place.name}` : `${miles(best.d)} ${compass(bearing(best.place, p))} of ${best.place.name}`;
  return { text, ...best };
}
