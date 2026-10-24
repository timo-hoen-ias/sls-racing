import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { CarDamage } from '../src/vehicle/damage.ts';
import { sportsCarFromScene, triangleCount } from '../src/vehicle/sportsCarGlb.ts';

async function load() {
  const buf = readFileSync(new URL('../public/models/sportscar.glb', import.meta.url));
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, '');
  return sportsCarFromScene(gltf.scene, '#2050c0');
}

describe('sports car GLB', () => {
  it('has three body LODs, the breakable parts and the effect anchors', async () => {
    const car = await load();
    const lod = car.body.getObjectByName('bodyLod') as THREE.LOD;
    expect(lod.levels.length).toBe(3);
    for (const part of ['splitter', 'wing', 'mirrorL', 'mirrorR', 'plate']) expect(car.body.getObjectByName(part)?.userData.part).toBe(part);
    // Anchors match the procedural car (tailpipes behind the bumper, lamps up front, left first).
    expect(car.exhausts[0].x).toBeGreaterThan(0);
    expect(car.exhausts[0].z).toBeLessThan(-2.2);
    expect(car.headlights[1].x).toBeLessThan(0);
    expect(car.headlights[1].z).toBeGreaterThan(1.9);
    expect(car.materials.paint.color.getHexString()).toBe('2050c0');
    const tris = triangleCount(car.body);
    expect(tris).toBeGreaterThan(10000);
    expect(tris).toBeLessThan(60000);
  });

  it('fits the physics: wheels on the axles, body within the collider footprint', async () => {
    const car = await load();
    const box = new THREE.Box3().setFromObject((car.body.getObjectByName('bodyLod') as THREE.LOD).levels[0].object);
    expect(box.min.y).toBeGreaterThanOrEqual(0.1);
    expect(box.max.z).toBeLessThan(2.4);
    expect(box.min.z).toBeGreaterThan(-2.4);
    expect(box.max.x).toBeLessThan(1.0);
    const w = car.makeWheel(-1);
    const wb = new THREE.Box3().setFromObject(w.spin);
    expect(wb.max.y).toBeCloseTo(0.35, 1);
    expect(wb.min.x).toBeLessThan(-0.1); // mirrored for the right side
  });

  it('dents in model space (float positions) and repairs', async () => {
    const car = await load();
    const damage = new CarDamage(car.body, car.materials.paint);
    const shell = car.body.getObjectByName('lod0')!;
    const before = new THREE.Box3().setFromObject(shell);
    damage.hit(new THREE.Vector3(0, 0, 1), 1);
    const after = new THREE.Box3().setFromObject(shell);
    expect(after.max.z).toBeLessThan(before.max.z - 0.02);
    damage.repair();
    expect(new THREE.Box3().setFromObject(shell).max.z).toBeCloseTo(before.max.z, 4);
  });
});

describe('alternative player cars', () => {
  it('hot hatch loads with the same loader, layout and wheel positions', async () => {
    const buf = readFileSync(new URL('../public/models/cars/hothatch.glb', import.meta.url));
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    const extras = gltf.scene.getObjectByName('car')!.userData;
    expect(extras.name).toBe('Hot Hatch');
    expect(extras.wheel.front).toBeCloseTo(1.27, 2);
    expect(extras.wheel.rear).toBeCloseTo(-1.2, 2);
    expect(extras.length).toBeLessThan(4.2);
    const car = sportsCarFromScene(gltf.scene, '#ffcc00');
    expect((car.body.getObjectByName('bodyLod') as THREE.LOD).levels.length).toBe(3);
    const box = new THREE.Box3().setFromObject((car.body.getObjectByName('bodyLod') as THREE.LOD).levels[0].object);
    expect(box.max.y).toBeGreaterThan(1.35);
    expect(Math.abs(box.max.z - box.min.z - extras.length)).toBeLessThan(0.15); // plus tailpipes
    expect(car.exhausts.length).toBe(2);
  });
});
