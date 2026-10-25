import { describe, expect, it } from 'vitest';
import type { RoadGraphData } from '../src/world/format.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';
import { generateEvents, mergeEvents } from '../src/game/events/generate.ts';
import { EventRunner, rewardFor } from '../src/game/events/runner.ts';
import { crossed, formatValue, type GameEvent, type Gate, medalFor } from '../src/game/events/types.ts';
import { levelOf, Progress, xpForLevel } from '../src/game/progress.ts';
import { SaveGame } from '../src/game/save.ts';

const gate = (z: number, w = 5): Gate => ({ x: 0, y: 0, z, dx: 0, dz: 1, w });

const sprint = (over: Partial<GameEvent> = {}): GameEvent => ({
  id: 'sprint-test', type: 'sprint', name: 'Test', where: 'Teststraße', start: gate(0), gates: [gate(200), gate(400)],
  medals: [40, 30, 20, 15], higher: false, unit: 's', level: 1, ...over,
});

/** Drives the runner straight along +z at speed v (m/s) for t seconds. */
function drive(r: EventRunner, from: number, v: number, t: number, x = 0, dt = 1 / 30) {
  let z = from;
  for (let s = 0; s < t; s += dt) { z += v * dt; r.update(dt, { x, z, speed: v }); }
  return z;
}

describe('gates', () => {
  it('counts a crossing only in the gate direction and inside its width', () => {
    const g = gate(10, 4);
    expect(crossed(g, 0, 9, 0, 11)).toBe(true);
    expect(crossed(g, 0, 11, 0, 9)).toBe(false);
    expect(crossed(g, 6, 9, 6, 11)).toBe(false);
    expect(crossed(g, 6, 9, 6, 11, 3)).toBe(true);
  });

  it('gives medals by thresholds, both directions', () => {
    const e = sprint();
    expect(medalFor(e, 50)).toBe(0);
    expect(medalFor(e, 35)).toBe(1);
    expect(medalFor(e, 14)).toBe(4);
    expect(medalFor({ ...e, higher: true, medals: [100, 120, 140, 160] }, 150)).toBe(3);
    expect(formatValue(e, 83.456)).toBe('1:23,46');
  });
});

describe('event runner', () => {
  it('counts down, then runs through the checkpoints to the finish', () => {
    const r = new EventRunner();
    const seen: number[] = [];
    let go = 0;
    r.onCountdown = (n) => seen.push(n);
    r.onGo = () => go++;
    r.startRace(sprint(), 3);
    expect(r.state).toBe('countdown');
    drive(r, -5, 0, 3.1);
    expect(seen).toEqual([3, 2, 1]);
    expect(go).toBe(1);
    expect(r.state).toBe('running');
    // 25 m/s: 405 m in 16.2 s → gold.
    drive(r, -5, 25, 18);
    expect(r.state).toBe('done');
    expect(r.result!.medal).toBe(3);
    expect(r.result!.value).toBeCloseTo(16.2, 0);
    expect(r.result!.best).toBe(true);
  });

  it('runs laps on circuits', () => {
    const r = new EventRunner();
    const e = sprint({ type: 'circuit', gates: [gate(100)], laps: 2 });
    r.startRace(e, 0.01);
    drive(r, -5, 0, 0.1);
    let laps = 0;
    r.onLap = () => laps++;
    drive(r, -5, 25, 5);
    expect(r.lap).toBe(2);
    expect(r.state).toBe('running');
    drive(r, -5, 25, 5);
    expect(laps).toBe(1);
    expect(r.state).toBe('done');
  });

  it('measures speed traps on the spot and fails zones left early', () => {
    const r = new EventRunner();
    let res = 0;
    r.onFinish = (x) => (res = x.value);
    r.startSkill({ ...sprint(), id: 'trap', type: 'speedtrap', gates: [], higher: true, unit: 'km/h', medals: [100, 120, 140, 160] }, 40);
    expect(res).toBeCloseTo(144);
    expect(r.result!.medal).toBe(3);

    let why = '';
    r.onFail = (_, w) => (why = w);
    r.startSkill({ ...sprint(), id: 'zone', type: 'speedzone', gates: [gate(500)], path: [0, 0, 0, 500], higher: true, unit: 'km/h', medals: [60, 80, 100, 120] }, 20);
    drive(r, 0, 20, 2, 50);
    expect(why).toBe('Zone verlassen');
    expect(r.state).toBe('idle');
  });

  it('adds two seconds per missed slalom cone pair', () => {
    const r = new EventRunner();
    const cones = [gate(30, 1.4), { ...gate(60, 1.4), x: 4 }];
    r.startSkill(sprint({ id: 'sl', type: 'slalom', gates: [gate(100)], extra: { cones }, medals: [16, 13, 11, 9.5] }), 20);
    drive(r, 0, 20, 6);
    expect(r.state).toBe('done');
    expect(r.misses).toBe(1);
    expect(r.result!.value).toBeCloseTo(r.time + 2, 1);
  });

  it('ends jumps with the distance flown and counts drift points in drift zones', () => {
    const r = new EventRunner();
    r.startSkill(sprint({ id: 'j', type: 'jump', gates: [], higher: true, unit: 'm', medals: [20, 35, 50, 70] }), 30);
    r.style({ kind: 'air', label: '', points: 0, nitro: 0, value: 42 });
    expect(r.result!.value).toBe(42);
    expect(r.result!.medal).toBe(2);

    r.startSkill(sprint({ id: 'd', type: 'drift', gates: [gate(300)], higher: true, unit: 'Pkt', medals: [500, 1000, 2000, 3000] }), 10);
    r.style({ kind: 'drift', label: '', points: 1200, nitro: 0 });
    r.style({ kind: 'nearMiss', label: '', points: 300, nitro: 0 });
    expect(r.value()).toBe(1200);
  });

  it('pays more for better medals and harder events', () => {
    const e = sprint();
    expect(rewardFor(e, 3).xp).toBeGreaterThan(rewardFor(e, 1).xp);
    expect(rewardFor({ ...e, level: 8 }, 1).credits).toBeGreaterThan(rewardFor(e, 1).credits);
    expect(rewardFor(e, 0).xp).toBeGreaterThan(0);
  });
});

describe('progress', () => {
  it('levels up with XP and reports each level', () => {
    expect(levelOf(0)).toBe(1);
    expect(levelOf(xpForLevel(2))).toBe(2);
    expect(levelOf(xpForLevel(5) - 1)).toBe(4);
    const p = new Progress(new SaveGame());
    const ups: number[] = [];
    p.onLevelUp = (l) => ups.push(l);
    p.reward(xpForLevel(3) + 10, 100, 'test');
    expect(p.level).toBe(3);
    expect(ups).toEqual([2, 3]);
    expect(p.spend(1e9)).toBe(false);
    expect(p.spend(100)).toBe(true);
  });
});

/** A 2 km straight main road along x, and a winding side road further away. */
function townGraph(): RoadGraph {
  const data: RoadGraphData = { v: 1, names: ['Hauptstraße', 'Kurvenweg'], nodes: [0, 0, 0, 2000, 0, 0, 5000, 0, 0, 5000, 0, 600], edges: [] };
  const straight: number[] = [];
  for (let k = 0; k <= 100; k++) straight.push(k * 20, 0, 0);
  const wind: number[] = [];
  for (let k = 0; k <= 60; k++) wind.push(5000 + Math.sin(k / 4) * 40, 0, k * 10);
  data.edges.push({ a: 0, b: 1, n: 0, c: 6, w: 9, p: straight });
  data.edges.push({ a: 2, b: 3, n: 1, c: 4, w: 6, p: wind });
  return new RoadGraph(data);
}

describe('event generator', () => {
  it('finds speed traps, zones and drift zones on matching roads, the same every time', () => {
    const g = townGraph();
    const a = generateEvents(g);
    const b = generateEvents(g);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    const types = new Set(a.map((e) => e.type));
    expect(types.has('speedtrap')).toBe(true);
    expect(types.has('drift')).toBe(true);
    for (const e of a) expect(e.medals.every((m, i) => i === 0 || (e.higher ? m > e.medals[i - 1] : m < e.medals[i - 1]))).toBe(true);
    // Starts keep their distance.
    for (const x of a) for (const y of a) if (x !== y) expect(Math.hypot(x.start.x - y.start.x, x.start.z - y.start.z)).toBeGreaterThan(249);
  });

  it('lets hand-made events replace generated ones by id', () => {
    const gen = generateEvents(townGraph());
    const own = { ...gen[0], name: 'Eigenes' };
    const merged = mergeEvents(gen, [own, sprint({ id: 'neu' })]);
    expect(merged.length).toBe(gen.length + 1);
    expect(merged.find((e) => e.id === gen[0].id)!.name).toBe('Eigenes');
  });
});
