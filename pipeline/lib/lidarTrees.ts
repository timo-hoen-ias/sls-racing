import { TREE_HEIGHT, Tree, type TreeKind } from '../../src/world/vegKinds.ts';
import { areaTreeKind } from './vegetation.ts';

// Places the trees measured by the LiDAR survey (pipeline/lib/lidar.ts) in the world: real position, height and
// crown. Inside the survey coverage they replace the scattered park and garden trees and absorb the OSM trees
// they stand on (which keep their mapped species). Woods stay scattered: the survey merges dense canopies.

/** [UTM east, UTM north, height m, crown radius m, leaf type -1|0|1|2] as in LidarFile.trees. */
export type MeasuredTree = [number, number, number, number, number];

export interface PlacedTree {
  e: number;
  n: number;
  kind: TreeKind;
  /** Scale for the game models (TREE_HEIGHT[kind] tall at 1). */
  scale: number;
  /** Crown radius in dm, 1..255. */
  crown: number;
}

export interface LidarPlacement {
  trees: PlacedTree[];
  /** Small measured trees (under minHeight) as bushes: e, n, scale. */
  bushes: [number, number, number][];
  /** True inside the survey coverage. */
  covered(e: number, n: number): boolean;
  /** Indices of the mapped trees replaced by a measured one. */
  merged: Set<number>;
}

export interface LidarOptions {
  /** Skips trees here (carriageways, woods). */
  skip(e: number, n: number): boolean;
  /** Area tags at a point, for the species mix. */
  tagsAt(e: number, n: number): Record<string, string> | undefined;
  /** Mapped trees with their kind, to merge with the measured ones. */
  mapped: { e: number; n: number; kind: TreeKind }[];
  rand(e: number, n: number, salt?: number): number;
  minHeight?: number;
  /** Mapped tree within this distance (m) of a measured one is the same tree. */
  mergeRadius?: number;
}

export function placeLidarTrees(coverage: [number, number, number, number][], measured: MeasuredTree[], o: LidarOptions): LidarPlacement {
  const covered = (e: number, n: number) => coverage.some(([e0, n0, e1, n1]) => e >= e0 && e < e1 && n >= n0 && n < n1);
  const minHeight = o.minHeight ?? 3.5;
  const R = o.mergeRadius ?? 4;
  // Grid of mapped trees for the merge.
  const cell = (e: number, n: number) => `${Math.floor(e / R)}_${Math.floor(n / R)}`;
  const grid = new Map<string, number[]>();
  o.mapped.forEach((t, i) => {
    const k = cell(t.e, t.n);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const taken = new Set<number>();
  const nearestMapped = (e: number, n: number) => {
    let best = -1, bd = R;
    const ce = Math.floor(e / R), cn = Math.floor(n / R);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const i of grid.get(`${ce + a}_${cn + b}`) ?? []) {
          const d = Math.hypot(o.mapped[i].e - e, o.mapped[i].n - n);
          if (d < bd && !taken.has(i)) { bd = d; best = i; }
        }
    return best;
  };

  const trees: PlacedTree[] = [];
  const bushes: [number, number, number][] = [];
  for (const [e, n, h, crown, leaf] of measured) {
    if (o.skip(e, n)) continue;
    if (h < minHeight) {
      if (h >= 1) bushes.push([e, n, Math.min(2, h / 1.5)]);
      continue;
    }
    const m = nearestMapped(e, n);
    let kind: TreeKind;
    if (m >= 0) {
      taken.add(m);
      kind = o.mapped[m].kind;
    } else if (leaf === 1) kind = Tree.conifer;
    else if (leaf === 2) kind = Tree.poplar;
    else {
      // Broadleaved: the area decides between broadleaf, birch and fruit trees.
      const k = areaTreeKind(o.tagsAt(e, n), o.rand(e, n, 41));
      kind = k === Tree.conifer || k === Tree.poplar ? Tree.broadleaf : k;
    }
    trees.push({ e, n, kind, scale: h / TREE_HEIGHT[kind], crown: Math.max(1, Math.min(255, Math.round(crown * 10))) });
  }
  return { trees, bushes, covered, merged: taken };
}
