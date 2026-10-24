import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { areaDensity, areaTreeScale } from '../pipeline/lib/vegetation.ts';
import { buildTree, triangles } from '../src/world/treeGen.ts';
import { BARKS, FOLIAGE_GRID, LEAF_CARDS, SPECIES } from '../src/world/treeSpecies.ts';
import { speciesOf } from '../src/world/vegetation.ts';
import { Tree } from '../src/world/vegKinds.ts';

describe('generated trees', () => {
  it('every species references a leaf card and a bark that exist, and the cards fit the atlas', () => {
    expect(LEAF_CARDS.length).toBeLessThanOrEqual(FOLIAGE_GRID * FOLIAGE_GRID);
    for (const sp of SPECIES) {
      expect(LEAF_CARDS.some((c) => c.id === sp.leaf), sp.id).toBe(true);
      expect(BARKS.some((b) => b.id === sp.bark), sp.id).toBe(true);
    }
  });

  it('builds both levels of detail within the triangle budget', () => {
    for (const sp of SPECIES) {
      const g = buildTree(sp, 7);
      const [t0, t1] = g.lods.map(triangles);
      expect(t0, sp.id).toBeLessThanOrEqual(3600);
      expect(t1, sp.id).toBeLessThanOrEqual(1000);
      expect(t1 * 2, sp.id).toBeLessThan(t0);
      for (const lod of g.lods) {
        for (const a of ['position', 'normal', 'uv', 'color', 'wind']) expect(lod.getAttribute(a), `${sp.id} ${a}`).toBeDefined();
        // Wood and leaves.
        expect(lod.groups.length).toBe(2);
      }
    }
  });

  it('stands on the origin at about the species height, as wide as its crown', () => {
    for (const sp of SPECIES) {
      const g = buildTree(sp, 3);
      const box = new THREE.Box3().setFromBufferAttribute(g.lods[0].getAttribute('position') as THREE.BufferAttribute);
      expect(box.min.y, sp.id).toBeGreaterThan(-0.5);
      expect(box.max.y, sp.id).toBeGreaterThan(sp.height * 0.85);
      expect(box.max.y, sp.id).toBeLessThan(sp.height * 1.2 + sp.card * 0.6);
      expect(g.height).toBeCloseTo(box.max.y, 3);
      expect(g.boxR, sp.id).toBeGreaterThan(sp.crown * 0.7);
      expect(g.boxR, sp.id).toBeLessThan(sp.crown * 1.5 + sp.card);
      expect(g.boxH).toBeGreaterThanOrEqual(box.max.y);
    }
  });

  it('maps leaf cards into their own atlas cell and wind from 0 at the foot', () => {
    const sp = SPECIES.find((s) => s.id === 'linde')!;
    const g = buildTree(sp, 1).lods[0];
    const cell = LEAF_CARDS.findIndex((c) => c.id === sp.leaf);
    const leaves = g.groups[1];
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const idx = g.index!;
    const u0 = (cell % FOLIAGE_GRID) / FOLIAGE_GRID, v1 = 1 - Math.floor(cell / FOLIAGE_GRID) / FOLIAGE_GRID;
    for (let i = leaves.start; i < leaves.start + leaves.count; i++) {
      const k = idx.getX(i);
      expect(uv.getX(k)).toBeGreaterThanOrEqual(u0);
      expect(uv.getX(k)).toBeLessThanOrEqual(u0 + 1 / FOLIAGE_GRID);
      expect(uv.getY(k)).toBeLessThanOrEqual(v1);
      expect(uv.getY(k)).toBeGreaterThanOrEqual(v1 - 1 / FOLIAGE_GRID);
    }
    const wind = g.getAttribute('wind') as THREE.BufferAttribute;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.2) expect(wind.getX(i)).toBeLessThan(0.1);
  });

  it('is the same tree for the same seed', () => {
    const sp = SPECIES[0];
    const a = buildTree(sp, 5).lods[0].getAttribute('position').array;
    const b = buildTree(sp, 5).lods[0].getAttribute('position').array;
    expect(Array.from(a.slice(0, 300))).toEqual(Array.from(b.slice(0, 300)));
  });
});

describe('species mix and density', () => {
  const share = (kind: number, forest: boolean) => {
    const n = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const s = speciesOf(kind as 0, forest, i / 1000);
      n.set(s, (n.get(s) ?? 0) + 1);
    }
    return n;
  };

  it('grows beech and oak in woods, lime and maple in town', () => {
    const wood = share(Tree.broadleaf, true), town = share(Tree.broadleaf, false);
    expect((wood.get('buche') ?? 0) + (wood.get('eiche') ?? 0)).toBeGreaterThan(800);
    expect(wood.get('linde')).toBeUndefined();
    expect((town.get('linde') ?? 0) + (town.get('ahorn') ?? 0)).toBeGreaterThan(400);
    expect([...share(Tree.conifer, true).keys()].sort()).toEqual(['fichte', 'kiefer']);
    expect(share(Tree.birch, false).get('birke')).toBe(1000);
  });

  it('plants woods densely and tall, parks more than plain grass', () => {
    expect(areaDensity({ landuse: 'forest' }, true).trees).toBeGreaterThanOrEqual(2.5);
    expect(areaDensity({ leisure: 'park' }, false).trees).toBeGreaterThan(areaDensity({ landuse: 'grass' }, false).trees * 3);
    expect(areaTreeScale({ landuse: 'forest' }, true, 0)).toBeGreaterThan(areaTreeScale({ leisure: 'park' }, false, 1) - 0.01);
  });
});
