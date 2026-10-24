import type { Edge, RoadGraph } from '../world/roadGraph.ts';

// Traffic light phases. Every signalised junction switches between two directions: the main axis (along its
// biggest road) and the cross axis, each with green, yellow and an all-red gap. Junction nodes of one group
// (a large junction mapped as several nodes) share their phases.

export type Light = 'green' | 'yellow' | 'red' | 'redyellow';

const YELLOW = 3;
const ALL_RED = 2;
const RED_YELLOW = 1.5;

interface SignalNode {
  node: number;
  group: number;
  /** Main axis, unit vector. */
  ax: number;
  az: number;
  offset: number;
}

export class Signals {
  enabled = true;
  /** Full cycle in seconds (both directions). */
  cycle = 56;
  /** Forces all lights (debug): undefined = normal operation. */
  forced?: Light;
  time = 0;
  readonly nodes = new Map<number, SignalNode>();

  constructor(graph: RoadGraph) {
    const axes = new Map<number, [number, number, number]>(); // group → axis x, z and the rank it came from
    const at = new Map<number, Edge[]>();
    for (const e of graph.edges) {
      for (const n of [e.a, e.b]) {
        if (!at.has(n)) at.set(n, []);
        at.get(n)!.push(e);
      }
    }
    for (const [node, group] of graph.signals) {
      for (const e of at.get(node) ?? []) {
        const best = axes.get(group);
        if (best && best[2] >= e.rank) continue;
        const [dx, dz] = edgeDir(e, node);
        axes.set(group, [dx, dz, e.rank]);
      }
    }
    for (const [node, group] of graph.signals) {
      const [ax, az] = axes.get(group) ?? [1, 0];
      this.nodes.set(node, { node, group, ax, az, offset: fract(Math.sin(group * 12.9898) * 43758.5453) * 200 });
    }
  }

  update(dt: number) {
    this.time += dt;
  }

  has(node: number) {
    return this.enabled && this.nodes.has(node);
  }

  /** Light shown to traffic arriving at node while travelling in direction (dx, dz); undefined without lights. */
  light(node: number, dx: number, dz: number): Light | undefined {
    if (!this.enabled) return undefined;
    const s = this.nodes.get(node);
    if (!s) return undefined;
    if (this.forced) return this.forced;
    const main = Math.abs(dx * s.ax + dz * s.az) > Math.SQRT1_2;
    return this.phase(s, main);
  }

  /** Light of one axis of a junction at the current time. */
  phase(s: SignalNode, main: boolean): Light {
    const half = this.cycle / 2;
    const green = half - YELLOW - ALL_RED;
    let t = (this.time + s.offset + (main ? 0 : half)) % this.cycle;
    if (t < green) return 'green';
    t -= green;
    if (t < YELLOW) return 'yellow';
    // Red for the rest of the cycle, red and yellow just before green.
    return t > this.cycle - green - RED_YELLOW ? 'redyellow' : 'red';
  }
}

/** Direction pointing away from node along the edge. */
export function edgeDir(e: Edge, node: number): [number, number] {
  const p = e.p, k = p.length / 3;
  const [i, j] = e.a === node ? [0, Math.min(2, k - 1)] : [k - 1, Math.max(0, k - 3)];
  const dx = p[j * 3] - p[i * 3], dz = p[j * 3 + 2] - p[i * 3 + 2];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

const fract = (v: number) => v - Math.floor(v);
