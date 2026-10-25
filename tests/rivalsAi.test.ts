import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { RaceLine, Rivals } from '../src/game/rivals.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';

beforeAll(async () => {
  await RAPIER.init();
});

/** A rounded rectangle (2·long + 100) × 200 m with 50 m corners, clockwise seen from above (x east, z south). */
function track(long = 150): number[] {
  const out: number[] = [];
  const corner = (cx: number, cz: number, a0: number) => {
    for (let k = 0; k <= 8; k++) { const a = a0 + (k / 8) * (Math.PI / 2); out.push(cx + Math.cos(a) * 50, cz + Math.sin(a) * 50); }
  };
  corner(long, 50, -Math.PI / 2);
  corner(long, 150, 0);
  corner(-long, 150, Math.PI / 2);
  corner(-long, 50, Math.PI);
  out.push(out[0], out[1]);
  return out;
}

function flatWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 1000;
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
  return world;
}

describe('ideal line', () => {
  it('cuts the apexes within the road and raises the bend radius', () => {
    const centre = new RaceLine(track(), true);
    const ideal = new RaceLine(track(), true).racing(() => 12);
    const bend = centre.nearest(150 + 35, 15).index;
    let minC = Infinity, minI = Infinity;
    for (let i = 0; i < centre.count; i++) { minC = Math.min(minC, centre.radius[i]); minI = Math.min(minI, ideal.radius[i]); }
    expect(minI).toBeGreaterThan(minC * 1.1);
    for (let i = 0; i < ideal.count; i++) expect(Math.abs(ideal.side[i])).toBeLessThanOrEqual(ideal.room[i] + 1e-4);
    // Clockwise: the inside of the bends is on the right (+), the line goes there at the apex.
    expect(ideal.side[bend]).toBeGreaterThan(1.5);
    expect(ideal.room[bend]).toBeCloseTo(6 - 1 - 1.4, 3);
  });

  it('stays on the centre line with apex 0 and unknown widths keep a narrow corridor', () => {
    const flat = new RaceLine(track(), true).racing(() => 12, 0);
    expect(Math.max(...flat.side.map(Math.abs))).toBe(0);
    const narrow = new RaceLine(track(), true).racing(() => undefined);
    expect(Math.max(...narrow.side.map(Math.abs))).toBeLessThanOrEqual(1.2 + 1e-4);
  });
});

describe('rival racecraft', () => {
  function race(opts: { overtake: boolean; seconds: number }) {
    const world = flatWorld();
    const rv = new Rivals({
      R: RAPIER, world, scene: new THREE.Scene(),
      makeView: async () => undefined,
      groundAt: () => 0,
      loaded: () => true,
      feel: () => new CarPhysics(RAPIER, flatWorld(), { x: 0, y: 1, z: 0 }, 0).feel,
      roadWidth: () => 12,
    });
    rv.railRange = 1e9;
    rv.rubber = 0;
    rv.mistakes = 0;
    rv.overtake = opts.overtake;
    // Long straights: passing starts on a straight.
    void rv.start(track(400), 3, 2);
    const [fast, slow] = rv.list;
    // The slow car starts 60 m ahead on the ideal line.
    slow.persona = { ...slow.persona, skill: 0.8, react: 0 };
    fast.persona = { ...fast.persona, skill: 1.05, react: 0 };
    const p = rv.line!.pose(60, true);
    slow.car.reset({ x: p.x, y: 0.9, z: p.z }, p.heading);
    slow.track.set(60);
    slow.driver.index = slow.track.index;
    let minGap = Infinity, touching = 0;
    for (let t = 0; t < opts.seconds * 60; t++) {
      rv.step(1 / 60, true, { x: 0, z: 5000 });
      world.step();
      rv.capture();
      const a = fast.car.body.translation(), b = slow.car.body.translation();
      if (t > 60) minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.z - b.z));
      world.contactPair(fast.car.body.collider(0), slow.car.body.collider(0), (m) => { if (m.numContacts() > 0) touching++; });
    }
    return { fast, slow, minGap, touching: touching / (opts.seconds * 60) };
  }

  it('overtakes a slower car on a free side, hardly touching it', () => {
    const { fast, slow, touching } = race({ overtake: true, seconds: 60 });
    expect(fast.passes).toBeGreaterThan(0);
    expect(fast.track.raced).toBeGreaterThan(slow.track.raced + 50);
    // Rubbing for at most a second or so in a minute of racing side by side.
    expect(touching).toBeLessThan(0.025);
  });

  it('follows at a distance when overtaking is off', () => {
    const { fast, slow, minGap, touching } = race({ overtake: false, seconds: 45 });
    expect(fast.track.raced).toBeLessThan(slow.track.raced);
    expect(minGap).toBeGreaterThan(4);
    expect(touching).toBe(0);
  });

  it('rubber band: rivals behind push, close ahead they race for real, far ahead they ease off', () => {
    const rv = new Rivals({ R: RAPIER, world: flatWorld(), scene: new THREE.Scene(), makeView: async () => undefined, groundAt: () => 0, loaded: () => true, feel: () => new CarPhysics(RAPIER, flatWorld(), { x: 0, y: 1, z: 0 }, 0).feel });
    expect(rv.band(-200)).toBeGreaterThan(1.1);
    expect(rv.band(30)).toBe(1);
    expect(rv.band(300)).toBeLessThan(1);
    rv.rubber = 0;
    expect(rv.band(-200)).toBe(1);
  });
});

describe('rivals on rails and mistakes', () => {
  function field(loaded: boolean) {
    const world = flatWorld();
    const rv = new Rivals({ R: RAPIER, world, scene: new THREE.Scene(), makeView: async () => undefined, groundAt: () => 0, loaded: () => loaded, feel: () => new CarPhysics(RAPIER, flatWorld(), { x: 0, y: 1, z: 0 }, 0).feel, roadWidth: () => 12 });
    rv.rubber = 0;
    rv.mistakes = 0;
    void rv.start(track(), 2, 1);
    rv.list[0].persona = { ...rv.list[0].persona, react: 0 };
    return { world, rv };
  }

  it('on rails slows for the bends like a driver would', () => {
    const { world, rv } = field(false);
    const r = rv.list[0];
    let minBend = Infinity, maxStraight = 0;
    for (let t = 0; t < 70 * 60 && r.finished === undefined; t++) {
      rv.step(1 / 60, true, { x: 0, z: 5000 });
      world.step();
      rv.capture();
      const R = rv.line!.radius[r.track.index];
      if (t > 600 && R < 70) minBend = Math.min(minBend, r.railSpeed);
      if (R > 1000) maxStraight = Math.max(maxStraight, r.railSpeed);
    }
    expect(r.rail).toBe(true);
    expect(r.finished).toBeDefined();
    expect(minBend).toBeLessThan(30);
    expect(maxStraight).toBeGreaterThan(minBend + 10);
  });

  it('a forced mistake overcooks the next bend and is counted', () => {
    const { rv } = field(true);
    const r = rv.list[0];
    rv.mistake(r, 'spät');
    expect(r.driver.err.lat).toBeGreaterThan(1.1);
    expect(r.mistakes).toBe(1);
    const plain = new RaceLine(track(), true).racing(() => 12);
    expect(plain.count).toBe(rv.line!.count);
    const before = r.driver.plan(0, 30);
    r.driver.err.t = 0;
    expect(before).toBeGreaterThan(r.driver.plan(0, 30));
  });
});
