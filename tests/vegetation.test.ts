import { describe, expect, it } from 'vitest';
import { areaDensity, areaTreeKind, treeKindOf } from '../pipeline/lib/vegetation.ts';
import { Tree } from '../src/world/vegKinds.ts';

describe('tree species', () => {
  it('reads genus, species and leaf type', () => {
    expect(treeKindOf({ genus: 'Picea' }, 0.5)).toBe(Tree.conifer);
    expect(treeKindOf({ species: 'Betula pendula' }, 0.5)).toBe(Tree.birch);
    expect(treeKindOf({ leaf_type: 'needleleaved' }, 0.5)).toBe(Tree.conifer);
    expect(treeKindOf({ genus: 'Platanus' }, 0.01)).toBe(Tree.broadleaf);
    expect(treeKindOf({ genus: 'Malus' }, 0.5)).toBe(Tree.fruit);
  });

  it('mixes untagged trees by area', () => {
    const share = (tags: Record<string, string>, kind: number) => {
      let n = 0;
      for (let i = 0; i < 1000; i++) if (areaTreeKind(tags, i / 1000) === kind) n++;
      return n / 1000;
    };
    expect(share({ landuse: 'forest', leaf_type: 'needleleaved' }, Tree.conifer)).toBeGreaterThan(0.8);
    expect(share({ landuse: 'forest' }, Tree.broadleaf)).toBeGreaterThan(0.6);
    expect(share({ landuse: 'orchard' }, Tree.fruit)).toBe(1);
  });

  it('puts bushes, not a wood, on scrub', () => {
    const scrub = areaDensity({ natural: 'scrub' }, true);
    const wood = areaDensity({ landuse: 'forest' }, true);
    expect(scrub.bushes).toBeGreaterThan(scrub.trees * 5);
    expect(wood.trees).toBeGreaterThan(scrub.trees);
  });
});
