import { activeRoadProfile } from '../../src/world/roadSpec.ts';
import type { Way } from './osm.ts';
import { ROAD_CLASSES, isBridge, isMotorRoad } from './roads.ts';

// Rounded bends (S2, game road profile): OSM draws many streets as a few straight pieces with sharp kinks.
// Each kink of a road that no other way shares is replaced by a short circular arc, so the car turns in one
// flowing curve instead of three jerks. The arc stays within a metre of the mapped line in town (two in the
// country), which keeps it clear of the buildings; junction nodes, tagged nodes (signals, crossings, stop
// signs), bridges, tunnels and motorways keep their mapped geometry.

/** Arc radius by road class rank (m). */
const RADIUS = (rank: number) => (rank >= 7 ? 120 : rank >= 5 ? 60 : rank >= 3 ? 30 : 15);
/** How far the arc may leave the mapped line at the kink (m). */
const DEVIATION = { town: 1, country: 2 };
/** Kinks below this turn are left alone. */
const MIN_TURN = (10 * Math.PI) / 180;
/** One arc piece per this much turn. */
const PIECE = (3 * Math.PI) / 180;
/**
 * Curves drawn as many short straight pieces (most OSM bends) get a spline through their nodes, cut so no
 * piece turns more than this against the next (radians); `SPLINE_MIN` (m) is the shortest piece.
 */
export const SPLINE = { turn: (3 * Math.PI) / 180, min: 0.75 };

let synthetic = 0;

/**
 * Smooths the kinks of drivable ways in place, before anything else reads their geometry. Returns the
 * number of kinks rounded. `keep` holds node ids that must stay where they are.
 */
export function smoothBends(ways: Way[], keep: Set<number>): number {
  if (activeRoadProfile() !== 'game') return 0;
  const uses = new Map<number, number>();
  for (const w of ways) if (w.tags.highway) for (const id of new Set(w.ids)) uses.set(id, (uses.get(id) ?? 0) + 1);
  let rounded = 0;
  for (const w of ways) {
    if (!isMotorRoad(w.tags) || isBridge(w.tags) || w.tags.tunnel || w.closed || w.pts.length < 3) continue;
    const rank = ROAD_CLASSES[w.tags.highway]?.rank ?? 9;
    if (rank >= 8 || w.tags.highway.endsWith('_link')) continue;
    const maxDev = w.urban === false ? DEVIATION.country : DEVIATION.town;
    const pts: [number, number][] = [w.pts[0]];
    const ids: number[] = [w.ids[0]];
    for (let i = 1; i < w.pts.length - 1; i++) {
      const arc = (uses.get(w.ids[i]) ?? 0) === 1 && !keep.has(w.ids[i]) ? bend(w.pts[i - 1], w.pts[i], w.pts[i + 1], RADIUS(rank), maxDev) : undefined;
      if (!arc) { pts.push(w.pts[i]); ids.push(w.ids[i]); continue; }
      rounded++;
      // The kink's own id stays on the arc's middle point; the others are new nodes no other way uses.
      const mid = Math.floor(arc.length / 2);
      arc.forEach((p, k) => { pts.push(p); ids.push(k === mid ? w.ids[i] : -(++synthetic)); });
    }
    pts.push(w.pts[w.pts.length - 1]);
    ids.push(w.ids[w.ids.length - 1]);
    w.pts = pts;
    w.ids = ids;
  }
  return rounded;
}

/** What splineCurves did: ways and pieces added, for the build log and index.json. */
export interface SplineStats { ways: number; points: number }

/**
 * Round curves: every drivable way that smoothBends would touch (and roundabouts) gets a centripetal
 * Catmull-Rom spline through its nodes, so a bend drawn as a few straight pieces becomes an even curve
 * with a piece every SPLINE.turn of turning. Nodes stay where they are (junctions keep meeting exactly);
 * between them the curve keeps within the arc deviation of the mapped line. Game road profile only.
 */
export function splineCurves(ways: Way[]): SplineStats {
  const stats: SplineStats = { ways: 0, points: 0 };
  if (activeRoadProfile() !== 'game') return stats;
  for (const w of ways) {
    const roundabout = w.closed && w.tags.junction === 'roundabout';
    if (!isMotorRoad(w.tags) || isBridge(w.tags) || w.tags.tunnel || (w.closed && !roundabout) || w.pts.length < 3) continue;
    const rank = ROAD_CLASSES[w.tags.highway]?.rank ?? 9;
    if (rank >= 8 || w.tags.highway.endsWith('_link')) continue;
    const maxDev = w.urban === false ? DEVIATION.country : DEVIATION.town;
    const n = w.pts.length;
    const at = (i: number): [number, number] => {
      if (roundabout) return w.pts[((i % (n - 1)) + (n - 1)) % (n - 1)];
      if (i < 0) return [2 * w.pts[0][0] - w.pts[1][0], 2 * w.pts[0][1] - w.pts[1][1]];
      if (i >= n) return [2 * w.pts[n - 1][0] - w.pts[n - 2][0], 2 * w.pts[n - 1][1] - w.pts[n - 2][1]];
      return w.pts[i];
    };
    const pts: [number, number][] = [w.pts[0]];
    const ids: number[] = [w.ids[0]];
    let added = 0;
    for (let i = 0; i < n - 1; i++) {
      const piece = splinePiece(at(i - 1), w.pts[i], w.pts[i + 1], at(i + 2), maxDev);
      for (const p of piece) { pts.push(p); ids.push(-(++synthetic)); }
      added += piece.length;
      pts.push(w.pts[i + 1]);
      ids.push(w.ids[i + 1]);
    }
    if (!added) continue;
    w.pts = pts;
    w.ids = ids;
    stats.ways++;
    stats.points += added;
  }
  return stats;
}

/** Inner points of the spline piece from p1 to p2 (without either end); none where the piece is straight. */
export function splinePiece(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], maxDev: number): [number, number][] {
  const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (len < 2 * SPLINE.min) return [];
  // Turn of the piece: between the tangent directions at its ends.
  const dir = (a: [number, number], b: [number, number]) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
  const turn = Math.max(Math.abs(wrap(dir(p0, p2) - dir(p1, p2))), Math.abs(wrap(dir(p1, p3) - dir(p1, p2)))) * 2;
  // Very sharp corners are not curves: the arc pass (bend) handles them, or they stay corners.
  if (turn < SPLINE.turn || turn > (150 * Math.PI) / 180) return [];
  const steps = Math.min(Math.ceil(turn / SPLINE.turn), Math.floor(len / SPLINE.min));
  if (steps < 2) return [];
  // Centripetal Catmull-Rom (alpha 0.5): no cusps or loops however uneven the node spacing.
  const t = (a: [number, number], b: [number, number]) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-6;
  const t0 = 0, t1 = t0 + t(p0, p1), t2 = t1 + t(p1, p2), t3 = t2 + t(p2, p3);
  const lerp = (a: [number, number], b: [number, number], ta: number, tb: number, x: number): [number, number] => {
    const k = (x - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  const out: [number, number][] = [];
  let dev = 0;
  for (let k = 1; k < steps; k++) {
    const x = t1 + ((t2 - t1) * k) / steps;
    const a1 = lerp(p0, p1, t0, t1, x), a2 = lerp(p1, p2, t1, t2, x), a3 = lerp(p2, p3, t2, t3, x);
    const b1 = lerp(a1, a2, t0, t2, x), b2 = lerp(a2, a3, t1, t3, x);
    const c = lerp(b1, b2, t1, t2, x);
    out.push(c);
    // Distance from the straight piece.
    const ux = (p2[0] - p1[0]) / len, uy = (p2[1] - p1[1]) / len;
    dev = Math.max(dev, Math.abs((c[0] - p1[0]) * uy - (c[1] - p1[1]) * ux));
  }
  // Keep within maxDev of the mapped line: shrink the bulge towards the straight piece.
  if (dev > maxDev) {
    const f = maxDev / dev;
    out.forEach((c, k) => {
      const s = (k + 1) / steps;
      const l: [number, number] = [p1[0] + (p2[0] - p1[0]) * s, p1[1] + (p2[1] - p1[1]) * s];
      out[k] = [l[0] + (c[0] - l[0]) * f, l[1] + (c[1] - l[1]) * f];
    });
  }
  return out;
}

/** Arc replacing the kink at b between a and c, or undefined where it is too slight or too cramped. */
export function bend(a: [number, number], b: [number, number], c: [number, number], radius: number, maxDev: number): [number, number][] | undefined {
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  if (l1 < 2 || l2 < 2) return undefined;
  const u = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1], v = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
  const turn = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  if (turn < MIN_TURN || turn > (120 * Math.PI) / 180) return undefined;
  const half = turn / 2;
  // Distance from the kink to the arc's middle: R (1 / cos(half) - 1).
  let R = Math.min(radius, maxDev / (1 / Math.cos(half) - 1));
  // Tangent points within the inner 45 % of both pieces, so neighbouring arcs never overlap.
  const t = Math.min(R * Math.tan(half), 0.45 * l1, 0.45 * l2);
  R = t / Math.tan(half);
  if (t < 1) return undefined;
  const p1 = [b[0] - u[0] * t, b[1] - u[1] * t];
  // Centre: perpendicular to the first piece, on the inside of the turn.
  const side = Math.sign(u[0] * v[1] - u[1] * v[0]);
  const C = [p1[0] - u[1] * R * side, p1[1] + u[0] * R * side];
  const a0 = Math.atan2(p1[1] - C[1], p1[0] - C[0]);
  const n = Math.max(2, Math.ceil(turn / PIECE));
  const out: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const ang = a0 + side * turn * (k / n);
    out.push([C[0] + Math.cos(ang) * R, C[1] + Math.sin(ang) * R]);
  }
  return out;
}
