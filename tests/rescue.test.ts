import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHANNELS, Recorder, type Sample } from '../src/replay/recorder.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { Rescue } from '../src/vehicle/rescue.ts';

beforeAll(async () => {
  await RAPIER.init();
});

const DT = 1 / 60;

function setup() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 1000;
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
  const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0);
  const recorder = new Recorder(30);
  const rescue = new Rescue();
  let t = 0;
  const run = (throttle: number, seconds: number, onFrame?: () => void) => {
    for (let i = 0; i < seconds * 60; i++) {
      const input = { throttle, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
      car.update(input, DT);
      world.step();
      t += DT;
      const p = car.body.translation(), q = car.body.rotation();
      const row = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Sample;
      Object.assign(row, { t, x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, speed: car.speed, nitro: car.nitro });
      recorder.push(row);
      onFrame?.();
    }
  };
  return { world, car, recorder, rescue, run };
}

describe('rescue', () => {
  it('resets a car lying on its roof after flipSeconds', () => {
    const { car, rescue, run } = setup();
    car.body.setTranslation({ x: 0, y: 2, z: 0 }, true);
    car.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true); // upside down
    const reasons: string[] = [];
    const idle = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
    run(0, 4, () => { const r = rescue.update(car, idle, DT); if (r) reasons.push(r); });
    expect(reasons).toEqual(['flip']);
  });

  it('resets a wedged car only while the player keeps a pedal down', () => {
    const { car, rescue } = setup();
    car.body.setBodyType(RAPIER.RigidBodyType.Fixed, true); // pinned in place
    const press = { throttle: 1, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
    const idle = { ...press, throttle: 0 };
    let r = null;
    for (let i = 0; i < 10 * 60 && !r; i++) r = rescue.update(car, idle, DT);
    expect(r).toBeNull();
    let frames = 0;
    for (; frames < 10 * 60 && !r; frames++) r = rescue.update(car, press, DT);
    expect(r).toBe('stuck');
    expect(frames / 60).toBeCloseTo(rescue.stuckSeconds, 0);
  });

  it('rewinds to the pose and speed of a few seconds ago and drops the later recording', () => {
    const { car, recorder, rescue, run } = setup();
    run(1, 8);
    const before = recorder.at(recorder.lastTime - rescue.rewindSeconds);
    expect(car.body.translation().z).toBeLessThan(before.z - 20);
    expect(rescue.rewind(car, recorder)).toBe(true);
    const p = car.body.translation();
    expect(p.z).toBeCloseTo(before.z, 0);
    const v = car.body.linvel();
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(Math.abs(before.speed), 0);
    expect(v.z).toBeLessThan(0); // still heading the way it was going
    expect(recorder.lastTime).toBeLessThanOrEqual(before.t + 1e-3);
    // Driving on records from the rewound point.
    run(1, 1);
    expect(recorder.lastTime).toBeGreaterThan(before.t + 0.9);
  });
});
