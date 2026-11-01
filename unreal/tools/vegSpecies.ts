// The generated tree and bush species exactly as the web game grows them (treeRender.ts buildSpecies: treeGen.ts
// buildTree with the same seeds), shared by export-vegetation.ts (meshes) and export-tiles.ts (model sizes for the
// instance scales of vegPlacement.ts).
import { buildTree, type TreeGeometry } from '../../src/world/treeGen.ts';
import { SPECIES } from '../../src/world/treeSpecies.ts';

/** veg.regen default seed of the web game (vegetation.ts). */
export const VEG_SEED = 1;

let cached: Record<string, TreeGeometry> | undefined;
export function species(): Record<string, TreeGeometry> {
  cached ??= Object.fromEntries(SPECIES.map((sp, i) => [sp.id, buildTree(sp, VEG_SEED * 101 + i * 7)]));
  return cached;
}

export const SPECIES_IDS = SPECIES.map((s) => s.id);
export const isBush = (id: string) => SPECIES.find((s) => s.id === id)?.form === 'bush';
