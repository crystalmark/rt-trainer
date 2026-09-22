// Moving map for your own route, drawn from the area data rather than map tiles, so it works offline: controlled
// airspace and its base, VRPs, landmarks, the airfield, your route and the track you've flown, and the aircraft.
// Track-up or north-up, zoom, drag to look around; tap a place and the app offers Direct to / Divert.
// Positions are the area's grid in nm with y north; SVG's y runs down, so a point is drawn at (x, -y). Symbols and
// labels are drawn in pixels (scaled by nm-per-pixel) so they keep their size, and turned to stay upright.
import { dist, bearing, inside, edgeDistance } from './geo.js';

const NS = 'http://www.w3.org/2000/svg';
const SPANS = [3, 5, 8, 12, 20, 30, 45];              // nm across the map
const BARS = [0.25, 0.5, 1, 2, 5, 10, 20];             // scale-bar lengths, nm
const LOOK_AHEAD = 0.22;                               // track-up: the aircraft sits this far below the middle
const n3 = v => (Math.round(v * 1000) / 1000).toString();
const make = (name, attrs = {}, parent = null) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const turn = (from, to, max) => { const d = ((to - from + 540) % 360) - 180; return (from + Math.max(-max, Math.min(max, d)) + 360) % 360; };

// A spot well inside a polygon for its label: the grid point furthest from any edge (a cheap pole of inaccessibility).
function labelSpot(poly) {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(x1 - x0, y1 - y0) / 30;
  let best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, d: -1 };
  for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) {
    const p = { x, y };
    if (!inside(p, poly)) continue;
    const d = edgeDistance(p, poly);
    if (d > best.d) best = { x, y, d };
  }
  return best;
}

export class MovingMap {
  /** root: a .map element holding an <svg> and the controls. onPick(place, { d, brg }) when a place is tapped. */
  constructor(root, { onPick = null } = {}) {
    this.root = root;
    this.onPick = onPick;
    this.svg = root.querySelector('svg');
    this.svg.replaceChildren();
    this.world = make('g', {}, this.svg);
    this.layer = Object.fromEntries(['air', 'airport', 'flown', 'route', 'marks', 'ac'].map(n => [n, make('g', { class: n }, this.world)]));
    this.flownLine = make('polyline', { class: 'flown', points: '' }, this.layer.flown);
    this.ac = make('g', { class: 'aircraft' }, this.layer.ac);
    make('circle', { class: 'orbit-ring', r: 18 }, this.ac);
    make('path', { d: 'M0 -11L7 9L0 5L-7 9Z' }, this.ac);
    this.ac.style.display = 'none';
    this.marks = [];                 // { g, x, y, place?, wp? } drawn in pixels
    this.span = 12; this.northUp = false; this.follow = true; this.centre = null;
    this.nav = null; this.navAt = 0; this.heading = 0; this.iconHeading = 0; this.fixed = null;
    this.flown = [];
    this.size = { w: 0, h: 0 };
    this.bind();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(root);
    this.resize();
    this.raf = requestAnimationFrame(t => this.tick(t));
  }

  destroy() { cancelAnimationFrame(this.raf); this.observer.disconnect(); }

  /** Start a new flight: forget the flown track and follow the aircraft again. */
  reset() {
    this.nav = null; this.fixed = null; this.fitTo = null; this.seen = false; this.flown = []; this.flownLine.setAttribute('points', '');
    this.follow = true; this.centre = null; this.root.classList.remove('panned', 'orbiting');
    this.ac.style.display = 'none';
  }

  setArea(area) {
    if (this.area === area) return;
    this.area = area;
    const { air, airport, marks } = this.layer;
    air.replaceChildren(); airport.replaceChildren(); marks.replaceChildren();
    this.marks = [];
    for (const v of [...area.airspace].sort((a, b) => b.base - a.base)) {
      make('path', { d: 'M' + v.poly.map(p => `${n3(p.x)} ${n3(-p.y)}`).join('L') + 'Z', class: `cas ${v.kind.toLowerCase()}` }, air);
    }
    for (const v of area.airspace) {
      const spot = labelSpot(v.poly), short = v.name.replace(/^.*\b(CTR|CTA \d+)$/, '$1');
      this.mark(marks, spot, 'cas-label', g => {
        make('text', { y: -3 }, g).textContent = short;
        make('text', { y: 10 }, g).textContent = `${v.base ? v.base : 'SFC'}–FL${Math.round(v.top / 100)}`;
      });
    }
    const ap = area.airport;
    if (ap) {
      if (ap.atz) make('circle', { class: 'atz', cx: n3(ap.x), cy: n3(-ap.y), r: ap.atz }, airport);
      for (const r of ap.runways || []) make('line', { class: 'rwy', x1: n3(r.a.x), y1: n3(-r.a.y), x2: n3(r.b.x), y2: n3(-r.b.y) }, airport);
      this.mark(marks, ap, 'airfield-label', g => { make('text', { x: 10, y: -8 }, g).textContent = ap.name; });
    }
    for (const p of area.places) {
      const kind = p.kind === 'vrp' ? 'vrp' : p.kind === 'airfield' ? 'field' : 'place';
      this.mark(marks, p, `pt ${kind}`, g => {
        if (kind === 'vrp') make('path', { d: 'M0 -6.5L5.6 3.2L-5.6 3.2Z' }, g);
        else make('circle', { r: kind === 'field' ? 3.4 : 2.3 }, g);
        make('text', { x: kind === 'vrp' ? 8 : 6, y: 4 }, g).textContent = p.name;
      }, p);
    }
    this.lastPx = null;
  }

  /** The route event from the engine: { points: [{ name, kind, x, y }], pending }. */
  setRoute({ points, pending = null }) {
    const g = this.layer.route;
    g.replaceChildren();
    const line = pts => pts.map(p => `${n3(p.x)},${n3(-p.y)}`).join(' ');
    make('polyline', { class: 'leg', points: line(points) }, g);
    if (pending) make('polyline', { class: 'leg pending', points: line(pending) }, g);
    this.marks = this.marks.filter(m => !m.wp);
    for (const p of pending || points) {
      if (p.kind === 'position') continue;
      this.mark(g, p, 'wp', w => make('circle', { r: 5 }, w), null, p.name);
    }
    this.route = points;
    this.lastPx = null;
  }

  /** A nav event from the engine (once a second). */
  update(nav) {
    this.nav = nav; this.navAt = performance.now();
    const last = this.flown[this.flown.length - 1];
    if (!last || dist(last, nav) > 0.05) {
      this.flown.push({ x: nav.x, y: nav.y });
      if (this.flown.length > 3000) this.flown.shift();
      this.flownLine.setAttribute('points', this.flown.map(p => `${n3(p.x)},${n3(-p.y)}`).join(' '));
    }
    for (const m of this.marks) if (m.wp) m.g.classList.toggle('next', !!nav.next && m.wp === nav.next.name);
    this.root.classList.toggle('orbiting', !!nav.orbiting);
    if (!this.seen) { this.heading = this.iconHeading = nav.track; this.seen = true; }       // first fix: face the way we're going
  }

  /** A look-only view of a whole route, north up (the briefing). */
  fit(points) {
    this.fitTo = points;                                                     // refitted when the map gets its size
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const aspect = this.size.w && this.size.h ? this.size.w / this.size.h : 1.5;
    this.span = Math.max(8, Math.max(w, h * aspect) * 1.25);
    this.centre = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
    this.follow = false; this.northUp = true;
    this.fixed = { x: points[0].x, y: points[0].y, track: bearing(points[0], points[1] || points[0]) };
    this.heading = this.iconHeading = this.fixed.track;
    this.lastPx = null;
  }

  // ---------- drawing ----------
  mark(parent, at, cls, build, place = null, wp = null) {
    const g = make('g', { class: cls }, parent);
    build(g);
    this.marks.push({ g, x: at.x, y: at.y, place, wp });
  }

  resize() {
    const r = this.svg.getBoundingClientRect();
    this.size = { w: r.width, h: r.height };
    this.lastPx = null;
    if (this.fitTo && r.width) this.fit(this.fitTo);
  }

  // Between nav events, carry the aircraft on along its track so the map rolls rather than jumps.
  position(t) {
    const n = this.nav;
    if (!n) return this.fixed;
    if (n.orbiting || !n.rate) return n;
    const d = n.speedKt * n.rate * Math.min(1500, t - this.navAt) / 3600000, a = n.track * Math.PI / 180;
    return { ...n, x: n.x + d * Math.sin(a), y: n.y + d * Math.cos(a) };
  }

  tick(t) {
    this.raf = requestAnimationFrame(tt => this.tick(tt));
    const dt = Math.min(100, t - (this.lastT ?? t));
    this.lastT = t;
    if (!this.root.isConnected || this.root.offsetParent === null) return;       // hidden: don't draw
    const pos = this.position(t);
    if (pos && this.nav) {
      this.heading = turn(this.heading, pos.track, 90 * dt / 1000);             // the map turns smoothly at a waypoint
      this.iconHeading = this.nav.orbiting ? (this.iconHeading + 30 * (this.nav.rate || 1) * dt / 1000) % 360 : this.heading;
    }
    this.frame(pos);
  }

  frame(pos) {
    const { w, h } = this.size;
    if (!w || !h) return;
    const px = this.span / w, H = h * px;
    const rot = this.northUp ? 0 : this.heading;
    const c = this.follow && pos ? pos : this.centre || pos || { x: 0, y: 0 };
    const shift = this.northUp ? 0 : H * LOOK_AHEAD;
    this.svg.setAttribute('viewBox', `${n3(-this.span / 2)} ${n3(-H / 2 - shift)} ${n3(this.span)} ${n3(H)}`);
    this.world.setAttribute('transform', `rotate(${n3(-rot)}) translate(${n3(-c.x)} ${n3(c.y)})`);
    this.view = { px, rot, c, shift, H };
    if (px !== this.lastPx || rot !== this.lastRot) {
      for (const m of this.marks) m.g.setAttribute('transform', `translate(${n3(m.x)} ${n3(-m.y)}) rotate(${n3(rot)}) scale(${n3(px)})`);
      this.lastPx = px; this.lastRot = rot;
      this.root.classList.toggle('far', this.span > 20);
      this.scaleBar(px, w);
    }
    if (pos) {
      this.ac.style.display = '';
      this.ac.setAttribute('transform', `translate(${n3(pos.x)} ${n3(-pos.y)}) rotate(${n3(this.iconHeading)}) scale(${n3(px)})`);
    }
  }

  scaleBar(px, w) {
    const bar = this.root.querySelector('.map-scale');
    if (!bar) return;
    const len = [...BARS].reverse().find(b => b / px <= w * 0.28) || BARS[0];
    bar.querySelector('span').style.width = `${Math.round(len / px)}px`;
    bar.querySelector('b').textContent = `${len} nm`;
  }

  // ---------- controls ----------
  zoom(dir) {
    const i = SPANS.findIndex(s => s >= this.span - 1e-9);
    this.span = SPANS[Math.max(0, Math.min(SPANS.length - 1, (i < 0 ? SPANS.length - 1 : i) + dir))];
  }

  // Where on the map (area grid, nm) a screen point is.
  toWorld(clientX, clientY) {
    const r = this.svg.getBoundingClientRect(), { px, rot, c, shift, H } = this.view;
    const sx = -this.span / 2 + (clientX - r.left) * px, sy = -H / 2 - shift + (clientY - r.top) * px;
    const a = rot * Math.PI / 180;
    return { x: c.x + sx * Math.cos(a) - sy * Math.sin(a), y: c.y - (sx * Math.sin(a) + sy * Math.cos(a)) };
  }

  bind() {
    const svg = this.svg;
    let start = null;
    svg.addEventListener('pointerdown', e => {
      if (!this.view) return;
      start = { x: e.clientX, y: e.clientY, c: { ...this.view.c }, moved: false, id: e.pointerId };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 6) return;
      start.moved = true;
      const { px, rot } = this.view, a = rot * Math.PI / 180;
      this.follow = false;                                                   // drag the map with your finger
      this.centre = { x: start.c.x - (dx * Math.cos(a) - dy * Math.sin(a)) * px, y: start.c.y + (dx * Math.sin(a) + dy * Math.cos(a)) * px };
      this.root.classList.add('panned');
    });
    const end = e => {
      if (!start || e.pointerId !== start.id) return;
      const tapped = !start.moved && e.type === 'pointerup';
      start = null;
      if (tapped && this.onPick) this.pick(e.clientX, e.clientY);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1 : -1); }, { passive: false });
    const on = (cls, fn) => this.root.querySelector(cls)?.addEventListener('click', fn);
    on('.map-zoom-in', () => this.zoom(-1));
    on('.map-zoom-out', () => this.zoom(1));
    on('.map-orient', e => { this.northUp = !this.northUp; e.currentTarget.textContent = this.northUp ? 'N' : 'TRK'; e.currentTarget.setAttribute('aria-label', this.northUp ? 'North up: switch to track up' : 'Track up: switch to north up'); });
    on('.map-centre', () => { this.follow = true; this.centre = null; this.root.classList.remove('panned'); });
  }

  // The place nearest the tap (within about 24 px), measured from the aircraft for the Direct to / Divert sheet.
  pick(clientX, clientY) {
    const p = this.toWorld(clientX, clientY), reach = 24 * this.view.px;
    let best = null;
    for (const m of this.marks) {
      const place = m.place || (m.wp && this.area.places.find(q => q.name === m.wp));
      if (!place) continue;
      const d = dist(p, m);
      if (d <= reach && (!best || d < best.d)) best = { place, d };
    }
    if (!best) return;
    const from = this.position(performance.now()) || this.fixed;
    this.onPick(best.place, from ? { d: dist(from, best.place), brg: bearing(from, best.place) } : null);
  }
}
