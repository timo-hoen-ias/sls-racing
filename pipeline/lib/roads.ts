import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import { edgeLineWidth, encodeRoad, isFieldWay, roadLook } from '../../src/render/pbr/roadCode.ts';
import type { RoadCarve } from './carve.ts';
import type { HalfWidths } from './overlap.ts';
import { MIN_SIDEWALK, noCars, roadSection, type RoadSection } from '../../src/world/roadSpec.ts';
import type { Junction } from './graph.ts';
import type { Way } from './osm.ts';
import { KERB } from './kerbs.ts';
import type { MeshBuf, TileMap } from './tilebuf.ts';
import { Line, type RampPlan } from './ramps.ts';
import { builtTunnel, isTunnel } from './tunnelMark.ts';

export { builtTunnel, isTunnel };

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
/** Feldwege climb and wind through hilly woods: samples every 2 m, so the drawn chords keep to the profile. */
const FIELD_STEP = 2;
export const ROAD_LIFT = 0.15; // road surface above the terrain mesh
/** Bank beside a Feldweg: width out from the edge, and how far its foot sinks under the terrain (m). */
const FIELD_BANK = { width: 1.2, sink: 0.15, skirt: 2.5 };
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
/** Block marking between through lanes and an auxiliary lane (RMS, motorways): broad line, 6 m line, 6 m gap. */
const BLOCK = { width: 0.3, period: 12, on: 6 };
/** Hatched gore (Sperrfläche) between a motorway and a ramp: 0.5 m stripes every 3 m. */
const HATCH = { width: 0.5, every: 3 };

/**
 * Width missing on the right of a motorway junction lane at `dist` metres along the way: the auxiliary lane
 * opens and closes linearly over its tapers (ramps.ts). 0 elsewhere.
 */
export function auxLoss(way: Way, section: RoadSection, dist: number): number {
  const run = section.aux ? way.auxRun : undefined;
  if (!run) return 0;
  const s = run.from + dist;
  const t = Math.min(1, run.taperIn > 0 ? s / run.taperIn : 1, run.taperOut > 0 ? (run.length - s) / run.taperOut : 1);
  return section.lane * (1 - Math.max(0, t));
}

/** Paved extent left and right of the OSM line at `dist` metres along a way (placement shift, junction tapers). */
export function carriagewayEdges(way: Way, section: RoadSection, dist: number) {
  return { left: section.width / 2 - section.shift, right: section.width / 2 + section.shift - auxLoss(way, section, dist) };
}

/** Carriageway width in metres (lanes and edge strips, see src/world/roadSpec.ts). */
export function roadWidth(tags: Record<string, string>): number | undefined {
  return ROAD_CLASSES[tags.highway] ? roadSection(tags)!.width : undefined;
}

/** Built as a carriageway (with collision), including pedestrian zones, roads closed to cars and built tunnels. */
export function isDrivable(tags: Record<string, string>) {
  return !!ROAD_CLASSES[tags.highway] && (!isTunnel(tags) || builtTunnel(tags)) && tags.area !== 'yes';
}

/** A carriageway open to cars: routing, traffic and the drive test use only these. */
export const isMotorRoad = (tags: Record<string, string>) => isDrivable(tags) && !noCars(tags);

export const isBridge = (tags: Record<string, string>) => !!tags.bridge && tags.bridge !== 'no';

/**
 * Sidewalk width beside a way: the full KERB.width, narrower where the game profile widened the carriageway
 * into the street space between the houses (never below MIN_SIDEWALK).
 */
export function sidewalkWidth(way: Way): number {
  const street = parseFloat(way.tags['sls:street']);
  if (!(street > 0)) return SIDEWALK.width;
  return Math.max(MIN_SIDEWALK, Math.min(SIDEWALK.width, (street - roadWidth(way.tags)!) / 2));
}

/** Pavement sides as kerbs.ts planned them (left = positive offsets), else the old default for streets. */
export function sidewalkSides(way: Way): { left: boolean; right: boolean } {
  if (isBridge(way.tags)) return { left: false, right: false };
  return way.sidewalks ?? (ROAD_CLASSES[way.tags.highway]?.street && !['no', 'none'].includes(way.tags.sidewalk) ? { left: true, right: true } : { left: false, right: false });
}

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

/** Extra height along a way where it was matched to an overlapping road (levels.ts), 0 elsewhere. */
export function levelAt(way: Way, dist: number): number {
  const l = way.level;
  if (!l) return 0;
  const d = l.dist;
  let i = 0, j = d.length - 1;
  if (dist <= d[0]) return l.dy[0];
  if (dist >= d[j]) return l.dy[j];
  while (j - i > 1) { const m = (i + j) >> 1; if (d[m] <= dist) i = m; else j = m; }
  const t = (dist - d[i]) / (d[j] - d[i] || 1);
  return l.dy[i] + (l.dy[j] - l.dy[i]) * t;
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
    ? (_e: number, _n: number, dist: number) => span(dist) + raised(dist) + levelAt(way, dist)
    : (e: number, n: number, dist: number) => ground(e, n, dist) + lift + raised(dist) + levelAt(way, dist);
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
export function roadProfile(way: Way, height: (e: number, n: number) => number, world: WorldInfo, step = way.tags.highway === 'track' ? FIELD_STEP : STEP) {
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
export class CarriagewayIndex {
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
  onOther(self: Way | undefined, x: number, z: number, margin: number, y?: number) {
    for (const s of this.cells.get(`${Math.floor(x / 16)}_${Math.floor(z / 16)}`) ?? []) {
      if (s.way === self) continue;
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
      const t = Math.min(1, Math.max(0, ((x - s.x0) * dx + (z - s.z0) * dz) / (dx * dx + dz * dz || 1)));
      if (y !== undefined && Math.abs(s.y0 + (s.y1 - s.y0) * t - y) > 3) continue;
      if (Math.hypot(s.x0 + dx * t - x, s.z0 + dz * t - z) < s.hw + margin) return true;
    }
    return false;
  }
  /** Whether (x, z) lies on the carriageway of another road at about height y (within `tol`). */
  level(self: Way, x: number, z: number, y: number, tol: number) {
    for (const s of this.cells.get(`${Math.floor(x / 16)}_${Math.floor(z / 16)}`) ?? []) {
      if (s.way === self) continue;
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
      const t = Math.min(1, Math.max(0, ((x - s.x0) * dx + (z - s.z0) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.abs(s.y0 + (s.y1 - s.y0) * t - y) > tol) continue;
      if (Math.hypot(s.x0 + dx * t - x, s.z0 + dz * t - z) < s.hw) return true;
    }
    return false;
  }
  /**
   * Lowest surface of another road under (x, z) that lies below height y (by less than `within`, so a car could
   * not pass between them), or undefined.
   */
  below(self: Way, x: number, z: number, y: number, within = 3): number | undefined {
    let low: number | undefined;
    for (const s of this.cells.get(`${Math.floor(x / 16)}_${Math.floor(z / 16)}`) ?? []) {
      if (s.way === self) continue;
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
      const t = Math.min(1, Math.max(0, ((x - s.x0) * dx + (z - s.z0) * dz) / (dx * dx + dz * dz || 1)));
      const sy = s.y0 + (s.y1 - s.y0) * t;
      if (sy >= y || sy < y - within) continue;
      if (Math.hypot(s.x0 + dx * t - x, s.z0 + dz * t - z) < s.hw + 0.3 && (low === undefined || sy < low)) low = sy;
    }
    return low;
  }
}

/**
 * Emits road ribbons, dashed centre lines, sidewalks and street lamps into the tiles they cross.
 * Returns all centreline samples so callers can pick a spawn point.
 */
export function buildRoads(
  ways: Way[], world: WorldInfo, height: (e: number, n: number) => number, tiles: TileMap, junctions: Junction[],
  carve?: RoadCarve, halves?: Map<Way, HalfWidths>,
  bridges: { dressed?: Set<number>; railings?: Railing[] } = {}, ramps?: RampPlan,
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
    const { shift, outer } = section;
    // Lane lines: long dashes on motorways (6 m line, 12 m gap), short ones elsewhere (3 m, 6 m).
    const dash = cls.rank >= 8 ? { period: 18, on: 6 } : { period: 9, on: 3 };
    const ring = rings.get(way)!;
    if (ring.length < 2) continue;
    const bridge = isBridge(way.tags);
    // Tunnels: the tube and the cut in the terrain come from the tile field (tunnels.ts, tunnelGeom.ts).
    const tunnel = builtTunnel(way.tags);
    const sides = sidewalkSides(way);
    const sidewalk = sides.left || sides.right;
    // Bridges dressed by a landmark model bring their own railings.
    const walkway = bridge && !bridges.dressed?.has(way.id);
    const capFrom = FAST.test(way.tags.highway) ? BRIDGE_CAP.behindRail : 0;
    // Surface, wear, edge lines and gutters for the road shader (src/render/pbr/roadCode.ts).
    const look = encodeRoad(roadLook(way.tags, way.id, section, sidewalk));
    const field = isFieldWay(way.tags);
    // Usable half width per sample, narrower where a road at another height runs alongside (overlap.ts).
    const half = halves?.get(way);
    // Nominal extent of the carriageway left and right of the OSM line: shifted by its placement, and on a
    // motorway junction lane narrower in the tapers where the auxiliary lane opens or closes (ramps.ts).
    const run = section.aux ? way.auxRun : undefined;
    const loss = (p: { dist: number }) => auxLoss(way, section, p.dist);
    const Ln = width / 2 - shift;
    const Rn = new Map(ring.map((p) => [p, width / 2 + shift - loss(p)]));
    // Beside a ramp's gore the motorway ends at the ramp's left edge line, so the ramp shows its own lines.
    const gores = ramps?.gores.filter((g) => g.ways.has(way)) ?? [];
    const goreAt = new Map<typeof ring[number], { from: number; to: number }>();
    if (gores.length) {
      const lines = gores.map((g) => ({ g, line: new Line(g.pts), ring: g.links.flatMap((w) => rings.get(w) ?? []) }));
      // Surface height of the ramp nearest to a point.
      const rampY = (ring: typeof lines[number]['ring'], e: number, n: number) => {
        let best = Infinity, y = NaN;
        for (const q of ring) { const d = (q.e - e) ** 2 + (q.n - n) ** 2; if (d < best) { best = d; y = q.y; } }
        return y;
      };
      const lw = edgeLineWidth(outer);
      for (const p of ring) {
        const edge = Rn.get(p)! - outer + lw;
        for (const { g, line, ring: rr } of lines) {
          if (Math.hypot(p.e - g.e, p.n - g.n) > 900) continue;
          const pr = line.project(p.e, p.n);
          // The motorway lies left of the ramp; the ramp's left line, seen from the motorway. Only where the
          // two surfaces meet at the same height (not where the ramp has dropped below or climbed away).
          if (pr.end && pr.d > 1 || pr.dist > 40 || pr.lat > 0) continue;
          if (!(Math.abs(rampY(rr, p.e, p.n) - p.y) < 0.25)) continue;
          const at = -pr.lat + g.leftLine;
          if (at < Rn.get(p)! + 0.05) {
            const cur = goreAt.get(p);
            if (!cur || at < cur.to) goreAt.set(p, { from: edge, to: Math.max(edge + 0.05, at) });
          }
        }
      }
    }
    const L = new Map(ring.map((p, i) => [p, Ln - (half ? width / 2 - half.left[i] : 0)]));
    const R = new Map(ring.map((p, i) => [p, Math.min(Rn.get(p)! - (half ? width / 2 - half.right[i] : 0), goreAt.get(p)?.to ?? Infinity)]));

    for (const r of ring) samples.push({ x: r.x, z: r.z, y: r.y, heading: Math.atan2(r.dx, r.dy) });

    // Pavement segments per side (segment i runs from sample i - 1 to i), decided first so the kerb can be
    // lowered where a stretch ends (junctions, driveways) and at mapped crossings.
    const hw0 = width / 2, sw0 = sidewalkWidth(way);
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
      const strip = (buf: MeshBuf, o0: Offset, o1: Offset, ya: [number, number], yb: [number, number], uv?: (p: typeof a, side: 0 | 1) => [number, number], [pa, pb] = [a, b]) => {
        const v: number[] = [];
        for (const [p, o, side, y] of [[pa, o0, 0, ya[0]], [pa, o1, 1, ya[1]], [pb, o0, 0, yb[0]], [pb, o1, 1, yb[1]]] as const) {
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
      // In a taper the full width changes along the road; the look then carries this segment's width.
      const full = (p: typeof a) => Ln + Rn.get(p)!;
      const segLook = run && (loss(a) > 0 || loss(b) > 0)
        ? encodeRoad(roadLook(way.tags, way.id, { ...section, width: (full(a) + full(b)) / 2 }, sidewalk)) : look;
      strip(tile.roads, right, left, [a.y, a.y], [b.y, b.y], (p, s) => [((s ? left(p) : right(p)) + Rn.get(p)!) / full(p), segLook]);
      // Lifted road on an embankment: own collision, and retaining walls down to the terrain.
      const above = !bridge && way.raise ? Math.max(a.y - height(a.e, a.n), b.y - height(b.e, b.n)) : 0;
      // Feldwege: a grassy bank on both sides down to the terrain, so a way across a slope or in a hairpin
      // (where the mesh is kept below the lower leg, carve.ts) sits on an embankment instead of floating.
      if (field && !bridge && !tunnel && !(above > ROAD_LIFT + 0.1)) {
        // Never above a lower road the bank reaches over (a junction arm, a way alongside): its wheels would hit it.
        const foot = (p: typeof a, o: number) => Math.min(height(p.e - p.dy * o, p.n + p.dx * o) - ROAD_LIFT, p.y - 0.05,
          (carriageways.below(way, ...off(p, o), p.y - STRIP_DROP) ?? Infinity) - STRIP_DROP) - FIELD_BANK.sink;
        const lo = (p: typeof a) => left(p) + FIELD_BANK.width, ro = (p: typeof a) => right(p) - FIELD_BANK.width;
        // In the path mesh (road shader, wheels only), not the carriageway: the surface check scans only that.
        strip(tile.paths, left, lo, [a.y, foot(a, lo(a))], [b.y, foot(b, lo(b))], () => [1, segLook]);
        strip(tile.paths, ro, right, [foot(a, ro(a)), a.y], [foot(b, ro(b)), b.y], () => [0, segLook]);
        // A skirt under the foot closes the view under the way where the mesh lies lower still (hairpins,
        // ways side by side at different heights); under the terrain it is never seen.
        const lp = (p: typeof a) => off(p, lo(p)), rp = (p: typeof a) => off(p, ro(p));
        wall(tile.paths, lp(a), lp(b), foot(a, lo(a)) - FIELD_BANK.skirt, foot(a, lo(a)), foot(b, lo(b)) - FIELD_BANK.skirt, foot(b, lo(b)), true);
        wall(tile.paths, rp(a), rp(b), foot(a, ro(a)) - FIELD_BANK.skirt, foot(a, ro(a)), foot(b, ro(b)) - FIELD_BANK.skirt, foot(b, ro(b)), false);
      }
      // The car rolls on the road as drawn: its own collision 5 cm under the surface, bevelled at the edges
      // down to the terrain mesh, which is fitted below it (carve.ts). Decks and lifted roads only push the
      // terrain down.
      const lifted = bridge || tunnel || above > ROAD_LIFT + 0.1;
      if (carve || lifted) {
        // Centred on the carriageway where it lies off the OSM line (placement, auxiliary lane).
        const co = (p: typeof a) => (Rn.get(p)! - Ln) / 2;
        const ext = [L.get(a)! + co(a), R.get(a)! - co(a), L.get(b)! + co(b), R.get(b)! - co(b)];
        const ch = Math.min(...ext), cap = Math.max(...ext);
        // Never in a tunnel: the ground above stays where it is.
        if (!tunnel) carve?.add(a.e + a.dy * co(a), a.n - a.dx * co(a), a.y, b.e + b.dy * co(b), b.n - b.dx * co(b), b.y, ch, !lifted, cap);
        const c = (p: typeof a, d: number) => p.y - d;
        // Another road just below beside this one (a junction arm, a road alongside at another height): the
        // collision must not reach out over it, or its wheels hit this road's skirt above their own surface.
        const lower = (p: typeof a, o: number) => carriageways.below(way, ...off(p, o), p.y - STRIP_DROP);
        // Decks and lifted roads reach 0.5 m wider, so a wheel at the edge has ground; where another deck or road
        // runs alongside at the same height with a slot of up to 1.5 m between them, across the slot.
        const reach = (p: typeof a, side: number) => {
          if (!lifted) return 0;
          const edge = side > 0 ? left(p) : -right(p);
          for (const o of [0.5, 1, 1.5]) if (carriageways.level(way, ...off(p, side * (edge + o)), p.y, 0.5)) return o + 0.25;
          return 0.5;
        };
        const lw = (p: typeof a) => left(p) + reach(p, 1), rw = (p: typeof a) => right(p) - reach(p, -1);
        strip(tile.collide, rw, lw, [c(a, STRIP_DROP), c(a, STRIP_DROP)], [c(b, STRIP_DROP), c(b, STRIP_DROP)]);
        if (!lifted) {
          // Bevel 1 m out and down under the terrain, but never above a lower road there.
          const skirt = (p: typeof a, o: number) => Math.min(c(p, ROAD_LIFT + 0.1), (lower(p, o) ?? Infinity) - STRIP_DROP);
          strip(tile.collide, lw, (p) => lw(p) + 1, [c(a, STRIP_DROP), skirt(a, lw(a) + 1)], [c(b, STRIP_DROP), skirt(b, lw(b) + 1)]);
          strip(tile.collide, (p) => rw(p) - 1, rw, [skirt(a, rw(a) - 1), c(a, STRIP_DROP)], [skirt(b, rw(b) - 1), c(b, STRIP_DROP)]);
        }
      }
      // Deck seen from below and from the side: 1 m thick slab, where there is room under it.
      // Outer edges of the deck (carriageway extents, placed off the OSM line where ramps.ts says so).
      const beyond = walkway ? capFrom + BRIDGE_CAP.width : 0.5;
      const ol = (_p: typeof a) => Ln + beyond, or = (p: typeof a) => -Rn.get(p)! - beyond;
      if (!tunnel && Math.min(a.y - height(a.e, a.n), b.y - height(b.e, b.n)) > 1.5 && (bridge || above > 0.6)) {
        strip(tile.sidewalks, ol, or, [a.y - 1, a.y - 1], [b.y - 1, b.y - 1], () => [0, 0]);
        wall(tile.sidewalks, off(a, ol(a)), off(b, ol(b)), a.y - 1, a.y, b.y - 1, b.y, true);
        wall(tile.sidewalks, off(a, or(a)), off(b, or(b)), a.y - 1, a.y, b.y - 1, b.y, false);
      }
      if (above > 0.6) {
        for (const side of [1, -1]) {
          const o = (p: typeof a) => (side > 0 ? ol(p) : or(p));
          const foot = (p: typeof a) => height(p.e - p.dy * o(p), p.n + p.dx * o(p)) - 0.3;
          wall(tile.sidewalks, off(a, o(a)), off(b, o(b)), foot(a), a.y, foot(b), b.y, side > 0);
        }
      }
      // Dashes: 3 m line, 6 m gap.
      if (cls.centreLine && way.tags.oneway !== 'yes' && Math.floor(a.dist / 9) === Math.floor(b.dist / 9) && a.dist % 9 < 3) {
        strip(tile.markings, -0.07, 0.07, [a.y + 0.02, a.y + 0.02], [b.y + 0.02, b.y + 0.02]);
      }
      // Dashes cut exactly to their pattern (line `on` metres every `period`, counted from `phase` before the
      // way's start), between offsets o0 < o1 (left positive), kept `clear` metres off junctions.
      const dashes = (o0: number, o1: number, period: number, on: number, phase: number, clear: number) => {
        const d0 = a.dist + phase, d1 = b.dist + phase;
        const at = (d: number) => {
          const t = (d - d0) / (d1 - d0 || 1);
          const l = (u: number, v: number) => u + (v - u) * t;
          return { ...a, e: l(a.e, b.e), n: l(a.n, b.n), x: l(a.x, b.x), z: l(a.z, b.z), y: l(a.y, b.y), dist: l(a.dist, b.dist) };
        };
        for (let s0 = Math.floor(d0 / period) * period; s0 < d1; s0 += period) {
          const lo = Math.max(d0, s0), hi = Math.min(d1, s0 + on);
          if (hi - lo < 0.05) continue;
          const p = at(lo), q = at(hi);
          if (jIndex.near(p.x, p.z, clear) || jIndex.near(q.x, q.z, clear)) continue;
          strip(tile.markings, o0, o1, [p.y + 0.02, p.y + 0.02], [q.y + 0.02, q.y + 0.02], undefined, [p, q]);
        }
      };
      // Lane lines (RMS on motorways: 0.15 m, 6 m line, 12 m gap). Offsets in the section are to the right;
      // strip offsets are to the left.
      for (const d of section.dividers) if (d !== section.block) dashes(-d - 0.075, -d + 0.075, dash.period, dash.on, 0, 1);
      // Block marking along the auxiliary lane, on the lane side of the through lanes' edge, in step along the run.
      if (run && section.block !== undefined) dashes(-section.block - BLOCK.width, -section.block, BLOCK.period, BLOCK.on, run.from, -2);

      // Bridge caps run through the nodes where the road continues; a road branching off stops them below.
      if (walkway || sidewalk) {
        const sw = walkway ? BRIDGE_CAP.width : sw0;
        const from = walkway ? capFrom : 0;
        const ground = (p: typeof a, o: number) => {
          // On a bridge the skirt ends at the underside of the deck slab.
          if (walkway) return p.y - 1;
          const [e, n] = [p.e - p.dy * o, p.n + p.dx * o];
          return Math.min(height(e, n), p.y) - 0.3;
        };
        const tuv = (p: typeof a, s: 0 | 1) => [p.dist / 2, s * (sw / 2)] as [number, number];
        for (const side of [1, -1]) {
          // Carriageway edge on this side (off the OSM line where the road is placed off it, ramps.ts).
          const edge = (p: typeof a) => (side > 0 ? Ln : Rn.get(p)!);
          let ka: number, kb: number;
          if (walkway) {
            // No cap where the road had to give way to another road alongside.
            const full = (p: typeof a) => (side > 0 ? L : R).get(p)! >= edge(p) - 0.05;
            if (!full(a) || !full(b)) continue;
            // A bridge cap may pass over a road below, not onto one at its own height.
            const corners = [off(a, side * (edge(a) + from + sw)), off(b, side * (edge(b) + from + sw)), off(a, side * (edge(a) + from + sw / 2)), off(b, side * (edge(b) + from + sw / 2))];
            if (corners.some(([x, z], i) => carriageways.onOther(way, x, z, 0.3, i % 2 ? b.y : a.y))) continue;
            ka = a.y + SIDEWALK.height;
            kb = b.y + SIDEWALK.height;
          } else {
            if (!paved.get(side)![i]) continue;
            ka = a.y + kerbAt(side, i - 1);
            kb = b.y + kerbAt(side, i);
          }
          const inner = (p: typeof a) => side * (edge(p) + from);
          const outer = (p: typeof a) => side * (edge(p) + from + sw);
          const [i0, i1] = side > 0 ? [inner, outer] : [outer, inner];
          // Top surface.
          strip(tile.sidewalks, i0, i1, [ka, ka], [kb, kb], tuv);
          // Kerb face towards the road and skirt on the outer edge, as narrow vertical strips.
          wall(tile.sidewalks, off(a, inner(a)), off(b, inner(b)), a.y - 0.05, ka, b.y - 0.05, kb, side < 0);
          wall(tile.sidewalks, off(a, outer(a)), off(b, outer(b)), ground(a, outer(a)), ka, ground(b, outer(b)), kb, side > 0);
          if (walkway && bridges.railings) {
            const o = (p: typeof a) => side * (edge(p) + from + sw - BRIDGE_CAP.railInset);
            const pa = [a.e - a.dy * o(a), a.n + a.dx * o(a)], pb = [b.e - b.dy * o(b), b.n + b.dx * o(b)];
            const de = pb[0] - pa[0], dn = pb[1] - pa[1];
            bridges.railings.push({ e: (pa[0] + pb[0]) / 2, n: (pa[1] + pb[1]) / 2, de, dn, len: Math.hypot(de, dn), y: (ka + kb) / 2 });
          }
        }
      }
    }

    if (goreAt.size) hatchGore(ring, goreAt, gores[0].kind === 'exit' ? 1 : -1, tiles, world);

    // Where two roads meet at an angle, their collision strips end square to each road and leave a wedge
    // open on the outside of the bend; continue each strip a little past both ends so they overlap.
    if (carve || bridge)
      for (const [p, dir] of [[ring[0], -1], [ring[ring.length - 1], 1]] as const) {
        const hw = width / 2 + (bridge ? 0.5 : 0);
        const hl = Ln + (bridge ? 0.5 : 0), hr = Rn.get(p)! + (bridge ? 0.5 : 0);
        const ext = Math.min(hw, 4) * dir;
        const tip = { e: p.e + p.dx * ext, n: p.n + p.dy * ext };
        const corner = (q: { e: number; n: number }, o: number) => utmToLocal(world, q.e - p.dy * o, q.n + p.dx * o);
        // The cap keeps the road's grade: flat, it would stick up out of a road continuing downhill.
        const q = dir > 0 ? ring[ring.length - 2] : ring[1];
        const grade = (p.y - q.y) / (Math.abs(p.dist - q.dist) || 1);
        const y = p.y - STRIP_DROP, yt = y + grade * Math.abs(ext);
        const t = tiles.at(p.e, p.n).collide;
        // Never above another road it reaches over (the road it ends on, lower there): its wheels would hit the cap.
        const capY = (x: number, z: number, h: number) => Math.min(h, (carriageways.below(way, x, z, h + STRIP_DROP) ?? Infinity) - STRIP_DROP);
        const v = [corner(p, -hr), corner(p, hl), corner(tip, -hr), corner(tip, hl)].map(([x, z], i) => t.vertex(x, capY(x, z, i < 2 ? y : yt), z, {}));
        // Upward-facing whichever way the cap points.
        if (dir > 0) { t.tri(v[0], v[2], v[1]); t.tri(v[1], v[2], v[3]); }
        else { t.tri(v[0], v[1], v[2]); t.tri(v[1], v[3], v[2]); }
      }

    // Street lamps, alternating sides.
    if (cls.street && cls.rank >= 3 && !bridge && !tunnel && way.urban !== false) {
      let next = LAMP_SPACING / 2;
      let side = 1;
      for (const r of ring) {
        if (r.dist < next) continue;
        next += LAMP_SPACING;
        side = -side;
        if ((side > 0 ? L : R).get(r)! < width / 2 - 0.05) continue;
        const pav = sidewalk && (side > 0 ? sides.left : sides.right);
        const o = side * (width / 2 + (pav ? sw0 - 0.5 : 0.8));
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

/**
 * Diagonal stripes over the gore between a motorway's edge line and a ramp's left line, where the two
 * carriageways part: per ring sample, the lateral span (right of the line) still paved by the motorway.
 */
function hatchGore(
  ring: { e: number; n: number; dx: number; dy: number; y: number; dist: number }[], at: Map<unknown, { from: number; to: number }>,
  dir: number, tiles: TileMap, world: WorldInfo,
) {
  const pts = ring.filter((p) => at.has(p) && at.get(p)!.to - at.get(p)!.from > 0.4);
  if (pts.length < 2) return;
  const sample = (d: number) => {
    let i = 1;
    while (i < pts.length - 1 && pts[i].dist < d) i++;
    const [a, b] = [pts[i - 1], pts[i]];
    if (d < a.dist - 0.01 || d > b.dist + 0.01 || b.dist - a.dist > 8.5) return undefined;
    const t = (d - a.dist) / (b.dist - a.dist || 1);
    const ga = at.get(a)!, gb = at.get(b)!;
    return { e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t, y: a.y + (b.y - a.y) * t, dx: a.dx, dy: a.dy, from: ga.from + (gb.from - ga.from) * t, to: ga.to + (gb.to - ga.to) * t };
  };
  const put = (p: { e: number; n: number; dx: number; dy: number }, along: number, lat: number) =>
    utmToLocal(world, p.e + p.dx * along + p.dy * lat, p.n + p.dy * along - p.dx * lat);
  for (let d = pts[0].dist + HATCH.every / 2; d < pts[pts.length - 1].dist; d += HATCH.every) {
    const s = sample(d);
    if (!s) continue;
    // 45° stripe from the motorway edge line across to the ramp line, 0.1 m clear of both lines.
    const a0 = s.from + 0.1, a1 = s.to - 0.1;
    if (a1 - a0 < 0.3) continue;
    const span = (a1 - a0) * dir;
    const w = HATCH.width * Math.SQRT2;
    const buf = tiles.at(s.e, s.n).markings;
    const y = s.y + 0.02;
    const c = [put(s, 0, a0), put(s, w, a0), put(s, span, a1), put(s, span + w, a1)];
    const v = c.map(([x, z]) => buf.vertex(x, y, z));
    // Face up (+y) whichever way the stripe runs.
    const up = (i: number, j: number, k: number) => (c[j][1] - c[i][1]) * (c[k][0] - c[i][0]) - (c[j][0] - c[i][0]) * (c[k][1] - c[i][1]) > 0;
    for (const [i, j, k] of [[0, 1, 2], [1, 3, 2]]) up(i, j, k) ? buf.tri(v[i], v[j], v[k]) : buf.tri(v[i], v[k], v[j]);
  }
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
