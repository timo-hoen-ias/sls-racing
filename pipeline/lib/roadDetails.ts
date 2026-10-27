// Road details from OSM nodes on the carriageway (2026-10-25): turning circles at dead ends as round asphalt
// pads, speed bumps and tables as raised strips with their white markings, and mini roundabouts as a painted
// ring. Turning circles are fillets (fillets.ts), so kerbs, lamps, props and the road masks keep off them.
import { utmToLocal, type WorldInfo } from '../../src/world/format.ts';
import { encodeRoad, roadLook } from '../../src/render/pbr/roadCode.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import type { Fillet } from './fillets.ts';
import { pointInRing, type OsmData, type Way } from './osm.ts';
import { ROAD_CLASSES, ROAD_LIFT, isBridge, isMotorRoad, roadSurfaceHeights, roadWidth } from './roads.ts';
import type { MeshBuf, TileMap } from './tilebuf.ts';

type Height = (e: number, n: number) => number;

/** A detail placed from OSM, for the game's osm.details command (details.json): kind, UTM position, a note. */
export interface DetailSpot { kind: string; e: number; n: number; note: string }

/** Where a node sits on a road: the way, the node's index, its surface heights and the direction there. */
interface OnRoad { way: Way; i: number; ys: number[]; de: number; dn: number; half: number }

/** Index of motor road nodes by OSM node id (first matching way wins; bridges are left out). */
function roadNodes(ways: Way[], wanted: Set<number>, height: Height): Map<number, OnRoad> {
  const out = new Map<number, OnRoad>();
  for (const w of ways) {
    if (!isMotorRoad(w.tags) || isBridge(w.tags) || w.tags.tunnel || w.graph) continue;
    let ys: number[] | undefined;
    w.ids.forEach((id, i) => {
      if (!wanted.has(id) || out.has(id)) return;
      ys ??= roadSurfaceHeights(w, height);
      const a = w.pts[Math.max(0, i - 1)], b = w.pts[Math.min(w.pts.length - 1, i + 1)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      out.set(id, { way: w, i, ys, de: (b[0] - a[0]) / l, dn: (b[1] - a[1]) / l, half: roadWidth(w.tags)! / 2 });
    });
  }
  return out;
}

/** Surface height `d` metres along the way from node i (negative = backwards), clamped to the way. */
function heightAlong(r: OnRoad, d: number): number {
  const { way, i, ys } = r;
  const dir = d < 0 ? -1 : 1;
  let left = Math.abs(d), k = i;
  while (left > 0) {
    const j = k + dir;
    if (j < 0 || j >= way.pts.length) return ys[k];
    const l = Math.hypot(way.pts[j][0] - way.pts[k][0], way.pts[j][1] - way.pts[k][1]);
    if (l >= left) return ys[k] + (ys[j] - ys[k]) * (left / (l || 1));
    left -= l;
    k = j;
  }
  return ys[k];
}

const lookOf = (w: Way) => encodeRoad({ ...roadLook(w.tags, w.id, roadSection(w.tags)!, false), lines: 0, gutter: false });

/** Buildings on a 32 m grid, to keep turning circles out of them. */
function buildingGrid(osm: Pick<OsmData, 'polygons'>) {
  const C = 32, grid = new Map<string, [number, number][][]>();
  for (const p of osm.polygons) {
    if (!p.tags.building) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of p.outer) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    for (let x = Math.floor(x0 / C); x <= Math.floor(x1 / C); x++)
      for (let y = Math.floor(y0 / C); y <= Math.floor(y1 / C); y++) {
        const k = `${x}_${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(p.outer);
      }
  }
  return (e: number, n: number) => (grid.get(`${Math.floor(e / C)}_${Math.floor(n / C)}`) ?? []).some((r) => pointInRing(e, n, r));
}

/** Other drivable roads near a point: way ids whose carriageway (plus margin) covers it, on a 32 m grid. */
function roadCover(ways: Way[]) {
  const C = 32, grid = new Map<string, { id: number; a: [number, number]; b: [number, number]; r: number; ids: Set<number> }[]>();
  for (const w of ways) {
    const width = roadWidth(w.tags);
    if (!width) continue;
    const ids = new Set(w.ids);
    for (let i = 1; i < w.pts.length; i++) {
      const seg = { id: w.id, a: w.pts[i - 1], b: w.pts[i], r: width / 2 + 0.3, ids };
      const x0 = Math.floor((Math.min(seg.a[0], seg.b[0]) - 12) / C), x1 = Math.floor((Math.max(seg.a[0], seg.b[0]) + 12) / C);
      const y0 = Math.floor((Math.min(seg.a[1], seg.b[1]) - 12) / C), y1 = Math.floor((Math.max(seg.a[1], seg.b[1]) + 12) / C);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x}_${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(seg);
      }
    }
  }
  /** Whether a road other than the one through `node` covers (e, n). */
  return (e: number, n: number, node: number) => (grid.get(`${Math.floor(e / C)}_${Math.floor(n / C)}`) ?? []).some((g) => {
    if (g.ids.has(node)) return false;
    const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1];
    const t = Math.max(0, Math.min(1, ((e - g.a[0]) * dx + (n - g.a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(g.a[0] + dx * t - e, g.a[1] + dy * t - n) < g.r;
  });
}

/** Turning circle radius by road class when OSM gives no diameter (m). */
const CIRCLE_RADIUS = (rank: number) => (rank >= 3 ? 7.5 : rank >= 2 ? 6.5 : 5.5);
const CIRCLE_STEPS = 20;
/** The pad may sit at most this far above or below the terrain at its rim (m). */
const CIRCLE_DROP = 1.2;

/**
 * Round asphalt pads at highway=turning_circle nodes, as fillets: centre first, then the closed rim. Shrunk where
 * a building or a steep slope is in the way; left out when no more than a metre beyond the road edge remains.
 */
export function planTurningCircles(osm: Pick<OsmData, 'ways' | 'points' | 'polygons'>, height: Height): { fillets: Fillet[]; skipped: number; spots: DetailSpot[] } {
  const nodes = osm.points.filter((p) => p.tags.highway === 'turning_circle');
  const on = roadNodes(osm.ways, new Set(nodes.map((p) => p.id)), height);
  const inBuilding = buildingGrid(osm);
  const onOtherRoad = roadCover(osm.ways);
  const fillets: Fillet[] = [];
  const spots: DetailSpot[] = [];
  let skipped = 0;
  for (const p of nodes) {
    const r = on.get(p.id);
    if (!r) continue;
    const y = r.ys[r.i];
    const rank = ROAD_CLASSES[r.way.tags.highway]?.rank ?? 1;
    const diameter = parseFloat(p.tags.diameter ?? '');
    const min = r.half + 1;
    let R = Math.max(min, Number.isFinite(diameter) && diameter > 4 ? diameter / 2 : CIRCLE_RADIUS(rank));
    const rim = (rad: number) => Array.from({ length: CIRCLE_STEPS }, (_, k) => {
      const a = (k / CIRCLE_STEPS) * Math.PI * 2;
      return [p.e + Math.cos(a) * rad, p.n + Math.sin(a) * rad] as [number, number];
    });
    const yAt = ([e, n]: [number, number]) => heightAlong(r, (e - p.e) * r.de + (n - p.n) * r.dn);
    const blocked = (rad: number) => rim(rad + 0.5).some((q) => inBuilding(q[0], q[1]) || onOtherRoad(q[0], q[1], p.id) || Math.abs(height(q[0], q[1]) + ROAD_LIFT - yAt(q)) > CIRCLE_DROP);
    while (R > min && blocked(R)) R -= 0.5;
    if (R < min || blocked(R)) { skipped++; spots.push({ kind: 'wendehammer', e: p.e, n: p.n, note: 'ausgelassen (Gebäude oder Hang)' }); continue; }
    spots.push({ kind: 'wendehammer', e: p.e, n: p.n, note: `Radius ${R.toFixed(1)} m${r.way.tags.name ? `, ${r.way.tags.name}` : ''}` });
    const ring = rim(R);
    ring.push(ring[0]);
    // The pad follows the road's slope along its direction (the dead end's last metres), level across.
    fillets.push({
      e: [p.e, ...ring.map((q) => q[0])], n: [p.n, ...ring.map((q) => q[1])], y: [y, ...ring.map(yAt)],
      node: [p.e, p.n], reach: R, look: lookOf(r.way),
    });
  }
  return { fillets, skipped, spots };
}

/** Speed bump profiles: length along the road (m), height (m), ramp length of a table (m, 0 = round hump). */
const CALMING: Record<string, { len: number; h: number; ramp: number }> = {
  bump: { len: 0.9, h: 0.07, ramp: 0 },
  hump: { len: 3.7, h: 0.08, ramp: 0 },
  mini_bumps: { len: 0.6, h: 0.05, ramp: 0 },
  cushion: { len: 2.5, h: 0.06, ramp: 0 },
  table: { len: 7, h: 0.08, ramp: 1.5 },
};
const PROFILE_STEPS = 10;

/** Height of a calming profile at s (0..len). */
function profile(c: { len: number; h: number; ramp: number }, s: number) {
  if (c.ramp) return c.h * Math.min(1, s / c.ramp, (c.len - s) / c.ramp);
  return c.h * Math.sin((Math.PI * s) / c.len) ** 2;
}

export interface CalmingStats { bumps: number; tables: number; rings: number; spots: DetailSpot[] }

/**
 * Speed bumps and tables drawn into the roads mesh (the wheels ride over them) across the full carriageway,
 * with white wedge markings on the approach; mini roundabouts get a painted ring with a raised white centre.
 */
export function drawCalming(osm: Pick<OsmData, 'ways' | 'points'>, world: WorldInfo, tiles: TileMap, height: Height): CalmingStats {
  const nodes = osm.points.filter((p) => CALMING[p.tags.traffic_calming ?? ''] || p.tags.highway === 'mini_roundabout');
  const on = roadNodes(osm.ways, new Set(nodes.map((p) => p.id)), height);
  const stats: CalmingStats = { bumps: 0, tables: 0, rings: 0, spots: [] };
  for (const p of nodes) {
    const r = on.get(p.id);
    if (!r) continue;
    const tile = tiles.at(p.e, p.n);
    if (p.tags.highway === 'mini_roundabout') {
      ring(tile.markings, world, p.e, p.n, r.ys[r.i] + 0.02, Math.min(4, r.half + 0.5), 0.15);
      ring(tile.markings, world, p.e, p.n, r.ys[r.i] + 0.025, 1.2, 1.2);
      stats.rings++;
      stats.spots.push({ kind: 'minikreisel', e: p.e, n: p.n, note: r.way.tags.name ?? '' });
      continue;
    }
    const c = CALMING[p.tags.traffic_calming!];
    const look = lookOf(r.way);
    const half = r.half;
    // Local frame: along (de, dn), across (dn, -de).
    const at = (s: number, x: number) => utmToLocal(world, p.e + r.de * s + r.dn * x, p.n + r.dn * s - r.de * x);
    const rows: { v: number; x: number; z: number }[][] = [];
    for (let k = 0; k <= PROFILE_STEPS; k++) {
      const s = (k / PROFILE_STEPS) * c.len;
      const d = s - c.len / 2;
      const y = heightAlong(r, d) + profile(c, s) + 0.004;
      rows.push([-half, 0, half].map((x) => {
        const [lx, lz] = at(d, x);
        return { v: tile.roads.vertex(lx, y, lz, { uv: [0.5, look] }), x: lx, z: lz };
      }));
    }
    for (let k = 0; k < PROFILE_STEPS; k++)
      for (let j = 0; j < 2; j++) quadUp(tile.roads, rows[k][j], rows[k][j + 1], rows[k + 1][j + 1], rows[k + 1][j]);
    // Markings: white wedges on the ramps (bumps: a row of triangles over the crest).
    const wedge = Math.min(1.2, half * 0.35);
    const top = (d: number) => heightAlong(r, d) + profile(c, d + c.len / 2) + 0.012;
    for (let x = -half + wedge; x <= half - wedge * 0.9; x += wedge * 2.2) {
      const s0 = c.ramp ? -c.len / 2 : -c.len / 2 + c.len * 0.15, s1 = c.ramp ? -c.len / 2 + c.ramp : c.len / 2 - c.len * 0.15;
      triUp(tile.markings, world, [
        [...at(s0, x - wedge / 2), top(s0)], [...at(s0, x + wedge / 2), top(s0)], [...at(s1, x), top(s1)],
      ]);
      if (c.ramp) {
        const t0 = c.len / 2, t1 = c.len / 2 - c.ramp;
        triUp(tile.markings, world, [[...at(t0, x - wedge / 2), top(t0)], [...at(t0, x + wedge / 2), top(t0)], [...at(t1, x), top(t1)]]);
      }
    }
    if (c.ramp) stats.tables++;
    else stats.bumps++;
    stats.spots.push({ kind: c.ramp ? 'aufpflasterung' : 'schwelle', e: p.e, n: p.n, note: `${p.tags.traffic_calming}, ${Math.round(c.h * 100)} cm${r.way.tags.name ? `, ${r.way.tags.name}` : ''}` });
  }
  return stats;
}

/** Quad of the bump grid (corners in order round it), wound to face up. */
function quadUp(buf: MeshBuf, ...q: { v: number; x: number; z: number }[]) {
  const [a, b, c, d] = q;
  if ((b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0) { buf.tri(a.v, b.v, c.v); buf.tri(a.v, c.v, d.v); }
  else { buf.tri(a.v, c.v, b.v); buf.tri(a.v, d.v, c.v); }
}

/** One marking triangle (local x, z, height), facing up. */
function triUp(buf: MeshBuf, _world: WorldInfo, p: [number, number, number][]) {
  const v = p.map(([x, z, y]) => buf.vertex(x, y, z));
  const up = (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) > 0;
  if (up) buf.tri(v[0], v[1], v[2]);
  else buf.tri(v[0], v[2], v[1]);
}

/** Painted ring (or disc when width ≥ radius) around a UTM point. */
function ring(buf: MeshBuf, world: WorldInfo, e: number, n: number, y: number, radius: number, width: number) {
  const steps = 24, r0 = Math.max(0, radius - width);
  for (let k = 0; k < steps; k++) {
    const a0 = (k / steps) * Math.PI * 2, a1 = ((k + 1) / steps) * Math.PI * 2;
    const pt = (r: number, a: number) => [...utmToLocal(world, e + Math.cos(a) * r, n + Math.sin(a) * r), y] as [number, number, number];
    triUp(buf, world, [pt(r0, a0), pt(radius, a0), pt(radius, a1)]);
    if (r0 > 0) triUp(buf, world, [pt(r0, a0), pt(radius, a1), pt(r0, a1)]);
  }
}

/** Roundabout rings: closed junction=roundabout ways, or the pieces of one chained end to start. */
function roundaboutRings(ways: Way[], height: Height): { pts: [number, number][]; ys: number[]; half: number; name: string }[] {
  const pieces = ways.filter((w) => w.tags.junction === 'roundabout' && isMotorRoad(w.tags) && !isBridge(w.tags) && !w.tags.tunnel);
  const byStart = new Map<number, Way>();
  for (const w of pieces) if (!w.closed) byStart.set(w.ids[0], w);
  const used = new Set<Way>();
  const out: ReturnType<typeof roundaboutRings> = [];
  for (const w of pieces) {
    if (used.has(w)) continue;
    const chain: Way[] = [w];
    used.add(w);
    if (!w.closed) {
      let cur = w;
      while (cur.ids[cur.ids.length - 1] !== w.ids[0]) {
        const next = byStart.get(cur.ids[cur.ids.length - 1]);
        if (!next || used.has(next) || chain.length > 12) break;
        chain.push(next);
        used.add(next);
        cur = next;
      }
      if (cur.ids[cur.ids.length - 1] !== w.ids[0]) continue;
    }
    const pts: [number, number][] = [], ys: number[] = [];
    for (const c of chain) {
      const h = roadSurfaceHeights(c, height);
      c.pts.forEach((p, i) => { if (i < c.pts.length - 1) { pts.push(p); ys.push(h[i]); } });
    }
    out.push({ pts, ys, half: Math.min(...chain.map((c) => roadWidth(c.tags)! / 2)), name: chain.find((c) => c.tags.name)?.tags.name ?? '' });
  }
  return out;
}

const KERB_H = 0.15;
const GRASS: [number, number, number] = [58, 88, 38];
const KERB: [number, number, number] = [170, 168, 160];

/**
 * Raised centre islands in roundabouts: a 15 cm kerb half a metre inside the ring's inner edge, grass on top. Drawn
 * in the details layer; the kerb is also a wall in the collision mesh so a car hops over it rather than through.
 */
export function drawRoundaboutIslands(ways: Way[], world: WorldInfo, tiles: TileMap, details: import('./details.ts').Details, height: Height): { islands: number; spots: DetailSpot[] } {
  const spots: DetailSpot[] = [];
  let islands = 0;
  for (const r of roundaboutRings(ways, height)) {
    const m = r.pts.length;
    if (m < 4) continue;
    const ce = r.pts.reduce((s, p) => s + p[0], 0) / m, cn = r.pts.reduce((s, p) => s + p[1], 0) / m;
    const inset = r.half + 0.5;
    const inner = r.pts.map(([e, n]) => {
      const d = Math.hypot(e - ce, n - cn);
      return d - inset < 1.5 ? undefined : ([ce + ((e - ce) * (d - inset)) / d, cn + ((n - cn) * (d - inset)) / d] as [number, number]);
    });
    if (inner.some((p) => !p)) { spots.push({ kind: 'kreisel-insel', e: ce, n: cn, note: `ausgelassen (zu klein)${r.name ? `, ${r.name}` : ''}` }); continue; }
    const ring = inner as [number, number][];
    // A road through the middle (a bypass or a turbo roundabout's lanes) leaves the centre open.
    if (ways.some((w) => isMotorRoad(w.tags) && w.tags.junction !== 'roundabout' && w.pts.some(([e, n]) => pointInRing(e, n, ring)))) {
      spots.push({ kind: 'kreisel-insel', e: ce, n: cn, note: `ausgelassen (Straße durch die Mitte)${r.name ? `, ${r.name}` : ''}` });
      continue;
    }
    // The kerb follows the ring's surface; the grass top is a fan to the mean height in the middle.
    const base = r.ys.map((y) => y - 0.05), top = r.ys.map((y) => y + KERB_H - 0.03);
    const mid = top.reduce((a, b) => a + b, 0) / m;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const a = ring[i], b = ring[j];
      details.quad([a[0], a[1], base[i]], [b[0], b[1], base[j]], [b[0], b[1], top[j]], [a[0], a[1], top[i]], KERB, true);
      details.quadUp([ce, cn, mid], [a[0], a[1], top[i]], [b[0], b[1], top[j]], [ce, cn, mid], GRASS);
      // Collision: the kerb face only (the island top stays out of the wheel rays' way).
      const buf = tiles.at(a[0], a[1]).collide;
      const [ax, az] = utmToLocal(world, a[0], a[1]), [bx, bz] = utmToLocal(world, b[0], b[1]);
      const v = [buf.vertex(ax, base[i], az), buf.vertex(bx, base[j], bz), buf.vertex(bx, top[j], bz), buf.vertex(ax, top[i], az)];
      buf.tri(v[0], v[1], v[2]); buf.tri(v[0], v[2], v[3]);
      buf.tri(v[0], v[2], v[1]); buf.tri(v[0], v[3], v[2]);
    }
    islands++;
    spots.push({ kind: 'kreisel-insel', e: ce, n: cn, note: `Insel ${(Math.hypot(ring[0][0] - ce, ring[0][1] - cn) * 2).toFixed(0)} m${r.name ? `, ${r.name}` : ''}` });
  }
  return { islands, spots };
}
