import { describe, expect, it } from 'vitest';
import { Collectibles, placeTokens } from '../src/game/collectibles.ts';
import type { RoadGraphData } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';

/** A 6 × 6 grid of residential streets, 100 m apart. */
function grid() {
  const data: RoadGraphData = { v: 1, names: ['Gasse'], nodes: [], edges: [] };
  const N = 6, S = 100;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) data.nodes.push(i * S, 0, j * S);
  const id = (i: number, j: number) => j * N + i;
  const line = (a: number, b: number) => [data.nodes[a * 3], 0, data.nodes[a * 3 + 2], (data.nodes[a * 3] + data.nodes[b * 3]) / 2, 0, (data.nodes[a * 3 + 2] + data.nodes[b * 3 + 2]) / 2, data.nodes[b * 3], 0, data.nodes[b * 3 + 2]];
  for (let j = 0; j < N; j++) for (let i = 0; i + 1 < N; i++) {
    data.edges.push({ a: id(i, j), b: id(i + 1, j), n: 0, c: 3, p: line(id(i, j), id(i + 1, j)) });
    data.edges.push({ a: id(j, i), b: id(j, i + 1), n: 0, c: 3, p: line(id(j, i), id(j, i + 1)) });
  }
  return new RoadGraph(data);
}

describe('hidden collectibles (E7)', () => {
  it('places the same spread-out tokens per district every time, and picks them up once', () => {
    const g = grid();
    const districts = [{ name: 'West', x: 100, z: 250 }, { name: 'Ost', x: 400, z: 250 }];
    const a = placeTokens(g, districts, 3);
    expect(a).toEqual(placeTokens(g, districts, 3));
    expect(a.filter((t) => t.district === 'West').length).toBeGreaterThan(0);
    for (const t of a) for (const o of a) if (t !== o && t.district === o.district) expect(Math.hypot(t.x - o.x, t.z - o.z)).toBeGreaterThanOrEqual(220);
    const col = new Collectibles();
    col.set(a);
    const picks: string[] = [];
    col.onPick = (t, n, total, done) => picks.push(`${t.id} ${n}/${total} ${done}`);
    col.update(0.1, a[0].x + 1, a[0].z);
    col.update(0.1, a[0].x, a[0].z);
    expect(picks.length).toBe(1);
    expect(col.count).toBe(1);
  });
});
