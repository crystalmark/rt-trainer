// Routes you describe in words ("Skipton to Wetherby via Salts Mill and Eccup at 2500 ft"), checked against an
// area's places and airspace: how far, where you enter and leave controlled airspace at your altitude, which
// points ATC will want reported, and what you pass close underneath. Pure functions: shared by the app and tests.
import { dist, bearing, compass, inside, edgeDistance, describe } from './geo.js';

const key = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const SEP = /(\bfrom\b|\bto\b|\bvia\b|\bthen\b|\band\b|,|;|\n|→|->|>|\s[-–—]\s)/i;
const FILLER = /\b(the|vrp|overhead|over|abeam|near|town|village|reservoir|railway station|roundabout)\b/g;
const ALTITUDE = /\b(?:at\s+|alt(?:itude)?\s+)?(\d{1,2}[,.]?\d{3}|\d{3,4})\s*(?:ft|feet|foot|')(?=\W|$)|\b(?:at|alt(?:itude)?)\s+(\d{1,2}[,.]?\d{3}|\d{3,4})\b/i;

function levenshtein(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}

const namesOf = p => [p.name, p.official, ...(p.hear || [])].filter(Boolean).map(key);

/** Find the place a piece of text names: exact, then contained, then a close spelling. */
export function findPlace(text, places) {
  const k = key(text), bare = key(k.replace(FILLER, ' '));
  if (!k) return null;
  for (const p of places) if (namesOf(p).some(n => n === k || n === bare)) return { place: p };
  let best = null;
  for (const p of places) for (const n of namesOf(p)) {
    if (n.length > 3 && ` ${k} `.includes(` ${n} `) && (!best || n.length > best.len)) best = { place: p, len: n.length };
  }
  if (best) return { place: best.place };
  const scored = places.map(p => ({ place: p, d: Math.min(...namesOf(p).map(n => levenshtein(bare || k, n))) })).sort((a, b) => a.d - b.d);
  const target = bare || k, allow = target.length <= 5 ? 1 : target.length <= 10 ? 2 : 3;
  if (scored[0] && scored[0].d <= allow && (!scored[1] || scored[1].d > scored[0].d)) return { place: scored[0].place, readAs: true };
  return { unknown: text.trim(), suggestions: scored.slice(0, 3).filter(s => s.d <= Math.max(2, target.length / 3)).map(s => s.place.name) };
}

/**
 * parseRoute("Skipton to Wetherby via Salts Mill and Eccup at 2500 ft", area)
 * -> { points: [place...], altitude: 2500 | null, notes: [...], unknown: [{ text, suggestions }] }
 */
export function parseRoute(text, area) {
  let t = String(text || '');
  let altitude = null;
  const m = ALTITUDE.exec(t);
  if (m) { altitude = Number((m[1] || m[2]).replace(/[,.]/, '')); t = t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length); }
  const items = []; let sep = 'start';
  t.split(SEP).forEach((piece, i) => {           // separators land at the odd indices
    if (i % 2) { const k = key(piece); sep = ['from', 'to', 'via', 'and'].includes(k) ? k : 'then'; return; }
    if (piece.trim()) { items.push({ sep, text: piece.trim() }); sep = 'then'; }
  });
  let seq = items;
  if (items.some(i => i.sep === 'via')) {
    const from = items.find(i => i.sep === 'from') || items[0];
    const toAt = items.map(i => i.sep).lastIndexOf('to');
    const to = toAt >= 0 ? items[toAt] : items[items.length - 1];
    seq = [from, ...items.filter(i => i !== from && i !== to), to];
  }
  const points = [], notes = [], unknown = [];
  for (const it of seq) {
    const f = findPlace(it.text, area.places);
    if (!f) continue;
    if (f.unknown) { unknown.push({ text: f.unknown, suggestions: f.suggestions }); continue; }
    if (f.readAs && key(it.text) !== key(f.place.name)) notes.push(`Read “${it.text}” as ${f.place.name}.`);
    if (points[points.length - 1] !== f.place) points.push(f.place);
  }
  return { points, altitude, notes, unknown };
}

/** The route in words, the way parseRoute reads it back. */
export const routeText = (points, altitude) => points.map(p => p.name).join(' → ') + (altitude ? ` at ${altitude} ft` : '');

/**
 * Lay the route over the area's airspace at the planned altitude.
 * Returns { points: [{ place, s }], total, posAt(s), nearestS(p), cas: [{ s0, s1, volume }], transit, under, closest,
 *           errors, warnings } where s is the distance along the route in nm. midFlight: the route starts at your
 *           present position (a change of plan), so it may start inside controlled airspace or close to it.
 */
export function planRoute(area, places, altitude, { midFlight = false } = {}) {
  const errors = [], warnings = [];
  if (places.length < 2) errors.push('Name at least two places: where you start and where you finish.');
  if (!(altitude >= 1000 && altitude < 5000)) errors.push('Plan an altitude from 1000 to 4900 ft (the transition altitude is 5000 ft).');
  let run = 0;
  const points = places.map((p, i) => { if (i) run += dist(places[i - 1], p); return { place: p, s: run }; });
  const total = run;
  const posAt = s => {
    s = Math.max(0, Math.min(total, s));
    let i = 1; while (i < points.length - 1 && points[i].s < s) i++;
    const a = points[i - 1] || points[0], b = points[i] || a, span = b.s - a.s || 1;
    const f = Math.max(0, Math.min(1, (s - a.s) / span));
    const q = { x: a.place.x + (b.place.x - a.place.x) * f, y: a.place.y + (b.place.y - a.place.y) * f };
    return { ...q, ...area.grid.ll(q), track: bearing(a.place, b.place) };
  };
  const plan = { area, altitude, points, total, posAt, errors, warnings, cas: [], transit: null, under: [], closest: null };
  if (errors.length || !total) { if (!errors.length) errors.push(midFlight ? 'You are already there.' : 'Those places are all in the same spot.'); return plan; }
  if (total > 90) errors.push(`That's ${Math.round(total)} nm: keep it under 90 nm.`);

  const volumeAt = p => area.airspace.find(v => altitude >= v.base && altitude < v.top && inside(p, v.poly)) || null;
  const step = 0.05, samples = [];
  for (let s = 0; s < total + step; s += step) { const ss = Math.min(s, total); samples.push({ s: ss, v: volumeAt(posAt(ss)) }); if (ss === total) break; }
  const edge = (lo, hi) => { const want = !!volumeAt(posAt(hi)); for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (!!volumeAt(posAt(mid)) === want) hi = mid; else lo = mid; } return hi; };
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i], prev = samples[i - 1];
    if (cur.v && (!prev || !prev.v)) plan.cas.push({ s0: prev ? edge(prev.s, cur.s) : 0, s1: total, volume: cur.v, exitVolume: cur.v });
    if (!cur.v && prev && prev.v) { const c = plan.cas[plan.cas.length - 1]; c.s1 = edge(prev.s, cur.s); c.exitVolume = prev.v; }
  }
  plan.nearestS = p => { let best = { s: 0, d: Infinity }; for (const { s } of samples) { const d = dist(p, posAt(s)); if (d < best.d) best = { s, d }; } return best; };

  const where = v => `${v.name}${v.base ? ` (base ${v.base} ft)` : ''} at ${altitude} ft`;
  if (samples[0].v && !midFlight) errors.push(`You'd start inside ${where(samples[0].v)}: start outside controlled airspace.`);
  if (samples[samples.length - 1].v) errors.push(`You'd finish inside ${where(samples[samples.length - 1].v)}: finish outside controlled airspace.`);
  if (plan.cas.length && plan.cas[0].s0 < 4 && !samples[0].v && !midFlight) errors.push('Start at least 4 nm before controlled airspace, so there is time to call.');

  // Airspace close overhead, and how close the route comes when it stays outside.
  for (const v of area.airspace) {
    if (v.base <= altitude || v.base - altitude > 500) continue;
    const over = samples.filter(x => inside(posAt(x.s), v.poly));
    if (over.length) plan.under.push({ volume: v, s0: over[0].s, s1: over[over.length - 1].s, gap: v.base - altitude });
  }
  if (!plan.cas.length) {
    let best = null;
    for (const { s } of samples) {
      const p = posAt(s);
      for (const v of area.airspace) {
        if (v.base > altitude) continue;
        const d = edgeDistance(p, v.poly);
        if (!best || d < best.d) best = { s, d, volume: v };
      }
    }
    plan.closest = best;
  }
  if (area.airport && points.some((_, i) => i && segmentPasses(points[i - 1].place, points[i].place, { x: 0, y: 0 }, 1))) {
    warnings.push(`The route passes within a mile of ${area.airport.name}: expect ATC to route you round the runway.`);
  }
  if (plan.cas.length > 1) warnings.push('The route leaves and re-enters controlled airspace: you will be cleared through it in one go.');
  if (plan.cas.length && !errors.length) plan.transit = transitOf(plan);
  return plan;
}

function segmentPasses(a, b, p, r) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < r;
}

// Entry and exit, the point ATC clears you "via", and the points you'll be asked to report.
function transitOf(plan) {
  const { area, points, posAt, nearestS, cas } = plan;
  const sIn = cas[0].s0, sOut = cas[cas.length - 1].s1;
  const entry = posAt(sIn), exit = posAt(sOut);
  const inner = points.slice(1, -1);
  const vrps = area.places.filter(p => p.kind === 'vrp');
  const onRoute = p => ({ place: p, s: nearestS(p).s });
  // Clear "via" your first waypoint around the entry (VRPs preferred), else the nearest VRP, else the nearest landmark.
  const score = w => Math.abs(w.s - sIn) - (w.place.kind === 'vrp' ? 2 : 0);
  let via = inner.filter(w => w.s >= sIn - 3 && w.s <= Math.min(sIn + 6, sOut - 0.5)).sort((a, b) => score(a) - score(b))[0] || null;
  if (!via) {
    const near = list => list.map(p => ({ p, d: dist(p, entry) })).filter(x => x.d <= 4).sort((a, b) => a.d - b.d)[0];
    const hit = near(vrps) || near(area.places);
    if (hit) via = onRoute(hit.p);
  }
  let reports = inner.filter(w => w.s > sIn - 0.5 && w.s < sOut - 0.3 && (!via || w.place !== via.place));
  if (!reports.length) {
    reports = vrps.map(onRoute).filter(r => r.s > sIn + 0.5 && r.s < sOut - 0.5 && dist(r.place, posAt(r.s)) <= 1.5 && (!via || r.place !== via.place));
  }
  if (via && via.s < sOut - 0.3) reports.unshift(via);
  reports.sort((a, b) => a.s - b.s);
  reports = reports.filter((r, i) => !i || r.place !== reports[i - 1].place);
  const last = reports[reports.length - 1];
  return {
    sIn, sOut, entry, exit, via, reports,
    // After the last report: "leave the zone south-east" from well inside, else "route direct <next waypoint>".
    leaveDirect: last && last.s < (sIn + sOut) / 2 ? points.find(w => w.s > last.s + 0.5)?.place || null : null,
    entryVolume: cas[0].volume, exitVolume: cas[cas.length - 1].exitVolume,
    exitSide: compass(bearing({ x: 0, y: 0 }, exit)),
    intoZone: cas[0].volume.kind === 'CTR',
  };
}

/** A plan's points as the map draws them. */
export const mapPoints = plan => plan.points.map(w => ({ name: w.place.name, kind: w.place.kind, x: w.place.x, y: w.place.y, s: w.s }));

/** Your present position as the first point of a changed route. */
export const presentPosition = p => ({ id: 'here', kind: 'position', name: 'present position', x: p.x, y: p.y, lat: p.lat, lon: p.lon });

/**
 * The places to fly after a change of plan in flight, from `s` nm along the current plan. "direct" skips ahead to a
 * waypoint still on the route, or goes to an off-route place first and then carries on with the route; "divert"
 * makes the place the destination.
 */
export function reroutePoints(plan, s, action, place) {
  const ahead = plan.points.filter(w => w.s > s + 0.05 && w.place.kind !== 'position').map(w => w.place);
  if (action === 'divert') return [place];
  const i = ahead.findIndex(p => p.id === place.id);
  return i >= 0 ? ahead.slice(i) : [place, ...ahead];
}

/** "3 miles south of Skipton", plus the names a pilot might reasonably use for the same spot. */
export function whereIs(area, p) {
  const d = describe(p, area.places) || { text: 'near the zone', d: 0, place: null };
  const nearby = area.places.filter(pl => dist(pl, p) <= Math.max(3, d.d + 2)).map(pl => pl.hear?.[0] || pl.name.toLowerCase());
  return { ...d, hear: [...new Set(nearby)] };
}
