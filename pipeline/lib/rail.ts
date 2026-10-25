// Railways from OSM (2026-10-25): track on a ballast bed with sleepers and two rails, drawn into the tiles'
// "details" layer (details.ts, visual only). Electrified lines get catenary masts with a contact wire, bridges a
// concrete deck, level crossings flush rails with a crossing panel and St Andrew's crosses (Prop.railCross).
// Track height: the terrain (DGM1 has the embankments), a straight span on bridges, the road surface at crossings.
import { Prop } from '../../src/world/propKinds.ts';
import { tileKey, utmToLocal, type WorldInfo } from '../../src/world/format.ts';
import { type Details, type Rgb, along, hexRgb } from './details.ts';
import type { OsmData, Way } from './osm.ts';
import { isBridge, isDrivable, roadSurfaceHeights, roadWidth } from './roads.ts';
import type { DetailSpot } from './roadDetails.ts';

type Height = (e: number, n: number) => number;

/** Track segment length (m): bed, rails and crossings are sampled this often. */
const SEG = 4;

/** Track dimensions (m): standard gauge 1435 mm, rail centres 1.5 m apart. */
export const TRACK = { gauge: 1.5, railH: 0.16, railW: 0.075, sleeperLen: 2.6, sleeperW: 0.26, sleeperEvery: 1.2, sleeperH: 0.1, bedTop: 2.8, bedBottom: 4.2, bedH: 0.35 };
/** Catenary: mast spacing, mast offset from the track centre, contact wire height above the rail top. */
export const CATENARY = { every: 55, offset: 3.1, mastH: 7, wireH: 5.5 };

const BALLAST = hexRgb(0x6e685f), BALLAST_OLD = hexRgb(0x6f7258), SLEEPER = hexRgb(0x5f574d), RAIL = hexRgb(0x5d5148), RAIL_TOP = hexRgb(0xa9a49c);
const RAIL_OLD = hexRgb(0x6b4a34), MAST = hexRgb(0x7f8a86), WIRE = hexRgb(0x3b3f3e), DECK = hexRgb(0xa29d93), DECK_UNDER = hexRgb(0x77736c), PANEL = hexRgb(0x3c3c3a);

/** Railway ways drawn as track; tunnels, abandoned and razed lines are left out. */
export const isTrack = (t: Record<string, string>) => /^(rail|light_rail|narrow_gauge|tram|disused)$/.test(t.railway ?? '') && !(t.tunnel && t.tunnel !== 'no');

interface RoadAt { d: number; y: number; half: number; de: number; dn: number }

/** Drivable roads as segments with their surface heights, for crossings. */
function roadIndex(ways: Way[], height: Height) {
  const C = 32;
  const grid = new Map<string, { a: [number, number]; b: [number, number]; ya: number; yb: number; half: number; bridge: boolean }[]>();
  for (const w of ways) {
    if (!isDrivable(w.tags)) continue;
    const ys = roadSurfaceHeights(w, height), half = roadWidth(w.tags)! / 2, bridge = isBridge(w.tags);
    for (let i = 1; i < w.pts.length; i++) {
      const s = { a: w.pts[i - 1], b: w.pts[i], ya: ys[i - 1], yb: ys[i], half, bridge };
      for (let x = Math.floor((Math.min(s.a[0], s.b[0]) - 10) / C); x <= Math.floor((Math.max(s.a[0], s.b[0]) + 10) / C); x++)
        for (let y = Math.floor((Math.min(s.a[1], s.b[1]) - 10) / C); y <= Math.floor((Math.max(s.a[1], s.b[1]) + 10) / C); y++) {
          const k = `${x}_${y}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push(s);
        }
    }
  }
  /** The road nearest to (e, n) whose surface lies within `dy` of y, if its carriageway (+ margin) covers the point. */
  return (e: number, n: number, y: number, margin: number, dy = 1.5): RoadAt | undefined => {
    let best: RoadAt | undefined;
    for (const s of grid.get(`${Math.floor(e / C)}_${Math.floor(n / C)}`) ?? []) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((e - s.a[0]) * dx + (n - s.a[1]) * dz) / l2));
      const d = Math.hypot(s.a[0] + dx * t - e, s.a[1] + dz * t - n);
      const ry = s.ya + (s.yb - s.ya) * t;
      if (d > s.half + margin || Math.abs(ry - y) > dy || s.bridge) continue;
      if (!best || d < best.d) { const l = Math.sqrt(l2); best = { d, y: ry, half: s.half, de: dx / l, dn: dz / l }; }
    }
    return best;
  };
}

export interface RailStats { km: number; electrifiedKm: number; masts: number; bridges: number; crossings: number; props: Map<string, number[]>; spots: DetailSpot[] }

export function buildRail(osm: Pick<OsmData, 'ways' | 'points' | 'extra'>, world: WorldInfo, details: Details, height: Height): RailStats {
  const tracks = (osm.extra?.ways ?? []).filter((w) => isTrack(w.tags));
  const road = roadIndex(osm.ways, height);
  const stats: RailStats = { km: 0, electrifiedKm: 0, masts: 0, bridges: 0, crossings: 0, props: new Map(), spots: [] };
  // Track centrelines on a grid, so a mast is not put onto a neighbouring track.
  const C = 16, centres = new Map<string, [number, number][]>();
  for (const w of tracks) for (const p of along(w.pts, 2)) {
    const k = `${Math.floor(p.e / C)}_${Math.floor(p.n / C)}`;
    if (!centres.has(k)) centres.set(k, []);
    centres.get(k)!.push([p.e, p.n]);
  }
  const trackNear = (e: number, n: number, r: number) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++)
      for (const [x, y] of centres.get(`${Math.floor(e / C) + a}_${Math.floor(n / C) + b}`) ?? []) if (Math.hypot(x - e, y - n) < r) return true;
    return false;
  };
  const addProp = (kind: number, e: number, n: number, y: number, de: number, dn: number) => {
    const k = tileKey(Math.floor(e / world.tileSize), Math.floor(n / world.tileSize));
    if (!stats.props.has(k)) stats.props.set(k, []);
    const [x, z] = utmToLocal(world, e, n);
    stats.props.get(k)!.push(kind, Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100, Math.round(Math.atan2(de, -dn) * 1000) / 1000, 0);
  };

  for (const w of tracks) {
    const old = w.tags.railway === 'disused';
    const bridge = isBridge(w.tags);
    // Bed level along the way: terrain (averaged over 3 m against the 1 m survey noise) or the bridge span.
    const pts = along(w.pts, SEG);
    if (pts.length < 2) continue;
    const ground = (e: number, n: number, de: number, dn: number) => (height(e, n) * 2 + height(e - de * 1.5, n - dn * 1.5) + height(e + de * 1.5, n + dn * 1.5)) / 4;
    const len = pts[pts.length - 1].d;
    const y0 = ground(pts[0].e, pts[0].n, pts[0].de, pts[0].dn), y1 = ground(pts[pts.length - 1].e, pts[pts.length - 1].n, pts[0].de, pts[0].dn);
    const bed = pts.map((p) => (bridge ? y0 + ((y1 - y0) * p.d) / (len || 1) : ground(p.e, p.n, p.de, p.dn)));
    stats.km += len / 1000;
    if (bridge) {
      stats.bridges++;
      stats.spots.push({ kind: 'bahnbruecke', e: pts[Math.floor(pts.length / 2)].e, n: pts[Math.floor(pts.length / 2)].n, note: `${len.toFixed(0)} m${w.tags.name ? `, ${w.tags.name}` : ''}` });
    }
    // Crossings: where a road at about the same level covers the track, the rails sit flush in its surface.
    const top = pts.map((p, i) => {
      const r = road(p.e, p.n, bed[i] + TRACK.bedH, 0.8);
      return r ? r.y + 0.01 : bed[i] + TRACK.bedH + TRACK.sleeperH;
    });
    const crossing = pts.map((p, i) => !!road(p.e, p.n, bed[i] + TRACK.bedH, 0.8));
    const across = (p: { de: number; dn: number }) => [p.dn, -p.de];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const [ae, an] = across(a), [be, bn] = across(b);
      const P = (p: typeof a, q: number[], off: number, y: number): [number, number, number] => [p.e + q[0] * off, p.n + q[1] * off, y];
      if (!crossing[i - 1] && !crossing[i]) {
        // Ballast bed: flat top and two slopes down into the ground.
        const ya = bed[i - 1], yb = bed[i];
        const ht = TRACK.bedTop / 2, hb = TRACK.bedBottom / 2, h = TRACK.bedH;
        const col: Rgb = old ? BALLAST_OLD : BALLAST;
        details.quadUp(P(a, [ae, an], -ht, ya + h), P(a, [ae, an], ht, ya + h), P(b, [be, bn], ht, yb + h), P(b, [be, bn], -ht, yb + h), col);
        for (const s of [-1, 1]) details.quadUp(P(a, [ae, an], s * ht, ya + h), P(a, [ae, an], s * hb, ya - 0.15), P(b, [be, bn], s * hb, yb - 0.15), P(b, [be, bn], s * ht, yb + h), col);
        if (bridge) {
          // Deck under the bed with parapets; its underside is what a driver sees passing below.
          for (const s of [-1, 1]) details.wall(P(a, [ae, an], s * 2.3, ya - 1.2), P(b, [be, bn], s * 2.3, yb - 1.2), 2.2, DECK);
          details.quadDown(P(a, [ae, an], -2.3, ya - 1.2), P(a, [ae, an], 2.3, ya - 1.2), P(b, [be, bn], 2.3, yb - 1.2), P(b, [be, bn], -2.3, yb - 1.2), DECK_UNDER);
        }
      } else {
        // Crossing panel between and beside the rails.
        const ya = top[i - 1] - 0.005, yb = top[i] - 0.005;
        details.quadUp(P(a, [ae, an], -1.1, ya), P(a, [ae, an], 1.1, ya), P(b, [be, bn], 1.1, yb), P(b, [be, bn], -1.1, yb), PANEL);
      }
      // Rails: a box each, top shiny.
      for (const s of [-1, 1]) {
        const off = (s * TRACK.gauge) / 2, hw = TRACK.railW / 2;
        const ya = top[i - 1] + TRACK.railH * (crossing[i - 1] ? 0.05 : 1), yb = top[i] + TRACK.railH * (crossing[i] ? 0.05 : 1);
        const ba = crossing[i - 1] ? ya - 0.02 : top[i - 1], bb = crossing[i] ? yb - 0.02 : top[i];
        details.quadUp(P(a, [ae, an], off - hw, ya), P(a, [ae, an], off + hw, ya), P(b, [be, bn], off + hw, yb), P(b, [be, bn], off - hw, yb), old ? RAIL_OLD : RAIL_TOP);
        for (const t of [-1, 1]) {
          const fa = P(a, [ae, an], off + t * hw, ba), fb = P(b, [be, bn], off + t * hw, bb);
          details.face(fa, fb, ya, yb, ae * t, an * t, old ? RAIL_OLD : RAIL);
        }
      }
    }
    // Sleepers: flat slabs every 1.2 m on the bed (none at crossings).
    for (const s of along(w.pts, TRACK.sleeperEvery)) {
      const i = Math.min(pts.length - 1, Math.round(s.d / SEG));
      if (crossing[i]) continue;
      const f = s.d / SEG, i0 = Math.min(bed.length - 1, Math.floor(f)), i1 = Math.min(bed.length - 1, Math.ceil(f));
      const y = bed[i0] + (bed[i1] - bed[i0]) * (f % 1) + TRACK.bedH;
      // Top face only: the sides are a few centimetres and cost most of the triangles.
      const ae = (s.dn * TRACK.sleeperLen) / 2, an = (-s.de * TRACK.sleeperLen) / 2, ce = (s.de * TRACK.sleeperW) / 2, cn = (s.dn * TRACK.sleeperW) / 2;
      const yt = y + TRACK.sleeperH;
      details.quadUp([s.e - ae - ce, s.n - an - cn, yt], [s.e + ae - ce, s.n + an - cn, yt], [s.e + ae + ce, s.n + an + cn, yt], [s.e - ae + ce, s.n - an + cn, yt], SLEEPER);
    }
    // Catenary on electrified lines: masts on the free side, a cantilever and the contact wire mast to mast.
    if (w.tags.electrified === 'contact_line' && !old) {
      stats.electrifiedKm += len / 1000;
      let prev: [number, number, number] | undefined;
      for (const m of along(w.pts, CATENARY.every)) {
        const i = Math.min(pts.length - 1, Math.round(m.d / SEG));
        const rail = top[i] + TRACK.railH;
        const wire: [number, number, number] = [m.e, m.n, rail + CATENARY.wireH];
        if (prev) details.tube(prev, wire, 0.03, WIRE, 3);
        prev = wire;
        if (crossing[i]) continue;
        const side = [1, -1].find((s) => !trackNear(m.e + m.dn * s * CATENARY.offset, m.n - m.de * s * CATENARY.offset, 2.4));
        if (side === undefined) continue;
        const me = m.e + m.dn * side * CATENARY.offset, mn = m.n - m.de * side * CATENARY.offset;
        const foot = Math.min(height(me, mn), bed[i]);
        details.cylinder(me, mn, foot, 0.13, rail + CATENARY.mastH - foot, MAST, 6, 0.1);
        details.tube([me, mn, rail + CATENARY.wireH + 0.9], [m.e, m.n, rail + CATENARY.wireH + 0.9], 0.04, MAST, 4);
        details.tube([m.e, m.n, rail + CATENARY.wireH + 0.9], wire, 0.015, WIRE, 3);
        stats.masts++;
      }
    }
  }

  // Level crossings: St Andrew's crosses at the road edge, on the right before the track in both directions.
  const trackNodes = new Set(tracks.flatMap((w) => w.ids));
  for (const p of osm.points) {
    if (p.tags.railway !== 'level_crossing' || !trackNodes.has(p.id)) continue;
    const r = road(p.e, p.n, height(p.e, p.n) + 0.2, 1, 3);
    if (!r) continue;
    stats.crossings++;
    stats.spots.push({ kind: 'bahnuebergang', e: p.e, n: p.n, note: p.tags['crossing:barrier'] && p.tags['crossing:barrier'] !== 'no' ? 'mit Schranken' : 'ohne Schranken' });
    for (const dir of [1, -1]) {
      const de = r.de * dir, dn = r.dn * dir;
      // Coming along (de, dn): the cross stands 4 m before the crossing, right of the road, facing the driver.
      const e = p.e - de * 4 + dn * (r.half + 0.9), n = p.n - dn * 4 - de * (r.half + 0.9);
      addProp(Prop.railCross, e, n, height(e, n) + 0.15, -de, -dn);
    }
  }
  return stats;
}

