import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DriveInput } from '../src/input/input.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { PUDDLE_N, puddleAt, puddleMask } from '../src/weather/puddles.ts';
import { DRY, Weather } from '../src/weather/weather.ts';

const run = (w: Weather, seconds: number) => {
  for (let i = 0; i < seconds * 10; i++) w.update(0.1);
};

describe('Weather', () => {
  it('starts dry with full grip', () => {
    const w = new Weather(1);
    w.auto = false;
    run(w, 30);
    expect(w.wet).toBe(0);
    expect(w.surface()).toEqual(DRY);
  });

  it('rain soaks the road over time and dries again after it stops', () => {
    const w = new Weather(1);
    w.auto = false;
    w.set('rain', 1);
    run(w, 5);
    expect(w.rain).toBeGreaterThan(0.4);
    expect(w.wet).toBeLessThan(0.4);
    run(w, 40);
    expect(w.wet).toBeGreaterThan(0.95);
    expect(w.puddles).toBeGreaterThan(0.9);
    const g = w.surface();
    expect(g.grip).toBeLessThan(0.75);
    expect(g.brake).toBeLessThan(0.7);
    w.set('clear');
    run(w, 30);
    expect(w.rain).toBe(0);
    expect(w.wet).toBeGreaterThan(0.5); // still wet a while after the rain
    run(w, 200);
    expect(w.wet).toBe(0);
  });

  it('snow covers the road, is slipperier than rain, and melts in the rain', () => {
    const w = new Weather(1);
    w.auto = false;
    w.set('snow', 1);
    run(w, 90);
    expect(w.snowCover).toBeGreaterThan(0.9);
    const snow = w.surface();
    w.set('rain', 1, true);
    const rain = w.surface();
    w.set('snow', 1, true);
    expect(snow.grip).toBeLessThan(rain.grip);
    expect(snow.traction).toBeLessThan(0.5);
    w.set('rain', 1);
    run(w, 60);
    expect(w.snowCover).toBe(0);
    expect(w.wet).toBeGreaterThan(0.8);
  });

  it('aquaplanes in puddles at speed, not when slow', () => {
    const w = new Weather(1);
    w.set('rain', 1, true);
    expect(w.aquaplaning(1, 5)).toBeGreaterThan(0.75);
    expect(w.aquaplaning(1, 35)).toBeLessThan(0.3);
    expect(w.aquaplaning(0, 35)).toBe(1);
    expect(w.hint(w.aquaplaning(1, 35))).toBe('aquaplaning');
  });

  it('changes by itself when auto weather is on', () => {
    const w = new Weather(7);
    w.auto = true;
    const kinds = new Set<string>();
    for (let i = 0; i < 20000; i++) {
      w.update(0.5);
      kinds.add(w.kind);
    }
    expect(kinds).toEqual(new Set(['clear', 'rain', 'snow']));
  });
});

describe('Puddles', () => {
  it('cover a few percent of the area and tile seamlessly', () => {
    const m = puddleMask();
    let wet = 0;
    for (let i = 0; i < m.length; i++) if (m[i] / 255 > 0.62) wet++;
    const share = wet / m.length;
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.2);
    expect(m.length).toBe(PUDDLE_N * PUDDLE_N);
    expect(puddleAt(13.3, 71.9)).toBeCloseTo(puddleAt(13.3 + 180, 71.9 - 360), 5);
  });
});

describe('Weather grip in the car physics', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  function brakingDistance(surface: Partial<typeof DRY>) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const s = 3000;
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])),
      ground,
    );
    const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0);
    const drive = (input: Partial<DriveInput>, seconds: number) => {
      const full: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false, ...input };
      for (let i = 0; i < seconds * 60; i++) {
        car.update(full, 1 / 60);
        world.step();
      }
    };
    drive({}, 1);
    // Same entry speed on every surface: accelerate on dry tarmac.
    while (car.speed < 25) drive({ throttle: 1 }, 1 / 60);
    Object.assign(car.surface, surface);
    const z0 = car.body.translation().z;
    for (let i = 0; i < 60 * 10 && car.speed > 0.5; i++) drive({ brake: 1 }, 1 / 60);
    return Math.abs(car.body.translation().z - z0);
  }

  it('stops later on a wet road and much later on snow', () => {
    const w = new Weather(1);
    const dry = brakingDistance(DRY);
    w.set('rain', 1, true);
    const wet = brakingDistance(w.surface());
    w.set('snow', 1, true);
    const snow = brakingDistance(w.surface());
    expect(wet).toBeGreaterThan(dry * 1.15);
    expect(snow).toBeGreaterThan(wet * 1.2);
  });
});
