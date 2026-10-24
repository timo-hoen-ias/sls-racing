import { describe, expect, it } from 'vitest';
import { placeLidarTrees, type MeasuredTree } from '../pipeline/lib/lidarTrees.ts';
import { TREE_HEIGHT, Tree } from '../src/world/vegKinds.ts';

const opts = {
  skip: (e: number) => e < 0, // "road" west of e = 0
  tagsAt: () => undefined,
  mapped: [{ e: 51, n: 50, kind: Tree.birch }, { e: 300, n: 300, kind: Tree.fruit }],
  rand: () => 0.5,
};

describe('LiDAR trees', () => {
  const measured: MeasuredTree[] = [
    [50, 50, 12, 3.4, 0], // on the mapped birch
    [80, 50, 18, 4, 1], // conifer
    [90, 50, 25, 2, 2], // poplar
    [-5, 50, 10, 3, 0], // on the road
    [100, 60, 2, 1, 0], // too small for a tree
  ];
  const p = placeLidarTrees([[0, 0, 1000, 1000]], measured, opts);

  it('keeps measured height and crown, and the species of a mapped tree it stands on', () => {
    expect(p.trees).toHaveLength(3);
    const birch = p.trees[0];
    expect(birch.kind).toBe(Tree.birch);
    expect(birch.scale * TREE_HEIGHT[Tree.birch]).toBeCloseTo(12, 5);
    expect(birch.crown).toBe(34);
    expect(p.merged.has(0)).toBe(true);
    expect(p.merged.has(1)).toBe(false);
  });

  it('takes the leaf type for the species and skips roads', () => {
    expect(p.trees[1].kind).toBe(Tree.conifer);
    expect(p.trees[2].kind).toBe(Tree.poplar);
    expect(p.trees.some((t) => t.e < 0)).toBe(false);
    expect(p.bushes).toHaveLength(1);
  });

  it('knows its coverage', () => {
    expect(p.covered(500, 500)).toBe(true);
    expect(p.covered(1500, 500)).toBe(false);
  });
});
