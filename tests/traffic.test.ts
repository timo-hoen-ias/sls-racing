import { describe, expect, it } from 'vitest';
import type { RoadGraphData } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';
import { type Agent, TrafficSim } from '../src/traffic/trafficSim.ts';

function rng(seed = 1) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Grid of 3 × 3 junctions, 120 m apart (local x east, z south). The middle row (z = 0) is a main road. */
function gridGraph(opts: { oneway?: boolean; signals?: boolean } = {}): RoadGraph {
  const S = 120;
  const data: RoadGraphData = { v: 1, names: ['Hauptstraße', 'Nebenstraße', 'Einbahn'], nodes: [], edges: [] };
  const id = (i: number, j: number) => j * 3 + i;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) data.nodes.push((i - 1) * S, 0, (j - 1) * S);
  const line = (a: number, b: number) => {
    const p: number[] = [];
    const [ax, az, bx, bz] = [data.nodes[a * 3], data.nodes[a * 3 + 2], data.nodes[b * 3], data.nodes[b * 3 + 2]];
    for (let k = 0; k <= 12; k++) p.push(ax + ((bx - ax) * k) / 12, 0, az + ((bz - az) * k) / 12);
    return p;
  };
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 2; i++) data.edges.push({ a: id(i, j), b: id(i + 1, j), n: j === 1 ? 0 : 1, c: j === 1 ? 6 : 3, p: line(id(i, j), id(i + 1, j)) });
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 2; j++) {
      const one = opts.oneway && i === 2;
      data.edges.push({ a: id(i, j), b: id(i, j + 1), n: one ? 2 : 1, c: 3, ...(one ? { o: 1 as const } : {}), p: line(id(i, j), id(i, j + 1)) });
    }
  if (opts.signals) data.s = [[id(1, 1), 0]];
  return new RoadGraph(data);
}

const edgeAt = (g: RoadGraph, x: number, z: number) => g.snap(x, z, 5)!.edge;

function run(sim: TrafficSim, seconds: number, each?: (t: number) => void, player?: Parameters<TrafficSim['update']>[1]) {
  for (let t = 0; t < seconds; t += 1 / 30) {
    sim.update(1 / 30, player);
    each?.(t);
  }
}

describe('TrafficSim', () => {
  it('keeps a safe gap to the car in front and never overlaps', () => {
    const g = gridGraph();
    const sim = new TrafficSim(g, { rng: rng(3) });
    sim.density = 0;
    const e = edgeAt(g, -60, 0);
    for (let s = 5; s < 110; s += 14) sim.spawn({ edge: e, dir: 1 }, s);
    expect(sim.agents.length).toBeGreaterThan(5);
    let minGap = Infinity;
    run(sim, 90, () => {
      for (const a of sim.agents)
        for (const b of sim.agents) {
          if (a === b || a.edge !== b.edge || a.dir !== b.dir || b.s <= a.s) continue;
          minGap = Math.min(minGap, b.s - a.s - (a.spec.length + b.spec.length) / 2);
        }
    });
    expect(minGap).toBeGreaterThan(0.5);
    // Everyone is still moving through the grid, not stuck.
    expect(sim.agents.filter((a) => a.v > 1).length).toBeGreaterThan(sim.agents.length / 3);
  });

  it('never drives against a one-way street', () => {
    const g = gridGraph({ oneway: true });
    const sim = new TrafficSim(g, { rng: rng(7) });
    sim.density = 0;
    for (const e of g.edges) for (const dir of [1, -1] as const) sim.spawn({ edge: e, dir }, 20);
    let wrong = 0;
    run(sim, 120, () => { for (const a of sim.agents) if (a.edge.oneway && a.dir < 0) wrong++; });
    expect(wrong).toBe(0);
  });

  it('gives way to the right at equal roads', () => {
    const g = gridGraph();
    const sim = new TrafficSim(g, { rng: rng(1) });
    sim.density = 0;
    // Middle-top junction (0, -120): west/east row and the column going south. Degree 3.
    const west = edgeAt(g, -60, -120);
    const south = edgeAt(g, 0, -60);
    const a = sim.spawn({ edge: west, dir: 1 }, 60)!; // driving east towards (0, -120)
    const b = sim.spawn({ edge: south, dir: -1 }, 60)!; // driving north towards (0, -120), on a's right
    a.v = b.v = 7;
    const order: Agent[] = [];
    run(sim, 30, () => {
      for (const x of [a, b]) if (!order.includes(x) && x.prev) order.push(x);
    });
    expect(order[0]).toBe(b);
  });

  it('lets the main road go first', () => {
    const g = gridGraph();
    const sim = new TrafficSim(g, { rng: rng(2) });
    sim.density = 0;
    // Middle junction (0, 0): main road (rank 6) east-west, side road from the north (rank 3).
    const main = edgeAt(g, -60, 0);
    const side = edgeAt(g, 0, -60);
    const m = sim.spawn({ edge: main, dir: 1 }, 70)!;
    // The side road car comes from the north (on the main road car's left), but gets close first.
    const s = sim.spawn({ edge: side, dir: 1 }, 90)!;
    m.v = 10; s.v = 6;
    const order: Agent[] = [];
    run(sim, 30, () => { for (const x of [m, s]) if (!order.includes(x) && x.prev) order.push(x); });
    expect(order[0]).toBe(m);
  });

  it('stops at a red light and drives on at green', () => {
    const g = gridGraph({ signals: true });
    const sim = new TrafficSim(g, { rng: rng(8) });
    sim.density = 0;
    sim.signals.forced = 'red';
    const side = edgeAt(g, 0, -60);
    const a = sim.spawn({ edge: side, dir: 1 }, 40)!; // from the north towards the lights at (0, 0)
    a.v = 10;
    run(sim, 25);
    expect(a.edge).toBe(side);
    expect(a.v).toBeLessThan(0.3);
    expect(a.reason).toBe('Rot');
    sim.signals.forced = 'green';
    run(sim, 10);
    expect(a.edge).not.toBe(side);
  });

  it('switches the two directions of a junction in turn', () => {
    const g = gridGraph({ signals: true });
    const sim = new TrafficSim(g, { rng: rng(9) });
    const node = 4;
    let bothGreen = 0, mainGreen = 0, crossGreen = 0;
    for (let t = 0; t < sim.signals.cycle * 2; t += 0.5) {
      sim.signals.update(0.5);
      const m = sim.signals.light(node, 1, 0), c = sim.signals.light(node, 0, 1);
      if (m === 'green' && c === 'green') bothGreen++;
      if (m === 'green') mainGreen++;
      if (c === 'green') crossGreen++;
    }
    expect(bothGreen).toBe(0);
    expect(mainGreen).toBeGreaterThan(20);
    expect(crossGreen).toBeGreaterThan(20);
  });

  it('stops behind the player without hitting them', () => {
    const g = gridGraph();
    const sim = new TrafficSim(g, { rng: rng(4) });
    sim.density = 0;
    const e = edgeAt(g, -60, 0);
    const a = sim.spawn({ edge: e, dir: 1 }, 5)!;
    a.v = 12;
    // The player stands in a's lane 70 m ahead.
    const lane = { x: a.x + 70, z: a.z };
    let crashed = 0;
    sim.events.crash = () => crashed++;
    run(sim, 20, undefined, { ...lane, vx: 0, vz: 0, halfLength: 2.25, halfWidth: 0.95 });
    expect(crashed).toBe(0);
    expect(a.v).toBeLessThan(0.3);
    expect(lane.x - a.x).toBeGreaterThan(a.spec.length / 2 + 2.25);
    expect(lane.x - a.x).toBeLessThan(15);
    expect(a.state).toBe('player');
  });

  it('moves smoothly through junctions (no jumps)', () => {
    const g = gridGraph();
    const sim = new TrafficSim(g, { rng: rng(5) });
    sim.density = 0;
    const a = sim.spawn({ edge: edgeAt(g, -60, 0), dir: 1 }, 10)!;
    let px = a.x, pz = a.z, maxJump = 0, edges = 0, last = a.edge;
    run(sim, 120, () => {
      maxJump = Math.max(maxJump, Math.hypot(a.x - px, a.z - pz) - a.v / 30);
      px = a.x; pz = a.z;
      if (a.edge !== last) { edges++; last = a.edge; }
    });
    expect(edges).toBeGreaterThan(4);
    expect(maxJump).toBeLessThan(0.35);
  });

  it('fills the area around the player up to the density target', () => {
    const g = gridGraph();
    const sim = new TrafficSim(g, { rng: rng(6), maxAgents: 20 });
    sim.density = 0.5;
    sim.spawnMin = 30;
    run(sim, 10, undefined, { x: 0, z: 0, vx: 0, vz: 0, halfLength: 2.25, halfWidth: 0.95 });
    expect(sim.agents.length).toBe(10);
  });

  it('thins traffic on the route of a running race (V1)', () => {
    const g = gridGraph();
    const sim = new TrafficSim(g, { rng: rng(6), maxAgents: 40 });
    sim.density = 1;
    sim.spawnMin = 30;
    const player = { x: 0, z: 0, vx: 0, vz: 0, halfLength: 2.25, halfWidth: 0.95 };
    // The race runs along the middle east-west street.
    const onRoute = (a: { x: number; z: number }) => Math.abs(a.z) < 10;
    run(sim, 10, undefined, player);
    const before = sim.agents.filter(onRoute).length;
    expect(before).toBeGreaterThan(3);
    sim.thinOut = (x, z) => Math.abs(z) < 10;
    sim.thinKeep = 0;
    sim.thinRoute(player, 0);
    expect(sim.agents.filter((a) => onRoute(a) && a.state !== 'player').length).toBe(0);
    run(sim, 10, undefined, player);
    expect(sim.agents.filter((a) => onRoute(a) && Math.hypot(a.x, a.z) > 40).length).toBeLessThan(before);
    expect(sim.target).toBe(28);
  });
});
