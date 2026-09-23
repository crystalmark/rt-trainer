// Landmark positions for a new area, from the Open-Meteo geocoder (GeoNames data, CC BY 4.0).
// Feed it one place per line on stdin and it prints rows ready to paste into an area's LANDMARKS list:
//
//   Name                          the name as it goes in the list, and what is searched for
//   Name=query                    when the two differ ("Berwick Law=North Berwick Law")
//   Name|kind                     kind defaults to town
//   Name|kind|county              keep only matches whose admin area contains this — Leven is in Fife and in
//                                 East Yorkshire, and the geocoder offers the wrong one first
//   !Name                         go straight to OpenStreetMap: the geocoder holds populated places only, so
//                                 hills, reservoirs, bridges and power stations are never in it
//
//   printf 'Musselburgh|town\nLeven|town|Fife\n' | node scripts/places.mjs
//
// Always read the admin area it prints in the trailing comment before pasting.
//
// It never invents a position: a name it cannot find is printed as a TODO so you notice.
const API = 'https://geocoding-api.open-meteo.com/v1/search';
const OSM = 'https://nominatim.openstreetmap.org/search';
const round = (v, n = 4) => Number(v.toFixed(n));

/** OpenStreetMap, for the features the geocoder does not carry. One request a second, as they ask. */
async function osm(query, county) {
  const url = `${OSM}?q=${encodeURIComponent(county ? `${query}, ${county}` : query)}&countrycodes=gb&format=jsonv2&limit=5`;
  const res = await fetch(url, { headers: { 'user-agent': 'rt-trainer/1.0 (landmark positions for a training app)' } });
  if (!res.ok) return null;
  const hits = await res.json();
  await new Promise(r => setTimeout(r, 1100));
  return hits.length ? { latitude: +hits[0].lat, longitude: +hits[0].lon, name: hits[0].name || query,
    admin2: (hits[0].display_name || '').split(',').slice(1, 3).join(',').trim(), src: 'OSM' } : null;
}

const names = (await new Promise(r => { let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => r(s)); }))
  .split('\n').map(l => l.trim()).filter(Boolean);

for (const line of names) {
  const [spec, kind = 'town', county = ''] = line.split('|').map(s => s.trim());
  const forceOsm = spec.startsWith('!');
  const [name, query = name] = spec.replace(/^!/, '').split('=').map(s => s.trim());
  let p = null;
  if (!forceOsm) {
    const res = await fetch(`${API}?name=${encodeURIComponent(query)}&count=10&language=en&format=json`);
    const { results = [] } = await res.json();
    const where = r => `${r.admin1 || ''} ${r.admin2 || ''}`.toLowerCase();
    const uk = results.filter(r => r.country_code === 'GB').filter(r => !county || where(r).includes(county.toLowerCase()));
    if (uk.length) p = { ...uk[0], matches: uk.length, src: 'GeoNames' };
  }
  if (!p) p = await osm(query, county);
  if (!p) { console.log(`  // TODO not found: ${name}${county ? ` in ${county}` : ''}`); continue; }
  const uk = { length: p.matches || 1 };
  console.log(`  ['${name}', ${round(p.latitude)}, ${round(p.longitude)}, '${kind}'],`.padEnd(64) +
    `// ${p.name}, ${p.admin2 || p.admin1 || ''}${uk.length > 1 ? ` (${uk.length} UK matches)` : ''} [${p.src}]`);
  await new Promise(r => setTimeout(r, 120));        // be kind to a free API
}
