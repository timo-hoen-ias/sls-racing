import type { RoadGraphData } from '../../src/world/format.ts';

// Junctions with traffic lights from OSM highway=traffic_signals nodes. The lights are usually mapped at the stop
// lines around a junction, so nearby signal nodes are grouped and every graph junction close to a group gets it.

const GROUP_RADIUS = 45;
const NODE_RADIUS = 30;

/** points: local x, z of the signal nodes. Returns [graph node, group] pairs. */
export function signalJunctions(graph: RoadGraphData, points: [number, number][]): [number, number][] {
  // Group signal nodes that are close together (single linkage).
  const group = points.map(() => -1);
  let groups = 0;
  for (let i = 0; i < points.length; i++) {
    if (group[i] >= 0) continue;
    const stack = [i];
    group[i] = groups;
    while (stack.length) {
      const k = stack.pop()!;
      for (let j = 0; j < points.length; j++) {
        if (group[j] >= 0) continue;
        if (Math.hypot(points[j][0] - points[k][0], points[j][1] - points[k][1]) < GROUP_RADIUS) { group[j] = groups; stack.push(j); }
      }
    }
    groups++;
  }
  const degree = new Uint16Array(graph.nodes.length / 3);
  for (const e of graph.edges) { degree[e.a]++; degree[e.b]++; }
  const out: [number, number][] = [];
  for (let n = 0; n < degree.length; n++) {
    if (degree[n] < 3) continue;
    const x = graph.nodes[n * 3], z = graph.nodes[n * 3 + 2];
    let best = -1, bd = NODE_RADIUS;
    points.forEach(([px, pz], i) => {
      const d = Math.hypot(px - x, pz - z);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) out.push([n, group[best]]);
  }
  return out;
}
