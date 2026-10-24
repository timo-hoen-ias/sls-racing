import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { Debris } from '../src/render/debris.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { Knockdown } from '../src/world/knockdown.ts';
import type { Knockable, KnockableSource } from '../src/world/streamer.ts';

beforeAll(async () => {
  await RAPIER.init();
});

function setup() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 500;
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
  // A lamp 30 m ahead (north = -z).
  const lamp = world.createCollider(RAPIER.ColliderDesc.cylinder(3.5, 0.12).setTranslation(0, 3.5, -30), ground);
  const info: Knockable = { kind: 'lamp', tileKey: 't', index: 0, x: 0, y: 0, z: -30, heading: 0, size: 7 };
  let removed = false;
  const source: KnockableSource = {
    lookup: (c) => (!removed && c.handle === lamp.handle ? info : undefined),
    remove: (c) => { removed = true; world.removeCollider(c, true); },
  };
  const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0);
  const debris = new Debris(RAPIER, world);
  const kd = new Knockdown(world, car, debris);
  kd.addSource(source, () => [new THREE.Mesh(new THREE.BoxGeometry(0.2, 7, 0.2).translate(0, 3.5, 0))], 90);
  const drive = (throttle: number, seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      car.update({ throttle, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false }, 1 / 60);
      kd.step(1 / 60);
      world.step();
      debris.update(1 / 60);
    }
  };
  return { car, kd, debris, drive, isRemoved: () => removed };
}

describe('Knockdown', () => {
  it('knocks a lamp over at speed and the car keeps going', () => {
    const { car, kd, debris, drive, isRemoved } = setup();
    drive(0, 1);
    while (car.body.translation().z > -20) drive(1, 1 / 60);
    const v0 = car.speed;
    drive(0.3, 1);
    expect(isRemoved()).toBe(true);
    expect(kd.count).toBe(1);
    expect(debris.count).toBe(1);
    expect(car.body.translation().z).toBeLessThan(-32);
    expect(car.speed).toBeGreaterThan(v0 * 0.7);
  });

  it('stops at a lamp when crawling', () => {
    const { car, drive, isRemoved } = setup();
    drive(0, 1);
    for (let i = 0; i < 60 * 30 && car.body.translation().z > -29.5; i++) drive(car.speed < 2 ? 0.3 : 0, 1 / 60);
    for (let i = 0; i < 120; i++) drive(car.speed < 2 ? 0.3 : 0, 1 / 60);
    expect(isRemoved()).toBe(false);
    expect(car.body.translation().z).toBeGreaterThan(-30);
  });
});
