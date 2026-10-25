import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { boundingRect, buildGardens, houseKindOf, houseRecords, planHouses } from '../pipeline/lib/houses.ts';
import { houseSetFromScene } from '../src/world/houseGlb.ts';
import { GARDEN_PARTS, GARDEN_STRIDE, HOUSE_MODELS, HOUSE_STRIDE } from '../src/world/houseKinds.ts';
import { gardenMatrices, houseMatrices } from '../src/world/houses.ts';
import type { WorldInfo } from '../src/world/format.ts';

const box = (g: THREE.BufferGeometry) => new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);

async function load() {
  const buf = readFileSync(new URL('../public/models/houses.glb', import.meta.url));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  return houseSetFromScene(gltf.scene);
}

describe('houses GLB', () => {
  it('has every catalogue model with both LODs, glass and its footprint', async () => {
    const set = await load();
    expect(HOUSE_MODELS.filter((m) => m.kind === 'haus').length).toBe(30);
    for (const m of HOUSE_MODELS) {
      const h = set.houses[m.id];
      expect(h, m.id).toBeDefined();
      expect(h.glass0.getAttribute('position')?.count ?? 0, `${m.id} Glas`).toBeGreaterThan(0);
      for (const g of [h.lod0, h.lod1]) {
        expect(g.getAttribute('uv'), `${m.id} uv`).toBeDefined();
        expect(g.getAttribute('color'), `${m.id} Farben`).toBeDefined();
      }
      const b = box(h.lod0);
      // Walls fill the footprint; eaves, porches and steps may reach a little further, the plinth into the ground.
      expect(b.max.x - b.min.x, `${m.id} Breite`).toBeGreaterThan(m.w - 0.2);
      expect(Math.max(b.max.x, -b.min.x), `${m.id} Seiten`).toBeLessThanOrEqual(m.w / 2 + m.reach);
      expect(-b.min.z, `${m.id} hinten`).toBeLessThanOrEqual(m.d / 2 + m.reach);
      expect(b.max.z, `${m.id} vorne`).toBeLessThanOrEqual(m.d / 2 + m.front);
      expect(b.min.y).toBeCloseTo(-2.5, 1);
      // LOD 1 is clearly lighter.
      const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      expect(tris(h.lod1), `${m.id} LOD 1`).toBeLessThan(tris(h.lod0) * 0.8);
    }
    for (const p of GARDEN_PARTS) expect(set.gardens[p], p).toBeDefined();
  });
});

const world: WorldInfo = { originE: 0, originN: 0, tileSize: 256 } as WorldInfo;
const rect = (e: number, n: number, w: number, d: number, a = 0): [number, number][] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => [e + x * c - y * s, n + x * s + y * c]);
};

describe('house planning', () => {
  it('finds the rotated rectangle of a footprint', () => {
    const r = boundingRect(rect(10, 20, 12, 8, 0.4))!;
    expect(r.e).toBeCloseTo(10);
    expect(r.n).toBeCloseTo(20);
    expect(r.a * r.b * 4).toBeCloseTo(96, 3);
  });

  it('classifies homes, villas and administrative buildings', () => {
    const c = (fn: string) => ({ key: 'x', outer: [], tags: {}, fn });
    expect(houseKindOf(c('31001_1000'), 110)).toBe('haus');
    expect(houseKindOf(c('31001_1000'), 300)).toBe('villa');
    expect(houseKindOf(c('31001_3012'), 900)).toBe('gross');
    expect(houseKindOf(c('31001_2463'), 30)).toBeUndefined();
    expect(houseKindOf({ key: 'o', outer: [], tags: { building: 'house' } }, 100)).toBe('haus');
  });

  // A street along n = -14 (the road mask covers n < -10), houses north of it.
  const opts = (footprints: { key: string; ring: [number, number][] }[]) => ({
    world, height: () => 0, onRoad: (_e: number, n: number) => n < -10, onPath: () => false, centre: () => 2000, footprints,
  });

  it('turns a detached house towards the street and keeps it and its garden off the road', () => {
    const house = rect(0, 0, 11, 9);
    const garage = rect(7.0, 0, 3, 6);
    const plan = planHouses([{ key: 'L1', outer: house, tags: { building: 'house' }, fn: '31001_1000' }], opts([{ key: 'L1', ring: house }, { key: 'L2', ring: garage }]));
    expect(plan.plans.length).toBe(1);
    const p = plan.plans[0];
    // Front faces south (the street) and the garage beside it goes with the plot.
    expect(p.fn).toBeCloseTo(-1);
    expect(plan.replaced.has('L2')).toBe(true);
    const recs = houseRecords(plan.plans, world).tiles;
    const all = [...recs.values()].flat();
    expect(all.length).toBe(HOUSE_STRIDE);
    const g = buildGardens(plan.plans, { world, height: () => 0, onRoad: (_e, n) => n < -10, onPath: () => false, inBuilding: () => false });
    expect(g.gardens).toBe(1);
    const parts = [...g.tiles.values()].flat();
    expect(parts.length / GARDEN_STRIDE).toBeGreaterThan(5);
    for (let o = 0; o < parts.length; o += GARDEN_STRIDE) expect(-parts[o + 3], GARDEN_PARTS[parts[o]]).toBeGreaterThan(-10);
    // Matrices for the game: one per record.
    expect(houseMatrices(new Float32Array(all)).length).toBe(16);
    expect(gardenMatrices(new Float32Array(parts)).length).toBe((parts.length / GARDEN_STRIDE) * 16);
  });

  it('leaves semi-detached houses and houses the model would push onto the road alone', () => {
    const a = rect(0, 0, 10, 9), b = rect(10.5, 0, 10, 9);
    const semi = planHouses([{ key: 'O1', outer: a, tags: { building: 'house' } }], opts([{ key: 'O1', ring: a }, { key: 'O2', ring: b }]));
    expect(semi.plans.length).toBe(0);
    const tight = rect(0, -4.5, 10, 9);
    const road = planHouses([{ key: 'O3', outer: tight, tags: { building: 'house' } }], opts([{ key: 'O3', ring: tight }]));
    expect(road.plans.length).toBe(0);
  });
});
