import { describe, expect, it } from 'vitest';
import { makeDelivery } from '../src/game/delivery.ts';
import type { RoadGraphData } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';

/** An L of two 600 m streets. */
function ell() {
  const p = (pts: number[][]) => pts.flatMap(([x, z]) => [x, 0, z]);
  const data: RoadGraphData = { v: 1, names: ['Weg'], nodes: [0, 0, 0, 600, 0, 0, 600, 0, 600], edges: [
    { a: 0, b: 1, n: 0, c: 3, p: p([[0, 0], [300, 0], [600, 0]]) },
    { a: 1, b: 2, n: 0, c: 3, p: p([[600, 0], [600, 300], [600, 600]]) },
  ] };
  return new RoadGraph(data);
}

describe('courier runs (E6)', () => {
  it('builds a timed race along the route to the house, medals from its length', () => {
    const e = makeDelivery(ell(), { x: 20, z: 3 }, { label: 'Weg 7', x: 606, z: 500 })!;
    expect(e.type).toBe('delivery');
    expect(e.name).toBe('Weg 7');
    const fin = e.gates[0];
    expect(Math.hypot(fin.x - 600, fin.z - 500)).toBeLessThan(2);
    expect(fin.dz).toBeCloseTo(1, 3);
    expect(e.start.dx).toBeCloseTo(1, 3);
    const len = 580 + 500;
    expect(e.medals[2]).toBeCloseTo(len / (70 / 3.6), -1);
    expect(e.limit!).toBeGreaterThan(e.medals[0]);
    expect(makeDelivery(ell(), { x: 20, z: 3 }, { label: 'nah', x: 100, z: 0 })).toBeUndefined();
  });
});
