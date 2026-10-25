import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { WallGlide } from '../src/game/forgive.ts';
import type { DriveInput } from '../src/input/input.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { FEEL } from '../src/game/feel.ts';

beforeAll(async () => {
  await RAPIER.init();
});

function setup(feel: 'fun' | 'real', wall = false, mesh?: { v: number[]; i: number[] }, step = 0) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 120;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 3000;
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
  // A long wall along x = 4 (east of the car), for glancing hits.
  if (wall) world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 2, 1500).setTranslation(4.5, 2, 0), ground);
  // A raised slab across the road from z = -20 on, `step` m high (a high kerb or terrain edge).
  if (step) world.createCollider(RAPIER.ColliderDesc.cuboid(6, step / 2, 20).setTranslation(0, step / 2, -40), ground);
  if (mesh) world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(mesh.v), new Uint32Array(mesh.i)), ground);
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

  it('fun brakes hard: 100 km/h to a stop in clearly less than the tyres alone, staying straight', () => {
    const stop = (feel: 'fun' | 'real') => {
      const { car, drive } = setup(feel);
      drive({}, 1);
      while (car.speed < 100 / 3.6) drive({ throttle: 1 }, 1 / 120);
      const p0 = car.body.translation();
      let t = 0;
      while (car.speed > 0.5 && t < 10) { drive({ brake: 1 }, 1 / 120); t += 1 / 120; }
      const p1 = car.body.translation();
      return { d: Math.abs(p1.z - p0.z), side: Math.abs(p1.x - p0.x), t };
    };
    const fun = stop('fun');
    const real = stop('real');
    expect(fun.d).toBeLessThan(20);
    expect(fun.d).toBeLessThan(real.d * 0.7);
    expect(fun.t).toBeLessThan(1.6);
    expect(fun.side).toBeLessThan(0.5);
  });

  // Heading 0 drives towards -z. A profile across the road (z, height) as a 12 m wide strip of triangles.
  const strip = (profile: [number, number][]) => {
    const v: number[] = [], i: number[] = [];
    profile.forEach(([z, y]) => v.push(-6, y, z, 6, y, z));
    for (let k = 0; k + 1 < profile.length; k++) { const a = k * 2; i.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    return { v, i };
  };
  // Coasts at 25 m/s over the strip; returns the longest time in the air and the jump length.
  const coast = (feel: 'fun' | 'real', mesh: { v: number[]; i: number[] }) => {
    const { car, drive } = setup(feel, false, mesh);
    drive({}, 1);
    car.body.setLinvel({ x: 0, y: 0, z: -25 }, true);
    let air = 0, longest = 0, from = 0, jump = 0;
    for (let t = 0; t < 3; t += 1 / 120) {
      drive({}, 1 / 120);
      const z = car.body.translation().z;
      if (car.airborne) { if (!air) from = z; air += 1 / 120; longest = Math.max(longest, air); }
      else { if (air > 0.1) jump = Math.max(jump, from - z); air = 0; }
    }
    return { longest, jump };
  };

  it('fun keeps the car on the road over a 15 cm hump where real hops off', () => {
    const hump = strip([[-25, 0.001], [-29, 0.001], [-30, 0.15], [-31, 0.001], [-120, 0.001]]);
    const fun = coast('fun', hump);
    const real = coast('real', hump);
    expect(real.longest).toBeGreaterThan(0.1);
    expect(fun.longest).toBeLessThan(0.05);
  });

  it('fun climbs a 30 cm edge that stops the real car, without flying', () => {
    const run = (feel: 'fun' | 'real') => {
      const { car, drive } = setup(feel, false, undefined, 0.3);
      drive({}, 1);
      car.body.setLinvel({ x: 0, y: 0, z: -12 }, true);
      let air = 0, longest = 0, top = 0;
      for (let t = 0; t < 3; t += 1 / 120) {
        drive({ throttle: 0.3 }, 1 / 120);
        air = car.airborne ? air + 1 / 120 : 0;
        longest = Math.max(longest, air);
        top = Math.max(top, car.body.translation().y);
      }
      return { z: car.body.translation().z, speed: car.speed, longest, top, steps: car.steps };
    };
    const fun = run('fun');
    const real = run('real');
    expect(real.z).toBeGreaterThan(-22);
    expect(fun.z).toBeLessThan(-35);
    expect(fun.speed).toBeGreaterThan(6);
    expect(fun.longest).toBeLessThan(0.15);
    expect(fun.top).toBeLessThan(1.2);
  });

  it('fun still jumps off a ramp', () => {
    // 1.6 m ramp over 8 m, then flat ground (the base plane at 0).
    const ramp = strip([[-20, 0.001], [-28, 1.6], [-28.2, 1.6]]);
    const fun = coast('fun', ramp);
    const real = coast('real', ramp);
    expect(fun.jump).toBeGreaterThan(12);
    expect(fun.jump).toBeGreaterThan(real.jump * 0.85);
  });

  it('fun brakes straight with the left wheels on a slippery strip, real pulls to one side', () => {
    const run = (feel: 'fun' | 'real') => {
      const { car, drive } = setup(feel);
      drive({}, 1);
      while (car.speed < 100 / 3.6) drive({ throttle: 1 }, 1 / 120);
      car.wheelGrip[0] = car.wheelGrip[2] = 0.45;
      let t = 0;
      while (car.speed > 3 && t < 10) { drive({ brake: 1 }, 1 / 120); t += 1 / 120; }
      const r = car.body.rotation();
      // Heading change from straight ahead (rad).
      return Math.abs(2 * Math.asin(Math.min(1, Math.abs(r.y))) - Math.PI);
    };
    const fun = run('fun');
    const real = run('real');
    expect(real).toBeGreaterThan(0.3);
    expect(fun).toBeLessThan(0.05);
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
