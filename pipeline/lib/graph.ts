import type { RoadGraphData, WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
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
  for (const w of roads) {
    const width = roadWidth(w.tags)!;
    w.ids.forEach((id, i) => {
      // A closed way touches its first node twice; count it once.
      if (i === w.ids.length - 1 && w.closed) return;
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
    const ys = roadSurfaceHeights(w, height);
    const name = w.tags.name ?? w.tags.ref ?? '';
    let n = -1;
    if (name) {
      if (!nameIdx.has(name)) { nameIdx.set(name, graph.names.length); graph.names.push(name); }
      n = nameIdx.get(name)!;
    }
    const c = ROAD_CLASSES[w.tags.highway].rank;
    const oneway = w.tags.oneway === 'yes' || w.tags.junction === 'roundabout';
    let start = 0;
    let p: number[] = [];
    for (let i = 0; i < w.ids.length; i++) {
      const [x, z] = utmToLocal(world, w.pts[i][0], w.pts[i][1]);
      p.push(r1(x), r1(ys[i]), r1(z));
      const split = i === w.ids.length - 1 || (i > 0 && (uses.get(w.ids[i]) ?? 0) > 1);
      if (i > start && split) {
        const a = node(w.ids[start], p[0], p[1], p[2]);
        const b = node(w.ids[i], p[p.length - 3], p[p.length - 2], p[p.length - 1]);
        if (a !== b || p.length > 6) graph.edges.push({ a, b, n, c, ...(oneway ? { o: 1 as const } : {}), p });
        start = i;
        p = [r1(x), r1(ys[i]), r1(z)];
      }
    }
  }

  const junctions: Junction[] = [];
  for (const w of roads)
    w.ids.forEach((id, i) => {
      if ((uses.get(id) ?? 0) > 1) {
        const [x, z] = utmToLocal(world, w.pts[i][0], w.pts[i][1]);
        junctions.push({ x, z, width: widest.get(id)! });
      }
    });
  return { graph, junctions };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
