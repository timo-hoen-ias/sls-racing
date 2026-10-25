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
const PIECE = (8 * Math.PI) / 180;

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
