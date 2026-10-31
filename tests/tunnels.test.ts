import { describe, expect, it } from 'vitest';
import type { Polygon, Way } from '../pipeline/lib/osm.ts';
import { roadProfiles } from '../pipeline/lib/profiles.ts';
import { isDrivable, roadSurfaceHeights } from '../pipeline/lib/roads.ts';
import { markTunnels, portalAnchors, tunnelProfiles } from '../pipeline/lib/tunnels.ts';
import { gridIndex } from '../src/world/tileBuild.ts';
import { TUNNEL, TUNNEL_STRIDE, cutTerrain, readTunnels, tubeColliders, tubeGeometry, tunnelAt } from '../src/world/tunnelGeom.ts';

const way = (id: number, ids: number[], pts: [number, number][], tags: Record<string, string>): Way => ({ id, ids, pts, tags, closed: false });

describe('markTunnels', () => {
  it('builds tunnels that lead through, not ones into a garage or under a hall', () => {
    const ways = [
      way(1, [1, 2], [[-100, 0], [-20, 0]], { highway: 'secondary' }),
      way(2, [2, 3], [[-20, 0], [20, 0]], { highway: 'secondary', tunnel: 'yes', layer: '-1' }),
      way(3, [3, 4], [[20, 0], [100, 0]], { highway: 'secondary' }),
      // Ramp down into an underground car park: ends below ground.
      way(4, [10, 11], [[0, 100], [0, 60]], { highway: 'service' }),
      way(5, [11, 12], [[0, 60], [0, 40]], { highway: 'service', tunnel: 'yes' }),
      // Drive-through under a shopping centre.
      way(6, [20, 21], [[300, 0], [320, 0]], { highway: 'service' }),
      way(7, [21, 22], [[320, 0], [370, 0]], { highway: 'service', tunnel: 'yes' }),
      way(8, [22, 23], [[370, 0], [390, 0]], { highway: 'service' }),
    ];
    const hall: Polygon = { id: 99, tags: { building: 'retail' }, outer: [[315, -20], [375, -20], [375, 20], [315, 20], [315, -20]], holes: [] };
    const r = markTunnels(ways, [hall]);
    expect(r.built).toBe(1);
    expect(r.skipped).toEqual({ 'dead end': 1, 'under a building': 1 });
    expect(isDrivable(ways[1].tags)).toBe(true);
    expect(isDrivable(ways[4].tags)).toBe(false);
    expect(isDrivable(ways[6].tags)).toBe(false);
  });
});

describe('tunnelProfiles', () => {
  const make = () => [
    way(1, [1, 2], [[-200, 0], [-50, 0]], { highway: 'primary' }),
    way(2, [2, 3, 4], [[-50, 0], [0, 0], [50, 0]], { highway: 'primary', tunnel: 'yes' }),
    way(3, [4, 5], [[50, 0], [200, 0]], { highway: 'primary' }),
  ];

  it('runs straight under a hill instead of over it', () => {
    const ways = make();
    markTunnels(ways, []);
    // Flat valley at 100 m with a 12 m hill between the portals.
    const height = (e: number) => 100 + Math.max(0, 12 - Math.abs(e) / 3.5);
    const portals = portalAnchors(ways, height);
    roadProfiles(ways, height, portals);
    tunnelProfiles(ways, height, portals);
    const y = roadSurfaceHeights(ways[1], height);
    expect(Math.max(...y) - Math.min(...y)).toBeLessThan(0.3);
    expect(ways[1].tunnel?.height).toBe(TUNNEL.height);
  });

  it('lowers the clear height under a road close above, then the road itself', () => {
    const ways = [...make(), way(9, [20, 21], [[0, -100], [0, 100]], { highway: 'residential' })];
    markTunnels(ways, []);
    // A road 3 m above the tunnel's road: less than the least clear height and the roof, so the tunnel dips.
    const height = (e: number, n: number) => (Math.abs(e) < 5 && Math.abs(n) < 100 ? 103 : 100);
    const portals = portalAnchors(ways, height);
    roadProfiles(ways, height, portals);
    tunnelProfiles(ways, height, portals);
    expect(ways[1].tunnel!.height).toBeCloseTo(TUNNEL.minHeight, 5);
    const mid = roadSurfaceHeights(ways[1], height)[1];
    const above = roadSurfaceHeights(ways[3], height)[0];
    expect(above - mid).toBeGreaterThanOrEqual(TUNNEL.minHeight + TUNNEL.slab);
  });
});

/** Flat 64 m grid at 100 m, 4 m step, from (0, 0). */
function grid() {
  const N = 17;
  const pos = new Float32Array(N * N * 3);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) pos.set([c * 4, 100, r * 4], (r * N + c) * 3);
  return { pos, idx: gridIndex(N) };
}

/** A straight tunnel along x at z = 32, road 1 m above the ground (a box on the surface), 3.5 m half width. */
function line(x0: number, x1: number) {
  const n = 9;
  const rec: number[] = [n, TUNNEL.height, 7];
  for (let i = 0; i < n; i++) rec.push(x0 + ((x1 - x0) * i) / (n - 1), 101, 32, 3.5, 3.5);
  expect(rec.length).toBe(3 + n * TUNNEL_STRIDE);
  return readTunnels(Float32Array.from(rec));
}

/** Height of the mesh at (x, z) from the triangle under it (highest if several overlap). */
function meshY(pos: Float32Array, idx: Uint32Array, x: number, z: number) {
  let best = -Infinity;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / d;
    const v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / d;
    if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
    best = Math.max(best, a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v);
  }
  return best;
}

describe('cutTerrain', () => {
  it('raises the ground over the tube to its roof, leaves the rest and closes the sides', () => {
    const lines = line(10, 54);
    const { pos, idx } = grid();
    const { mesh, skirts } = cutTerrain({ pos, idx }, lines);
    const roof = 101 + TUNNEL.height + TUNNEL.slab;
    // Over the tube (inside the walls' outer faces): at the roof; well away: untouched.
    for (const [x, z] of [[20, 32], [30, 28], [40, 36.5], [12, 32]]) expect(meshY(mesh.pos, mesh.idx, x, z)).toBeCloseTo(roof, 4);
    for (const [x, z] of [[5, 32], [60, 32], [30, 20], [30, 45]]) expect(meshY(mesh.pos, mesh.idx, x, z)).toBeCloseTo(100, 4);
    // Every point of the original area is still covered once (no holes).
    let area = 0;
    for (let t = 0; t < mesh.idx.length; t += 3) {
      const [a, b, c] = [mesh.idx[t], mesh.idx[t + 1], mesh.idx[t + 2]].map((i) => [mesh.pos[i * 3], mesh.pos[i * 3 + 2]]);
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    expect(area).toBeCloseTo(64 * 64, 3);
    // Skirts along both sides from the ground up to the roof: 2 × 44 m × (roof - 100).
    let skirt = 0;
    for (let i = 0; i < skirts.length; i += 9) {
      const [a, b, c] = [0, 3, 6].map((k) => [skirts[i + k], skirts[i + k + 1], skirts[i + k + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      skirt += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    expect(skirt).toBeCloseTo(2 * 44 * (roof - 100), 1);
  });

  it('builds the tube and its colliders only for the segments a tile owns', () => {
    const lines = line(10, 54);
    const all = tubeColliders(lines, () => true);
    expect(all.length).toBe(8 * 5);
    expect(tubeColliders(lines, (x) => x < 32).length).toBe(4 * 5);
    const { tube, lights } = tubeGeometry(lines, () => true);
    expect(tube.pos.length).toBeGreaterThan(0);
    expect(tube.col.length).toBe(tube.pos.length);
    expect(tube.uv.length / 2).toBe(tube.pos.length / 3);
    expect(lights.length).toBeGreaterThan(0);
  });

  it('finds the tube around a point', () => {
    const lines = line(10, 54);
    expect(tunnelAt(lines, 30, 102, 32)?.road).toBeCloseTo(101, 5);
    expect(tunnelAt(lines, 30, 102, 32 + 3.5 + TUNNEL.walk + 0.1)).toBeUndefined();
    expect(tunnelAt(lines, 30, 101 + TUNNEL.height + 1, 32)).toBeUndefined();
    expect(tunnelAt(lines, 5, 102, 32)).toBeUndefined();
  });
});
