import RAPIER from '@dimforge/rapier3d-compat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { applyCar, CARS, findCar } from '../src/vehicle/cars.ts';
import { carGeometry } from '../src/vehicle/sportsCarGlb.ts';
import { CAR, ENGINE, ENGINE_SOUND, VEHICLE } from '../src/vehicle/tuning.ts';

// Real sizes in these tests; the vehicle scale has its own test below.
const GAME_SCALE = VEHICLE.scale;
beforeAll(async () => {
  await RAPIER.init();
  VEHICLE.scale = 1;
});
afterAll(() => {
  VEHICLE.scale = GAME_SCALE;
  applyCar(findCar('sportscar')!);
});

const HATCH = carGeometry({ name: 'hothatch', wheel: { front: 1.32, rear: -1.27, track: 1.56, radius: 0.32, width: 0.24 }, length: 4.3, width: 1.82 })!;
const idle = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };

function drive(car: CarPhysics, world: RAPIER.World, input: typeof idle, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) {
    car.update(input, 1 / 60);
    world.step();
  }
}

function setup() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 2000;
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
  return { world, car: new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0) };
}

describe('cars', () => {
  it('takes a half track (as in the first hot hatch GLB) as the wheel offset', () => {
    applyCar(findCar('hothatch')!, carGeometry({ name: 'Hot Hatch', length: 3.97, width: 1.81, wheel: { front: 1.27, rear: -1.2, track: 0.8, radius: 0.35, width: 0.3 } }));
    expect(CAR.wheel.x).toBe(0.8);
    expect(CAR.halfExtents.z).toBeCloseTo(1.91);
  });

  it('shrinks every dimension by the vehicle scale but keeps mass and drivetrain', () => {
    applyCar(findCar('hothatch')!, HATCH);
    const real = structuredClone({ CAR, ENGINE });
    VEHICLE.scale = 0.8;
    applyCar(findCar('hothatch')!, HATCH);
    expect(CAR.wheel.front - CAR.wheel.rear).toBeCloseTo(2.59 * 0.8);
    expect(CAR.wheel.radius).toBeCloseTo(0.32 * 0.8);
    expect(CAR.halfExtents.z).toBeCloseTo(real.CAR.halfExtents.z * 0.8);
    expect(CAR.wheel.rest).toBeCloseTo(real.CAR.wheel.rest * 0.8);
    expect(CAR.mass).toBe(real.CAR.mass);
    expect(ENGINE.wheelRadius).toBe(0.32);
    VEHICLE.scale = 1;
    applyCar(findCar('hothatch')!, HATCH);
    expect(CAR.halfExtents.z).toBeCloseTo(real.CAR.halfExtents.z);
  });

  it('the scaled coupé drives, corners and brakes upright', () => {
    VEHICLE.scale = 0.8;
    applyCar(findCar('sportscar')!);
    const { world, car } = setup();
    drive(car, world, idle, 1);
    drive(car, world, { ...idle, throttle: 1 }, 5);
    expect(Math.abs(car.speed) * 3.6).toBeGreaterThan(110);
    expect(Math.abs(car.body.translation().x)).toBeLessThan(2);
    drive(car, world, { ...idle, throttle: 0.4, steer: 0.6 }, 3);
    let r = car.body.rotation();
    expect(1 - 2 * (r.x * r.x + r.z * r.z)).toBeGreaterThan(0.9);
    drive(car, world, { ...idle, throttle: 0.3 }, 2);
    // Held longer, the brake pedal selects reverse: look for the stop.
    let slowest = Infinity;
    for (let i = 0; i < 6 * 60 && car.speed > -1; i++) {
      drive(car, world, { ...idle, brake: 1 }, 1 / 60);
      slowest = Math.min(slowest, Math.abs(car.speed));
    }
    expect(slowest).toBeLessThan(0.5);
    r = car.body.rotation();
    expect(1 - 2 * (r.x * r.x + r.z * r.z)).toBeGreaterThan(0.95);
    VEHICLE.scale = 1;
    applyCar(findCar('sportscar')!);
  });

  it('reads the dimensions from the GLB extras and rejects incomplete ones', () => {
    expect(HATCH.wheel.track).toBe(1.56);
    expect(carGeometry({ name: 'car' })).toBeUndefined();
    expect(carGeometry({ wheel: { front: 1 }, length: 4, width: 2 })).toBeUndefined();
  });

  it('every car has a label, model and sane engine', () => {
    for (const c of CARS) {
      applyCar(c);
      expect(c.label.length).toBeGreaterThan(2);
      expect(c.url).toMatch(/\.glb$/);
      expect(ENGINE.shiftRpm).toBeLessThan(ENGINE.maxRpm);
      expect(ENGINE_SOUND.voice.maxRpm).toBe(ENGINE.maxRpm);
      expect(ENGINE.torque.at(-1)![0]).toBeGreaterThanOrEqual(ENGINE.maxRpm);
    }
  });

  it('applies tuning and geometry, and switching back restores the coupé', () => {
    applyCar(findCar('sportscar')!);
    const coupe = structuredClone({ CAR, ENGINE, ENGINE_SOUND });
    applyCar(findCar('hothatch')!, HATCH);
    expect(CAR.mass).toBe(1350);
    expect(CAR.wheel.front - CAR.wheel.rear).toBeCloseTo(2.59);
    expect(CAR.wheel.x).toBeCloseTo(0.78);
    expect(ENGINE.wheelRadius).toBe(0.32);
    expect(ENGINE.gears.length).toBe(6);
    expect(ENGINE_SOUND.voice.cylinders).toBe(4);
    expect(ENGINE_SOUND.turbo).toBeDefined();
    applyCar(findCar('sportscar')!);
    expect(structuredClone({ CAR, ENGINE, ENGINE_SOUND })).toEqual(coupe);
  });

  it('a rebuilt car takes the new wheel positions and still drives straight and upright', () => {
    const { world, car } = setup();
    drive(car, world, idle, 1);
    applyCar(findCar('hothatch')!, HATCH);
    car.rebuild();
    expect(car.controller.wheelChassisConnectionPointCs(0)!.z).toBeCloseTo(1.32);
    expect(car.controller.wheelRadius(0)).toBeCloseTo(0.32);
    drive(car, world, { ...idle, throttle: 1 }, 5);
    const v = car.body.linvel();
    expect(Math.hypot(v.x, v.z) * 3.6).toBeGreaterThan(110);
    expect(Math.abs(car.body.translation().x)).toBeLessThan(2);
    const r = car.body.rotation();
    expect(1 - 2 * (r.x * r.x + r.z * r.z)).toBeGreaterThan(0.95);
    applyCar(findCar('gt')!, { wheel: { front: 1.45, rear: -1.45, track: 1.64, radius: 0.36, width: 0.3 }, length: 4.85, width: 1.98 });
    car.rebuild();
    // Brakes to a stop (held longer, the brake pedal would select reverse).
    let slowest = Infinity;
    for (let i = 0; i < 6 * 60; i++) {
      drive(car, world, { ...idle, brake: 1 }, 1 / 60);
      slowest = Math.min(slowest, Math.abs(car.speed));
    }
    expect(slowest).toBeLessThan(0.5);
  });
});
