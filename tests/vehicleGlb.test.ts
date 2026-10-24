import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { KINDS, type VehicleKind } from '../src/traffic/trafficSim.ts';
import { proceduralVehicleSet, vehicleSetFromScene } from '../src/traffic/vehicleGlb.ts';

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
