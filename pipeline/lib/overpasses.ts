// Grade separation. The terrain model (SRTM/EU-DEM, ~30 m) smooths away embankments, so a bridge that
// carries one road over another often ends up only centimetres above the lower road, and its deck
// becomes a wall across it. This lifts the upper road (the bridge and its approaches) until there is
// headroom, ramping the lift down along the connected road network. Lifted roads get their own
// collision, so the car drives on them rather than on the terrain below.
import type { Way } from './osm.ts';
import { densify, isBridge, isDrivable, roadSurfaceHeights } from './roads.ts';

/** Headroom between the lower road and the upper deck. */
export const CLEARANCE = 4.8;
/** Gradient of the approach ramps. */
const GRADE = 0.06;

const level = (t: Record<string, string>) => {
  const l = parseInt(t.layer);
  return Number.isFinite(l) ? l : isBridge(t) ? 1 : 0;
};

/** Where segment ab crosses segment cd: [t along ab, u along cd], or undefined. */
function cross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | undefined {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return undefined;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : undefined;
}

/** Height along a way at segment i, fraction t, from per-node heights. */
const at = (ys: number[], i: number, t: number) => ys[i] + (ys[i + 1] - ys[i]) * t;

/** Max-heap of [value, node]. */
class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(v: [number, number]) {
    const a = this.a;
    a.push(v);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] >= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] > a[m][0]) m = l;
        if (r < a.length && a[r][0] > a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface OverpassReport {
  /** Road crossings without a junction where one road passes over the other. */
  crossings: number;
  /** Of those, how many needed a lift. */
  lifted: number;
  /** Smallest headroom left after lifting (m), for the log. */
  minClearance: number;
}

/**
 * Sets `way.raise` (metres per node) on upper roads so every grade-separated crossing has CLEARANCE
 * of headroom. Lower roads at a crossing are pinned so the lift never spreads onto them.
 */
export function liftOverpasses(ways: Way[], height: (e: number, n: number) => number): OverpassReport {
  const roads = ways.filter((w) => isDrivable(w.tags));
  const base = new Map(roads.map((w) => [w, roadSurfaceHeights(w, height)]));

  // Segment grid for crossing tests.
  const CELL = 64;
  const grid = new Map<string, [Way, number][]>();
  for (const w of roads)
    for (let i = 1; i < w.pts.length; i++) {
      const [a, b] = [w.pts[i - 1], w.pts[i]];
      const seen = new Set<string>();
      for (const [e, n] of densify([a, b], CELL / 2)) {
        const k = `${Math.floor(e / CELL)}_${Math.floor(n / CELL)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push([w, i - 1]);
      }
    }

  // Every crossing of two roads that do not share a node there.
  const crossings: { a: Way; i: number; t: number; b: Way; j: number; u: number }[] = [];
  const done = new Set<string>();
  for (const cell of grid.values())
    for (let p = 0; p < cell.length; p++)
      for (let q = p + 1; q < cell.length; q++) {
        const [[a, i], [b, j]] = [cell[p], cell[q]];
        if (a === b) continue;
        const key = a.id < b.id ? `${a.id}:${i}:${b.id}:${j}` : `${b.id}:${j}:${a.id}:${i}`;
        if (done.has(key)) continue;
        done.add(key);
        if ([a.ids[i], a.ids[i + 1]].some((n) => n === b.ids[j] || n === b.ids[j + 1])) continue;
        const x = cross(a.pts[i], a.pts[i + 1], b.pts[j], b.pts[j + 1]);
        if (x) crossings.push({ a, i, t: x[0], b, j, u: x[1] });
      }

  const need = new Map<number, number>(); // node id → lift
  const pinned = new Set<number>();
  const found: { upper: Way; i: number; t: number; lower: Way; j: number; u: number }[] = [];
  const separate = (upper: Way, i: number, t: number, lower: Way, j: number, u: number) => {
    found.push({ upper, i, t, lower, j, u });
    pinned.add(lower.ids[j]);
    pinned.add(lower.ids[j + 1]);
    const lift = CLEARANCE - (at(base.get(upper)!, i, t) - at(base.get(lower)!, j, u));
    if (lift > 0) for (const n of [upper.ids[i], upper.ids[i + 1]]) need.set(n, Math.max(need.get(n) ?? 0, lift));
  };
  const level0: typeof crossings = [];
  for (const c of crossings) {
    const [la, lb] = [level(c.a.tags), level(c.b.tags)];
    if (la > lb) separate(c.a, c.i, c.t, c.b, c.j, c.u);
    else if (lb > la) separate(c.b, c.j, c.u, c.a, c.i, c.t);
    else level0.push(c);
  }

  // Spread the lift over the road network, losing GRADE metres per metre of road.
  const adj = new Map<number, [number, number][]>();
  for (const w of roads)
    for (let i = 1; i < w.ids.length; i++) {
      const d = Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
      for (const [a, b] of [[w.ids[i - 1], w.ids[i]], [w.ids[i], w.ids[i - 1]]]) {
        if (!adj.has(a)) adj.set(a, []);
        adj.get(a)!.push([b, d]);
      }
    }
  let lift = new Map<number, number>();
  const spread = () => {
    lift = new Map();
    const heap = new Heap();
    for (const [n, v] of need) heap.push([v, n]);
    while (heap.size) {
      const [v, n] = heap.pop();
      if ((lift.get(n) ?? 0) >= v) continue;
      lift.set(n, v);
      for (const [m, d] of adj.get(n) ?? []) {
        const vm = v - GRADE * d;
        if (vm > 0 && !pinned.has(m) && (lift.get(m) ?? 0) < vm) heap.push([vm, m]);
      }
    }
  };
  const liftAt = (w: Way, i: number, t: number) => (lift.get(w.ids[i]) ?? 0) * (1 - t) + (lift.get(w.ids[i + 1]) ?? 0) * t;

  // A ramp can run into a road that crosses it without a junction. A ramp already half way up becomes
  // an overpass there; a lower one stops at the crossing. Repeat until nothing changes.
  for (let round = 0; round < 6; round++) {
    spread();
    let changed = false;
    for (const c of level0) {
      const ra = liftAt(c.a, c.i, c.t), rb = liftAt(c.b, c.j, c.u);
      if (Math.abs(ra - rb) < 0.3 || (found.some((f) => f.upper === c.a && f.lower === c.b) || found.some((f) => f.upper === c.b && f.lower === c.a))) continue;
      const [hi, i, t, lo, j, u, r] = ra > rb ? [c.a, c.i, c.t, c.b, c.j, c.u, ra] as const : [c.b, c.j, c.u, c.a, c.i, c.t, rb] as const;
      if (r >= CLEARANCE / 2) separate(hi, i, t, lo, j, u);
      else for (const n of [hi.ids[i], hi.ids[i + 1]]) { pinned.add(n); need.delete(n); }
      changed = true;
    }
    if (!changed) break;
  }

  for (const w of roads) {
    const r = w.ids.map((n) => lift.get(n) ?? 0);
    if (r.some((v) => v > 0)) w.raise = r;
  }

  let minClearance = Infinity;
  for (const c of found) {
    const ru = c.upper.raise ? at(c.upper.raise, c.i, c.t) : 0;
    const rl = c.lower.raise ? at(c.lower.raise, c.j, c.u) : 0;
    minClearance = Math.min(minClearance, at(base.get(c.upper)!, c.i, c.t) + ru - at(base.get(c.lower)!, c.j, c.u) - rl);
  }
  return { crossings: found.length, lifted: need.size ? new Set(found.filter((c) => need.has(c.upper.ids[c.i])).map((c) => c.upper.id)).size : 0, minClearance };
}
