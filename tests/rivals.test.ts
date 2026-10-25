import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { LineTracker, RaceLine, RIVAL_LEVELS, RivalDriver } from '../src/game/rivals.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';

beforeAll(async () => {
  await RAPIER.init();
});

/** A rounded rectangle 400 × 200 m with 50 m corners, clockwise seen from above (x east, z south). */
function track(): number[] {
  const out: number[] = [];
  const corner = (cx: number, cz: number, a0: number) => {
    for (let k = 0; k <= 8; k++) { const a = a0 + (k / 8) * (Math.PI / 2); out.push(cx + Math.cos(a) * 50, cz + Math.sin(a) * 50); }
  };
  corner(150, 50, -Math.PI / 2);
  corner(150, 150, 0);
  corner(-150, 150, Math.PI / 2);
  corner(-150, 50, Math.PI);
  out.push(out[0], out[1]);
  return out;
}

describe('race line', () => {
  it('measures the line and finds bends', () => {
    const L = new RaceLine(track(), true);
    expect(L.length).toBeGreaterThan(1090);
    expect(L.length).toBeLessThan(1130);
    // Straight in the middle of the top side, bend at the corners.
    const top = L.nearest(0, 0).index;
    const bend = L.nearest(150 + 35, 15).index;
    expect(L.radius[top]).toBeGreaterThan(500);
    expect(L.radius[bend]).toBeGreaterThan(30);
    expect(L.radius[bend]).toBeLessThan(80);
  });

  it('counts laps over the start, also when starting behind the line', () => {
    const L = new RaceLine(track(), true);
    const t = new LineTracker(L, -10);
    const p0 = L.pose(-10);
    t.update(p0.x, p0.z);
    for (let d = -10; d < L.length * 2 + 20; d += 3) { const p = L.pose(d); t.update(p.x, p.z); }
    expect(t.raced).toBeGreaterThan(L.length * 2);
    expect(t.lap).toBe(3);
  });
});

describe('rival driver', () => {
  it('laps a circuit on the line without spinning, faster when stronger', () => {
    const run = (level: keyof typeof RIVAL_LEVELS) => {
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      world.timestep = 1 / 60;
      const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const s = 1000;
      world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
      const L = new RaceLine(track(), true);
      const p = L.pose(0);
      const car = new CarPhysics(RAPIER, world, { x: p.x, y: 0.9, z: p.z }, p.heading);
      const d = new RivalDriver(L);
      d.level = RIVAL_LEVELS[level];
      d.index = 0;
      const t = new LineTracker(L);
      let off = 0, time = 0;
      while (t.raced < L.length && time < 90) {
        const q = car.body.translation();
        car.update(d.drive({ x: q.x, z: q.z, heading: car.heading(), speed: car.speed }), 1 / 60);
        world.step();
        const q2 = car.body.translation();
        t.update(q2.x, q2.z);
        off = Math.max(off, L.nearest(q2.x, q2.z, t.index).dist);
        time += 1 / 60;
      }
      return { time, off };
    };
    const easy = run('leicht');
    const hard = run('schwer');
    expect(easy.time).toBeLessThan(80);
    expect(hard.time).toBeLessThan(easy.time);
    expect(easy.off).toBeLessThan(5);
    expect(hard.off).toBeLessThan(6);
  });
});
