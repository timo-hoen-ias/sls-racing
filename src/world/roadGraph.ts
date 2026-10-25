import type { RoadGraphData } from './format.ts';
import { PATH_KINDS, type PathKind } from './roadSpec.ts';

export interface Edge {
  id: number;
  a: number;
  b: number;
  name: string;
  rank: number;
  oneway: boolean;
  /** Carriageway width (m). */
  width: number;
  /** Lanes (total on two-way roads); 0 when the graph predates it. */
  lanes: number;
  /** Centre of the rightmost lane, metres right of the centreline (a → b on one-way roads). */
  rightLane: number;
  /** Pavement sides: bit 1 right, bit 2 left of a → b; -1 when the graph predates it. */
  kerb: number;
  /** Closed to cars (pedestrian zone, access tags): routing and traffic leave it out. */
  noCars: boolean;
  /** Polyline x, y, z. */
  p: Float32Array;
  /** Cumulative length at each polyline point. */
  cum: Float32Array;
  length: number;
}

/** Footpath, cycle path or steps: drawn beside the network, never part of it. */
export interface PathLine {
  id: number;
  kind: PathKind;
  width: number;
  /** Surface (SURFACE in render/pbr/roadCode.ts). */
  surface: number;
  /** Polyline x, y, z. */
  p: Float32Array;
  length: number;
}

export interface Snap {
  edge: Edge;
  /** Distance along the edge from node a. */
  along: number;
  x: number;
  y: number;
  z: number;
  dist: number;
  /** Direction of the edge at the snap point (a → b), unit x/z. */
  dx: number;
  dz: number;
}

export interface Route {
  /** Polyline x, y, z from start to destination. */
  pts: Float32Array;
  cum: Float32Array;
  length: number;
  /** Turns at junctions: distance along the route, signed angle (positive = right), street after the turn. */
  turns: { at: number; angle: number; street: string }[];
  /** Street name per polyline point index range: [startIndex, name]. */
  streets: [number, string][];
}

const CELL = 50;
/** Carriageway width per rank for graphs built before edges carried their width. */
const RANK_WIDTH = [3, 4, 5, 6, 5.5, 7, 7.5, 8.5, 10, 11];

/** Road network for street names, the minimap and GPS routing. */
export class RoadGraph {
  readonly edges: Edge[] = [];
  readonly nodes: Float32Array;
  /** Per node: [edge id, node at the other end]. */
  readonly adj: [edge: number, other: number][][];
  private grid = new Map<number, number[]>(); // cell → [edge, segment, edge, segment, …]
  /** Junctions with traffic lights: [node, group]. */
  readonly signals: [number, number][];
  readonly paths: PathLine[] = [];
  private pathGrid = new Map<number, number[]>(); // cell → [path, segment, …]
  bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };

  constructor(data: RoadGraphData) {
    this.nodes = Float32Array.from(data.nodes);
    this.signals = data.s ?? [];
    this.adj = Array.from({ length: data.nodes.length / 3 }, () => []);
    data.edges.forEach((e, id) => {
      const p = Float32Array.from(e.p);
      const cum = new Float32Array(p.length / 3);
      for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 2] - p[i * 3 - 1]);
      const width = e.w ?? RANK_WIDTH[e.c] ?? 6;
      const rightLane = e.r ?? (e.o && e.c < 8 ? 0 : width / 4);
      const edge: Edge = { id, a: e.a, b: e.b, name: e.n >= 0 ? data.names[e.n] : '', rank: e.c, oneway: !!e.o, width, lanes: e.l ?? 0, rightLane, kerb: e.k ?? -1, noCars: !!e.x, p, cum, length: cum[cum.length - 1] };
      this.edges.push(edge);
      this.adj[e.a].push([id, e.b]);
      this.adj[e.b].push([id, e.a]);
      for (let i = 0; i < cum.length - 1; i++) {
        const x0 = p[i * 3], z0 = p[i * 3 + 2], x1 = p[i * 3 + 3], z1 = p[i * 3 + 5];
        for (let cx = Math.floor(Math.min(x0, x1) / CELL); cx <= Math.floor(Math.max(x0, x1) / CELL); cx++)
          for (let cz = Math.floor(Math.min(z0, z1) / CELL); cz <= Math.floor(Math.max(z0, z1) / CELL); cz++) {
            const k = key(cx, cz);
            let list = this.grid.get(k);
            if (!list) this.grid.set(k, (list = []));
            list.push(id, i);
          }
        const b = this.bounds;
        b.minX = Math.min(b.minX, x0, x1); b.maxX = Math.max(b.maxX, x0, x1);
        b.minZ = Math.min(b.minZ, z0, z1); b.maxZ = Math.max(b.maxZ, z0, z1);
      }
    });
    (data.w ?? []).forEach((w, id) => {
      const p = Float32Array.from(w.p);
      let length = 0;
      for (let i = 0; i + 1 < p.length / 3; i++) {
        const x0 = p[i * 3], z0 = p[i * 3 + 2], x1 = p[i * 3 + 3], z1 = p[i * 3 + 5];
        length += Math.hypot(x1 - x0, z1 - z0);
        for (let cx = Math.floor(Math.min(x0, x1) / CELL); cx <= Math.floor(Math.max(x0, x1) / CELL); cx++)
          for (let cz = Math.floor(Math.min(z0, z1) / CELL); cz <= Math.floor(Math.max(z0, z1) / CELL); cz++) {
            const k = key(cx, cz);
            let list = this.pathGrid.get(k);
            if (!list) this.pathGrid.set(k, (list = []));
            list.push(id, i);
          }
      }
      this.paths.push({ id, kind: PATH_KINDS[w.k] ?? 'path', width: w.w, surface: w.s ?? 0, p, length });
    });
  }

  /** Closest path within maxDist (any distance to its centreline), or undefined. */
  pathNear(x: number, z: number, maxDist = 30): { path: PathLine; dist: number; x: number; y: number; z: number } | undefined {
    let best: { path: PathLine; dist: number; x: number; y: number; z: number } | undefined;
    const r = Math.ceil(maxDist / CELL);
    const cx0 = Math.floor(x / CELL), cz0 = Math.floor(z / CELL);
    for (let cx = cx0 - r; cx <= cx0 + r; cx++)
      for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
        const list = this.pathGrid.get(key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const path = this.paths[list[i]], p = path.p, s = list[i + 1];
          const ax = p[s * 3], az = p[s * 3 + 2], dx = p[s * 3 + 3] - ax, dz = p[s * 3 + 5] - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
          const px = ax + dx * t, pz = az + dz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < maxDist && (!best || d < best.dist)) best = { path, dist: d, x: px, y: p[s * 3 + 1] + (p[s * 3 + 4] - p[s * 3 + 1]) * t, z: pz };
        }
      }
    return best;
  }

  /** Paths with at least one segment in the square around (x, z). Calls fn once per path. */
  forEachPathNear(x: number, z: number, radius: number, fn: (p: PathLine) => void) {
    const seen = new Set<number>();
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++)
      for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
        const list = this.pathGrid.get(key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          if (seen.has(list[i])) continue;
          seen.add(list[i]);
          fn(this.paths[list[i]]);
        }
      }
  }

  /** Edges with at least one segment in the square around (x, z). Calls fn once per edge. */
  forEachEdgeNear(x: number, z: number, radius: number, fn: (e: Edge) => void) {
    const seen = new Set<number>();
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++)
      for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
        const list = this.grid.get(key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          if (seen.has(list[i])) continue;
          seen.add(list[i]);
          fn(this.edges[list[i]]);
        }
      }
  }

  /** Closest point on the network (on edges that pass accept), or undefined when nothing is within maxDist. */
  snap(x: number, z: number, maxDist = 60, accept?: (e: Edge) => boolean): Snap | undefined {
    let best: Snap | undefined;
    const r = Math.ceil(maxDist / CELL);
    const cx0 = Math.floor(x / CELL), cz0 = Math.floor(z / CELL);
    for (let cx = cx0 - r; cx <= cx0 + r; cx++)
      for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
        const list = this.grid.get(key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const e = this.edges[list[i]];
          if (accept && !accept(e)) continue;
          const s = list[i + 1];
          const p = e.p;
          const ax = p[s * 3], ay = p[s * 3 + 1], az = p[s * 3 + 2];
          const bx = p[s * 3 + 3], by = p[s * 3 + 4], bz = p[s * 3 + 5];
          const dx = bx - ax, dz = bz - az;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const px = ax + dx * t, pz = az + dz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < maxDist && (!best || d < best.dist)) {
            const l = Math.sqrt(l2);
            best = { edge: e, along: e.cum[s] + l * t, x: px, y: ay + (by - ay) * t, z: pz, dist: d, dx: dx / l, dz: dz / l };
          }
        }
      }
    return best;
  }

  /** Shortest route by distance between two points on the network (A*). One-way streets are ignored: this is arcade.
   *  Roads closed to cars are only used where the route starts or ends on one. */
  route(from: Snap, to: Snap): Route | undefined {
    const N = this.adj.length;
    const S = N, G = N + 1; // virtual start and goal nodes
    const nx = (n: number) => (n === S ? from.x : n === G ? to.x : this.nodes[n * 3]);
    const nz = (n: number) => (n === S ? from.z : n === G ? to.z : this.nodes[n * 3 + 2]);
    const h = (n: number) => Math.hypot(nx(n) - to.x, nz(n) - to.z);
    const neighbours = (n: number): [number, number, number][] => {
      // [node, cost, edge] where edge = -1 for direct start→goal on the same edge
      const out: [number, number, number][] = [];
      if (n === S) {
        out.push([from.edge.a, from.along, from.edge.id], [from.edge.b, from.edge.length - from.along, from.edge.id]);
        if (from.edge === to.edge) out.push([G, Math.abs(to.along - from.along), -1]);
        return out;
      }
      for (const [e, o] of this.adj[n]) if (!this.edges[e].noCars) out.push([o, this.edges[e].length, e]);
      if (n === to.edge.a) out.push([G, to.along, to.edge.id]);
      if (n === to.edge.b) out.push([G, to.edge.length - to.along, to.edge.id]);
      return out;
    };
    const g = new Map<number, number>([[S, 0]]);
    const prev = new Map<number, [number, number]>(); // node → [previous node, via edge]
    const open = new Heap();
    open.push(S, h(S));
    const closed = new Set<number>();
    while (open.size) {
      const n = open.pop()!;
      if (n === G) break;
      if (closed.has(n)) continue;
      closed.add(n);
      for (const [m, cost, e] of neighbours(n)) {
        const c = g.get(n)! + cost;
        if (c < (g.get(m) ?? Infinity)) {
          g.set(m, c);
          prev.set(m, [n, e]);
          open.push(m, c + h(m));
        }
      }
    }
    if (!prev.has(G)) return undefined;

    // Walk back and stitch the polyline.
    const hops: [number, number, number][] = []; // [from node, to node, edge]
    for (let n = G; n !== S; ) {
      const [p, e] = prev.get(n)!;
      hops.unshift([p, n, e]);
      n = p;
    }
    const pts: number[] = [];
    const streets: [number, string][] = [];
    const junctionIdx: number[] = [];
    const push = (x: number, y: number, z: number) => {
      const l = pts.length;
      if (l && Math.abs(pts[l - 3] - x) < 0.05 && Math.abs(pts[l - 1] - z) < 0.05) return;
      pts.push(x, y, z);
    };
    for (const [a, b, e] of hops) {
      const edge = e >= 0 ? this.edges[e] : from.edge;
      const startAlong = a === S ? from.along : a === edge.a ? 0 : edge.length;
      const endAlong = b === G ? to.along : b === edge.a ? 0 : edge.length;
      if (a !== S) junctionIdx.push(pts.length / 3 - 1);
      streets.push([Math.max(0, pts.length / 3 - 1), edge.name]);
      for (const q of slice(edge, startAlong, endAlong)) push(q[0], q[1], q[2]);
    }
    const P = Float32Array.from(pts);
    const cum = new Float32Array(P.length / 3);
    for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 2] - P[i * 3 - 1]);

    // Turn instructions at junctions where the direction changes noticeably.
    const turns: Route['turns'] = [];
    for (let k = 0; k < junctionIdx.length; k++) {
      const i = junctionIdx[k];
      const before = pointAt(P, cum, cum[i] - 12);
      const at = pointAt(P, cum, cum[i]);
      const after = pointAt(P, cum, cum[i] + 12);
      const a1 = Math.atan2(at[0] - before[0], at[2] - before[2]);
      const a2 = Math.atan2(after[0] - at[0], after[2] - at[2]);
      let d = a2 - a1;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      // In the local frame (x east, z south) a clockwise turn seen from above is negative in atan2(x, z).
      const angle = -d;
      // Ignore the junction right at the start: the car may be a few metres past it.
      if (Math.abs(angle) > 0.5 && cum[i] > 15) turns.push({ at: cum[i], angle, street: streets[k + 1]?.[1] ?? '' });
    }
    return { pts: P, cum, length: cum[cum.length - 1], turns, streets };
  }
}

/** Points of an edge between two distances along it, in travel order. */
function slice(e: Edge, from: number, to: number): [number, number, number][] {
  const out: [number, number, number][] = [pointAt(e.p, e.cum, from)];
  const n = e.cum.length;
  if (from < to) { for (let i = 0; i < n; i++) if (e.cum[i] > from && e.cum[i] < to) out.push([e.p[i * 3], e.p[i * 3 + 1], e.p[i * 3 + 2]]); }
  else for (let i = n - 1; i >= 0; i--) if (e.cum[i] < from && e.cum[i] > to) out.push([e.p[i * 3], e.p[i * 3 + 1], e.p[i * 3 + 2]]);
  out.push(pointAt(e.p, e.cum, to));
  return out;
}

export function pointAt(p: Float32Array, cum: Float32Array, d: number): [number, number, number] {
  const n = cum.length;
  if (d <= 0) return [p[0], p[1], p[2]];
  if (d >= cum[n - 1]) return [p[n * 3 - 3], p[n * 3 - 2], p[n * 3 - 1]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [p[lo * 3] + (p[hi * 3] - p[lo * 3]) * t, p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * t, p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * t];
}

/** Projects a point onto a polyline, searching near a previous distance first. */
export function project(p: Float32Array, cum: Float32Array, x: number, z: number): { along: number; dist: number } {
  let best = { along: 0, dist: Infinity };
  for (let i = 0; i < cum.length - 1; i++) {
    const ax = p[i * 3], az = p[i * 3 + 2], dx = p[i * 3 + 3] - ax, dz = p[i * 3 + 5] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best.dist) best = { along: cum[i] + Math.sqrt(l2) * t, dist: d };
  }
  return best;
}

const key = (cx: number, cz: number) => cx * 100003 + cz;

class Heap {
  private items: number[] = [];
  private prio: number[] = [];
  get size() { return this.items.length; }
  push(item: number, p: number) {
    this.items.push(item);
    this.prio.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop() {
    const top = this.items[0];
    const lastI = this.items.pop()!;
    const lastP = this.prio.pop()!;
    if (this.items.length) {
      this.items[0] = lastI;
      this.prio[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}
