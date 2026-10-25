import { describe, expect, it } from 'vitest';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { drawCalming, planTurningCircles } from '../pipeline/lib/roadDetails.ts';
import { TileMap } from '../pipeline/lib/tilebuf.ts';
import type { WorldInfo } from '../src/world/format.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1100, N = 1100;

/** Dead-end residential street running east from (E, N), 100 m, nodes 1..6. */
function street(): Way {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 5; i++) pts.push([E + i * 20, N]);
  return { id: 1, tags: { highway: 'residential' }, pts, ids: pts.map((_, i) => i + 1), closed: false };
}
const data = (o: Partial<OsmData>): OsmData => ({ ways: [street()], polygons: [], trees: [], points: [], ...o });
const house = (e: number, n: number) => ({ id: 9, tags: { building: 'yes' }, outer: [[e, n], [e + 10, n], [e + 10, n + 10], [e, n + 10], [e, n]] as [number, number][], holes: [] });

describe('road details', () => {
  it('puts a round pad at a turning circle and shrinks it away from a building', () => {
    const point = { id: 6, tags: { highway: 'turning_circle' }, e: E + 100, n: N };
    const free = planTurningCircles(data({ points: [point] }), () => 0);
    expect(free.fillets).toHaveLength(1);
    const f = free.fillets[0];
    expect(f.reach).toBeCloseTo(7.5);
    expect(Math.hypot(f.e[5] - point.e, f.n[5] - point.n)).toBeCloseTo(7.5);
    // A house 5 m north of the node: the pad shrinks to keep half a metre off it.
    const tight = planTurningCircles(data({ points: [point], polygons: [house(E + 95, N + 5)] }), () => 0);
    expect(tight.fillets[0].reach).toBeLessThanOrEqual(4.5);
    expect(tight.fillets[0].reach).toBeGreaterThanOrEqual(4);
    // Steep ground all round leaves it out.
    expect(planTurningCircles(data({ points: [point] }), (e) => (e > E + 103 ? 3 : 0)).fillets).toHaveLength(0);
  });

  it('draws a speed bump across the road with its crest at the bump height', () => {
    const tiles = new TileMap(256);
    const stats = drawCalming(data({ points: [{ id: 3, tags: { traffic_calming: 'bump' }, e: E + 40, n: N }] }), world, tiles, () => 0);
    expect(stats.bumps).toBe(1);
    const roads = tiles.at(E + 40, N).roads;
    const ys = roads.pos.filter((_, i) => i % 3 === 1);
    const base = Math.min(...ys);
    expect(Math.max(...ys) - base).toBeCloseTo(0.07, 2);
    // Every quad faces up.
    for (let t = 0; t < roads.idx.length; t += 3) {
      const [a, b, c] = [roads.idx[t], roads.idx[t + 1], roads.idx[t + 2]].map((i) => [roads.pos[i * 3], roads.pos[i * 3 + 2]]);
      expect((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])).toBeGreaterThan(0);
    }
    expect(tiles.at(E + 40, N).markings.idx.length).toBeGreaterThan(0);
  });
});
