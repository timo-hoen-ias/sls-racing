import { afterEach, describe, expect, it } from 'vitest';
import { drawFillets, inFillet, planFillets } from '../pipeline/lib/fillets.ts';
import { TileMap } from '../pipeline/lib/tilebuf.ts';
import type { Way } from '../pipeline/lib/osm.ts';
import { roadSection, setRoadProfile } from '../src/world/roadSpec.ts';

const way = (id: number, ids: number[], pts: [number, number][], tags: Record<string, string> = {}): Way =>
  ({ id, ids, pts, closed: false, urban: true, tags: { highway: 'residential', ...tags } });

/** Two streets crossing at node 1 (origin): one east-west, one north-south. */
const cross = (tags: Record<string, string> = {}) => [
  way(1, [10, 1, 11], [[-60, 0], [0, 0], [60, 0]], tags),
  way(2, [20, 1, 21], [[0, -60], [0, 0], [0, 60]], tags),
];

afterEach(() => setRoadProfile('real'));

describe('junction corner fillets (S2)', () => {
  it('rounds all four corners of a crossing, only with the game profile', () => {
    expect(planFillets(cross(), () => 0)).toEqual([]);
    setRoadProfile('game');
    const f = planFillets(cross(), () => 0);
    expect(f.length).toBe(4);
    const hw = roadSection({ highway: 'residential' })!.width / 2;
    for (const c of f) {
      // Corner point where both kerb lines meet.
      expect(Math.abs(Math.abs(c.e[0]) - hw)).toBeLessThan(0.01);
      expect(Math.abs(Math.abs(c.n[0]) - hw)).toBeLessThan(0.01);
      // The arc's middle lies inside the corner, not on the road and not past the sidewalk.
      const mid = Math.floor(c.e.length / 2) + 1;
      const d = Math.hypot(c.e[mid] - c.e[0], c.n[mid] - c.n[0]);
      expect(d).toBeGreaterThan(0.3);
      expect(d).toBeLessThan(2.6 * Math.SQRT2);
      expect(c.reach).toBeGreaterThan(hw + 2);
      // A point just inside the corner is on the fillet, the junction centre is not.
      expect(inFillet(c, c.e[0] * 1.08, c.n[0] * 1.08)).toBe(true);
      expect(inFillet(c, 0, 0)).toBe(false);
    }
  });

  it('opens up wider on country roads and keeps to the street line where it is measured', () => {
    setRoadProfile('game');
    const rural = planFillets(cross({}).map((w) => ({ ...w, urban: false })), () => 0);
    const town = planFillets(cross({ 'sls:street': '9' }), () => 0);
    const reach = (l: typeof town) => Math.max(...l.map((f) => f.reach));
    expect(rural.length).toBe(4);
    expect(reach(rural)).toBeGreaterThan(reach(town));
    // With 9 m between the building lines, the arc keeps off the building corner.
    for (const c of town) for (let i = 1; i < c.e.length; i++) expect(Math.min(Math.abs(c.e[i]), Math.abs(c.n[i]))).toBeLessThan(4.5);
  });

  it('leaves junctions with a bridge or a ramp square, and shallow forks alone', () => {
    setRoadProfile('game');
    const bridge = cross();
    bridge[1].tags.bridge = 'yes';
    expect(planFillets(bridge, () => 0)).toEqual([]);
    // A Y fork at 20 degrees.
    const a = (20 * Math.PI) / 180;
    const fork = [
      way(1, [10, 1], [[-60, 0], [0, 0]]),
      way(2, [1, 11], [[0, 0], [60, 0]]),
      way(3, [1, 12], [[0, 0], [60 * Math.cos(a), 60 * Math.sin(a)]]),
    ];
    const f = planFillets(fork, () => 0);
    // Only the two wide corners beside the straight-on road get rounded.
    for (const c of f) expect(Math.abs(Math.atan2(c.n[0], c.e[0]))).toBeGreaterThan(a);
  });

  it('draws the corners as road facing up, with collision', () => {
    setRoadProfile('game');
    const tiles = new TileMap(256);
    drawFillets(planFillets(cross(), () => 0), { originE: -100, originN: 100, tileSize: 256 } as never, tiles);
    let tris = 0;
    for (const t of tiles.tiles.values())
      for (const buf of [t.roads, t.collide])
        for (let i = 0; i < buf.idx.length; i += 3) {
          const [a, b, c] = [buf.idx[i], buf.idx[i + 1], buf.idx[i + 2]].map((k) => [buf.pos[k * 3], buf.pos[k * 3 + 1], buf.pos[k * 3 + 2]]);
          const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
          expect(ny).toBeGreaterThan(0);
          tris++;
        }
    expect(tris).toBeGreaterThan(4 * 6 * 2);
  });
});

describe('rounded bends (S2)', () => {
  it('replaces a kink with an arc close to the mapped line, keeping shared and tagged nodes', async () => {
    const { bend, smoothBends } = await import('../pipeline/lib/smooth.ts');
    const arc = bend([0, -50], [0, 0], [50, 0], 30, 1)!;
    expect(arc.length).toBeGreaterThan(5);
    // Starts on the first piece, ends on the second, never more than 1 m off the corner.
    expect(Math.abs(arc[0][0])).toBeLessThan(1e-6);
    expect(Math.abs(arc[arc.length - 1][1])).toBeLessThan(1e-6);
    for (const [e, n] of arc) expect(Math.min(Math.abs(e), Math.abs(n))).toBeLessThan(2.5);
    const mid = arc[Math.floor(arc.length / 2)];
    expect(Math.hypot(mid[0], mid[1])).toBeLessThan(1.01);
    expect(bend([0, -50], [0, 0], [3, 50], 30, 1)).toBeUndefined();

    const road = () => way(1, [10, 1, 11], [[0, -50], [0, 0], [50, 0]]);
    setRoadProfile('game');
    const w = road();
    expect(smoothBends([w], new Set())).toBe(1);
    expect(w.pts.length).toBe(w.ids.length);
    expect(w.ids).toContain(1);
    expect(w.ids.filter((id) => id < 0).length).toBe(w.ids.length - 3);
    const kept = road();
    expect(smoothBends([kept], new Set([1]))).toBe(0);
    const shared = road();
    expect(smoothBends([shared, way(2, [1, 30], [[0, 0], [-40, 0]])], new Set())).toBe(0);
    setRoadProfile('real');
    expect(smoothBends([road()], new Set())).toBe(0);
  });
});
