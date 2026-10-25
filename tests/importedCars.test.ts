import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { applyCar, findCar } from '../src/vehicle/cars.ts';
import { sportsCarFromScene, triangleCount } from '../src/vehicle/sportsCarGlb.ts';
import { VEHICLE } from '../src/vehicle/tuning.ts';
import { withoutTextures } from './glbWithoutTextures.ts';

// The CC-BY models brought in by tools/import-car.ts: same loader and layout as the Blender cars, plus the
// source credit, the colour-changeable lacquer split from the body texture, and physics that fits them.

const IMPORTED = ['coupe', 'sedan', 'goblin', 'offroad'] as const;
/** Length range (m) and LOD 0 triangle budget: the off-roader comes from the lighter traffic pack. */
const SIZE: Record<string, { length: [number, number]; tris: [number, number] }> = {
  offroad: { length: [3.7, 4.3], tris: [3000, 20000] },
};
const DEFAULT_SIZE = { length: [4.2, 5.1], tris: [30000, 120000] };

async function load(id: string) {
  const buf = readFileSync(new URL(`../public/models/cars/${id}.glb`, import.meta.url));
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(withoutTextures(buf), '');
}

const GAME_SCALE = VEHICLE.scale;
beforeAll(async () => {
  await RAPIER.init();
  VEHICLE.scale = 1;
});
afterAll(() => {
  VEHICLE.scale = GAME_SCALE;
  applyCar(findCar('sportscar')!);
});

describe('imported car models', () => {
  for (const id of IMPORTED) {
    it(`${id}: layout, credit, paint and dimensions`, async () => {
      const gltf = await load(id);
      const car = sportsCarFromScene(gltf.scene, '#ff00ff');
      expect(findCar(id)?.url).toMatch(new RegExp(`cars/${id}\\.glb$`));
      const geo = car.geometry!;
      expect(geo.source).toMatch(/CC BY 4\.0/);
      const size = SIZE[id] ?? DEFAULT_SIZE;
      expect(geo.length).toBeGreaterThan(size.length[0]);
      expect(geo.length).toBeLessThan(size.length[1]);
      expect(geo.wheel.front).toBeGreaterThan(0.9);
      expect(geo.wheel.rear).toBeLessThan(-0.9);
      expect(geo.wheel.track).toBeGreaterThan(1.4);
      expect(geo.wheel.radius).toBeGreaterThan(0.3);
      expect(geo.wheel.radius).toBeLessThan(0.4);
      const lod = car.body.getObjectByName('bodyLod') as THREE.LOD;
      expect(lod.levels.length).toBe(3);
      // The lacquer is the game's paint material (car.color works) and covers a good part of the body.
      let painted = 0, all = 0;
      lod.levels[0].object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const n = (m.geometry.index?.count ?? 0) / 3;
        all += n;
        if (m.material === car.materials.paint) painted += n;
      });
      expect(car.materials.paint.color.getHexString()).toBe('ff00ff');
      expect(painted / all).toBeGreaterThan(0.2);
      // Body on the ground, wheels on it, effect anchors at the ends.
      const box = new THREE.Box3().setFromObject(lod.levels[0].object);
      expect(box.min.y).toBeGreaterThan(-0.02);
      expect(Math.abs(box.max.z - box.min.z - geo.length)).toBeLessThan(0.05);
      const wb = new THREE.Box3().setFromObject(car.makeWheel(1).spin);
      expect(wb.max.y).toBeCloseTo(geo.wheel.radius, 1);
      // Brake lights (where the model has them) at the back: the car points to +z.
      const brake = new THREE.Box3();
      lod.levels[0].object.traverse((o) => { if ((o as THREE.Mesh).material === car.materials.brake) brake.expandByObject(o); });
      if (!brake.isEmpty()) expect(brake.max.z).toBeLessThan(0);
      expect(car.headlights[0].z).toBeGreaterThan(1.5);
      expect(car.exhausts[0].z).toBeLessThan(-1.5);
      // Detailed but within budget for the one player car; the far levels are much lighter.
      const tris = triangleCount(car.body);
      expect(tris).toBeGreaterThan(size.tris[0]);
      expect(tris).toBeLessThan(size.tris[1]);
      lod.levels.forEach((l, i) => i > 0 && expect(triangleCount(l.object)).toBeLessThan(tris * (id === 'offroad' ? 0.6 : 0.4)));
    });
  }

  it('each imported car drives, corners and brakes upright with its own wheels', async () => {
    for (const id of IMPORTED) {
      const geo = sportsCarFromScene((await load(id)).scene).geometry;
      applyCar(findCar(id)!, geo);
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      world.timestep = 1 / 60;
      const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const s = 2000;
      world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
      const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0);
      const idle = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
      const drive = (input: typeof idle, seconds: number) => {
        for (let i = 0; i < seconds * 60; i++) {
          car.update(input, 1 / 60);
          world.step();
        }
      };
      drive(idle, 1);
      drive({ ...idle, throttle: 1 }, 5);
      expect(Math.abs(car.speed) * 3.6, id).toBeGreaterThan(100);
      expect(Math.abs(car.body.translation().x), id).toBeLessThan(2);
      drive({ ...idle, throttle: 0.4, steer: 0.6 }, 3);
      let r = car.body.rotation();
      expect(1 - 2 * (r.x * r.x + r.z * r.z), id).toBeGreaterThan(0.9);
      drive({ ...idle, throttle: 0.3 }, 2);
      // Held longer, the brake pedal selects reverse: look for the stop.
      let slowest = Infinity;
      for (let i = 0; i < 6 * 60 && car.speed > -1; i++) {
        drive({ ...idle, brake: 1 }, 1 / 60);
        slowest = Math.min(slowest, Math.abs(car.speed));
      }
      expect(slowest, id).toBeLessThan(0.5);
      r = car.body.rotation();
      expect(1 - 2 * (r.x * r.x + r.z * r.z), id).toBeGreaterThan(0.95);
    }
  });
});
