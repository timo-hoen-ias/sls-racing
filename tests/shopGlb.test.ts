import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { SHOP_TYPES, shopSetFromScene } from '../src/world/shopGlb.ts';
import { withoutTextures } from './glbWithoutTextures.ts';

async function load() {
  const buf = readFileSync(new URL('../public/models/shops.glb', import.meta.url));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(withoutTextures(buf), '');
  return shopSetFromScene(gltf.scene);
}

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const box = (g: THREE.BufferGeometry) => new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);

describe('shops GLB', () => {
  it('has every part and sign type, within the triangle budget', async () => {
    const set = await load();
    for (const p of ['markise', 'markise-kasten', 'nasenschild', 'ladenschild', 'cafe-tisch', 'aufsteller']) expect(set.parts[p], p).toBeDefined();
    for (const t of SHOP_TYPES) expect(set.faces[t], t).toBeDefined();
    let total = 0;
    for (const p of Object.values(set.parts)) total += tris(p.lod0);
    for (const f of Object.values(set.faces)) total += tris(f.fascia) + tris(f.projecting);
    expect(total).toBeLessThan(3000);
  });

  it('wall parts sit on the facade plane at the agreed heights', async () => {
    const set = await load();
    const awning = box(set.parts.markise.lod0);
    expect(awning.min.z).toBeGreaterThan(-0.05);
    expect(awning.max.z).toBeCloseTo(1.4, 1);
    expect(awning.min.y).toBeGreaterThan(2.1);
    expect(awning.max.x - awning.min.x).toBeCloseTo(1, 1);
    const fascia = box(set.parts.ladenschild.lod0);
    expect(fascia.min.y).toBeCloseTo(2.6, 1);
    expect(fascia.max.y).toBeCloseTo(3.1, 1);
    const face = box(set.faces.baeckerei.fascia);
    expect(face.max.z).toBeGreaterThanOrEqual(fascia.max.z - 1e-4); // in front of the board
    expect(set.faces.baeckerei.fascia.getAttribute('uv')).toBeDefined();
    const sign = box(set.parts.nasenschild.lod0);
    expect(sign.max.z).toBeGreaterThan(0.75);
    expect(sign.max.y).toBeGreaterThan(3.2);
  });
});
