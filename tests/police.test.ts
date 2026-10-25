import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BUST, HEAT, MAX_HEAT, Police, Wanted } from '../src/game/police.ts';
import type { CarPhysics } from '../src/vehicle/carPhysics.ts';
import type { RoadGraph } from '../src/world/roadGraph.ts';

const run = (w: Wanted, seconds: number, s: { seen: boolean; caught: boolean }) => {
  for (let t = 0; t < seconds; t += 0.1) w.update(0.1, s);
};

describe('wanted level (V4)', () => {
  it('raises, never lowers by raise, and reports why', () => {
    const w = new Wanted();
    const log: string[] = [];
    w.onChange = (h, why) => log.push(`${h} ${why}`);
    w.raise(2, 'gerammt');
    w.raise(1, 'zu schnell');
    w.raise(9, 'debug');
    expect(w.heat).toBe(MAX_HEAT);
    expect(log).toEqual(['2 gerammt', `${MAX_HEAT} debug`]);
  });

  it('escalates while the chase goes on in sight', () => {
    const w = new Wanted();
    w.raise(1, 'x');
    run(w, 50, { seen: true, caught: false });
    expect(w.heat).toBe(2);
  });

  it('ends with an escape once out of sight long enough', () => {
    const w = new Wanted();
    let escaped: number[] = [];
    w.onEscape = (h, t) => (escaped = [h, t]);
    w.raise(3, 'x');
    run(w, HEAT[3].escape - 1, { seen: false, caught: false });
    expect(w.heat).toBe(3);
    // Seen again: the escape timer starts over.
    run(w, 0.5, { seen: true, caught: false });
    run(w, HEAT[3].escape - 1, { seen: false, caught: false });
    expect(w.heat).toBe(3);
    run(w, 2, { seen: false, caught: false });
    expect(w.heat).toBe(0);
    expect(escaped[0]).toBe(3);
    expect(escaped[1]).toBeGreaterThan(HEAT[3].escape * 2 - 2);
  });

  it('ends with a bust when boxed in, which recovers slowly when the player breaks free', () => {
    const w = new Wanted();
    let bust = 0;
    w.onBust = (h) => (bust = h);
    w.raise(2, 'x');
    run(w, BUST - 1, { seen: true, caught: true });
    run(w, 0.3, { seen: true, caught: false });
    expect(w.heat).toBe(2);
    run(w, 1.8, { seen: true, caught: true });
    expect(w.heat).toBe(0);
    expect(bust).toBe(2);
  });
});

describe('police units', () => {
  it('a flipped, stuck unit leaves the world without its car being stepped again', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0));
    const police = new Police({
      R: RAPIER, world, scene: new THREE.Scene(), graph: { snap: () => undefined } as unknown as RoadGraph,
      makeView: async () => undefined, groundAt: () => 0, loaded: () => true, feel: () => ({}) as CarPhysics['feel'],
    });
    police.patrols = 0;
    police.wanted.raise(1, 'Test');
    const add = (police as unknown as { add(x: number, y: number, z: number, h: number, m: string): { car: CarPhysics; stuck: number } }).add.bind(police);
    const flipped = add(5, 0, 0, 0, 'chase');
    const other = add(-5, 0, 0, 0, 'chase');
    flipped.car.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);
    flipped.stuck = 3;
    const player = { x: 0, z: 20, vx: 0, vz: 0, speed: 0, heading: 0 };
    expect(() => police.step(1 / 60, player, other.car)).not.toThrow();
    expect(police.units.length).toBe(1);
    world.step();
  });
});
