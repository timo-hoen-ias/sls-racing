import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DriveInput } from '../src/input/input.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';

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
    const full: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, ...input };
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
