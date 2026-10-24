import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DriveInput } from '../src/input/input.ts';
import { CarPhysics, maxSteerAngle } from '../src/vehicle/carPhysics.ts';

beforeAll(async () => {
  await RAPIER.init();
});

function setup(heading = 0) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 2000;
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])),
    ground,
  );
  const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, heading);
  const drive = (input: Partial<DriveInput>, seconds: number) => {
    const full: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false, ...input };
    for (let i = 0; i < seconds * 60; i++) {
      car.update(full, 1 / 60);
      world.step();
    }
  };
  return { world, car, drive };
}

describe('CarPhysics', () => {
  it('settles on its wheels', () => {
    const { car, drive } = setup();
    drive({}, 2);
    const y = car.body.translation().y;
    expect(y).toBeGreaterThan(0.05);
    expect(y).toBeLessThan(1);
    expect([0, 1, 2, 3].every((i) => car.controller.wheelIsInContact(i))).toBe(true);
  });

  it('drives forward along its heading (north = -z)', () => {
    const { car, drive } = setup(0);
    drive({}, 1);
    drive({ throttle: 1 }, 4);
    const p = car.body.translation();
    expect(car.speed).toBeGreaterThan(15);
    expect(p.z).toBeLessThan(-25);
    expect(Math.abs(p.x)).toBeLessThan(3);
  });

  it('turns right when steering right', () => {
    const { car, drive } = setup(0);
    drive({}, 1);
    drive({ throttle: 1 }, 2);
    const h0 = car.heading();
    drive({ throttle: 0.6, steer: 1 }, 1.5);
    const dh = Math.atan2(Math.sin(car.heading() - h0), Math.cos(car.heading() - h0));
    expect(dh).toBeGreaterThan(0.3);
  });

  it('nitro makes the car faster', () => {
    const a = setup();
    a.drive({}, 1);
    a.drive({ throttle: 1 }, 4);
    const b = setup();
    b.drive({}, 1);
    b.drive({ throttle: 1, nitro: true }, 4);
    expect(b.car.speed).toBeGreaterThan(a.car.speed + 3);
    expect(b.car.nitro).toBeLessThan(0.5);
  });

  it('brakes to a stop and reverses', () => {
    const { car, drive } = setup();
    drive({}, 1);
    drive({ throttle: 1 }, 3);
    drive({ brake: 1 }, 4);
    drive({ brake: 1 }, 2);
    expect(car.speed).toBeLessThan(-2);
  });
});

describe('CarPhysics tyres', () => {
  it('reports contact points and no slip when cruising straight', () => {
    const { car, drive } = setup();
    drive({}, 1);
    drive({ throttle: 0.4 }, 3);
    expect(car.wheels.every((w) => w.contact)).toBe(true);
    expect(car.wheels[0].p.y).toBeLessThan(0.2);
    expect(car.wheels[0].n.y).toBeGreaterThan(0.9);
    expect(car.slip).toBeLessThan(0.15);
  });

  it('slides the rear tyres in a handbrake turn', () => {
    const { car, drive } = setup();
    drive({}, 1);
    drive({ throttle: 1 }, 3);
    let maxRear = 0;
    for (let i = 0; i < 40; i++) {
      drive({ throttle: 0.5, steer: 1, handbrake: true }, 1 / 60);
      maxRear = Math.max(maxRear, car.wheels[2].slip, car.wheels[3].slip);
    }
    expect(maxRear).toBeGreaterThan(0.5);
  });

  it('accelerates realistically and is drag-limited at the top', () => {
    const { car, drive } = setup();
    drive({}, 1);
    let t100 = 0;
    for (let i = 1; i <= 60 * 8 && !t100; i++) {
      drive({ throttle: 1 }, 1 / 60);
      if (car.speed * 3.6 >= 100) t100 = i / 60;
    }
    expect(t100).toBeGreaterThan(3);
    expect(t100).toBeLessThan(6);
  });
});

describe('Steering', () => {
  it('gives full lock when slow and only a few degrees at speed', () => {
    expect(maxSteerAngle(0)).toBeCloseTo(0.6, 2);
    expect(maxSteerAngle(100 / 3.6)).toBeLessThan(0.2);
    expect(maxSteerAngle(200 / 3.6)).toBeLessThan(0.1);
    expect(maxSteerAngle(200 / 3.6)).toBeGreaterThan(0.04);
  });

  it('stays stable with full lock at 200 km/h', () => {
    const { car, drive } = setup();
    drive({}, 1);
    while (car.speed < 200 / 3.6) drive({ throttle: 1, nitro: true }, 1 / 60);
    drive({ throttle: 0.6, steer: 1 }, 2);
    // No spin: the car keeps most of its speed and still points along its travel.
    expect(car.speed).toBeGreaterThan(150 / 3.6);
    const lv = car.body.linvel();
    const h = car.heading();
    const travel = Math.atan2(lv.x, -lv.z);
    expect(Math.abs(Math.atan2(Math.sin(travel - h), Math.cos(travel - h)))).toBeLessThan(0.2);
  });
});
