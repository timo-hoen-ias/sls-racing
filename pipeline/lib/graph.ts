import type { RoadGraphData, WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import type { OsmData, Way } from './osm.ts';
import { noCars, roadSection } from '../../src/world/roadSpec.ts';
import { isFieldWay } from '../../src/render/pbr/roadCode.ts';
import { ROAD_CLASSES, isDrivable, roadSurfaceHeights, roadWidth } from './roads.ts';

export interface Junction {
  x: number;
  z: number;
  /** Widest road meeting here, metres. */
  width: number;
}

/**
 * Splits drivable ways at shared nodes into a routable graph.
 * Also returns junction positions so sidewalks can stop short of crossings.
 */
export function buildGraph(ways: Way[], world: WorldInfo, height: (e: number, n: number) => number, osm: Pick<OsmData, 'restrictions' | 'busRoutes'> = {}): { graph: RoadGraphData; junctions: Junction[]; banned: number } {
  const roads = ways.filter((w) => isDrivable(w.tags));
  const uses = new Map<number, number>();
  const widest = new Map<number, number>();
  // Ramps moved onto their auxiliary lane (ramps.ts) keep their mapped nodes in the graph.
  const ids = (w: Way) => w.graph?.ids ?? w.ids;
  const pts = (w: Way) => w.graph?.pts ?? w.pts;
  for (const w of roads) {
    const width = roadWidth(w.tags)!;
    ids(w).forEach((id, i, all) => {
      // A closed way touches its first node twice; count it once.
      if (i === all.length - 1 && w.closed) return;
      uses.set(id, (uses.get(id) ?? 0) + 1);
      widest.set(id, Math.max(widest.get(id) ?? 0, width));
    });
  }

  const graph: RoadGraphData = { v: 1, names: [], nodes: [], edges: [] };
  /** OSM way of each graph edge, for the turn restrictions. */
  const edgeWay: number[] = [];
  const nameIdx = new Map<string, number>();
  const nodeIdx = new Map<number, number>();
  const node = (id: number, x: number, y: number, z: number) => {
    let i = nodeIdx.get(id);
    if (i === undefined) {
      i = graph.nodes.length / 3;
      graph.nodes.push(r1(x), r1(y), r1(z));
      nodeIdx.set(id, i);
    }
    return i;
  };

  for (const w of roads) {
    const surf = roadSurfaceHeights(w, height);
    const ys = w.graph ? w.graph.at.map((i) => surf[i]) : surf;
    const wids = ids(w), wpts = pts(w);
    const name = w.tags.name ?? w.tags.ref ?? '';
    let n = -1;
    if (name) {
      if (!nameIdx.has(name)) { nameIdx.set(name, graph.names.length); graph.names.push(name); }
      n = nameIdx.get(name)!;
    }
    const c = ROAD_CLASSES[w.tags.highway].rank;
    const oneway = w.tags.oneway === 'yes' || w.tags.junction === 'roundabout';
    const section = roadSection(w.tags)!;
    // Pavement sides (kerbs.ts): 1 right, 2 left of a → b.
    const k = w.sidewalks ? (w.sidewalks.right ? 1 : 0) | (w.sidewalks.left ? 2 : 0) : undefined;
    const dims = { w: r1(section.width), l: section.lanes, r: r1(section.rightLane), ...(k !== undefined ? { k } : {}), ...(noCars(w.tags) ? { x: 1 as const } : {}), ...(isFieldWay(w.tags) ? { f: 1 as const } : {}) };
    let start = 0;
    let p: number[] = [];
    for (let i = 0; i < wids.length; i++) {
      const [x, z] = utmToLocal(world, wpts[i][0], wpts[i][1]);
      p.push(r1(x), r1(ys[i]), r1(z));
      const split = i === wids.length - 1 || (i > 0 && (uses.get(wids[i]) ?? 0) > 1);
      if (i > start && split) {
        const a = node(wids[start], p[0], p[1], p[2]);
        const b = node(wids[i], p[p.length - 3], p[p.length - 2], p[p.length - 1]);
        if (a !== b || p.length > 6) {
          graph.edges.push({ a, b, n, c, ...(oneway ? { o: 1 as const } : {}), ...dims, p });
          edgeWay.push(w.id);
        }
        start = i;
        p = [r1(x), r1(ys[i]), r1(z)];
      }
    }
  }

  const junctions: Junction[] = [];
  for (const w of roads)
    ids(w).forEach((id, i) => {
      if ((uses.get(id) ?? 0) > 1) {
        const [x, z] = utmToLocal(world, pts(w)[i][0], pts(w)[i][1]);
        junctions.push({ x, z, width: widest.get(id)! });
      }
    });
  const t = turnBans(graph, edgeWay, nodeIdx, osm.restrictions);
  if (t.length) graph.t = t;
  const b = busLines(edgeWay, osm.busRoutes);
  if (b.length) graph.b = b;
  return { graph, junctions, banned: t.length / 3 };
}

/** Direction (local x, z) in which an edge leaves node v. */
function leaving(e: RoadGraphData['edges'][number], v: number): [number, number] {
  const p = e.p, n = p.length / 3;
  const fromA = e.a === v;
  const i0 = fromA ? 0 : n - 1;
  // A point some metres along the edge, so a short first segment does not decide the direction.
  let j = i0;
  for (let k = 1; k < n; k++) {
    j = fromA ? k : n - 1 - k;
    if (Math.hypot(p[j * 3] - p[i0 * 3], p[j * 3 + 2] - p[i0 * 3 + 2]) > 8) break;
  }
  const dx = p[j * 3] - p[i0 * 3], dz = p[j * 3 + 2] - p[i0 * 3 + 2];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Signed turn angle from edge f into edge t at node v: positive = right, as in the router's turn list. */
export function turnAngleAt(g: RoadGraphData, f: number, v: number, t: number): number {
  const [ix, iz] = leaving(g.edges[f], v);
  const [ox, oz] = leaving(g.edges[t], v);
  // Arriving along f means moving against its leaving direction.
  const d = Math.atan2(ox, oz) - Math.atan2(-ix, -iz);
  return -Math.atan2(Math.sin(d), Math.cos(d));
}

/** Whether a turn of this angle fits the restriction's kind (no_left_turn, only_straight_on …). */
function fitsKind(kind: string, angle: number, uTurn: boolean): boolean {
  if (/u_turn$/.test(kind)) return uTurn || Math.abs(angle) > 2.6;
  if (uTurn) return false;
  if (/left_turn$/.test(kind)) return angle < -0.35;
  if (/right_turn$/.test(kind)) return angle > 0.35;
  if (/straight_on$/.test(kind)) return Math.abs(angle) < 0.8;
  return true;
}

/**
 * Turn restrictions as banned edge pairs [from edge, via node, to edge, …]. The from and to ways often run on
 * through the via node (two edges each there); the turn direction the restriction names picks the right pair.
 */
function turnBans(g: RoadGraphData, edgeWay: number[], nodeIdx: Map<number, number>, restrictions: OsmData['restrictions']): number[] {
  if (!restrictions?.length) return [];
  const at = new Map<number, number[]>();
  g.edges.forEach((e, i) => {
    for (const v of e.a === e.b ? [e.a] : [e.a, e.b]) {
      if (!at.has(v)) at.set(v, []);
      at.get(v)!.push(i);
    }
  });
  const out = new Set<string>();
  for (const r of restrictions) {
    const v = nodeIdx.get(r.via);
    if (v === undefined) continue;
    const touching = at.get(v) ?? [];
    const from = touching.filter((e) => edgeWay[e] === r.from);
    const to = touching.filter((e) => edgeWay[e] === r.to);
    for (const f of from) {
      // A one-way from edge that leaves the node cannot be the approach.
      const fe = g.edges[f];
      if (fe.o && fe.a === v && fe.a !== fe.b) continue;
      const fits = to.filter((t) => fitsKind(r.kind, turnAngleAt(g, f, v, t), t === f));
      if (!fits.length) continue;
      if (r.only) { for (const x of touching) if (!fits.includes(x)) out.add(`${f},${v},${x}`); }
      else for (const t of fits) out.add(`${f},${v},${t}`);
    }
  }
  return [...out].flatMap((s) => s.split(',').map(Number));
}

/** Bus routes on the graph: the edges of their member ways, in member order; one entry per line number. */
function busLines(edgeWay: number[], routes: OsmData['busRoutes']): NonNullable<RoadGraphData['b']> {
  if (!routes?.length) return [];
  const byWay = new Map<number, number[]>();
  edgeWay.forEach((w, e) => {
    if (!byWay.has(w)) byWay.set(w, []);
    byWay.get(w)!.push(e);
  });
  // Both directions of a line are separate routes in OSM; they share the line number.
  const lines = new Map<string, { r: string; n: string; e: number[] }>();
  for (const r of routes) {
    const edges = r.ways.flatMap((w) => byWay.get(w) ?? []);
    if (!edges.length) continue;
    const key = r.ref || r.name;
    const line = lines.get(key) ?? { r: r.ref, n: r.name.replace(/:.*$/, '').trim(), e: [] };
    const seen = new Set(line.e);
    for (const e of edges) if (!seen.has(e)) { seen.add(e); line.e.push(e); }
    lines.set(key, line);
  }
  return [...lines.values()];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
