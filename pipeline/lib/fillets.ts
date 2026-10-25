import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import { encodeRoad, roadLook } from '../../src/render/pbr/roadCode.ts';
import { activeRoadProfile, roadSection } from '../../src/world/roadSpec.ts';
import type { RoadCarve } from './carve.ts';
import type { Way } from './osm.ts';
import { ROAD_CLASSES, isBridge, isMotorRoad, roadSurfaceHeights, sidewalkSides, sidewalkWidth } from './roads.ts';
import type { TileMap } from './tilebuf.ts';

// Rounded junction corners (S2, game road profile): where two streets meet at an angle, the corner between
// their kerb lines gets an asphalt fillet of a few metres radius, so a car turning off can carry speed
// instead of clipping a square corner. The radius is kept inside the pavement (the building line stays where
// it is): in town only as far as the sidewalk allows, wider on country roads. Drawn as road, with its own
// collision, the terrain fitted under it; kerbs, lamps and props keep off it (build.ts).

/** One rounded corner: the point where both kerb lines meet, then the arc between the tangent points (UTM). */
export interface Fillet {
  e: number[];
  n: number[];
  y: number[];
  /** Junction node (UTM) and how far from it the fillet reaches, to keep kerbs and props off it. */
  node: [number, number];
  reach: number;
  look: number;
}

/** Target radius by the lesser road class meeting at the corner. */
const RADIUS = (rank: number) => (rank >= 5 ? 10 : rank >= 3 ? 8 : rank >= 2 ? 5 : 4);
/** Kept this far inside the building line (m). */
const MARGIN = 0.4;
/** Rural corners (no sidewalk): how far into the verge the arc may reach. */
const RURAL_INSET = 4;
const MIN_ANGLE = (40 * Math.PI) / 180, MAX_ANGLE = (150 * Math.PI) / 180;
/** Arms use their first metres only: further on a street may bend. */
const ARM = 14;
const ARC_STEPS = 6;
const STRIP_DROP = 0.05;

interface Arm {
  way: Way;
  /** Unit direction away from the node (east, north). */
  de: number;
  dn: number;
  /** Carriageway half widths left and right of the arm, looking away from the node. */
  left: number;
  right: number;
  /** Paved room beyond the kerb line on each side (sidewalk up to the building line), m. */
  roomLeft: number;
  roomRight: number;
  /** Usable length along the arm (to the next junction or the way's end, at most ARM). */
  len: number;
  /** Surface height at the node and at `len`. */
  y0: number;
  y1: number;
  rank: number;
}

const eligible = (w: Way) =>
  isMotorRoad(w.tags) && !isBridge(w.tags) && !w.tags.tunnel && !w.tags.highway.endsWith('_link') && (ROAD_CLASSES[w.tags.highway]?.rank ?? 9) < 8
  && !w.raise?.some((r) => r > 0.05) && !w.graph;

/** Plans rounded corners at street junctions; none with the real road profile. */
export function planFillets(ways: Way[], height: (e: number, n: number) => number): Fillet[] {
  if (activeRoadProfile() !== 'game') return [];
  const roads = ways.filter(eligible);
  const uses = new Map<number, number>();
  const blocked = new Set<number>();
  for (const w of ways) {
    if (!isMotorRoad(w.tags)) continue;
    for (const id of new Set(w.ids)) uses.set(id, (uses.get(id) ?? 0) + 1);
    if (!eligible(w)) for (const id of w.ids) blocked.add(id);
  }
  const arms = new Map<number, Arm[]>();
  const at = new Map<number, [number, number]>();
  for (const w of roads) {
    const section = roadSection(w.tags)!;
    const ys = roadSurfaceHeights(w, height);
    const sides = sidewalkSides(w);
    const sw = sidewalkWidth(w);
    const street = +w.tags['sls:street'] || 0;
    // Room beyond the kerb: to the measured street line, else the sidewalk, else the rural verge.
    const room = (paved: boolean) => (street ? Math.max(0, street / 2 - section.width / 2) : paved ? sw : w.urban === false ? RURAL_INSET : 1.5);
    const rank = ROAD_CLASSES[w.tags.highway].rank;
    const L = section.width / 2 - section.shift, R = section.width / 2 + section.shift;
    for (let i = 0; i < w.ids.length; i++) {
      if ((uses.get(w.ids[i]) ?? 0) < 2) continue;
      if (w.closed && i === w.ids.length - 1) continue;
      for (const dir of [1, -1] as const) {
        const arm = walk(w, ys, i, dir, uses);
        if (!arm) continue;
        const fwd = dir > 0;
        const list = arms.get(w.ids[i]) ?? [];
        list.push({
          way: w, ...arm, rank,
          left: fwd ? L : R, right: fwd ? R : L,
          roomLeft: room(fwd ? sides.left : sides.right), roomRight: room(fwd ? sides.right : sides.left),
        });
        arms.set(w.ids[i], list);
        at.set(w.ids[i], w.pts[i]);
      }
    }
  }
  const out: Fillet[] = [];
  for (const [id, list] of arms) {
    // A node where a bridge, ramp or lifted road meets is left square: its arms are missing from the list.
    if (list.length < 2 || blocked.has(id)) continue;
    const [ne, nn] = at.get(id)!;
    list.sort((a, b) => Math.atan2(a.dn, a.de) - Math.atan2(b.dn, b.de));
    for (let k = 0; k < list.length; k++) {
      const A = list[k], B = list[(k + 1) % list.length];
      if (A === B) continue;
      let theta = Math.atan2(B.dn, B.de) - Math.atan2(A.dn, A.de);
      if (theta <= 0) theta += Math.PI * 2;
      if (theta < MIN_ANGLE || theta > MAX_ANGLE) continue;
      if (Math.abs(A.y0 - B.y0) > 0.3) continue;
      const f = corner(ne, nn, A, B, theta);
      if (f) out.push(f);
    }
  }
  return out;
}

/** The first metres of a way from node i in one direction. */
function walk(w: Way, ys: number[], i: number, dir: 1 | -1, uses: Map<number, number>) {
  const p = w.pts;
  const step = (j: number) => {
    let n = j + dir;
    if (w.closed) n = (n + p.length - 1) % (p.length - 1);
    return n;
  };
  if (!w.closed && (i + dir < 0 || i + dir >= p.length)) return undefined;
  let len = 0, j = i, de = 0, dn = 0, y1 = ys[i];
  for (let guard = 0; guard < p.length; guard++) {
    const n = step(j);
    if (n < 0 || n >= p.length) break;
    const sl = Math.hypot(p[n][0] - p[j][0], p[n][1] - p[j][1]);
    const take = Math.min(sl, ARM - len);
    if (!de && !dn && sl > 0.1) { de = (p[n][0] - p[i][0]) / sl; dn = (p[n][1] - p[i][1]) / sl; }
    len += take;
    y1 = ys[j] + (ys[n] - ys[j]) * (take / (sl || 1));
    if (len >= ARM || (uses.get(w.ids[n]) ?? 0) > 1 || (!w.closed && (n === 0 || n === p.length - 1))) break;
    j = n;
  }
  if (len < 3 || (!de && !dn)) return undefined;
  // Direction over the arm, not just its first segment.
  const ex = pointAlong(w, i, dir, Math.min(len, 8));
  const l = Math.hypot(ex[0] - p[i][0], ex[1] - p[i][1]) || 1;
  return { de: (ex[0] - p[i][0]) / l, dn: (ex[1] - p[i][1]) / l, len, y0: ys[i], y1 };
}

function pointAlong(w: Way, i: number, dir: 1 | -1, d: number): [number, number] {
  const p = w.pts;
  let j = i;
  for (let guard = 0; guard < p.length; guard++) {
    let n = j + dir;
    if (w.closed) n = (n + p.length - 1) % (p.length - 1);
    if (n < 0 || n >= p.length) break;
    const sl = Math.hypot(p[n][0] - p[j][0], p[n][1] - p[j][1]);
    if (sl >= d) return [p[j][0] + ((p[n][0] - p[j][0]) * d) / sl, p[j][1] + ((p[n][1] - p[j][1]) * d) / sl];
    d -= sl;
    j = n;
  }
  return p[j];
}

/** Fillet in the corner from arm A counter-clockwise to arm B, seen from above (east, north). */
function corner(ne: number, nn: number, A: Arm, B: Arm, theta: number): Fillet | undefined {
  // Kerb lines: A's left edge, B's right edge.
  const la = [-A.dn, A.de], rb = [B.dn, -B.de];
  const pa = [ne + la[0] * A.left, nn + la[1] * A.left], pb = [ne + rb[0] * B.right, nn + rb[1] * B.right];
  // pa + A.d s = pb + B.d u
  const det = A.de * -B.dn - A.dn * -B.de;
  if (Math.abs(det) < 1e-3) return undefined;
  const qx = pb[0] - pa[0], qy = pb[1] - pa[1];
  const s = (qx * -B.dn - qy * -B.de) / det;
  const u = (A.de * qy - A.dn * qx) / det;
  const P = [pa[0] + A.de * s, pa[1] + A.dn * s];
  const half = theta / 2, sin = Math.sin(half);
  // Inside the building line: the arc's middle stays MARGIN short of the corner of the paved room.
  const room = Math.min(A.roomLeft, B.roomRight);
  let R = RADIUS(Math.min(A.rank, B.rank));
  if (sin < 0.999) R = Math.min(R, (room - MARGIN * sin) / (1 - sin));
  // The tangent points stay on the straight first metres of both arms, short of the next junction.
  const t0 = R / Math.tan(half);
  const maxT = Math.min(A.len * 0.6 - s, B.len * 0.6 - u, 12);
  let t = Math.min(t0, maxT);
  R = t * Math.tan(half);
  if (R < 2.5 || t < 2) return undefined;
  t = R / Math.tan(half);
  const TA = [P[0] + A.de * t, P[1] + A.dn * t], TB = [P[0] + B.de * t, P[1] + B.dn * t];
  // Arc centre on the bisector, R/sin from P.
  const bx = A.de + B.de, by = A.dn + B.dn, bl = Math.hypot(bx, by) || 1;
  const C = [P[0] + (bx / bl) * (R / sin), P[1] + (by / bl) * (R / sin)];
  const a0 = Math.atan2(TA[1] - C[1], TA[0] - C[0]), a1 = Math.atan2(TB[1] - C[1], TB[0] - C[0]);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const yA = (d: number) => A.y0 + (A.y1 - A.y0) * Math.min(1, d / A.len), yB = (d: number) => B.y0 + (B.y1 - B.y0) * Math.min(1, d / B.len);
  const e = [P[0]], n = [P[1]], y = [(yA(s) + yB(u)) / 2];
  for (let k = 0; k <= ARC_STEPS; k++) {
    const a = a0 + (sweep * k) / ARC_STEPS;
    e.push(C[0] + Math.cos(a) * R);
    n.push(C[1] + Math.sin(a) * R);
    // Height blends from arm A's at TA to arm B's at TB.
    const w = k / ARC_STEPS;
    y.push(yA(s + t) * (1 - w) + yB(u + t) * w);
  }
  const reach = Math.max(Math.hypot(TA[0] - ne, TA[1] - nn), Math.hypot(TB[0] - ne, TB[1] - nn));
  const lesser = A.rank <= B.rank ? A : B;
  const section = roadSection(lesser.way.tags)!;
  const look = encodeRoad({ ...roadLook(lesser.way.tags, lesser.way.id, section, false), lines: 0, gutter: false });
  return { e, n, y, node: [ne, nn], reach, look };
}

/** Draws the fillets into the tiles: road surface, collision with a bevel down to the terrain, and carving. */
export function drawFillets(fillets: Fillet[], world: WorldInfo, tiles: TileMap, carve?: RoadCarve) {
  for (const f of fillets) {
    const tile = tiles.at(f.e[0], f.n[0]);
    const loc = f.e.map((e, i) => utmToLocal(world, e, f.n[i]));
    // Fan from the corner point, wound to face up.
    const flip = up(loc[0], loc[1], loc[2]);
    const tri = (buf: typeof tile.roads, a: number, b: number, c: number) => (flip ? buf.tri(a, b, c) : buf.tri(a, c, b));
    const fan = (buf: typeof tile.roads, drop: number, uv: boolean) => {
      const v = loc.map(([x, z], i) => buf.vertex(x, f.y[i] - drop, z, uv ? { uv: [0.5, f.look] } : {}));
      for (let k = 1; k + 1 < v.length; k++) tri(buf, v[0], v[k], v[k + 1]);
    };
    fan(tile.roads, 0, true);
    fan(tile.collide, STRIP_DROP, false);
    // Bevel 1 m out from the arc, down to the terrain, like the road strips' edges.
    const c = [f.e[0], f.n[0]];
    for (let k = 1; k + 1 < loc.length; k++) {
      const out = (i: number) => {
        const de = f.e[i] - c[0], dn = f.n[i] - c[1], l = Math.hypot(de, dn) || 1;
        return utmToLocal(world, f.e[i] + de / l, f.n[i] + dn / l);
      };
      const [o0, o1] = [out(k), out(k + 1)];
      const v = [
        tile.collide.vertex(loc[k][0], f.y[k] - STRIP_DROP, loc[k][1], {}),
        tile.collide.vertex(loc[k + 1][0], f.y[k + 1] - STRIP_DROP, loc[k + 1][1], {}),
        tile.collide.vertex(o0[0], f.y[k] - 0.25, o0[1], {}),
        tile.collide.vertex(o1[0], f.y[k + 1] - 0.25, o1[1], {}),
      ];
      const ok = up(loc[k], loc[k + 1], o0);
      if (ok) { tile.collide.tri(v[0], v[1], v[2]); tile.collide.tri(v[1], v[3], v[2]); }
      else { tile.collide.tri(v[0], v[2], v[1]); tile.collide.tri(v[1], v[2], v[3]); }
    }
    // Terrain kept under the patch: spokes from the corner to the arc.
    if (carve) for (let k = 1; k < f.e.length; k++) carve.add(f.e[0], f.n[0], f.y[0], f.e[k], f.n[k], f.y[k], 1.2);
  }
}

/** Whether the triangle a, b, c (local x, z) faces up when wound in this order. */
const up = (a: [number, number], b: [number, number], c: [number, number]) => (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) > 0;

/** Whether a point (UTM) lies in a fillet, grown by `margin` metres. */
export function inFillet(f: Fillet, e: number, n: number, margin = 0): boolean {
  let inside = false;
  const m = f.e.length;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    if ((f.n[i] > n) !== (f.n[j] > n) && e < ((f.e[j] - f.e[i]) * (n - f.n[i])) / (f.n[j] - f.n[i]) + f.e[i]) inside = !inside;
  }
  if (margin === 0) return inside;
  let d = Infinity;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const dx = f.e[i] - f.e[j], dy = f.n[i] - f.n[j];
    const t = Math.max(0, Math.min(1, ((e - f.e[j]) * dx + (n - f.n[j]) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(f.e[j] + dx * t - e, f.n[j] + dy * t - n));
  }
  return margin > 0 ? inside || d <= margin : inside && d >= -margin;
}
