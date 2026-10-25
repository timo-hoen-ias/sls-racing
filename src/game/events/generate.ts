import { type Edge, pointAt, type RoadGraph } from '../../world/roadGraph.ts';
import type { EventType, Gate, GameEvent } from './types.ts';

// Events from the road network of any region, deterministic for the same graph: speed traps at the end of
// long straights, speed zones along them, drift zones on twisty stretches, near-miss zones on busy main roads,
// cone slaloms on wide straights, sprints across town and circuits around a centre. Hand-made events
// (tiles/events.json) can replace or add to them by id.

interface Chain {
  /** Polyline x, y, z and cumulative length. */
  p: Float32Array;
  cum: Float32Array;
  length: number;
  rank: number;
  width: number;
  name: string;
  /** Drivable a → b / b → a (one-way streets). */
  fwd: boolean;
  back: boolean;
}

const lerpAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Joins edges through nodes with exactly two roads of the same rank into longer chains. */
export function chains(graph: RoadGraph, accept: (e: Edge) => boolean): Chain[] {
  const nNodes = graph.nodes.length / 3;
  const adj: number[][] = Array.from({ length: nNodes }, () => []);
  for (const e of graph.edges) if (accept(e)) { adj[e.a].push(e.id); if (e.b !== e.a) adj[e.b].push(e.id); }
  const used = new Set<number>();
  const out: Chain[] = [];
  for (const e0 of graph.edges) {
    if (used.has(e0.id) || !accept(e0)) continue;
    used.add(e0.id);
    // Each part: edge and whether it runs along the chain (a → b).
    const parts: { e: Edge; along: boolean }[] = [{ e: e0, along: true }];
    const extend = (atEnd: boolean) => {
      for (;;) {
        const last = atEnd ? parts[parts.length - 1] : parts[0];
        const node = atEnd ? (last.along ? last.e.b : last.e.a) : (last.along ? last.e.a : last.e.b);
        const list = adj[node];
        if (list.length !== 2) return;
        const nextId = list[0] === last.e.id ? list[1] : list[0];
        const n = graph.edges[nextId];
        if (used.has(nextId) || n.rank !== e0.rank) return;
        used.add(nextId);
        const along = atEnd ? n.a === node : n.b === node;
        if (atEnd) parts.push({ e: n, along }); else parts.unshift({ e: n, along });
      }
    };
    extend(true);
    extend(false);
    const pts: number[] = [];
    for (const { e, along } of parts) {
      const k = e.p.length / 3;
      for (let i = 0; i < k; i++) {
        const j = along ? i : k - 1 - i;
        if (pts.length && i === 0) continue;
        pts.push(e.p[j * 3], e.p[j * 3 + 1], e.p[j * 3 + 2]);
      }
    }
    const p = Float32Array.from(pts);
    const cum = new Float32Array(p.length / 3);
    for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 2] - p[i * 3 - 1]);
    out.push({
      p, cum, length: cum[cum.length - 1], rank: e0.rank, width: Math.min(...parts.map((x) => x.e.width)), name: parts.find((x) => x.e.name)?.e.name ?? '',
      fwd: parts.every((x) => !x.e.oneway || x.along), back: parts.every((x) => !x.e.oneway || !x.along),
    });
  }
  return out;
}

/** Direction (unit x/z) of the chain at distance d. */
function dirAt(c: { p: Float32Array; cum: Float32Array }, d: number) {
  const [x0, , z0] = pointAt(c.p, c.cum, Math.max(0, d - 2));
  const [x1, , z1] = pointAt(c.p, c.cum, d + 2);
  const l = Math.hypot(x1 - x0, z1 - z0) || 1;
  return { dx: (x1 - x0) / l, dz: (z1 - z0) / l };
}

function gate(c: { p: Float32Array; cum: Float32Array }, d: number, w: number, reverse = false): Gate {
  const [x, y, z] = pointAt(c.p, c.cum, d);
  const { dx, dz } = dirAt(c, d);
  return { x, y, z, dx: reverse ? -dx : dx, dz: reverse ? -dz : dz, w };
}

const TURN_STEP = 10;
const turnCache = new WeakMap<Chain, Float64Array>();

/** Running total of heading change every 10 m along the chain. */
function turnSums(c: Chain) {
  let sums = turnCache.get(c);
  if (sums) return sums;
  const n = Math.floor(c.length / TURN_STEP) + 1;
  sums = new Float64Array(n);
  let last: number | undefined;
  for (let i = 0; i < n; i++) {
    const { dx, dz } = dirAt(c, i * TURN_STEP);
    const h = Math.atan2(dx, dz);
    sums[i] = (i ? sums[i - 1] : 0) + (last === undefined ? 0 : Math.abs(lerpAngle(h - last)));
    last = h;
  }
  turnCache.set(c, sums);
  return sums;
}

/** Total change of heading (rad) along a stretch. */
function turning(c: Chain, from: number, to: number) {
  const s = turnSums(c);
  const i = Math.max(0, Math.min(s.length - 1, Math.floor(from / TURN_STEP)));
  const j = Math.max(0, Math.min(s.length - 1, Math.floor(to / TURN_STEP)));
  return s[j] - s[i];
}

/** Longest stretch with little heading change: [from, to] (two pointers over the 10 m samples). */
function straightest(c: Chain, maxTurn: number): [number, number] {
  const s = turnSums(c);
  let best: [number, number] = [0, 0];
  let i = 0;
  for (let j = 0; j < s.length; j++) {
    while (s[j] - s[i] > maxTurn) i++;
    if ((j - i) * TURN_STEP > best[1] - best[0]) best = [i * TURN_STEP, j * TURN_STEP];
  }
  return best;
}

function pathOf(c: Chain, from: number, to: number, reverse: boolean) {
  const out: number[] = [];
  const step = Math.max(5, (to - from) / 400);
  for (let d = from; d <= to + 0.01; d += step) {
    const [x, , z] = pointAt(c.p, c.cum, Math.min(d, to));
    out.push(x, z);
  }
  if (reverse) {
    const r: number[] = [];
    for (let i = out.length - 2; i >= 0; i -= 2) r.push(out[i], out[i + 1]);
    return r;
  }
  return out;
}

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
}

export interface GenerateOptions {
  seed?: number;
  /** Minimum distance between event starts (m). */
  spacing?: number;
  max?: Partial<Record<EventType, number>>;
  /** Ramps placed in the world (W3) that get a jump event each. */
  ramps?: { x: number; y: number; z: number; heading: number; length: number; height: number; name: string; runup?: { x: number; y: number; z: number } }[];
}

const STREET = (name: string) => name.replaceAll(';', ' / ') || 'Landstraße';

export function generateEvents(graph: RoadGraph, opts: GenerateOptions = {}): GameEvent[] {
  const spacing = opts.spacing ?? 250;
  const max = { speedtrap: 14, speedzone: 8, drift: 8, nearmiss: 6, slalom: 4, sprint: 8, circuit: 4, duel: 2, jump: 12, ...opts.max };
  const events: GameEvent[] = [];
  const taken: { x: number; z: number }[] = [];
  const free = (x: number, z: number, r = spacing) => taken.every((t) => Math.hypot(t.x - x, t.z - z) > r);
  const add = (e: GameEvent) => {
    if (!free(e.start.x, e.start.z)) return false;
    // Every gate has to stay clear of other events too, so markers never overlap.
    events.push(e);
    taken.push({ x: e.start.x, z: e.start.z });
    return true;
  };
  const count = (t: EventType) => events.filter((e) => e.type === t).length;
  const id = (t: EventType, g: Gate) => `${t}-${Math.round(g.x)}-${Math.round(g.z)}`;
  const road = (e: Edge) => !e.noCars && e.rank >= 3;
  const all = chains(graph, road).sort((a, b) => b.length * b.rank - a.length * a.rank || a.p[0] - b.p[0]);

  // Motorway duel: the longest motorway/trunk straight as a head-to-head race against one rival.
  for (const c of all) {
    if (count('duel') >= max.duel) break;
    if (c.rank < 8 || c.length < 1500) continue;
    const rev = !c.fwd;
    const from = 0, to = Math.min(c.length, 4000);
    const s = gate(c, rev ? to : from, c.width / 2 + 2, rev);
    const f = gate(c, rev ? from : to, c.width / 2 + 2, rev);
    const len = to - from;
    add({ id: id('duel', s), type: 'duel', name: `Duell auf der ${STREET(c.name)}`, where: STREET(c.name), start: s, gates: [f], path: pathOf(c, from, to, rev),
      medals: [len / (170 / 3.6), len / (200 / 3.6), len / (230 / 3.6), len / (260 / 3.6)], higher: false, unit: 's', level: 6, rivals: 1 });
  }

  // Speed traps at the end of straights, and speed zones along them.
  for (const c of all) {
    if (c.rank < 5) continue;
    const [a, b] = straightest(c, 0.18);
    if (b - a < 180) continue;
    const rev = !c.fwd || (c.back && c.fwd && Math.round(c.p[0]) % 2 === 1);
    const v = c.rank >= 9 ? [200, 235, 265, 295] : c.rank >= 8 ? [170, 200, 230, 260] : [110, 135, 160, 185];
    if (count('speedtrap') < max.speedtrap) {
      const g = gate(c, rev ? a + 20 : b - 20, c.width / 2 + 1.5, rev);
      // Run-up on the same straight: what a car needs to reach the gold speed at ~4.5 m/s², as far as the straight allows.
      const need = Math.min(600, (v[2] / 3.6) ** 2 / 9 + 40);
      const runup = gate(c, rev ? Math.min(b - 5, a + 20 + need) : Math.max(a + 5, b - 20 - need), c.width / 2, rev);
      add({ id: id('speedtrap', g), type: 'speedtrap', name: `Blitzer ${STREET(c.name)}`, where: STREET(c.name), start: g, gates: [], medals: v as GameEvent['medals'], higher: true, unit: 'km/h', level: c.rank >= 8 ? 3 : 1, extra: { runup } });
    }
    if (count('speedzone') < max.speedzone && b - a > 350) {
      const len = Math.min(700, b - a);
      const from = rev ? b - len : a, to = rev ? b : a + len;
      const s = gate(c, rev ? to : from, c.width / 2 + 1.5, rev);
      const f = gate(c, rev ? from : to, c.width / 2 + 1.5, rev);
      const z = v.map((k) => k * 0.85);
      add({ id: id('speedzone', s), type: 'speedzone', name: `Tempozone ${STREET(c.name)}`, where: STREET(c.name), start: s, gates: [f], path: pathOf(c, from, to, rev),
        medals: z as GameEvent['medals'], higher: true, unit: 'km/h', level: 2, limit: 60 });
    }
  }

  // Drift zones on twisty stretches.
  for (const c of [...all].sort((x, y) => turning(y, 0, y.length) / y.length - turning(x, 0, x.length) / x.length)) {
    if (count('drift') >= max.drift) break;
    if (c.rank < 3 || c.rank > 7 || c.length < 150) continue;
    const len = Math.min(450, c.length);
    const turn = turning(c, 0, len);
    if (turn < 1.2) continue;
    const rev = !c.fwd;
    const s = gate(c, rev ? len : 0, c.width / 2 + 2, rev);
    const f = gate(c, rev ? 0 : len, c.width / 2 + 2, rev);
    const k = len / 200;
    add({ id: id('drift', s), type: 'drift', name: `Driftzone ${STREET(c.name)}`, where: STREET(c.name), start: s, gates: [f], path: pathOf(c, 0, len, rev),
      medals: [700 * k, 1500 * k, 2600 * k, 4000 * k], higher: true, unit: 'Pkt', level: 2, limit: 60 });
  }

  // Near-miss zones on busy main roads.
  for (const c of all) {
    if (count('nearmiss') >= max.nearmiss) break;
    if (c.rank < 5 || c.rank > 8 || c.length < 450) continue;
    const len = Math.min(900, c.length);
    const rev = !c.fwd;
    const s = gate(c, rev ? len : 0, c.width / 2 + 1.5, rev);
    const f = gate(c, rev ? 0 : len, c.width / 2 + 1.5, rev);
    add({ id: id('nearmiss', s), type: 'nearmiss', name: `Verkehrsslalom ${STREET(c.name)}`, where: STREET(c.name), start: s, gates: [f], path: pathOf(c, 0, len, rev),
      medals: [2, 4, 6, 9], higher: true, unit: '×', level: 3, limit: 90 });
  }

  // Cone slalom on wide straights: pairs of cones alternating left and right every 25 m.
  for (const c of all) {
    if (count('slalom') >= max.slalom) break;
    // Not on motorways and expressways: cones there would be a hazard, not a game.
    if (c.width < 7 || c.rank < 4 || c.rank > 7) continue;
    const [a, b] = straightest(c, 0.12);
    if (b - a < 260) continue;
    const rev = !c.fwd;
    const from = rev ? b - 240 : a + 20, to = from + 220;
    const cones: Gate[] = [];
    for (let i = 0; i < 8; i++) {
      const d = rev ? to - 20 - i * 25 : from + 20 + i * 25;
      const g = gate(c, d, 1.4, rev);
      const side = (i % 2 ? 1 : -1) * Math.min(1.8, c.width / 4);
      cones.push({ ...g, x: g.x - g.dz * side, z: g.z + g.dx * side });
    }
    const s = gate(c, rev ? to : from, c.width / 2 + 1.5, rev);
    const f = gate(c, rev ? from : to, c.width / 2 + 1.5, rev);
    add({ id: id('slalom', s), type: 'slalom', name: `Pylonen-Slalom ${STREET(c.name)}`, where: STREET(c.name), start: s, gates: [f], path: pathOf(c, from, to, rev),
      medals: [16, 13, 11, 9.5], higher: false, unit: 's', level: 1, limit: 45, extra: { cones } });
  }

  // Sprints across town and circuits around a centre.
  const rand = rng(opts.seed ?? 7);
  const big = all.filter((c) => c.rank >= 4 && c.length > 80);
  const open = (e: Edge) => !e.noCars;
  const routeGates = (pts: Float32Array, cum: Float32Array, every: number, w: number, from = 0) => {
    const out: Gate[] = [];
    const len = cum[cum.length - 1];
    for (let d = from + every; d < len - every * 0.4; d += every) out.push(gate({ p: pts, cum }, d, w));
    out.push(gate({ p: pts, cum }, len - 2, w));
    return out;
  };
  // Every point: dropping some would cut the corners of curved roads.
  const flat = (pts: Float32Array) => { const o: number[] = []; for (let i = 0; i < pts.length; i += 3) o.push(pts[i], pts[i + 2]); return o; };
  for (let tries = 0; tries < 200 && count('sprint') < max.sprint && big.length; tries++) {
    const c = big[Math.floor(rand() * big.length)];
    const [sx, , sz] = pointAt(c.p, c.cum, c.length / 2);
    const ang = rand() * Math.PI * 2, dist = 1500 + rand() * 2200;
    const from = graph.snap(sx, sz, 50, open);
    const to = graph.snap(sx + Math.cos(ang) * dist, sz + Math.sin(ang) * dist, 300, (e) => open(e) && e.rank >= 4);
    if (!from || !to) continue;
    const r = graph.route(from, to);
    if (!r || r.length < 1200 || r.length > dist * 2.2) continue;
    const s = gate({ p: r.pts, cum: r.cum }, 4, 6);
    const end = r.streets.length ? r.streets[r.streets.length - 1][1] : '';
    const len = r.length;
    add({ id: id('sprint', s), type: 'sprint', name: `${STREET(from.edge.name)} → ${STREET(end || to.edge.name)}`, where: STREET(from.edge.name), start: s,
      gates: routeGates(r.pts, r.cum, 350, 9), path: flat(r.pts), medals: [len / (65 / 3.6), len / (80 / 3.6), len / (95 / 3.6), len / (110 / 3.6)], higher: false, unit: 's',
      level: 1 + Math.floor(count('sprint') / 2), rivals: 3 });
  }
  for (let tries = 0; tries < 200 && count('circuit') < max.circuit && big.length; tries++) {
    const c = big[Math.floor(rand() * big.length)];
    const [cx, , cz] = pointAt(c.p, c.cum, c.length / 2);
    const R = 350 + rand() * 350;
    const a0 = rand() * Math.PI * 2;
    const snaps = [0, 1, 2].map((i) => graph.snap(cx + Math.cos(a0 + (i * Math.PI * 2) / 3) * R, cz + Math.sin(a0 + (i * Math.PI * 2) / 3) * R, 200, (e) => open(e) && e.rank >= 4));
    if (snaps.some((s) => !s)) continue;
    const legs = [0, 1, 2].map((i) => graph.route(snaps[i]!, snaps[(i + 1) % 3]!));
    if (legs.some((l) => !l || l.length < 200)) continue;
    const pts: number[] = [];
    for (const l of legs) for (let i = 0; i < l!.pts.length; i += 3) pts.push(l!.pts[i], l!.pts[i + 1], l!.pts[i + 2]);
    const P = Float32Array.from(pts);
    const cum = new Float32Array(P.length / 3);
    for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 2] - P[i * 3 - 1]);
    const len = cum[cum.length - 1];
    if (len < 1500 || len > 6000) continue;
    const s = gate({ p: P, cum }, 4, 6);
    const laps = len < 3000 ? 3 : 2;
    const total = len * laps;
    add({ id: id('circuit', s), type: 'circuit', name: `Rundkurs ${STREET(snaps[0]!.edge.name)}`, where: STREET(snaps[0]!.edge.name), start: s,
      gates: routeGates(P, cum, 400, 9), laps, path: flat(P), medals: [total / (60 / 3.6), total / (75 / 3.6), total / (90 / 3.6), total / (105 / 3.6)], higher: false, unit: 's',
      level: 2 + count('circuit'), rivals: 4 });
  }
  // Jumps on placed ramps (W3), last so they never push other events away.
  for (const r of opts.ramps ?? []) {
    if (count('jump') >= max.jump) break;
    const dx = Math.sin(r.heading), dz = -Math.cos(r.heading);
    const g: Gate = { x: r.x - dx * (r.length / 2 + 12), y: r.y, z: r.z - dz * (r.length / 2 + 12), dx, dz, w: 5 };
    const ru = r.runup ?? { x: g.x - dx * 60, y: g.y, z: g.z - dz * 60 };
    const rl = Math.hypot(g.x - ru.x, g.z - ru.z) || 1;
    const runup: Gate = { ...ru, dx: (g.x - ru.x) / rl, dz: (g.z - ru.z) / rl, w: 5 };
    events.push({ id: id('jump', g), type: 'jump', name: `Sprungschanze ${r.name}`, where: r.name, start: g, gates: [], medals: [20, 35, 50, 70], higher: true, unit: 'm', level: 1, limit: 6, extra: { ramp: r, runup } });
    taken.push({ x: g.x, z: g.z });
  }
  return events;
}

/** Hand-made events replace generated ones with the same id, the rest are added; drop leaves events out (failed the event test). */
export function mergeEvents(generated: GameEvent[], custom: GameEvent[] | undefined, drop: string[] = []) {
  if (drop.length) {
    const out = new Set(drop);
    generated = generated.filter((e) => !out.has(e.id));
  }
  if (!custom?.length) return generated;
  const byId = new Map(generated.map((e) => [e.id, e]));
  for (const e of custom) byId.set(e.id, e);
  return [...byId.values()];
}
