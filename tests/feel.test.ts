import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { WallGlide } from '../src/game/forgive.ts';
import type { DriveInput } from '../src/input/input.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { FEEL } from '../src/game/feel.ts';

beforeAll(async () => {
  await RAPIER.init();
});

function setup(feel: 'fun' | 'real', wall = false) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 120;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 3000;
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
  // A long wall along x = 4 (east of the car), for glancing hits.
  if (wall) world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 2, 1500).setTranslation(4.5, 2, 0), ground);
  const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0);
  Object.assign(car.feel, FEEL[feel].car);
  car.burst.enabled = FEEL[feel].burst;
  const glide = new WallGlide();
  glide.enabled = FEEL[feel].glide;
  const drive = (input: Partial<DriveInput>, seconds: number) => {
    const full: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false, ...input };
    for (let i = 0; i < seconds * 120; i++) {
      const v = car.body.linvel();
      const before = { x: v.x, y: v.y, z: v.z };
      car.update(full, 1 / 120);
      world.step();
      glide.apply(car.body, before);
    }
  };
  return { world, car, drive, glide };
}

describe('game feel', () => {
  it('fun accelerates harder than real', () => {
    const fun = setup('fun');
    const real = setup('real');
    for (const s of [fun, real]) { s.drive({}, 1); s.drive({ throttle: 1 }, 6); }
    expect(fun.car.speed).toBeGreaterThan(real.car.speed * 1.05);
  });

  it('a short nitro tap fires a burst forward', () => {
    const { car, drive } = setup('fun');
    drive({}, 1);
    drive({ throttle: 1 }, 2);
    const v0 = car.speed;
    const n0 = car.nitro;
    drive({ throttle: 1, nitro: true }, 0.1);
    drive({ throttle: 1 }, 1 / 60);
    expect(car.nitro).toBeLessThan(n0 - 0.1);
    drive({ throttle: 1 }, 0.2);
    const { car: ref, drive: driveRef } = setup('fun');
    driveRef({}, 1);
    driveRef({ throttle: 1 }, 2.3 + 1 / 60);
    expect(car.speed).toBeGreaterThan(ref.speed + 3);
    expect(v0).toBeGreaterThan(0);
  });

  it('glides along a wall it scrapes at a shallow angle instead of stopping', () => {
    const run = (feel: 'fun' | 'real') => {
      const { car, drive } = setup(feel, true);
      drive({}, 1);
      drive({ throttle: 1 }, 3);
      // Veer right into the wall at speed.
      drive({ throttle: 1, steer: 0.35 }, 0.6);
      drive({ throttle: 0.5 }, 1);
      return Math.abs(car.speed);
    };
    const fun = run('fun');
    const real = run('real');
    expect(fun).toBeGreaterThan(15);
    expect(fun).toBeGreaterThan(real);
  });

  it('levels itself in the air', () => {
    const { car, drive } = setup('fun');
    drive({}, 1);
    // Launch it high with a roll.
    car.body.setTranslation({ x: 0, y: 30, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 2 }, true);
    drive({}, 1.6);
    const r = car.body.rotation();
    const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
    expect(upY).toBeGreaterThan(0.9);
  });

  it('a handbrake pull starts a drift that holds without the handbrake (F2)', () => {
    const slipOf = (car: CarPhysics) => {
      const v = car.body.linvel();
      const r = car.body.rotation();
      // Body forward (+z) and left (+x) in the world.
      const fx = 2 * (r.x * r.z + r.w * r.y), fz = 1 - 2 * (r.x * r.x + r.y * r.y);
      const lx = 1 - 2 * (r.y * r.y + r.z * r.z), lz = 2 * (r.x * r.z - r.w * r.y);
      return Math.atan2(v.x * lx + v.z * lz, v.x * fx + v.z * fz);
    };
    const run = (latch: boolean) => {
      const { car, drive } = setup('fun');
      car.driftKit.enabled = latch;
      drive({}, 1);
      drive({ throttle: 1 }, 3.5);
      drive({ throttle: 1, steer: 0.6, handbrake: true }, 0.35);
      let most = 0;
      for (let i = 0; i < 15; i++) { drive({ throttle: 0.9, steer: 0.15 }, 0.1); most = Math.max(most, Math.abs(slipOf(car))); }
      return { car, most, slip: Math.abs(slipOf(car)) };
    };
    const on = run(true);
    const off = run(false);
    expect(on.car.driftDir).toBe(1);
    expect(on.slip).toBeGreaterThan(0.2);
    expect(on.slip).toBeGreaterThan(off.slip + 0.1);
    expect(on.car.speed).toBeGreaterThan(10);
    // Lifting off ends it.
    const { car } = on;
    for (let i = 0; i < 60; i++) { car.update({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false }, 1 / 120); }
    expect(car.driftDir).toBe(0);
  });
});
