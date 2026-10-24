import type { RoadGraphData } from '../../src/world/format.ts';

// Junctions with traffic lights from OSM highway=traffic_signals nodes. The lights are usually mapped at the stop
// lines around a junction, so nearby signal nodes are grouped and every graph junction close to a group gets it.

const GROUP_RADIUS = 45;
const NODE_RADIUS = 30;

/** Lights seen on street-level photos count only when a group has a mapped light, or photo lights at this many
 *  different spots (SPOT m apart): a junction has heads on several corners, a pedestrian crossing only two. */
const MIN_SPOTS = 3;
const SPOT = 6;

/** points: local x, z of the signal nodes, photos: lights detected on photos. Returns [graph node, group] pairs. */
export function signalJunctions(graph: RoadGraphData, mapped: [number, number][], photos: [number, number][] = []): [number, number][] {
  const points = [...mapped, ...photos];
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
  // Groups backed by OSM, or by photo lights on several corners.
  const support = new Array<number>(groups).fill(0);
  const spots: [number, number][][] = Array.from({ length: groups }, () => []);
  group.forEach((g, i) => {
    if (i < mapped.length) { support[g] = MIN_SPOTS; return; }
    const [x, z] = points[i];
    if (spots[g].some(([sx, sz]) => Math.hypot(sx - x, sz - z) < SPOT)) return;
    spots[g].push([x, z]);
    support[g] = Math.max(support[g], spots[g].length);
  });
  const degree = new Uint16Array(graph.nodes.length / 3);
  for (const e of graph.edges) { degree[e.a]++; degree[e.b]++; }
  const out: [number, number][] = [];
  for (let n = 0; n < degree.length; n++) {
    if (degree[n] < 3) continue;
    const x = graph.nodes[n * 3], z = graph.nodes[n * 3 + 2];
    let best = -1, bd = NODE_RADIUS;
    points.forEach(([px, pz], i) => {
      if (support[group[i]] < MIN_SPOTS) return;
      const d = Math.hypot(px - x, pz - z);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) out.push([n, group[best]]);
  }
  return out;
}
