import type { RoadGraphData, WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
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
export function buildGraph(ways: Way[], world: WorldInfo, height: (e: number, n: number) => number): { graph: RoadGraphData; junctions: Junction[] } {
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
        if (a !== b || p.length > 6) graph.edges.push({ a, b, n, c, ...(oneway ? { o: 1 as const } : {}), ...dims, p });
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
  return { graph, junctions };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
