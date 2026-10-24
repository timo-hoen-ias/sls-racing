import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import type { Junction } from './graph.ts';
import type { Way } from './osm.ts';
import type { MeshBuf, TileMap } from './tilebuf.ts';

interface RoadClass {
  /** Draw order at overlaps: higher sits a little higher. */
  rank: number;
  centreLine: boolean;
  /** Urban street that gets sidewalks and street lamps. */
  street: boolean;
}

export const ROAD_CLASSES: Record<string, RoadClass> = {
  motorway: { rank: 9, centreLine: false, street: false },
  trunk: { rank: 8, centreLine: true, street: false },
  primary: { rank: 7, centreLine: true, street: true },
  secondary: { rank: 6, centreLine: true, street: true },
  tertiary: { rank: 5, centreLine: true, street: true },
  motorway_link: { rank: 8, centreLine: false, street: false },
  trunk_link: { rank: 7, centreLine: false, street: false },
  primary_link: { rank: 6, centreLine: false, street: false },
  secondary_link: { rank: 5, centreLine: false, street: false },
  tertiary_link: { rank: 4, centreLine: false, street: false },
  unclassified: { rank: 3, centreLine: false, street: true },
  residential: { rank: 3, centreLine: false, street: true },
  living_street: { rank: 2, centreLine: false, street: true },
  pedestrian: { rank: 2, centreLine: false, street: false },
  service: { rank: 1, centreLine: false, street: false },
  track: { rank: 0, centreLine: false, street: false },
};

const STEP = 4; // metres between road samples
export const ROAD_LIFT = 0.15; // road surface above the terrain mesh
const SIDEWALK = { width: 2.2, height: 0.14 };
const LAMP_SPACING = 32;

/** Carriageway width in metres (lanes and edge strips, see src/world/roadSpec.ts). */
export function roadWidth(tags: Record<string, string>): number | undefined {
  return ROAD_CLASSES[tags.highway] ? roadSection(tags)!.width : undefined;
}

export function isDrivable(tags: Record<string, string>) {
  return !!ROAD_CLASSES[tags.highway] && tags.tunnel !== 'yes' && tags.area !== 'yes' && tags.access !== 'no';
}

export const isBridge = (tags: Record<string, string>) => !!tags.bridge && tags.bridge !== 'no';

export function densify(pts: [number, number][], step = STEP): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** Road surface height along a way: draped on the terrain, or a straight span for bridges, plus any lift. */
function surface(way: Way, height: (e: number, n: number) => number) {
  const cls = ROAD_CLASSES[way.tags.highway];
  const lift = ROAD_LIFT + cls.rank * 0.008;
  const pts = way.pts;
  const h0 = height(...pts[0]);
  const h1 = height(...pts[pts.length - 1]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const len = cum[cum.length - 1];
  const raise = way.raise;
  let seg = 0;
  const raised = (dist: number) => {
    if (!raise) return 0;
    if (dist < cum[seg]) seg = 0;
    while (seg < cum.length - 2 && dist > cum[seg + 1]) seg++;
    const t = Math.min(1, Math.max(0, (dist - cum[seg]) / (cum[seg + 1] - cum[seg] || 1)));
    return raise[seg] + (raise[seg + 1] - raise[seg]) * t;
  };
  return isBridge(way.tags)
    ? (_e: number, _n: number, dist: number) => h0 + (h1 - h0) * (dist / (len || 1)) + 0.4 + raised(dist)
    : (e: number, n: number, dist: number) => height(e, n) + lift + raised(dist);
}

/** Surface height at each original node of a way (for the road graph). */
export function roadSurfaceHeights(way: Way, height: (e: number, n: number) => number): number[] {
  const y = surface(way, height);
  let dist = 0;
  return way.pts.map((p, i) => {
    if (i) dist += Math.hypot(p[0] - way.pts[i - 1][0], p[1] - way.pts[i - 1][1]);
    return y(p[0], p[1], dist);
  });
}

export interface RoadSample {
  x: number;
  z: number;
  y: number;
  heading: number;
}

/** Spatial lookup: is a point close to a junction of the given width? */
class JunctionIndex {
  private cells = new Map<string, Junction[]>();
  constructor(junctions: Junction[]) {
    for (const j of junctions) {
      const k = `${Math.floor(j.x / 20)}_${Math.floor(j.z / 20)}`;
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k)!.push(j);
    }
  }
  near(x: number, z: number, extra: number) {
    const cx = Math.floor(x / 20), cz = Math.floor(z / 20);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const j of this.cells.get(`${cx + dx}_${cz + dz}`) ?? []) {
          if (Math.hypot(j.x - x, j.z - z) < j.width / 2 + extra) return true;
        }
    return false;
  }
}

/**
 * Emits road ribbons, dashed centre lines, sidewalks and street lamps into the tiles they cross.
 * Returns all centreline samples so callers can pick a spawn point.
 */
export function buildRoads(
  ways: Way[], world: WorldInfo, height: (e: number, n: number) => number, tiles: TileMap, junctions: Junction[],
): RoadSample[] {
  const samples: RoadSample[] = [];
  const jIndex = new JunctionIndex(junctions);
  for (const way of ways) {
    if (!isDrivable(way.tags)) continue;
    const section = roadSection(way.tags)!;
    const width = section.width;
    const cls = ROAD_CLASSES[way.tags.highway];
    // Lane lines: long dashes on motorways (6 m line, 12 m gap), short ones elsewhere (3 m, 6 m).
    const dash = cls.rank >= 8 ? { period: 18, on: 6 } : { period: 9, on: 3 };
    const pts = densify(way.pts);
    if (pts.length < 2) continue;
    const bridge = isBridge(way.tags);
    const ySurf = surface(way, height);
    const sidewalk = cls.street && !bridge && !['no', 'none'].includes(way.tags.sidewalk);

    let dist = 0;
    const ring = pts.map((p, i) => {
      if (i) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const [x, z] = utmToLocal(world, p[0], p[1]);
      return { e: p[0], n: p[1], x, z, dx, dy, y: ySurf(p[0], p[1], dist), dist };
    });

    for (const r of ring) samples.push({ x: r.x, z: r.z, y: r.y, heading: Math.atan2(r.dx, r.dy) });

    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1];
      const b = ring[i];
      const tile = tiles.at((a.e + b.e) / 2, (a.n + b.n) / 2);
      // Point at signed offset `o` (left positive) from a sample, in local coordinates.
      const off = (p: typeof a, o: number) => utmToLocal(world, p.e - p.dy * o, p.n + p.dx * o);
      // Quad between offsets o0 and o1 (left of o0 means o1 > o0) facing up, with heights per corner.
      const strip = (buf: MeshBuf, o0: number, o1: number, ya: [number, number], yb: [number, number], uv?: (p: typeof a, side: 0 | 1) => [number, number]) => {
        const v: number[] = [];
        for (const [p, o, side, y] of [[a, o0, 0, ya[0]], [a, o1, 1, ya[1]], [b, o0, 0, yb[0]], [b, o1, 1, yb[1]]] as const) {
          const [x, z] = off(p, o);
          v.push(buf.vertex(x, y, z, uv ? { uv: uv(p, side) } : {}));
        }
        // Winding chosen so faces point up (+y) or away from the road centre.
        buf.tri(v[0], v[2], v[1]);
        buf.tri(v[1], v[2], v[3]);
      };
      const hw = width / 2;
      strip(tile.roads, -hw, hw, [a.y, a.y], [b.y, b.y], (p, s) => [s, p.dist / width]);
      // Lifted road on an embankment: own collision, and retaining walls down to the terrain.
      const above = !bridge && way.raise ? Math.max(a.y - height(a.e, a.n), b.y - height(b.e, b.n)) : 0;
      if (bridge || above > ROAD_LIFT + 0.1) {
        // Where a deck or ramp is close to the ground, sink its collision into the terrain so its edge is no kerb.
        const cy = (p: typeof a) => p.y - Math.max(0, 0.6 - (p.y - height(p.e, p.n)));
        strip(tile.collide, -hw - 0.5, hw + 0.5, [cy(a), cy(a)], [cy(b), cy(b)]);
      }
      // Deck seen from below and from the side: 1 m thick slab, where there is room under it.
      if (Math.min(a.y - height(a.e, a.n), b.y - height(b.e, b.n)) > 1.5 && (bridge || above > 0.6)) {
        const o = hw + 0.5;
        strip(tile.sidewalks, o, -o, [a.y - 1, a.y - 1], [b.y - 1, b.y - 1]);
        wall(tile.sidewalks, off(a, o), off(b, o), a.y - 1, a.y, b.y - 1, b.y, true);
        wall(tile.sidewalks, off(a, -o), off(b, -o), a.y - 1, a.y, b.y - 1, b.y, false);
      }
      if (above > 0.6) {
        for (const side of [1, -1]) {
          const o = side * (hw + 0.5);
          const foot = (p: typeof a) => height(p.e - p.dy * o, p.n + p.dx * o) - 0.3;
          wall(tile.sidewalks, off(a, o), off(b, o), foot(a), a.y, foot(b), b.y, side > 0);
        }
      }
      // Dashes: 3 m line, 6 m gap.
      if (cls.centreLine && way.tags.oneway !== 'yes' && Math.floor(a.dist / 9) === Math.floor(b.dist / 9) && a.dist % 9 < 3) {
        strip(tile.markings, -0.07, 0.07, [a.y + 0.02, a.y + 0.02], [b.y + 0.02, b.y + 0.02]);
      }
      if (section.dividers.length && Math.floor(a.dist / dash.period) === Math.floor(b.dist / dash.period) && a.dist % dash.period < dash.on &&
        !jIndex.near(a.x, a.z, 1) && !jIndex.near(b.x, b.z, 1)) {
        // Offsets in the section are to the right; strip offsets are to the left.
        for (const d of section.dividers) strip(tile.markings, -d - 0.075, -d + 0.075, [a.y + 0.02, a.y + 0.02], [b.y + 0.02, b.y + 0.02]);
      }

      if (sidewalk && !jIndex.near(a.x, a.z, 2.8) && !jIndex.near(b.x, b.z, 2.8)) {
        const sw = SIDEWALK.width;
        const top = (p: typeof a) => p.y + SIDEWALK.height;
        const ground = (p: typeof a, o: number) => {
          const [e, n] = [p.e - p.dy * o, p.n + p.dx * o];
          return Math.min(height(e, n), p.y) - 0.3;
        };
        const tuv = (p: typeof a, s: 0 | 1) => [p.dist / 2, s * (sw / 2)] as [number, number];
        for (const side of [1, -1]) {
          const inner = side * hw;
          const outer = side * (hw + sw);
          const [i0, i1] = side > 0 ? [inner, outer] : [outer, inner];
          // Top surface.
          strip(tile.sidewalks, i0, i1, [top(a), top(a)], [top(b), top(b)], tuv);
          // Kerb face towards the road and skirt on the outer edge, as narrow vertical strips.
          wall(tile.sidewalks, off(a, inner), off(b, inner), a.y - 0.05, top(a), b.y - 0.05, top(b), side < 0);
          wall(tile.sidewalks, off(a, outer), off(b, outer), ground(a, outer), top(a), ground(b, outer), top(b), side > 0);
        }
      }
    }

    // Street lamps, alternating sides.
    if (cls.street && cls.rank >= 3 && !bridge) {
      let next = LAMP_SPACING / 2;
      let side = 1;
      for (const r of ring) {
        if (r.dist < next) continue;
        next += LAMP_SPACING;
        side = -side;
        const o = side * (width / 2 + (sidewalk ? SIDEWALK.width - 0.5 : 0.8));
        const [x, z] = utmToLocal(world, r.e - r.dy * o, r.n + r.dx * o);
        if (jIndex.near(x, z, 4)) continue;
        // Heading of the lamp arm: towards the road centre.
        const heading = Math.atan2(r.dx, r.dy) + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
        const t = tiles.at(r.e - r.dy * o, r.n + r.dx * o);
        t.lamps.push(x, r.y + (sidewalk ? SIDEWALK.height : 0), z, heading);
      }
    }
  }
  return samples;
}

/** Vertical strip between two ground points; `flip` turns it to face the other way. */
function wall(buf: MeshBuf, a: [number, number], b: [number, number], ya0: number, ya1: number, yb0: number, yb1: number, flip: boolean) {
  const v0 = buf.vertex(a[0], ya0, a[1], { uv: [0, 0] });
  const v1 = buf.vertex(b[0], yb0, b[1], { uv: [0, 0] });
  const v2 = buf.vertex(b[0], yb1, b[1], { uv: [0, 0] });
  const v3 = buf.vertex(a[0], ya1, a[1], { uv: [0, 0] });
  if (flip) { buf.tri(v0, v2, v1); buf.tri(v0, v3, v2); }
  else { buf.tri(v0, v1, v2); buf.tri(v0, v2, v3); }
}
