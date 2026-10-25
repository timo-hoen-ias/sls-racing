import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
// The models are at real size; the game draws them at VEHICLE.scale.
import { REAL_KINDS as KINDS, type VehicleKind } from '../src/traffic/trafficSim.ts';
import { proceduralVehicleSet, vehicleSetFromScene, withPack } from '../src/traffic/vehicleGlb.ts';

async function load() {
  const buf = readFileSync(new URL('../public/models/traffic.glb', import.meta.url));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  return vehicleSetFromScene(gltf.scene);
}

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('traffic GLB', () => {
  it('has variants for every kind with all five parts', async () => {
    const set = await load();
    expect(set.car.map((v) => v.name)).toEqual(['car-estate', 'car-hatch', 'car-sedan']);
    for (const kind of Object.keys(KINDS) as VehicleKind[]) {
      expect(set[kind].length).toBeGreaterThan(0);
      for (const v of set[kind]) for (const g of Object.values(v.lod0)) expect(g.getAttribute('position').count).toBeGreaterThan(0);
    }
  });

  it('fits the simulation sizes and stands on the ground, front at +z', async () => {
    const set = await load();
    for (const kind of Object.keys(KINDS) as VehicleKind[])
      for (const v of set[kind]) {
        const box = new THREE.Box3().setFromBufferAttribute(v.lod0.paint.getAttribute('position') as THREE.BufferAttribute)
          .union(new THREE.Box3().setFromBufferAttribute(v.lod0.detail.getAttribute('position') as THREE.BufferAttribute));
        const spec = KINDS[kind];
        expect(box.min.y).toBeCloseTo(0, 1);
        expect(box.max.z - box.min.z).toBeLessThan(spec.length + 0.3);
        expect(box.max.x - box.min.x).toBeLessThan(spec.width + 0.4);
        expect(box.max.y).toBeLessThan(spec.height + 0.3);
        // Head lights in front, tail lights behind.
        const lights = v.lod0.lights.getAttribute('position') as THREE.BufferAttribute;
        const zs = Array.from({ length: lights.count }, (_, i) => lights.getZ(i));
        expect(Math.max(...zs)).toBeGreaterThan(spec.length / 2 - 0.4);
        expect(Math.min(...zs)).toBeLessThan(-spec.length / 2 + 0.4);
        expect(v.lod0.detail.getAttribute('color')).toBeDefined();
      }
  });

  it('keeps the far level of detail cheaper and the procedural fallback in the same shape', async () => {
    const set = await load();
    for (const v of set.car) expect(tris(v.lod1.paint) + tris(v.lod1.detail)).toBeLessThan((tris(v.lod0.paint) + tris(v.lod0.detail)) * 0.6);
    const proc = proceduralVehicleSet();
    expect(Object.keys(proc).sort()).toEqual(Object.keys(set).sort());
  });
});

// The CC-BY passenger car pack (tools/import-traffic.ts) over the Blender set: what main.ts loads by default.
async function loadPack() {
  const buf = readFileSync(new URL('../public/models/traffic-cars.glb', import.meta.url));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  return { gltf, pack: vehicleSetFromScene(gltf.scene, false) };
}

describe('passenger car pack', () => {
  it('replaces the Blender cars, adds to the vans and keeps buses and lorries', async () => {
    const [base, { gltf, pack }] = await Promise.all([load(), loadPack()]);
    expect((gltf.parser.json.asset.extras as { source: string }).source).toMatch(/CC BY 4\.0/);
    expect(pack.bus).toEqual([]);
    const set = withPack(base, pack);
    expect(set.car.map((v) => v.name)).toEqual(['car-compact', 'car-coupe', 'car-hatchback', 'car-offroad', 'car-saloon', 'car-sport', 'car-suv', 'car-wagon']);
    expect(set.van.map((v) => v.name)).toEqual(['van-panel', 'van-minivan', 'van-pickup']);
    expect(set.bus).toBe(base.bus);
    expect(set.truck).toBe(base.truck);
  });

  it('fits the simulation sizes with lacquer, lights and a cheaper far level', async () => {
    const { pack } = await loadPack();
    for (const kind of ['car', 'van'] as const)
      for (const v of pack[kind]!) {
        const box = new THREE.Box3().setFromBufferAttribute(v.lod0.paint.getAttribute('position') as THREE.BufferAttribute)
          .union(new THREE.Box3().setFromBufferAttribute(v.lod0.detail.getAttribute('position') as THREE.BufferAttribute));
        const spec = KINDS[kind];
        expect(box.min.y, v.name).toBeCloseTo(0, 1);
        expect(box.max.z - box.min.z, v.name).toBeGreaterThan(3.2);
        expect(box.max.z - box.min.z, v.name).toBeLessThan(spec.length + 0.3);
        expect(box.max.x - box.min.x, v.name).toBeLessThan(spec.width + 0.4);
        expect(box.max.y, v.name).toBeLessThan(spec.height + 0.3);
        expect(Math.abs(box.max.z + box.min.z), v.name).toBeLessThan(0.1);
        // Brake lights at the back, every part present, lacquer a real share of the car.
        const brake = v.lod0.brake.getAttribute('position') as THREE.BufferAttribute;
        expect(brake.count, v.name).toBeGreaterThan(0);
        for (let i = 0; i < brake.count; i++) expect(brake.getZ(i), v.name).toBeLessThan(0);
        for (const g of Object.values(v.lod0)) expect(g.getAttribute('position').count, v.name).toBeGreaterThan(0);
        expect(tris(v.lod0.paint) / (tris(v.lod0.paint) + tris(v.lod0.detail)), v.name).toBeGreaterThan(0.15);
        expect(tris(v.lod1.paint) + tris(v.lod1.detail), v.name).toBeLessThan((tris(v.lod0.paint) + tris(v.lod0.detail)) * 0.6);
      }
  });
});
