import { describe, expect, it } from 'vitest';
import { turnAngleAt } from '../pipeline/lib/graph.ts';
import type { RoadGraphData } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';

// A crossroads (local x east, z south): centre C, arms to the south, north, east and west, 100 m each,
// and a ring road joining the ends of the north and east arms so there is a way round.
const C = 0, N = 1, S = 2, E = 3, W = 4;
const nodes = [0, 0, 0, 0, 0, -100, 0, 0, 100, 100, 0, 0, -100, 0, 0];
const edge = (a: number, b: number) => ({ a, b, n: -1, c: 3, w: 6, p: [nodes[a * 3], 0, nodes[a * 3 + 2], nodes[b * 3], 0, nodes[b * 3 + 2]] });
const data = (t?: number[]): RoadGraphData => ({
  v: 1, names: [], nodes,
  edges: [edge(S, C), edge(C, N), edge(C, E), edge(C, W), { ...edge(N, E), p: [0, 0, -100, 100, 0, -100, 100, 0, 0] }],
  ...(t ? { t } : {}),
});

describe('turn restrictions', () => {
  it('gives the turn direction from the south arm (heading north): east is right, west is left', () => {
    const g = data();
    expect(turnAngleAt(g, 0, C, 2)).toBeGreaterThan(1.3);
    expect(turnAngleAt(g, 0, C, 3)).toBeLessThan(-1.3);
    expect(Math.abs(turnAngleAt(g, 0, C, 1))).toBeLessThan(0.1);
  });

  it('routes straight through without a ban and around the block with one', () => {
    const free = new RoadGraph(data());
    const from = free.snap(0, 60)!, to = free.snap(60, 0)!;
    expect(free.route(from, to)!.length).toBeCloseTo(120, 0);
    // No right turn from the south arm into the east arm: north, along the ring, back down the east arm.
    const banned = new RoadGraph(data([0, C, 2]));
    expect(banned.banned(0, C, 2)).toBe(true);
    const r = banned.route(banned.snap(0, 60)!, banned.snap(60, 0)!)!;
    expect(r.length).toBeGreaterThan(300);
    // Turned off, the navigation ignores it again.
    banned.respectBans = false;
    expect(banned.route(banned.snap(0, 60)!, banned.snap(60, 0)!)!.length).toBeCloseTo(120, 0);
  });

  it('falls back to a route through the ban when there is no other way', () => {
    // With only the south and east arms the only way east is the banned turn.
    const g = data([0, C, 1]);
    g.edges = [g.edges[0], g.edges[2]];
    const graph = new RoadGraph(g);
    expect(graph.route(graph.snap(0, 60)!, graph.snap(60, 0)!)!.length).toBeCloseTo(120, 0);
  });
});
