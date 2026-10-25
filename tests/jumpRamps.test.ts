import { describe, expect, it } from 'vitest';
import { generateEvents } from '../src/game/events/generate.ts';
import type { RoadGraphData } from '../src/world/format.ts';
import { placeJumpRamps, rampGeometry } from '../src/world/jumpRamps.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';

/** A straight 400 m residential street, a crooked one and a main road. */
function town() {
  const p = (pts: number[][]) => pts.flatMap(([x, z]) => [x, 0, z]);
  const data: RoadGraphData = { v: 1, names: ['Gerade Straße', 'Krumme Gasse', 'Hauptstraße'], nodes: [0, 0, 0, 400, 0, 0, 400, 0, 400, 0, 0, 400], edges: [
    { a: 0, b: 1, n: 0, c: 3, w: 6, p: p([[0, 0], [200, 0], [400, 0]]) },
    { a: 1, b: 2, n: 1, c: 3, w: 6, p: p([[400, 0], [430, 100], [380, 200], [430, 300], [400, 400]]) },
    { a: 2, b: 3, n: 2, c: 6, w: 8, p: p([[400, 400], [0, 400]]) },
  ] };
  return new RoadGraph(data);
}

describe('jump ramps (W3)', () => {
  it('sits only on a long straight residential street, with a run-up behind it', () => {
    const ramps = placeJumpRamps(town());
    expect(ramps).toHaveLength(1);
    const r = ramps[0];
    expect(r.name).toBe('Gerade Straße');
    expect(Math.abs(r.z)).toBeLessThan(0.01);
    // Driving +x: heading π/2 in the (sin h, -cos h) convention.
    expect(Math.sin(r.heading)).toBeCloseTo(1, 3);
    expect(r.x - r.runup.x).toBeGreaterThan(100);
    expect(400 - r.x).toBeGreaterThanOrEqual(85);
  });

  it('gets a jump event that starts at the run-up', () => {
    const g = town();
    const ramps = placeJumpRamps(g);
    const jumps = generateEvents(g, { ramps }).filter((e) => e.type === 'jump');
    expect(jumps).toHaveLength(1);
    const run = jumps[0].extra!.runup!;
    expect(run.dx).toBeCloseTo(1, 3);
    expect(jumps[0].start.x).toBeLessThan(ramps[0].x - ramps[0].length / 2);
  });

  it('builds a closed ramp body rising to the lip', () => {
    const g = rampGeometry({ length: 14, height: 1.6, width: 4 });
    let top = -Infinity;
    for (let i = 1; i < g.pos.length; i += 3) top = Math.max(top, g.pos[i]);
    expect(top).toBeCloseTo(1.55, 2);
    expect(g.idx.length % 3).toBe(0);
    expect(Math.max(...g.idx)).toBeLessThan(g.pos.length / 3);
  });
});
