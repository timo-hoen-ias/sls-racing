import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROAD_GROUPS } from '../src/vehicle/carPhysics.ts';
import {
  cellCentre, clusterIssues, gapIssues, gridCols, probeCells, rasterizeMesh, slotCells, surfaceIssues, type CellGrid,
} from '../src/world/surfaceScan.ts';
import type { Way } from '../pipeline/lib/osm.ts';
import { matchLevels } from '../pipeline/lib/levels.ts';
import { roadProfile, roadSurfaceHeights } from '../pipeline/lib/roads.ts';
import type { WorldInfo } from '../src/world/format.ts';

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
  const slots = probeCells(RAPIER, world, slotCells(levels, grid), grid, (c) => kind.get(c.handle) ?? '?');
  return { cells, gaps: gapIssues(slots, gridCols(grid)), issues: surfaceIssues(cells, gridCols(grid)).map((s) => ({ ...s, x: cellCentre(grid, s.key)[0], z: cellCentre(grid, s.key)[1] })) };
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

describe('slots between carriageways', () => {
  it('a 1 m slot between two decks over a valley is a gap, a wide median is not', () => {
    const decks = (gap: number) => scan([quad(-10, 10, -4, -gap / 2, 0), quad(-10, 10, gap / 2, 4, 0)], [], -6).gaps;
    expect(decks(1).length).toBeGreaterThan(0);
    expect(decks(1).every((s) => s.kind === 'gap')).toBe(true);
    expect(decks(3)).toEqual([]);
    // With ground under the slot at road height there is nothing to drop into.
    expect(scan([quad(-10, 10, -4, -0.5, 0), quad(-10, 10, 0.5, 4, 0)], [], -0.15).gaps).toEqual([]);
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

  it('a road leaving a bridge end at a right angle meets the deck where their surfaces overlap, straight on keeps its grade', () => {
    const deck = way(5, [[0, 0], [50, 0]], { highway: 'secondary', bridge: 'yes' });
    deck.deck = [101, 101];
    // Shares the bridge's end node, climbing 5 % to the north.
    const turn = way(6, [[50, 0], [50, 40]], { highway: 'secondary' });
    turn.ids[0] = deck.ids[1];
    turn.profile = { dist: Float32Array.from([0, 40]), y: Float32Array.from([101, 103]) };
    const ahead = way(7, [[50, 0], [90, 0]], { highway: 'secondary' });
    ahead.ids[0] = deck.ids[1];
    ahead.profile = { dist: Float32Array.from([0, 40]), y: Float32Array.from([101, 103]) };
    const at = (w: Way, d: number) => roadProfile(w, flat, { originE: 0, originN: 0, tileSize: 256 } as WorldInfo, 2).reduce((b, p) => (Math.abs(p.dist - d) < Math.abs(b.dist - d) ? p : b)).y;
    const y0 = at(turn, 2), a0 = at(ahead, 4);
    matchLevels([deck, turn, ahead], flat);
    const y = roadSurfaceHeights(deck, flat)[0];
    // Beside the deck the turning road comes down to it, the road straight on is untouched.
    expect(Math.abs(at(turn, 2) - y)).toBeLessThan(Math.abs(y0 - y));
    expect(at(ahead, 4)).toBeCloseTo(a0, 3);
  });

  it('the touching legs of a hairpin become one surface', () => {
    // Track out east and back west 2 m beside itself, climbing 1 %: the legs overlap with a 0.6–1.1 m ledge.
    const t = way(3, [[0, 0], [60, 0], [60, 2], [0, 2]], { highway: 'track' });
    t.profile = { dist: Float32Array.from([0, 60, 62, 122]), y: Float32Array.from([100, 100.6, 100.62, 101.22]) };
    const at = (d: number) => roadProfile(t, flat, { originE: 0, originN: 0, tileSize: 256 } as WorldInfo, 2).reduce((b, p) => (Math.abs(p.dist - d) < Math.abs(b.dist - d) ? p : b)).y;
    expect(at(92) - at(30)).toBeGreaterThan(0.5);
    matchLevels([t], flat);
    expect(Math.abs(at(92) - at(30))).toBeLessThan(0.05);
    // A road beside another (not a bridge, not the same way) is left as it is.
    const main = way(1, [[0, 10], [200, 10]], { highway: 'primary' });
    main.profile = { dist: Float32Array.from([0, 200]), y: Float32Array.from([100, 100]) };
    const side = way(2, [[0, 16], [200, 16]], { highway: 'residential' });
    side.profile = { dist: Float32Array.from([0, 200]), y: Float32Array.from([99.5, 99.5]) };
    expect(matchLevels([main, side], flat).ways).toBe(0);
  });

  it('surfaces a car fits between stay separate levels', () => {
    const a = way(1, [[0, 0], [100, 0]], { highway: 'primary' });
    a.profile = { dist: Float32Array.from([0, 100]), y: Float32Array.from([100, 100]) };
    const b = way(2, [[0, 1], [100, 1]], { highway: 'primary', bridge: 'yes' });
    b.deck = [106, 106];
    expect(matchLevels([a, b], flat).ways).toBe(0);
  });
});
