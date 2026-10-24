import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { classify, RoadSurface } from '../src/vehicle/roadSurface.ts';
import { Ground } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';

beforeAll(async () => {
  await RAPIER.init();
});

const graph = (rank: number) => new RoadGraph({ v: 1, names: ['Teststraße'], nodes: [0, 0, 0, 100, 0, 0], edges: [{ a: 0, b: 1, n: 0, c: rank, p: [0, 0, 0, 50, 0, 0, 100, 0, 0] }] });

describe('road surface', () => {
  it('tells road from roadside', () => {
    const g = graph(5);
    expect(classify(g, () => Ground.grass, 50, 1).kind).toBe('asphalt');
    expect(classify(g, () => Ground.grass, 50, 4.5).kind).toBe('gehweg');
    expect(classify(g, () => Ground.grass, 50, 9).kind).toBe('gras');
    expect(classify(g, () => Ground.urban, 50, 9).kind).toBe('gehweg');
    expect(classify(g, () => Ground.farmland, 50, 30).kind).toBe('acker');
    expect(classify(g, () => undefined, 50, 30).kind).toBe('gras');
  });

  it('paves pedestrian zones with setts and tracks with gravel', () => {
    expect(classify(graph(2), () => Ground.urban, 50, 1).kind).toBe('pflaster');
    expect(classify(graph(0), () => Ground.grass, 50, 0.5).kind).toBe('schotter');
  });

  it('slows the car and costs grip on grass', () => {
    const run = (force: 'asphalt' | 'gras') => {
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      world.timestep = 1 / 60;
      const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const s = 2000;
      world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
      const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0);
      const rs = new RoadSurface(graph(5), () => Ground.grass);
      rs.force = force;
      const step = (throttle: number, n: number) => {
        for (let i = 0; i < n; i++) {
          rs.update(car);
          car.update({ throttle, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false }, 1 / 60);
          world.step();
        }
      };
      step(0, 60);
      while (car.speed < 80 / 3.6) step(1, 1);
      step(0, 180);
      return { speed: car.speed, grip: car.wheelGrip[0], rumble: rs.rumble };
    };
    const road = run('asphalt');
    const grass = run('gras');
    expect(grass.speed).toBeLessThan(road.speed - 1.5);
    expect(grass.grip).toBeLessThan(0.7);
    expect(grass.rumble).toBeGreaterThan(0);
    expect(road.rumble).toBe(0);
  });
});
