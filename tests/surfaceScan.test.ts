import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROAD_GROUPS } from '../src/vehicle/carPhysics.ts';
import {
  cellCentre, clusterIssues, gridCols, probeCells, rasterizeMesh, surfaceIssues, type CellGrid,
} from '../src/world/surfaceScan.ts';
import type { Way } from '../pipeline/lib/osm.ts';
import { matchLevels } from '../pipeline/lib/levels.ts';
import { roadSurfaceHeights } from '../pipeline/lib/roads.ts';

beforeAll(async () => {
  await RAPIER.init();
});

/** Flat quad (x0..x1 × z0..z1) at height y as positions and indices. */
const quad = (x0: number, x1: number, z0: number, z1: number, y: number, y1 = y) => ({
  pos: new Float32Array([x0, y, z0, x1, y1, z0, x0, y, z1, x1, y1, z1]),
  idx: new Uint32Array([0, 2, 1, 1, 2, 3]),
});

/** Scans quads drawn as roads, with the same quads as wheel-only road colliders and a terrain plane under them. */
function scan(roads: { pos: Float32Array; idx: Uint32Array }[], solids: { pos: Float32Array; idx: Uint32Array }[] = [], terrain = -0.15, collide = true) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const kind = new Map<number, string>();
  const add = (desc: RAPIER.ColliderDesc, k: string) => kind.set(world.createCollider(desc, body).handle, k);
  const t = quad(-50, 50, -50, 50, terrain);
  add(RAPIER.ColliderDesc.trimesh(t.pos, t.idx), 'terrain');
  if (collide) for (const r of roads) add(RAPIER.ColliderDesc.trimesh(r.pos, r.idx).setCollisionGroups(ROAD_GROUPS), 'road');
  for (const s of solids) add(RAPIER.ColliderDesc.trimesh(s.pos, s.idx), 'solid');
  world.step();
  const grid: CellGrid = { cell: 0.5, c0: -40, c1: 40, r0: -40, r1: 40 };
  const levels = new Map<number, number[]>();
  for (const r of roads) rasterizeMesh(r.pos, r.idx, grid, levels);
  const cells = probeCells(RAPIER, world, levels, grid, (c) => kind.get(c.handle) ?? '?');
  return { cells, issues: surfaceIssues(cells, gridCols(grid)).map((s) => ({ ...s, x: cellCentre(grid, s.key)[0], z: cellCentre(grid, s.key)[1] })) };
}

describe('surface scan', () => {
  it('a smooth road on the terrain has no issues, every cell covered', () => {
    const { cells, issues } = scan([quad(-10, 10, -2, 2, 0, 0.8)]);
    expect(cells.size).toBe(40 * 8);
    expect(issues).toEqual([]);
  });

  it('finds the step between two road pieces at different heights, and only there', () => {
    const { issues } = scan([quad(-10, 0, -2, 2, 0), quad(0, 10, -2, 2, 0.3)]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((s) => s.kind === 'step' && Math.abs(s.x) < 0.6 && Math.abs(s.size - 0.3) < 0.01)).toBe(true);
    expect(clusterIssues(issues.map((s) => ({ ...s, y: 0 })))).toHaveLength(1);
  });

  it('terrain poking through the road is a bump, a gap in the road a hole', () => {
    const { issues } = scan([quad(-10, 10, -2, 2, 0)], [], 0.25);
    expect(issues.some((s) => s.kind === 'bump' && s.what === 'terrain')).toBe(true);
    // Drawn but without its collider, over a valley.
    const hole = scan([quad(-10, 10, -2, 2, 0)], [], -3, false).issues;
    expect(hole.filter((s) => s.kind === 'hole').length).toBe(40 * 8);
  });

  it('a solid just above the road surface catches the underbody: snag', () => {
    // A thin deck slab 0.2 m above the road, under the wheel ray start: wheels see it as a bump, chassis too.
    const { issues } = scan([quad(-10, 10, -2, 2, 0)], [quad(-1, 1, -1, 1, 0.2)]);
    expect(issues.some((s) => s.kind === 'bump' && s.what === 'solid')).toBe(true);
    // Road meshes do not catch the chassis: a raised road piece is only a bump/step for the wheels, never a snag.
    const roadOnly = scan([quad(-10, 10, -2, 2, 0), quad(-1, 1, -1, 1, 0.2)]).issues;
    expect(roadOnly.some((s) => s.kind === 'snag')).toBe(false);
  });
});

describe('overlapping road levels', () => {
  const flat = () => 100;
  const way = (id: number, pts: [number, number][], tags: Record<string, string>): Way => ({ id, tags, pts, ids: pts.map((_, i) => id * 100 + i), closed: false });

  it('two carriageways of one bridge measured apart meet at one height', () => {
    const a = way(1, [[0, 0], [100, 0]], { highway: 'tertiary', bridge: 'yes' });
    const b = way(2, [[0, 6], [100, 6]], { highway: 'tertiary', bridge: 'yes' });
    a.deck = [110, 110];
    b.deck = [111, 111];
    matchLevels([a, b], flat);
    const ya = roadSurfaceHeights(a, flat), yb = roadSurfaceHeights(b, flat);
    expect(Math.abs(ya[0] - yb[0])).toBeLessThan(0.05);
    expect(ya[0]).toBeGreaterThan(110.3);
  });

  it('a minor road overlapping a main road takes its height and fades back into its own', () => {
    const main = way(1, [[0, 0], [200, 0]], { highway: 'primary' });
    main.profile = { dist: Float32Array.from([0, 200]), y: Float32Array.from([100, 100]) };
    // Side road running alongside the main road for 40 m, half a metre lower, then leaving it.
    const side = way(2, [[60, 6], [100, 6], [100, 106]], { highway: 'residential' });
    side.profile = { dist: Float32Array.from([0, 40, 140]), y: Float32Array.from([99.5, 99.5, 99.5]) };
    matchLevels([main, side], flat);
    const s = roadSurfaceHeights(side, flat), m = roadSurfaceHeights(main, flat);
    // Alongside: same surface (less the draw-order lift between the classes).
    expect(Math.abs(s[0] - m[0])).toBeLessThan(0.05);
    // The main road keeps its height; the side road is back on its own profile far from it.
    expect(m[0]).toBeCloseTo(100 + 0.15 + 7 * 0.008, 3);
    expect(s[2]).toBeCloseTo(99.5 + 0.15 + 3 * 0.008, 3);
  });

  it('surfaces a car fits between stay separate levels', () => {
    const a = way(1, [[0, 0], [100, 0]], { highway: 'primary' });
    a.profile = { dist: Float32Array.from([0, 100]), y: Float32Array.from([100, 100]) };
    const b = way(2, [[0, 1], [100, 1]], { highway: 'primary', bridge: 'yes' });
    b.deck = [106, 106];
    expect(matchLevels([a, b], flat).ways).toBe(0);
  });
});
