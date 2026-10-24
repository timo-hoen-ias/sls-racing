import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import { encodeRoad, roadLook } from '../../src/render/pbr/roadCode.ts';
import type { RoadCarve } from './carve.ts';
import type { HalfWidths } from './overlap.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import type { Junction } from './graph.ts';
import type { Way } from './osm.ts';
import { KERB } from './kerbs.ts';
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
/** Road collision lies this far under the drawn surface. */
const STRIP_DROP = 0.05;
const SIDEWALK = { width: KERB.width, height: KERB.height };
/**
 * Bridges without a landmark model get a raised walkway (cap) on both sides with a pedestrian railing at its
 * outer edge. On fast roads the cap starts behind the guard rail (props.ts), else right at the carriageway.
 */
const BRIDGE_CAP = { width: 1.5, behindRail: 0.6, railInset: 0.1 };
const FAST = /^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$/;

/** A pedestrian railing piece along a bridge cap: centre (UTM), direction, length and foot height. */
export interface Railing { e: number; n: number; de: number; dn: number; len: number; y: number }
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
  const prof = way.profile;
  let pseg = 0;
  const ground = (e: number, n: number, dist: number) => {
    if (!prof) return height(e, n);
    const d = prof.dist;
    if (dist < d[pseg]) pseg = 0;
    while (pseg < d.length - 2 && dist > d[pseg + 1]) pseg++;
    const t = Math.min(1, Math.max(0, (dist - d[pseg]) / (d[pseg + 1] - d[pseg] || 1)));
    return prof.y[pseg] + (prof.y[pseg + 1] - prof.y[pseg]) * t;
  };
  const deck = way.deck;
  let dseg = 0;
  // Measured deck heights per node (from the surface model), else a straight span between the ends.
  const span = (dist: number) => {
    if (!deck) return h0 + (h1 - h0) * (dist / (len || 1)) + ROAD_LIFT;
    if (dist < cum[dseg]) dseg = 0;
    while (dseg < cum.length - 2 && dist > cum[dseg + 1]) dseg++;
    const t = Math.min(1, Math.max(0, (dist - cum[dseg]) / (cum[dseg + 1] - cum[dseg] || 1)));
    return deck[dseg] + (deck[dseg + 1] - deck[dseg]) * t + ROAD_LIFT;
  };
  return isBridge(way.tags)
    ? (_e: number, _n: number, dist: number) => span(dist) + raised(dist)
    : (e: number, n: number, dist: number) => ground(e, n, dist) + lift + raised(dist);
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

/** Centreline samples every STEP metres with direction, distance and surface height, as the road is drawn. */
export function roadProfile(way: Way, height: (e: number, n: number) => number, world: WorldInfo, step = STEP) {
  const pts = densify(way.pts, step);
  if (pts.length < 2) return [];
  const ySurf = surface(way, height);
  let dist = 0;
  return pts.map((p, i) => {
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

/** Carriageways of all roads, to keep sidewalks off other roads where they meet at an angle. */
class CarriagewayIndex {
  private cells = new Map<string, { way: Way; x0: number; z0: number; x1: number; z1: number; y0: number; y1: number; hw: number }[]>();
  add(way: Way, ring: { x: number; y: number; z: number }[], hw: number) {
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]];
      const s = { way, x0: a.x, z0: a.z, x1: b.x, z1: b.z, y0: a.y, y1: b.y, hw };
      for (let cx = Math.floor((Math.min(a.x, b.x) - hw) / 16); cx <= Math.floor((Math.max(a.x, b.x) + hw) / 16); cx++)
        for (let cz = Math.floor((Math.min(a.z, b.z) - hw) / 16); cz <= Math.floor((Math.max(a.z, b.z) + hw) / 16); cz++) {
          const k = `${cx}_${cz}`;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k)!.push(s);
        }
    }
  }
  /** Whether (x, z) lies on the carriageway of a road other than `self` (plus a margin), near height y if given. */
  onOther(self: Way, x: number, z: number, margin: number, y?: number) {
    for (const s of this.cells.get(`${Math.floor(x / 16)}_${Math.floor(z / 16)}`) ?? []) {
      if (s.way === self) continue;
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
      const t = Math.min(1, Math.max(0, ((x - s.x0) * dx + (z - s.z0) * dz) / (dx * dx + dz * dz || 1)));
      if (y !== undefined && Math.abs(s.y0 + (s.y1 - s.y0) * t - y) > 3) continue;
      if (Math.hypot(s.x0 + dx * t - x, s.z0 + dz * t - z) < s.hw + margin) return true;
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
  carve?: RoadCarve, halves?: Map<Way, HalfWidths>,
  bridges: { dressed?: Set<number>; railings?: Railing[] } = {},
): RoadSample[] {
  const samples: RoadSample[] = [];
  const jIndex = new JunctionIndex(junctions);
  const rings = new Map(ways.filter((w) => isDrivable(w.tags)).map((w) => [w, roadProfile(w, height, world)]));
  const carriageways = new CarriagewayIndex();
  for (const [w, r] of rings) carriageways.add(w, r, roadWidth(w.tags)! / 2);
  for (const way of ways) {
    if (!isDrivable(way.tags)) continue;
    const section = roadSection(way.tags)!;
    const width = section.width;
    const cls = ROAD_CLASSES[way.tags.highway];
    // Lane lines: long dashes on motorways (6 m line, 12 m gap), short ones elsewhere (3 m, 6 m).
    const dash = cls.rank >= 8 ? { period: 18, on: 6 } : { period: 9, on: 3 };
    const ring = rings.get(way)!;
    if (ring.length < 2) continue;
    const bridge = isBridge(way.tags);
    // Pavement sides as kerbs.ts planned them (left = positive offsets), else the old default for streets.
    const sides = way.sidewalks ?? (cls.street && !bridge && !['no', 'none'].includes(way.tags.sidewalk) ? { left: true, right: true } : { left: false, right: false });
    const sidewalk = !bridge && (sides.left || sides.right);
    // Bridges dressed by a landmark model bring their own railings.
    const walkway = bridge && !bridges.dressed?.has(way.id);
    const capFrom = FAST.test(way.tags.highway) ? BRIDGE_CAP.behindRail : 0;
    // Surface, wear, edge lines and gutters for the road shader (src/render/pbr/roadCode.ts).
    const look = encodeRoad(roadLook(way.tags, way.id, section, sidewalk));
    // Usable half width per sample, narrower where a road at another height runs alongside (overlap.ts).
    const half = halves?.get(way);
    const L = new Map(ring.map((p, i) => [p, half?.left[i] ?? width / 2]));
    const R = new Map(ring.map((p, i) => [p, half?.right[i] ?? width / 2]));

    for (const r of ring) samples.push({ x: r.x, z: r.z, y: r.y, heading: Math.atan2(r.dx, r.dy) });

    // Pavement segments per side (segment i runs from sample i - 1 to i), decided first so the kerb can be
    // lowered where a stretch ends (junctions, driveways) and at mapped crossings.
    const hw0 = width / 2, sw0 = SIDEWALK.width;
    const paved = new Map<number, boolean[]>();
    for (const side of [1, -1] as const) {
      const on: boolean[] = new Array(ring.length).fill(false);
      if (sidewalk && (side > 0 ? sides.left : sides.right))
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1], b = ring[i];
          if (jIndex.near(a.x, a.z, 2.8) || jIndex.near(b.x, b.z, 2.8)) continue;
          // No sidewalk where the road had to give way to another road alongside.
          const full = (p: typeof a) => (side > 0 ? L : R).get(p)! >= hw0 - 0.05;
          if (!full(a) || !full(b)) continue;
          // Nor where it would reach onto another road (roads meeting at a shallow angle).
          const o = (p: typeof a, d: number) => utmToLocal(world, p.e - p.dy * d, p.n + p.dx * d);
          const corners = [o(a, side * (hw0 + sw0)), o(b, side * (hw0 + sw0)), o(a, side * (hw0 + sw0 / 2)), o(b, side * (hw0 + sw0 / 2))];
          if (corners.some(([x, z]) => carriageways.onOther(way, x, z, 0.3))) continue;
          on[i] = true;
        }
      paved.set(side, on);
    }
    const crossings = way.lowered ?? [];
    /** Kerb height at sample j on one side: lowered at the ends of a pavement stretch and at crossings. */
    const kerbAt = (side: number, j: number) => {
      const on = paved.get(side)!;
      const end = (j > 0 && on[j]) !== (j + 1 < on.length && on[j + 1]);
      const d = ring[j].dist;
      return end || crossings.some((c) => Math.abs(c - d) <= KERB.crossing) ? KERB.lowered : SIDEWALK.height;
    };

    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1];
      const b = ring[i];
      const tile = tiles.at((a.e + b.e) / 2, (a.n + b.n) / 2);
      // Point at signed offset `o` (left positive) from a sample, in local coordinates.
      const off = (p: typeof a, o: number) => utmToLocal(world, p.e - p.dy * o, p.n + p.dx * o);
      // Quad between offsets o0 and o1 (left of o0 means o1 > o0; fixed or per sample) facing up, with heights per corner.
      type Offset = number | ((p: typeof a) => number);
      const strip = (buf: MeshBuf, o0: Offset, o1: Offset, ya: [number, number], yb: [number, number], uv?: (p: typeof a, side: 0 | 1) => [number, number]) => {
        const v: number[] = [];
        for (const [p, o, side, y] of [[a, o0, 0, ya[0]], [a, o1, 1, ya[1]], [b, o0, 0, yb[0]], [b, o1, 1, yb[1]]] as const) {
          const [x, z] = off(p, typeof o === 'number' ? o : o(p));
          v.push(buf.vertex(x, y, z, uv ? { uv: uv(p, side) } : {}));
        }
        // Winding chosen so faces point up (+y) or away from the road centre.
        buf.tri(v[0], v[2], v[1]);
        buf.tri(v[1], v[2], v[3]);
      };
      const hw = width / 2;
      const left = (p: typeof a) => L.get(p)!, right = (p: typeof a) => -R.get(p)!;
      // uv.x: 0 at the full right edge, 1 at the full left edge, so narrowed stretches keep their lines in place.
      strip(tile.roads, right, left, [a.y, a.y], [b.y, b.y], (p, s) => [(s ? left(p) : right(p)) / width + 0.5, look]);
      // Lifted road on an embankment: own collision, and retaining walls down to the terrain.
      const above = !bridge && way.raise ? Math.max(a.y - height(a.e, a.n), b.y - height(b.e, b.n)) : 0;
      // The car rolls on the road as drawn: its own collision 5 cm under the surface, bevelled at the edges
      // down to the terrain mesh, which is fitted below it (carve.ts). Decks and lifted roads only push the
      // terrain down.
      const lifted = bridge || above > ROAD_LIFT + 0.1;
      if (carve || lifted) {
        carve?.add(a.e, a.n, a.y, b.e, b.n, b.y, Math.min(L.get(a)!, R.get(a)!, L.get(b)!, R.get(b)!), !lifted);
        const c = (p: typeof a, d: number) => p.y - d;
        const extra = lifted ? 0.5 : 0;
        const lw = (p: typeof a) => left(p) + extra, rw = (p: typeof a) => right(p) - extra;
        strip(tile.collide, rw, lw, [c(a, STRIP_DROP), c(a, STRIP_DROP)], [c(b, STRIP_DROP), c(b, STRIP_DROP)]);
        if (!lifted) {
          strip(tile.collide, lw, (p) => lw(p) + 1, [c(a, STRIP_DROP), c(a, ROAD_LIFT + 0.1)], [c(b, STRIP_DROP), c(b, ROAD_LIFT + 0.1)]);
          strip(tile.collide, (p) => rw(p) - 1, rw, [c(a, ROAD_LIFT + 0.1), c(a, STRIP_DROP)], [c(b, ROAD_LIFT + 0.1), c(b, STRIP_DROP)]);
        }
      }
      // Deck seen from below and from the side: 1 m thick slab, where there is room under it.
      if (Math.min(a.y - height(a.e, a.n), b.y - height(b.e, b.n)) > 1.5 && (bridge || above > 0.6)) {
        const o = walkway ? hw + capFrom + BRIDGE_CAP.width : hw + 0.5;
        strip(tile.sidewalks, o, -o, [a.y - 1, a.y - 1], [b.y - 1, b.y - 1], () => [0, 0]);
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

      // Bridge caps run through the nodes where the road continues; a road branching off stops them below.
      if (walkway || sidewalk) {
        const sw = walkway ? BRIDGE_CAP.width : SIDEWALK.width;
        const from = walkway ? capFrom : 0;
        const ground = (p: typeof a, o: number) => {
          // On a bridge the skirt ends at the underside of the deck slab.
          if (walkway) return p.y - 1;
          const [e, n] = [p.e - p.dy * o, p.n + p.dx * o];
          return Math.min(height(e, n), p.y) - 0.3;
        };
        const tuv = (p: typeof a, s: 0 | 1) => [p.dist / 2, s * (sw / 2)] as [number, number];
        for (const side of [1, -1]) {
          let ka: number, kb: number;
          if (walkway) {
            // No cap where the road had to give way to another road alongside.
            const full = (p: typeof a) => (side > 0 ? L : R).get(p)! >= hw - 0.05;
            if (!full(a) || !full(b)) continue;
            // A bridge cap may pass over a road below, not onto one at its own height.
            const corners = [off(a, side * (hw + from + sw)), off(b, side * (hw + from + sw)), off(a, side * (hw + from + sw / 2)), off(b, side * (hw + from + sw / 2))];
            if (corners.some(([x, z], i) => carriageways.onOther(way, x, z, 0.3, i % 2 ? b.y : a.y))) continue;
            ka = a.y + SIDEWALK.height;
            kb = b.y + SIDEWALK.height;
          } else {
            if (!paved.get(side)![i]) continue;
            ka = a.y + kerbAt(side, i - 1);
            kb = b.y + kerbAt(side, i);
          }
          const inner = side * (hw + from);
          const outer = side * (hw + from + sw);
          const [i0, i1] = side > 0 ? [inner, outer] : [outer, inner];
          // Top surface.
          strip(tile.sidewalks, i0, i1, [ka, ka], [kb, kb], tuv);
          // Kerb face towards the road and skirt on the outer edge, as narrow vertical strips.
          wall(tile.sidewalks, off(a, inner), off(b, inner), a.y - 0.05, ka, b.y - 0.05, kb, side < 0);
          wall(tile.sidewalks, off(a, outer), off(b, outer), ground(a, outer), ka, ground(b, outer), kb, side > 0);
          if (walkway && bridges.railings) {
            const o = side * (hw + from + sw - BRIDGE_CAP.railInset);
            const pa = [a.e - a.dy * o, a.n + a.dx * o], pb = [b.e - b.dy * o, b.n + b.dx * o];
            const de = pb[0] - pa[0], dn = pb[1] - pa[1];
            bridges.railings.push({ e: (pa[0] + pb[0]) / 2, n: (pa[1] + pb[1]) / 2, de, dn, len: Math.hypot(de, dn), y: (ka + kb) / 2 });
          }
        }
      }
    }

    // Where two roads meet at an angle, their collision strips end square to each road and leave a wedge
    // open on the outside of the bend; continue each strip a little past both ends so they overlap.
    if (carve || bridge)
      for (const [p, dir] of [[ring[0], -1], [ring[ring.length - 1], 1]] as const) {
        const hw = width / 2 + (bridge ? 0.5 : 0);
        const ext = Math.min(hw, 4) * dir;
        const tip = { e: p.e + p.dx * ext, n: p.n + p.dy * ext };
        const corner = (q: { e: number; n: number }, o: number) => utmToLocal(world, q.e - p.dy * o, q.n + p.dx * o);
        // The cap keeps the road's grade: flat, it would stick up out of a road continuing downhill.
        const q = dir > 0 ? ring[ring.length - 2] : ring[1];
        const grade = (p.y - q.y) / (Math.abs(p.dist - q.dist) || 1);
        const y = p.y - STRIP_DROP, yt = y + grade * Math.abs(ext);
        const t = tiles.at(p.e, p.n).collide;
        const v = [corner(p, -hw), corner(p, hw), corner(tip, -hw), corner(tip, hw)].map(([x, z], i) => t.vertex(x, i < 2 ? y : yt, z, {}));
        // Upward-facing whichever way the cap points.
        if (dir > 0) { t.tri(v[0], v[2], v[1]); t.tri(v[1], v[2], v[3]); }
        else { t.tri(v[0], v[1], v[2]); t.tri(v[1], v[3], v[2]); }
      }

    // Street lamps, alternating sides.
    if (cls.street && cls.rank >= 3 && !bridge && way.urban !== false) {
      let next = LAMP_SPACING / 2;
      let side = 1;
      for (const r of ring) {
        if (r.dist < next) continue;
        next += LAMP_SPACING;
        side = -side;
        if ((side > 0 ? L : R).get(r)! < width / 2 - 0.05) continue;
        const pav = sidewalk && (side > 0 ? sides.left : sides.right);
        const o = side * (width / 2 + (pav ? SIDEWALK.width - 0.5 : 0.8));
        const [x, z] = utmToLocal(world, r.e - r.dy * o, r.n + r.dx * o);
        if (jIndex.near(x, z, 4)) continue;
        // Heading of the lamp arm: towards the road centre.
        const heading = Math.atan2(r.dx, r.dy) + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
        const t = tiles.at(r.e - r.dy * o, r.n + r.dx * o);
        t.lamps.push(x, r.y + (pav ? SIDEWALK.height : 0), z, heading);
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
