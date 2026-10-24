import { describe, expect, it } from 'vitest';
import type { RoadGraphData } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';
import { PedSim } from '../src/peds/pedSim.ts';
import { TrafficSim } from '../src/traffic/trafficSim.ts';

function rng(seed = 1) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/** A residential street from x = -100 to 100 at z = 0, with a side street going north at x = 0. */
function graph() {
  const line = (ax: number, az: number, bx: number, bz: number) => {
    const p: number[] = [];
    for (let k = 0; k <= 10; k++) p.push(ax + ((bx - ax) * k) / 10, 0, az + ((bz - az) * k) / 10);
    return p;
  };
  const data: RoadGraphData = {
    v: 1, names: ['Hauptstraße', 'Seitenweg'], nodes: [-100, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, -100],
    edges: [
      { a: 0, b: 1, n: 0, c: 3, p: line(-100, 0, 0, 0) },
      { a: 1, b: 2, n: 0, c: 3, p: line(0, 0, 100, 0) },
      { a: 1, b: 3, n: 1, c: 3, p: line(0, 0, 0, -100) },
    ],
  };
  return new RoadGraph(data);
}

describe('PedSim', () => {
  it('walks on the sidewalk, beside the carriageway', () => {
    const g = graph();
    const sim = new PedSim(g, { rng: rng(3) });
    sim.density = 0;
    const p = sim.spawn(g.edges[0], 1, 20, 1);
    p.state = 'walk';
    const x0 = p.x;
    for (let i = 0; i < 300; i++) sim.update(1 / 30, undefined);
    expect(p.x).toBeGreaterThan(x0 + 8);
    // Residential carriageway is 6 m wide: the sidewalk starts 3 m from the centre line.
    if (p.edge === g.edges[0]) expect(Math.abs(p.z)).toBeGreaterThan(3);
  });

  it('jumps out of the way of a car coming at them', () => {
    const g = graph();
    const sim = new PedSim(g, { rng: rng(4) });
    sim.density = 0;
    const p = sim.spawn(g.edges[0], 1, 50, 1);
    p.state = 'stand';
    p.timer = 99;
    // Car 15 m away driving straight at the pedestrian at 15 m/s.
    let dodged = 0, knocked = 0;
    sim.events.dodged = () => dodged++;
    sim.events.knocked = () => knocked++;
    const car = { x: p.x - 15, z: p.z, vx: 15, vz: 0, halfWidth: 0.95 };
    for (let i = 0; i < 30; i++) { sim.update(1 / 30, undefined, car); car.x += 0.5; }
    expect(dodged).toBe(1);
    expect(knocked).toBe(0);
  });

  it('gets knocked over by a car that does not miss, then stands up again', () => {
    const g = graph();
    const sim = new PedSim(g, { rng: rng(5) });
    sim.density = 0;
    const p = sim.spawn(g.edges[0], 1, 50, 1);
    p.state = 'stand';
    p.timer = 99;
    let knocked = 0;
    sim.events.knocked = () => knocked++;
    sim.update(1 / 30, undefined, { x: p.x - 1, z: p.z, vx: 15, vz: 0, halfWidth: 0.95 });
    expect(knocked).toBe(1);
    expect(p.state).toBe('down');
    for (let i = 0; i < 30 * 8; i++) sim.update(1 / 30, undefined);
    expect(p.state).not.toBe('down');
  });

  it('makes traffic wait while crossing at a junction', () => {
    const g = graph();
    const peds = new PedSim(g, { rng: rng(6) });
    const traffic = new TrafficSim(g, { rng: rng(6) });
    peds.density = traffic.density = 0;
    const car = traffic.spawn({ edge: g.edges[0], dir: 1 }, 30)!;
    car.v = 8;
    // A pedestrian standing on the lane ahead, mid-crossing.
    const p = peds.spawn(g.edges[1], 1, 0.5, 1);
    p.state = 'cross';
    traffic.obstacles = [{ x: car.x + 30, z: car.z, vx: 0, vz: 0, halfLength: 0.4, halfWidth: 0.4 }];
    for (let i = 0; i < 30 * 15; i++) traffic.update(1 / 30, undefined);
    expect(car.v).toBeLessThan(0.3);
    expect(car.x).toBeLessThan(traffic.obstacles[0].x - 2);
  });

  it('waits at a red light and crosses at green', () => {
    const g = graph();
    const sim = new PedSim(g, { rng: rng(4) });
    sim.density = 0;
    let light = 'red';
    sim.signals = { light: (node) => (node === 1 ? light : undefined) };
    const p = sim.spawn(g.edges[0], 1, 80, 1); // walking east towards the junction at x = 0
    p.state = 'walk';
    for (let i = 0; i < 30 * 20; i++) sim.update(1 / 30, undefined);
    expect(p.state).toBe('wait');
    expect(p.edge).toBe(g.edges[0]);
    expect(p.x).toBeLessThan(-2);
    light = 'green';
    for (let i = 0; i < 30 * 10; i++) sim.update(1 / 30, undefined);
    expect(p.edge).not.toBe(g.edges[0]);
  });

  it('steps over to a shop window, looks in, and walks on', () => {
    const g = graph();
    const sim = new PedSim(g, { rng: rng(7) });
    sim.density = 0;
    sim.browse = 1;
    const p = sim.spawn(g.edges[0], 1, 20, 1);
    p.state = 'walk';
    // A shop front 15 m ahead, set back 4 m behind the pedestrian's sidewalk, facing the street.
    const out = Math.sign(p.z);
    const front = { id: 7, x: p.x + 15, z: p.z + out * 4, heading: out > 0 ? Math.PI : 0 };
    // And one across the street, facing away from this sidewalk: ignored.
    const across = { id: 8, x: p.x + 8, z: -p.z - out * 4, heading: out > 0 ? 0 : Math.PI };
    sim.shops = { busy: () => 0, front: (x, z, r) => [across, front].find((f) => Math.hypot(f.x - x, f.z - z) < r) };
    let arrived = false;
    for (let i = 0; i < 30 * 25 && !arrived; i++) {
      sim.update(1 / 30, undefined);
      arrived = !!p.visit && p.visit.d >= p.visit.len;
    }
    expect(arrived).toBe(true);
    expect(sim.browsing()).toBe(1);
    expect(Math.hypot(p.x - front.x, p.z - front.z)).toBeLessThan(1.5);
    // Looking at the window: facing away from the street.
    expect(Math.cos(p.yaw - (front.heading + Math.PI))).toBeCloseTo(1, 5);
    for (let i = 0; i < 30 * 20 && p.visit; i++) { sim.update(1 / 30, undefined); }
    expect(p.visit).toBeUndefined();
    expect(p.state).not.toBe('stand');
    // The same window only once.
    for (let i = 0; i < 30 * 3; i++) { sim.update(1 / 30, undefined); expect(p.visit).toBeUndefined(); }
  });

  it('spawns more pedestrians along shopping streets', () => {
    const g = graph();
    const count = (busy: (x: number, z: number) => number) => {
      const sim = new PedSim(g, { rng: rng(9), maxPeds: 200 });
      sim.density = 1;
      sim.shops = { busy, front: () => undefined };
      for (let i = 0; i < 40; i++) sim.update(0.25, { x: 0, z: 30 });
      return sim.peds.filter((p) => p.edge === g.edges[2]).length / sim.peds.length;
    };
    // Shops only along the side street: its share of pedestrians goes up.
    expect(count((x) => (Math.abs(x) < 5 ? 3 : 0))).toBeGreaterThan(count(() => 0) * 1.5);
  });
});
