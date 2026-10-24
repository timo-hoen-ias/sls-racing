import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { SPECIES_BY_KIND, vegetationFromScene } from '../src/world/vegGlb.ts';
import { withoutTextures } from './glbWithoutTextures.ts';

async function load() {
  const buf = readFileSync(new URL('../public/models/vegetation.glb', import.meta.url));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(withoutTextures(buf), '');
  return vegetationFromScene(gltf.scene);
}

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('vegetation GLB', () => {
  it('has every species of every kind with lod0, lod1 and billboards for trees', async () => {
    const set = await load();
    for (const [kind, ids] of Object.entries(SPECIES_BY_KIND))
      for (const id of ids) {
        const s = set.species[id];
        expect(s, id).toBeDefined();
        expect(s.kind).toBe(kind);
        expect(tris(s.lod0)).toBeLessThanOrEqual(800);
        expect(tris(s.lod1)).toBeLessThanOrEqual(120);
        expect(tris(s.lod1)).toBeLessThan(tris(s.lod0));
        expect(s.lod0.getAttribute('color'), `${id} color`).toBeDefined();
        expect(s.lod0.getAttribute('wind')).toBeDefined();
        if (!['busch', 'gebuesch', 'hecke'].includes(id)) {
          expect(s.billboard && tris(s.billboard)).toBe(4);
          expect(s.billboard!.getAttribute('uv'), `${id} uv`).toBeDefined();
        }
      }
  });

  it('stands on the origin: trees 8 m tall, bushes about 1.5 m, hedge 1 m along z', async () => {
    const set = await load();
    for (const s of Object.values(set.species)) {
      const box = new THREE.Box3().setFromBufferAttribute(s.lod0.getAttribute('position') as THREE.BufferAttribute);
      expect(box.min.y).toBeLessThanOrEqual(0.05);
      expect(Math.abs((box.min.x + box.max.x) / 2)).toBeLessThan(1.2);
      if (s.billboard) expect(box.max.y).toBeCloseTo(8, 1);
      else expect(box.max.y).toBeLessThan(2);
      expect(s.height).toBeCloseTo(box.max.y, 1);
    }
    const hedge = new THREE.Box3().setFromBufferAttribute(set.species.hecke.lod0.getAttribute('position') as THREE.BufferAttribute);
    expect(hedge.max.z - hedge.min.z).toBeCloseTo(1, 2);
    expect(hedge.max.x - hedge.min.x).toBeLessThan(1);
  });
});
