import { describe, expect, it } from 'vitest';
import type { RoadGraphData } from '../src/world/format.ts';
import { signalJunctions } from '../pipeline/lib/signals.ts';

/** Two crossroads at x = 0 and x = 300 (degree 4 each). */
function graph(): RoadGraphData {
  const nodes = [0, 0, 0, -100, 0, 0, 100, 0, 0, 0, 0, -100, 0, 0, 100, 300, 0, 0, 400, 0, 0, 300, 0, -100, 300, 0, 100];
  const e = (a: number, b: number) => ({ a, b, n: 0, c: 3, p: [nodes[a * 3], 0, nodes[a * 3 + 2], nodes[b * 3], 0, nodes[b * 3 + 2]] });
  return { v: 1, names: ['A'], nodes, edges: [e(0, 1), e(0, 2), e(0, 3), e(0, 4), e(5, 2), e(5, 6), e(5, 7), e(5, 8)] };
}

describe('signal junctions', () => {
  it('takes mapped lights, and photo lights only on several corners', () => {
    const g = graph();
    expect(signalJunctions(g, [[5, 5]]).map(([n]) => n)).toEqual([0]);
    // Lights on two corners of the second junction (a pedestrian crossing?) are not enough, three corners are;
    // repeated sightings of the same light count once.
    expect(signalJunctions(g, [[5, 5]], [[290, 8], [310, -9], [291, 9], [289, 7]]).map(([n]) => n)).toEqual([0]);
    expect(signalJunctions(g, [[5, 5]], [[290, 8], [310, -9], [308, 10]]).map(([n]) => n)).toEqual([0, 5]);
    // A photo light next to a mapped one joins its group.
    const both = signalJunctions(g, [[5, 5]], [[-8, 6]]);
    expect(both).toEqual([[0, 0]]);
  });
});
