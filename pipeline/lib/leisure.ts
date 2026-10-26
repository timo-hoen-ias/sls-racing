// Leisure grounds from OSM (2026-10-25): pitches get their surface, line markings and equipment by sport (goals
// and floodlights on football pitches, nets on tennis and volleyball courts, hoops on basketball courts),
// playgrounds get swings, slides, climbing frames and sandpits, swimming pools a flat basin with a tiled rim,
// fountain areas a stone basin, running tracks their tartan. Drawn into the tiles' "details" layer (details.ts);
// goals, hoops, masts and play equipment are solid.
import { type Details, type Rgb, hexRgb } from './details.ts';
import type { OsmData, Polygon } from './osm.ts';
import type { DetailSpot } from './roadDetails.ts';

type Height = (e: number, n: number) => number;
type P3 = [number, number, number];
type Pt = [number, number];

const WHITE = hexRgb(0xeeeeea), NET = hexRgb(0x2b2e30), STEEL = hexRgb(0x8d948f), LAMP = hexRgb(0xdedbd0);
const WOOD = hexRgb(0x8a6a48), RED = hexRgb(0xb83a2e), YELLOW = hexRgb(0xe0b23a), BLUE = hexRgb(0x2f6fb0), SAND = hexRgb(0xd8c28e);
const POOL = hexRgb(0x4bb3d3), RIM = hexRgb(0xe8e4dc), STONE = hexRgb(0xb9b2a5), FOUNTAIN_WATER = hexRgb(0x5b8fa3), TARTAN = hexRgb(0xa4473a);

/** Pitch surface colour by sport and surface tag; undefined keeps the ground (grass). */
export function pitchSurface(t: Record<string, string>): Rgb | undefined {
  const sport = t.sport ?? '', surface = t.surface ?? '';
  if (/grass/.test(surface)) return undefined;
  if (/artificial_turf/.test(surface)) return hexRgb(0x3f7a3a);
  if (/tartan|rubber/.test(surface)) return TARTAN;
  if (/asphalt|concrete|paved/.test(surface)) return hexRgb(0x55585a);
  if (/sand/.test(surface) || /beachvolleyball|equestrian/.test(sport)) return /equestrian/.test(sport) ? hexRgb(0xc7ad7c) : SAND;
  if (/clay|fine_gravel|gravel/.test(surface)) return /tennis/.test(sport) ? hexRgb(0xb4553a) : hexRgb(0x9a5a3e);
  if (/acrylic|hard/.test(surface)) return hexRgb(0x2f5d8a);
  if (/tennis/.test(sport)) return hexRgb(0xb4553a); // German courts are mostly clay
  if (/boules/.test(sport)) return hexRgb(0xbca57f);
  if (/basketball|multi|skateboard|table_tennis/.test(sport)) return hexRgb(0x55585a);
  return undefined;
}

/** Smallest rectangle round a ring: centre, unit long axis (ue, un), half length a along it and half width b. */
export function orientedRect(ring: Pt[]): { e: number; n: number; ue: number; un: number; a: number; b: number } | undefined {
  const pts = hull(ring);
  if (pts.length < 3) return undefined;
  let best: { e: number; n: number; ue: number; un: number; a: number; b: number } | undefined, bestArea = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 1e-6) continue;
    const ue = (q[0] - p[0]) / l, un = (q[1] - p[1]) / l;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const [e, n] of pts) {
      const s = e * ue + n * un, t = -e * un + n * ue;
      s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area < bestArea) {
      bestArea = area;
      const sc = (s0 + s1) / 2, tc = (t0 + t1) / 2;
      const r = { e: sc * ue - tc * un, n: sc * un + tc * ue, ue, un, a: (s1 - s0) / 2, b: (t1 - t0) / 2 };
      best = r.a >= r.b ? r : { e: r.e, n: r.n, ue: -un, un: ue, a: r.b, b: r.a };
    }
  }
  return best;
}

function hull(ring: Pt[]): Pt[] {
  const p = [...ring].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function ringArea(r: Pt[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s / 2);
}

function inside(ring: Pt[], e: number, n: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Small deterministic hash (0..1) for picking equipment. */
const hash = (a: number, b: number) => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export interface LeisureStats { pitches: number; goals: number; nets: number; floodlights: number; playgrounds: number; equipment: number; pools: number; fountains: number; tracks: number; spots: DetailSpot[] }

export function buildLeisure(osm: Pick<OsmData, 'polygons' | 'points' | 'extra'>, details: Details, measured: Height): LeisureStats {
  // Areas beyond the fetched terrain are left out (NaN).
  const height: Height = (e, n) => { try { return measured(e, n); } catch { return NaN; } };
  const stats: LeisureStats = { pitches: 0, goals: 0, nets: 0, floodlights: 0, playgrounds: 0, equipment: 0, pools: 0, fountains: 0, tracks: 0, spots: [] };
  const areas = [...osm.polygons, ...(osm.extra?.areas ?? [])];
  const seen = new Set<number>();
  const once = (p: Polygon) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; };
  const onGround = (lift: number) => (e: number, n: number) => height(e, n) + lift;
  const valid = (ring: Pt[]) => ring.every(([e, n]) => Number.isFinite(height(e, n)));

  for (const p of areas) {
    const t = p.tags;
    if (t.leisure !== 'pitch' || !once(p) || !valid(p.outer)) continue;
    const surf = pitchSurface(t);
    if (surf) details.surface(p.outer, p.holes, onGround(0.03), surf);
    const r = orientedRect(p.outer);
    if (!r) continue;
    stats.pitches++;
    const sport = t.sport ?? '';
    stats.spots.push({ kind: 'sportplatz', e: r.e, n: r.n, note: `${sport || 'Platz'} ${(r.a * 2).toFixed(0)}×${(r.b * 2).toFixed(0)} m${t.name ? `, ${t.name}` : ''}` });
    // A pitch that is not near a rectangle gets no lines.
    if (ringArea(p.outer) < 0.75 * 4 * r.a * r.b || r.a < 4) continue;
    const at = (s: number, q: number): Pt => [r.e + r.ue * s - r.un * q, r.n + r.un * s + r.ue * q];
    const P = (s: number, q: number, lift: number): P3 => { const [e, n] = at(s, q); return [e, n, height(e, n) + lift]; };
    const line = (s0: number, q0: number, s1: number, q1: number, w = 0.1) => {
      const len = Math.hypot(s1 - s0, q1 - q0), k = Math.max(1, Math.ceil(len / 3));
      const pts: P3[] = [];
      for (let i = 0; i <= k; i++) pts.push(P(s0 + ((s1 - s0) * i) / k, q0 + ((q1 - q0) * i) / k, 0.05));
      details.ribbon(pts, w, WHITE);
    };
    const box = (a: number, b: number) => { line(-a, -b, a, -b); line(a, -b, a, b); line(a, b, -a, b); line(-a, b, -a, -b); };
    const circle = (s: number, q: number, rad: number, from = 0, to = Math.PI * 2) => {
      const k = Math.max(8, Math.ceil((rad * (to - from)) / 1.5));
      const pts: P3[] = [];
      for (let i = 0; i <= k; i++) { const ang = from + ((to - from) * i) / k; pts.push(P(s + Math.cos(ang) * rad, q + Math.sin(ang) * rad, 0.05)); }
      details.ribbon(pts, 0.1, WHITE);
    };
    const post = (s: number, q: number, h: number, rad: number, col: Rgb) => {
      const [e, n, y] = P(s, q, 0);
      details.cylinder(e, n, y, rad, h, col, 6);
      details.solid([e, n, y], Math.max(0.2, rad * 2), Math.max(0.2, rad * 2), h, r.ue, r.un);
    };
    const net = (q0: number, q1: number, h: number) => {
      post(0, q0, h + 0.05, 0.05, STEEL);
      post(0, q1, h + 0.05, 0.05, STEEL);
      const a = P(0, q0, 0), b = P(0, q1, 0);
      details.wall([a[0], a[1], a[2] + h * 0.1], [b[0], b[1], b[2] + h * 0.1], h * 0.9, NET);
      details.tube([a[0], a[1], a[2] + h], [b[0], b[1], b[2] + h], 0.03, WHITE, 3);
      stats.nets++;
    };
    const a = r.a - 1, b = r.b - 1;
    if (/soccer/.test(sport) && a > 12) {
      box(a, b);
      line(0, -b, 0, b);
      circle(0, 0, Math.min(9.15, b * 0.45));
      const pd = Math.min(16.5, a * 0.3), pw = Math.min(20.15, b * 0.75), gd = Math.min(5.5, a * 0.1), gw = Math.min(9.15, b * 0.35);
      for (const side of [-1, 1]) {
        line(side * a, -pw, side * (a - pd), -pw); line(side * (a - pd), -pw, side * (a - pd), pw); line(side * (a - pd), pw, side * a, pw);
        line(side * a, -gw, side * (a - gd), -gw); line(side * (a - gd), -gw, side * (a - gd), gw); line(side * (a - gd), gw, side * a, gw);
        // Goal: posts, crossbar and a frame back to the ground.
        const big = a > 35, w = big ? 3.66 : 2.5, h = big ? 2.44 : 2, depth = big ? 1.8 : 1.2;
        for (const q of [-w, w]) {
          post(side * a, q, h, 0.06, WHITE);
          const top = P(side * a, q, h), back = P(side * (a + depth), q, 0);
          details.tube(top, back, 0.04, WHITE, 3);
        }
        details.tube(P(side * a, -w, h), P(side * a, w, h), 0.06, WHITE, 4);
        details.tube(P(side * (a + depth), -w, 0.05), P(side * (a + depth), w, 0.05), 0.04, WHITE, 3);
        stats.goals++;
      }
      if (a > 35) {
        // Floodlights: four masts beside the touchlines.
        for (const s of [-a * 0.55, a * 0.55]) for (const q of [-(r.b + 3), r.b + 3]) {
          post(s, q, 18, 0.18, STEEL);
          const head = P(s, q, 18), toward = P(s, q * 0.8, 17.5);
          details.box(head[0], head[1], head[2], r.ue, r.un, 2.2, 0.5, 1.2, LAMP);
          details.tube(head, toward, 0.06, STEEL, 3);
          stats.floodlights++;
        }
      }
    } else if (/tennis/.test(sport) && a > 8) {
      const k = Math.min(1, a / 11.885, b / 5.485), L = 11.885 * k, D = 5.485 * k, S = 4.115 * k, SV = 6.4 * k;
      box(L, D);
      line(-L, -S, L, -S); line(-L, S, L, S);
      line(-SV, -S, -SV, S); line(SV, -S, SV, S); line(-SV, 0, SV, 0);
      net(-D - 0.9, D + 0.9, 0.95);
    } else if (/basketball/.test(sport) && a > 6) {
      box(a, b);
      line(0, -b, 0, b);
      circle(0, 0, Math.min(1.8, b * 0.3));
      for (const side of [-1, 1]) {
        circle(side * a, 0, Math.min(6.75, b * 0.9), side > 0 ? Math.PI / 2 : -Math.PI / 2, side > 0 ? Math.PI * 1.5 : Math.PI / 2);
        post(side * (a + 1), 0, 3.4, 0.08, STEEL);
        const board = P(side * (a - 0.2), 0, 2.9);
        details.box(board[0], board[1], board[2], r.ue, r.un, 0.05, 1.8, 1.05, WHITE);
        details.tube(P(side * (a + 1), 0, 3.3), P(side * (a - 0.2), 0, 3.3), 0.05, STEEL, 3);
        circle(side * (a - 0.6), 0, 0.23);
      }
    } else if (/volleyball/.test(sport) && a > 5) {
      box(a, b);
      net(-b - 0.5, b + 0.5, 2.43);
    } else if (a > 6 && surf) {
      box(a, b);
    }
  }

  // Playgrounds: equipment on a grid inside the area, chosen per spot.
  const play = (e: number, n: number, kind: number, ue: number, un: number) => {
    const y = height(e, n);
    if (!Number.isFinite(y)) return;
    const le = -un, ln = ue;
    const Q = (s: number, q: number, h: number): P3 => [e + ue * s + le * q, n + un * s + ln * q, y + h];
    if (kind === 0) {
      // Swing: A-frames, top bar, two seats on chains.
      for (const s of [-1.6, 1.6]) for (const q of [-0.9, 0.9]) details.tube(Q(s, q, 0), Q(s, 0, 2.3), 0.06, RED, 4);
      details.tube(Q(-1.6, 0, 2.3), Q(1.6, 0, 2.3), 0.06, RED, 4);
      for (const s of [-0.7, 0.7]) {
        for (const d of [-0.22, 0.22]) details.tube(Q(s + d, 0, 2.3), Q(s + d, 0, 0.45), 0.012, STEEL, 3);
        details.box(Q(s, 0, 0)[0], Q(s, 0, 0)[1], y + 0.42, ue, un, 0.5, 0.18, 0.04, hexRgb(0x222222));
      }
      details.solid(Q(0, 0, 0), 2, 3.4, 2.3, le, ln);
    } else if (kind === 1) {
      // Slide: ladder tower and a ramp.
      details.box(Q(0, 0, 0)[0], Q(0, 0, 0)[1], y, ue, un, 1.2, 1.2, 1.5, WOOD, YELLOW);
      for (const q of [-0.35, 0.35]) details.tube(Q(0.6, q, 1.5), Q(3, q, 0.3), 0.05, BLUE, 4);
      details.quadUp(Q(0.6, -0.3, 1.5), Q(3, -0.3, 0.3), Q(3, 0.3, 0.3), Q(0.6, 0.3, 1.5), BLUE);
      details.quadDown(Q(0.6, -0.3, 1.48), Q(3, -0.3, 0.28), Q(3, 0.3, 0.28), Q(0.6, 0.3, 1.48), BLUE);
      details.solid(Q(0.6, 0, 0), 1.4, 3.6, 1.5, le, ln);
    } else if (kind === 2) {
      // Climbing frame: a cube of bars.
      const c = [-1, 1];
      for (const s of c) for (const q of c) details.tube(Q(s, q, 0), Q(s, q, 2), 0.05, YELLOW, 4);
      for (const h of [1, 2]) for (const s of c) { details.tube(Q(s, -1, h), Q(s, 1, h), 0.04, RED, 3); details.tube(Q(-1, s, h), Q(1, s, h), 0.04, RED, 3); }
      details.solid(Q(0, 0, 0), 2.1, 2.1, 2, le, ln);
    } else if (kind === 3) {
      // Sandpit: a low wooden frame round sand.
      details.surface([[Q(-2, -2, 0)[0], Q(-2, -2, 0)[1]], [Q(2, -2, 0)[0], Q(2, -2, 0)[1]], [Q(2, 2, 0)[0], Q(2, 2, 0)[1]], [Q(-2, 2, 0)[0], Q(-2, 2, 0)[1]]], [], (ee, nn) => height(ee, nn) + 0.12, SAND, 2);
      for (const [s0, q0, s1, q1] of [[-2, -2, 2, -2], [2, -2, 2, 2], [2, 2, -2, 2], [-2, 2, -2, -2]]) details.wall(Q(s0, q0, 0), Q(s1, q1, 0), 0.25, WOOD);
    } else {
      // Seesaw.
      details.box(Q(0, 0, 0)[0], Q(0, 0, 0)[1], y, ue, un, 0.3, 0.4, 0.5, RED);
      details.tube(Q(-1.8, 0, 0.3), Q(1.8, 0, 0.7), 0.07, WOOD, 4);
      details.solid(Q(0, 0, 0), 0.6, 3.6, 0.7, le, ln);
    }
    stats.equipment++;
  };
  for (const p of areas) {
    if (p.tags.leisure !== 'playground' || !once(p) || !valid(p.outer)) continue;
    const area = ringArea(p.outer), r = orientedRect(p.outer);
    if (!r || area < 25) continue;
    stats.playgrounds++;
    stats.spots.push({ kind: 'spielplatz', e: r.e, n: r.n, note: `${Math.round(area)} m²${p.tags.name ? `, ${p.tags.name}` : ''}` });
    const want = Math.max(1, Math.min(6, Math.round(area / 120)));
    let placed = 0;
    for (let s = -r.a + 3; s <= r.a - 3 && placed < want; s += 6.5)
      for (let q = -r.b + 3; q <= r.b - 3 && placed < want; q += 6.5) {
        const e = r.e + r.ue * s - r.un * q, n = r.n + r.un * s + r.ue * q;
        if (![[-2.5, -2.5], [2.5, -2.5], [2.5, 2.5], [-2.5, 2.5]].every(([x, z]) => inside(p.outer, e + x, n + z))) continue;
        play(e, n, (Math.floor(hash(p.id, placed) * 5) + placed) % 5, r.ue, r.un);
        placed++;
      }
    if (!placed) { play(r.e, r.n, Math.floor(hash(p.id, 9) * 5), r.ue, r.un); }
  }
  for (const pt of osm.points) {
    if (pt.tags.leisure !== 'playground') continue;
    play(pt.e, pt.n, Math.floor(hash(pt.id, 1) * 5), 1, 0);
    play(pt.e + 5, pt.n + 1, Math.floor(hash(pt.id, 2) * 5), 0, 1);
    stats.playgrounds++;
  }

  // Swimming pools and fountain basins: flat water at the highest ground on the rim, a rim, walls down to the ground.
  const basin = (p: Polygon, water: Rgb, rim: Rgb, wall: number, rimW: number) => {
    const ring = p.outer;
    const hs = ring.map(([e, n]) => height(e, n));
    const top = Math.max(...hs), low = Math.min(...hs);
    if (top - low > 1.5) return false;
    details.surface(ring, p.holes, () => top + wall - 0.12, water, 50);
    const pts: P3[] = ring.map(([e, n]) => [e, n, top + wall]);
    details.ribbon(pts, rimW, rim);
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]];
      // Both ends from the lower ground up to the rim, so the wall top stays level with it.
      const bot = Math.min(hs[i - 1], hs[i], top) - 0.1;
      details.wall([a[0], a[1], bot], [b[0], b[1], bot], top + wall - bot, rim);
    }
    return true;
  };
  for (const p of areas) {
    const t = p.tags;
    if (t.leisure === 'swimming_pool' && once(p) && valid(p.outer) && ringArea(p.outer) > 6 && t.location !== 'indoor' && t.indoor !== 'yes') {
      if (!basin(p, POOL, RIM, 0.12, 0.5)) continue;
      stats.pools++;
      const r = orientedRect(p.outer);
      if (r && stats.pools % 4 === 1) stats.spots.push({ kind: 'schwimmbecken', e: r.e, n: r.n, note: `${Math.round(ringArea(p.outer))} m²${t.name ? `, ${t.name}` : ''}` });
    } else if (t.amenity === 'fountain' && once(p) && valid(p.outer) && ringArea(p.outer) > 3) {
      if (!basin(p, FOUNTAIN_WATER, STONE, 0.5, 0.45)) continue;
      stats.fountains++;
      const r = orientedRect(p.outer);
      if (r) {
        const y = Math.max(...p.outer.map(([e, n]) => height(e, n)));
        details.cylinder(r.e, r.n, y, 0.35, 1.6, STONE, 8, 0.25);
        details.disc(r.e, r.n, y + 1.6, 0.7, STONE, 12);
        stats.spots.push({ kind: 'brunnen', e: r.e, n: r.n, note: t.name ?? '' });
      }
    }
  }

  // Running tracks: tartan, as an area (with the infield as a hole) or along the mapped line.
  const trackWays = new Set<number>();
  for (const w of osm.extra?.ways ?? []) {
    if (w.tags.leisure !== 'track' || w.tags.area === 'yes') continue;
    trackWays.add(w.id);
    if (!w.pts.every(([e, n]) => Number.isFinite(height(e, n)))) continue;
    const width = Number.parseFloat(w.tags.width ?? '') || (w.closed ? 7.5 : 5);
    details.ribbon(w.pts.flatMap(([e, n], i) => {
      if (i === 0) return [[e, n, height(e, n) + 0.04] as P3];
      // Split long segments so the ribbon follows the ground.
      const [pe, pn] = w.pts[i - 1], k = Math.max(1, Math.ceil(Math.hypot(e - pe, n - pn) / 3));
      return Array.from({ length: k }, (_, j) => { const f = (j + 1) / k, x = pe + (e - pe) * f, z = pn + (n - pn) * f; return [x, z, height(x, z) + 0.04] as P3; });
    }), width, TARTAN);
    stats.tracks++;
    stats.spots.push({ kind: 'laufbahn', e: w.pts[0][0], n: w.pts[0][1], note: w.tags.name ?? '' });
  }
  for (const p of osm.extra?.areas ?? []) {
    if (p.tags.leisure !== 'track' || trackWays.has(p.id) || !once(p) || !valid(p.outer)) continue;
    details.surface(p.outer, p.holes, onGround(0.04), TARTAN);
    stats.tracks++;
    stats.spots.push({ kind: 'laufbahn', e: p.outer[0][0], n: p.outer[0][1], note: p.tags.name ?? '' });
  }
  return stats;
}
