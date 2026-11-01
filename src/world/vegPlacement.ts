// Where the trees and bushes of a tile stand, which species they are and how big: pure TypeScript, shared by the
// web game (vegetation.ts builds its instanced meshes from it) and the Unreal export (unreal/tools/export-tiles.ts
// writes the same instances for the HISM foliage), so both games plant the same forest.
import { Ground, TERRAIN_N, TERRAIN_STEP } from './format.ts';
import { BUSH_STRIDE, Bush, TREE_HEIGHT, Tree, type TreeKind } from './vegKinds.ts';

/** Species mix per tile tree kind: in woods mostly beech and oak, spruce and pine; in town lime, maple, plane. */
const MIX: Record<'town' | 'forest', Record<TreeKind, [string, number][]>> = {
  town: {
    [Tree.broadleaf]: [['linde', 0.3], ['ahorn', 0.24], ['platane', 0.14], ['eiche', 0.17], ['buche', 0.15]],
    [Tree.conifer]: [['fichte', 0.55], ['kiefer', 0.45]],
    [Tree.poplar]: [['pappel', 1]], [Tree.birch]: [['birke', 1]], [Tree.fruit]: [['obst', 1]],
  },
  forest: {
    [Tree.broadleaf]: [['buche', 0.55], ['eiche', 0.33], ['ahorn', 0.12]],
    [Tree.conifer]: [['fichte', 0.6], ['kiefer', 0.4]],
    [Tree.poplar]: [['pappel', 1]], [Tree.birch]: [['birke', 1]], [Tree.fruit]: [['obst', 1]],
  },
};

export function speciesOf(kind: TreeKind, forest: boolean, r: number): string {
  const mix = MIX[forest ? 'forest' : 'town'][kind] ?? MIX.town[Tree.broadleaf];
  let acc = 0;
  for (const [id, share] of mix) if (r < (acc += share)) return id;
  return mix[mix.length - 1][0];
}

export const BUSH_SPECIES: Record<number, string> = { [Bush.round]: 'busch', [Bush.scrub]: 'gebuesch' };

export const vegFract = (v: number) => v - Math.floor(v);
export const vegHash = (x: number, z: number, salt: number) => vegFract(Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453);

/** One instance: x, y, z, crown width scale, height scale, colour variation. */
export type VegRec = [number, number, number, number, number, number];

/** The tile fields placement reads (format.ts): trees (x, y, z, scale), kinds, LiDAR crowns (dm), bushes, ground. */
export interface VegSource {
  ox: number;
  oz: number;
  ground: Uint8Array;
  trees?: Float32Array;
  kinds?: Uint8Array;
  crowns?: Uint8Array;
  bushes?: Float32Array;
}

/** Model size per species (treeGen.ts TreeGeometry: height and crown radius of the generated model). */
export type SpeciesSize = Record<string, { height: number; crown: number }>;

/** Ground class of the terrain cell under (x, z) in a tile. */
export function groundAt(t: VegSource, x: number, z: number) {
  const c = Math.max(0, Math.min(TERRAIN_N - 1, Math.round((x - t.ox) / TERRAIN_STEP)));
  const r = Math.max(0, Math.min(TERRAIN_N - 1, Math.round((z - t.oz) / TERRAIN_STEP)));
  return t.ground[r * TERRAIN_N + c];
}

/** Instances per species of one tile; LiDAR-measured trees only with `lidar` (veg.lidar). */
export function placeVegetation(t: VegSource, geo: SpeciesSize, lidar: boolean): Map<string, VegRec[]> {
  const bySpecies = new Map<string, VegRec[]>();
  const push = (sp: string, r: VegRec) => { if (!bySpecies.has(sp)) bySpecies.set(sp, []); bySpecies.get(sp)!.push(r); };
  const tr = t.trees;
  if (tr?.length) {
    for (let i = 0; i < tr.length / 4; i++) {
      const crown = (t.crowns?.[i] ?? 0) / 10;
      if (!lidar && crown) continue;
      const x = tr[i * 4], y = tr[i * 4 + 1] - 0.15, z = tr[i * 4 + 2], sc = tr[i * 4 + 3];
      const kind = (t.kinds?.[i] ?? Tree.broadleaf) as TreeKind;
      const forest = groundAt(t, x, z) === Ground.forest;
      const sp = speciesOf(kind, forest, vegHash(x, z, 1));
      const model = geo[sp];
      // Height from the tile's scale; crown from the survey, or in proportion (narrower in a closed wood).
      const h = (sc * TREE_HEIGHT[kind] * (crown ? 1 : 0.9 + 0.2 * vegHash(x, z, 2))) / model.height;
      let w = crown ? crown / model.crown : h * (forest ? 0.72 : 1) * (0.9 + 0.2 * vegHash(x, z, 3));
      w = Math.min(h * 1.8, Math.max(h * 0.55, w));
      push(sp, [x, y, z, w, h, kind === Tree.conifer ? 0.03 : 0.07]);
    }
  }
  const bu = t.bushes;
  if (bu?.length) {
    for (let i = 0; i < bu.length / BUSH_STRIDE; i++) {
      const o = i * BUSH_STRIDE;
      const sp = BUSH_SPECIES[bu[o + 4]] ?? 'busch';
      const s = (bu[o + 3] * 1.5) / geo[sp].height;
      push(sp, [bu[o], bu[o + 1] - 0.1, bu[o + 2], s * (0.9 + 0.3 * vegHash(bu[o], bu[o + 2], 4)), s, 0.08]);
    }
  }
  return bySpecies;
}

/** Yaw (radians) and colour variation (r, g, b factors) of one instance, as vegetation.ts fill() draws it. */
export function vegLook([x, , z, , , tint]: VegRec): { yaw: number; col: [number, number, number] } {
  const r = vegHash(x, z, 5);
  return { yaw: r * Math.PI * 2, col: [1 + (vegFract(r * 3.7) - 0.5) * tint * 2, 1 + (vegFract(r * 5.3) - 0.5) * tint * 2, 1 - tint] };
}
