import { Tree, type TreeKind } from '../../src/world/vegKinds.ts';

// Picks tree species from OSM tags and the area a tree stands in. Saarlouis has few species tags, so most trees
// get a kind from where they grow, with a deterministic random mix.

const CONIFERS = /^(Pinus|Picea|Abies|Larix|Taxus|Thuja|Pseudotsuga|Cedrus|Chamaecyparis)$/;
const FRUIT = /^(Malus|Prunus|Pyrus|Juglans|Cydonia)$/;

/** Kind of a mapped tree (natural=tree); r is a random number 0..1 for the trees without tags. */
export function treeKindOf(tags: Record<string, string>, r: number): TreeKind {
  const genus = tags.genus ?? tags.species?.split(' ')[0] ?? '';
  if (CONIFERS.test(genus) || tags.leaf_type === 'needleleaved') return Tree.conifer;
  if (genus === 'Betula') return Tree.birch;
  if (genus === 'Populus') return Tree.poplar;
  if (FRUIT.test(genus)) return Tree.fruit;
  if (genus || tags.leaf_type === 'broadleaved') return Tree.broadleaf;
  // Street and park trees here are mostly broadleaved, a few birches and conifers.
  return r < 0.08 ? Tree.birch : r < 0.13 ? Tree.conifer : Tree.broadleaf;
}

/** Kind of a tree scattered in an area with these tags (forest, park, orchard, cemetery …). */
export function areaTreeKind(tags: Record<string, string> | undefined, r: number): TreeKind {
  const lu = tags?.landuse;
  if (lu === 'orchard') return Tree.fruit;
  if (lu === 'allotments' || tags?.leisure === 'garden') return r < 0.5 ? Tree.fruit : r < 0.6 ? Tree.conifer : Tree.broadleaf;
  if (lu === 'cemetery') return r < 0.35 ? Tree.conifer : r < 0.5 ? Tree.poplar : Tree.broadleaf;
  if (lu === 'forest' || tags?.natural === 'wood') {
    // Saarland's woods are mostly beech and oak, with spruce and pine stands.
    const needle = tags?.leaf_type === 'needleleaved' ? 0.85 : tags?.leaf_type === 'mixed' ? 0.45 : 0.18;
    return r < needle ? Tree.conifer : r < needle + 0.08 ? Tree.birch : Tree.broadleaf;
  }
  return r < 0.1 ? Tree.birch : r < 0.16 ? Tree.conifer : r < 0.2 ? Tree.poplar : Tree.broadleaf;
}

/** Trees per terrain cell and bushes per terrain cell for an area, by its tags (forest or grass class). */
export function areaDensity(tags: Record<string, string> | undefined, forest: boolean): { trees: number; bushes: number } {
  if (tags?.natural === 'scrub') return { trees: 0.15, bushes: 2.5 };
  if (forest) return { trees: 2, bushes: 0.25 };
  const lu = tags?.landuse, lei = tags?.leisure;
  if (lu === 'orchard') return { trees: 0.3, bushes: 0 };
  if (lei === 'park' || lei === 'garden' || lu === 'allotments' || lu === 'cemetery') return { trees: 0.1, bushes: 0.12 };
  if (lei === 'pitch' || lei === 'playground') return { trees: 0, bushes: 0.01 };
  return { trees: 0.06, bushes: 0.04 };
}
