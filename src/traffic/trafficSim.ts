// AI traffic on the road graph: cars, vans, buses and lorries that keep to the right lane, follow each other
// with the Intelligent Driver Model, slow down for bends and turns, give way at junctions (main road first,
// otherwise right before left, left turns wait for oncoming traffic) and brake for the player.
// Pure simulation without three.js, so it runs in tests.

import { type Edge, type RoadGraph, pointAt, project } from '../world/roadGraph.ts';

export type VehicleKind = 'car' | 'van' | 'bus' | 'truck';

export interface KindSpec {
  length: number;
  width: number;
  height: number;
  /** Comfortable acceleration and braking (m/s²). */
  accel: number;
  decel: number;
  /** Factor on the speed limit. */
  speed: number;
}

export const KINDS: Record<VehicleKind, KindSpec> = {
  car: { length: 4.4, width: 1.8, height: 1.45, accel: 2.2, decel: 3, speed: 1 },
  van: { length: 5.3, width: 2, height: 2.25, accel: 1.6, decel: 2.6, speed: 0.95 },
  bus: { length: 12, width: 2.55, height: 3.1, accel: 1, decel: 2.2, speed: 0.85 },
  truck: { length: 10.5, width: 2.5, height: 3.6, accel: 0.8, decel: 2.2, speed: 0.75 },
};

/** Speed limit per road rank (m/s): 30 km/h in residential streets, 50 in town, 90 and 120 on trunk roads and motorways. */
export const SPEED_LIMIT = [4, 5, 4, 8.3, 11, 13.9, 13.9, 13.9, 25, 33];
/** Approximate carriageway width per rank, matching the pipeline's road classes. */
const ROAD_WIDTH = [3, 4, 5, 6, 5.5, 7, 7.5, 8.5, 10, 11];
/** Tracks, service roads, living streets and pedestrian zones carry no traffic. */
export const MIN_RANK = 3;

/** Lateral acceleration drivers accept in bends (m/s²). */
const LAT_ACC = 2.6;
/** Distance before a junction where drivers decide where to go and start looking for other traffic. */
const LOOK = 40;
/** Corner rounding at junctions (m). */
const BLEND = 6;
const IDM = { s0: 2.2, T: 1.3 };
/** Seconds standing before a vehicle counts as gridlocked. */
const STUCK = 25;

export interface Lane {
  edge: Edge;
  /** 1 = a → b, -1 = b → a. */
  dir: 1 | -1;
}

export type AgentState = 'drive' | 'follow' | 'yield' | 'player' | 'crashed';

export interface Agent {
  id: number;
  kind: VehicleKind;
  spec: KindSpec;
  /** Paint colour, 0xrrggbb. */
  color: number;
  edge: Edge;
  dir: 1 | -1;
  /** Distance travelled along the edge in driving direction. */
  s: number;
  v: number;
  /** Where the car goes at the end of this edge. */
  next?: Lane;
  /** The edge it came from, while it is still rounding the corner. */
  prev?: Lane;
  /** Personal speed factor, so not everyone drives exactly the limit. */
  desire: number;
  state: AgentState;
  /** Seconds standing at a junction; impatient drivers eventually go. */
  wait: number;
  /** Seconds left standing still after a crash (hazard lights). */
  crashed: number;
  /** Seconds without moving, whatever the reason; long-stuck vehicles out of sight are removed (gridlock). */
  stuck: number;
  /** Seconds stuck behind the player, for the horn. */
  blocked: number;
  braking: boolean;
  /** Why it is waiting (for traffic.near): the vehicle it gives way to and the rule. */
  reason?: string;
  /** Pose on the road surface: position, heading as atan2(dx, dz) of the driving direction, pitch (nose up > 0). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface PlayerState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Half length and half width of the player's car. */
  halfLength: number;
  halfWidth: number;
}

export interface TrafficEvents {
  honk?(a: Agent): void;
  crash?(a: Agent, strength: number): void;
}

const node = (l: Lane) => (l.dir > 0 ? l.edge.b : l.edge.a);
const startNode = (l: Lane) => (l.dir > 0 ? l.edge.a : l.edge.b);
const sameLane = (a: Lane | undefined, b: Lane | undefined) => !!a && !!b && a.edge === b.edge && a.dir === b.dir;

/** Lateral offset of the driving lane from the centre line, to the right. */
export function laneOffset(e: Edge) {
  const w = ROAD_WIDTH[e.rank] ?? 6;
  // One-way roads: in the middle, except motorway carriageways where traffic keeps to the right lane.
  if (e.oneway) return e.rank >= 8 ? w / 4 : 0;
  return w / 4;
}

export class TrafficSim {
  readonly agents: Agent[] = [];
  /** 0..1, scales the number of vehicles around the player. */
  density = 0.6;
  maxAgents: number;
  /** Vehicles appear and vanish between these distances from the player. */
  spawnMin = 90;
  spawnMax = 420;
  frozen = false;
  events: TrafficEvents = {};
  private graph: RoadGraph;
  private adj: number[][];
  private rng: () => number;
  private nextId = 1;
  private spawnTimer = 0;
  private curveCache = new Map<number, Float32Array>();

  constructor(graph: RoadGraph, opts: { maxAgents?: number; rng?: () => number } = {}) {
    this.graph = graph;
    this.maxAgents = opts.maxAgents ?? 60;
    this.rng = opts.rng ?? Math.random;
    this.adj = Array.from({ length: graph.nodes.length / 3 }, () => []);
    for (const e of graph.edges) {
      this.adj[e.a].push(e.id);
      if (e.b !== e.a) this.adj[e.b].push(e.id);
    }
  }

  get target() {
    return Math.round(this.density * this.maxAgents);
  }

  clear() {
    this.agents.length = 0;
  }

  /**
   * Advances the traffic. `view` is the camera position and forward direction: new vehicles near the player
   * only appear outside the view.
   */
  update(dt: number, player: PlayerState | undefined, view?: { x: number; z: number; fx: number; fz: number }) {
    if (player) this.populate(dt, player, view);
    if (this.frozen || dt <= 0) return;
    // Decide first, then move, so every car reacts to the same snapshot.
    const acc = this.agents.map((a) => this.decide(a, player, dt));
    for (let i = 0; i < this.agents.length; i++) this.move(this.agents[i], acc[i], dt);
  }

  /** Puts a vehicle on a lane at a distance along it. Returns undefined when the spot is taken. */
  spawn(lane: Lane, s: number, kind?: VehicleKind): Agent | undefined {
    if (lane.edge.oneway && lane.dir < 0) return undefined;
    kind ??= this.pickKind(lane.edge.rank);
    const spec = KINDS[kind];
    s = Math.min(Math.max(s, 0), lane.edge.length);
    for (const b of this.agents) if (sameLane(b, lane) && Math.abs(b.s - s) < (spec.length + b.spec.length) / 2 + 8) return undefined;
    const limit = SPEED_LIMIT[lane.edge.rank] * spec.speed;
    const a: Agent = {
      id: this.nextId++, kind, spec, color: this.pickColor(kind), edge: lane.edge, dir: lane.dir, s,
      v: limit * 0.7, desire: 0.88 + this.rng() * 0.22, state: 'drive', wait: 0, crashed: 0, blocked: 0, stuck: 0, braking: false,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    };
    this.pose(a);
    this.agents.push(a);
    return a;
  }

  /** Spawns a vehicle on the nearest road with traffic ahead of a point. */
  spawnNear(x: number, z: number, fx: number, fz: number, ahead = 40, kind?: VehicleKind) {
    const px = x + fx * ahead, pz = z + fz * ahead;
    let best: { e: Edge; along: number; dist: number } | undefined;
    this.graph.forEachEdgeNear(px, pz, 150, (e) => {
      if (e.rank < MIN_RANK) return;
      const pr = project(e.p, e.cum, px, pz);
      if (!best || pr.dist < best.dist) best = { e, ...pr };
    });
    if (!best) return undefined;
    const { e, along } = best;
    // Drive in the player's direction where the road allows it.
    const [ax, , az] = pointAt(e.p, e.cum, along - 2);
    const [bx, , bz] = pointAt(e.p, e.cum, along + 2);
    let dir: 1 | -1 = (bx - ax) * fx + (bz - az) * fz >= 0 ? 1 : -1;
    if (e.oneway) dir = 1;
    return this.spawn({ edge: e, dir }, dir > 0 ? along : e.length - along, kind);
  }

  // --- population ---

  private populate(dt: number, p: PlayerState, view?: { x: number; z: number; fx: number; fz: number }) {
    // Drop vehicles far away, and gridlocked ones the player cannot see.
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];
      const d = Math.hypot(a.x - p.x, a.z - p.z);
      const seen = !!view && d < 150 && ((a.x - view.x) * view.fx + (a.z - view.z) * view.fz) / Math.max(d, 1) > 0.2;
      if (d > this.spawnMax + 80 || (a.stuck > STUCK && a.state !== 'player' && !seen)) this.agents.splice(i, 1);
    }
    const missing = this.target - this.agents.length;
    if (missing <= 0) return;
    // Fill quickly when nearly empty (start, teleport), otherwise trickle in.
    this.spawnTimer -= dt;
    const burst = this.agents.length < this.target * 0.3;
    if (!burst && this.spawnTimer > 0) return;
    this.spawnTimer = 0.25;
    const candidates: Edge[] = [];
    let total = 0;
    this.graph.forEachEdgeNear(p.x, p.z, this.spawnMax, (e) => {
      if (e.rank < MIN_RANK || e.length < 15) return;
      candidates.push(e);
      total += e.length * (e.rank >= 5 ? 2 : 1);
    });
    if (!candidates.length) return;
    for (let tries = burst ? Math.min(missing, 12) * 4 : 4, made = 0; tries > 0 && made < Math.min(missing, burst ? 12 : 1); tries--) {
      let r = this.rng() * total;
      let e = candidates[0];
      for (const c of candidates) { r -= c.length * (c.rank >= 5 ? 2 : 1); if (r <= 0) { e = c; break; } }
      const dir: 1 | -1 = e.oneway || this.rng() < 0.5 ? 1 : -1;
      const s = this.rng() * e.length;
      const along = dir > 0 ? s : e.length - s;
      const [x, , z] = pointAt(e.p, e.cum, along);
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < (burst ? 40 : this.spawnMin) || d > this.spawnMax) continue;
      // Do not pop up in plain sight.
      if (!burst && view && d < 250) {
        const dx = (x - view.x) / d, dz = (z - view.z) / d;
        if (dx * view.fx + dz * view.fz > 0.2) continue;
      }
      if (this.spawn({ edge: e, dir }, s)) made++;
    }
  }

  private pickKind(rank: number): VehicleKind {
    const r = this.rng();
    if (rank >= 8) return r < 0.14 ? 'truck' : r < 0.26 ? 'van' : 'car';
    if (rank >= 5) return r < 0.06 ? 'bus' : r < 0.18 ? 'van' : r < 0.21 ? 'truck' : 'car';
    return r < 0.1 ? 'van' : 'car';
  }

  private pickColor(kind: VehicleKind): number {
    if (kind === 'bus') return this.rng() < 0.7 ? 0xd9d9d4 : 0xe8c21c;
    if (kind === 'truck') return [0xe8e8e8, 0x2b4f8c, 0xb22a22, 0x2d6b3a][Math.floor(this.rng() * 4)];
    // German car park: lots of grey, black, white and silver, a few colours.
    const palette = [0x1c1d20, 0x1c1d20, 0x9ea2a6, 0x9ea2a6, 0xd8d8d6, 0xf0f0ee, 0x4a4e54, 0x5d6168, 0x23365e, 0x6e1a1a, 0x30492f, 0xa8a090, 0x8a5a2b, 0x2a6f9b];
    if (kind === 'van') return this.rng() < 0.6 ? 0xf0f0ee : palette[Math.floor(this.rng() * palette.length)];
    return palette[Math.floor(this.rng() * palette.length)];
  }

  // --- driving ---

  private decide(a: Agent, p: PlayerState | undefined, dt: number): number {
    if (a.crashed > 0) {
      a.crashed -= dt;
      a.state = 'crashed';
      return -8;
    }
    const e = a.edge;
    const rem = e.length - a.s;
    if (!a.next && rem < LOOK + a.v * 2) a.next = this.chooseNext(a);

    // Free speed: limit, then bends and the turn ahead, braking comfortably towards each.
    const limit = SPEED_LIMIT[e.rank] * a.spec.speed * a.desire;
    let v0 = limit;
    const b = a.spec.decel * 0.6;
    const curve = this.curveSpeeds(e);
    const n = curve.length;
    for (let i = 0; i < n; i++) {
      const along = a.dir > 0 ? e.cum[i] : e.length - e.cum[i];
      const d = along - a.s;
      if (d < -3 || d > 120) continue;
      v0 = Math.min(v0, Math.sqrt(curve[i] ** 2 + 2 * b * Math.max(0, d)));
    }
    if (a.next) {
      const turn = Math.abs(this.turnAngle({ edge: e, dir: a.dir }, a.next));
      const vt = turn > 2.6 ? 3 : Math.max(4.5, limit * (1 - turn / 1.9));
      v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * b * Math.max(0, rem)));
      const nl = SPEED_LIMIT[a.next.edge.rank] * a.spec.speed * a.desire;
      v0 = Math.min(v0, Math.sqrt(nl * nl + 2 * b * Math.max(0, rem)));
    }
    v0 = Math.max(v0, 1);

    // Nearest obstacle ahead: another vehicle, a give-way line or the player.
    let gap = Infinity, vLead = 0;
    a.state = 'drive';
    a.reason = undefined;
    const lane: Lane = { edge: e, dir: a.dir };
    for (const o of this.agents) {
      if (o === a) continue;
      let d = Infinity;
      if (sameLane(o, lane) && o.s > a.s) d = o.s - a.s;
      else if (a.next && sameLane(o, a.next)) d = rem + o.s;
      else if (sameLane(o.prev, lane) && o.s < BLEND * 2) d = rem + o.s;
      if (d === Infinity) continue;
      d -= (a.spec.length + o.spec.length) / 2;
      if (d < gap) { gap = d; vLead = o.v; a.state = 'follow'; a.reason = `folgt #${o.id}`; }
    }
    const why = a.next ? this.mustYield(a, rem) : undefined;
    if (why) {
      const stop = rem - this.stopOffset(a);
      if (stop < gap) { gap = Math.max(0.1, stop); vLead = 0; a.state = 'yield'; a.reason = why; }
    }
    if (p) {
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      const rx = p.x - a.x, rz = p.z - a.z;
      const f = rx * fx + rz * fz;
      const lat = -rx * fz + rz * fx;
      const reach = a.spec.width / 2 + p.halfWidth + 0.4;
      if (f > -a.spec.length / 2 && f < 60 && Math.abs(lat) < reach) {
        const d = f - a.spec.length / 2 - p.halfLength;
        if (d < gap) { gap = Math.max(0.05, d); vLead = Math.max(0, p.vx * fx + p.vz * fz); a.state = 'player'; }
      }
      // Contact with the player: stop with hazard lights after a real hit.
      if (Math.abs(f) < a.spec.length / 2 + p.halfLength && Math.abs(lat) < a.spec.width / 2 + p.halfWidth) {
        const rel = Math.hypot(p.vx - fx * a.v, p.vz - fz * a.v);
        if (rel > 4) {
          a.crashed = 6 + Math.min(10, rel * 0.5);
          a.v = 0;
          a.state = 'crashed';
          this.events.crash?.(a, Math.min(1, rel / 20));
          return 0;
        }
      }
    }

    // Intelligent Driver Model.
    const { accel: am, decel: bm } = a.spec;
    const free = 1 - (a.v / v0) ** 4;
    let acc = am * free;
    if (gap < 200) {
      const sStar = IDM.s0 + Math.max(0, a.v * IDM.T + (a.v * (a.v - vLead)) / (2 * Math.sqrt(am * bm)));
      acc = am * (free - (sStar / Math.max(gap, 0.1)) ** 2);
    }
    acc = Math.max(acc, -9);

    // Waiting at a junction or behind the player.
    if (a.v < 0.5 && a.state === 'yield') a.wait += dt;
    else if (a.state !== 'follow') a.wait = 0;
    if (a.state === 'player' && a.v < 0.5) {
      a.blocked += dt;
      if (a.blocked > 2.5) { this.events.honk?.(a); a.blocked = -3 - this.rng() * 4; }
    } else if (a.blocked > 0) a.blocked = 0;
    return acc;
  }

  private move(a: Agent, acc: number, dt: number) {
    a.braking = acc < -0.6 || (a.v < 0.3 && a.state !== 'drive');
    a.v = Math.max(0, a.v + acc * dt);
    a.s += a.v * dt;
    a.stuck = a.v < 0.3 && a.crashed <= 0 ? a.stuck + dt : 0;
    while (a.s >= a.edge.length) {
      const next = a.next ?? this.chooseNext(a);
      if (!next) { a.s = a.edge.length; a.v = 0; break; }
      a.s -= a.edge.length;
      a.prev = { edge: a.edge, dir: a.dir };
      a.edge = next.edge;
      a.dir = next.dir;
      a.next = undefined;
      a.wait = 0;
    }
    if (a.prev && a.s > BLEND * 2) a.prev = undefined;
    this.pose(a);
  }

  /** Picks the next edge at the end of the current one: bigger roads and going straight on are more likely. */
  private chooseNext(a: Agent): Lane | undefined {
    const here: Lane = { edge: a.edge, dir: a.dir };
    const n = node(here);
    const options: { lane: Lane; w: number }[] = [];
    for (const id of this.adj[n]) {
      const e = this.graph.edges[id];
      if (e === a.edge || e.rank < MIN_RANK) continue;
      const dir: 1 | -1 = e.a === n ? 1 : -1;
      if (e.oneway && dir < 0) continue;
      const lane = { edge: e, dir };
      const turn = Math.abs(this.turnAngle(here, lane));
      options.push({ lane, w: (0.6 + e.rank / 3) * (turn < 0.5 ? 3 : turn > 2.4 ? 0.1 : 1) });
    }
    // Dead end: turn round, also on one-way stubs (better than getting stuck).
    if (!options.length) return { edge: a.edge, dir: a.dir > 0 ? -1 : 1 };
    let r = this.rng() * options.reduce((s, o) => s + o.w, 0);
    for (const o of options) if ((r -= o.w) <= 0) return o.lane;
    return options[options.length - 1].lane;
  }

  /** Give-way rules at the junction at the end of the agent's edge. */
  private mustYield(a: Agent, rem: number): string | undefined {
    const n = node({ edge: a.edge, dir: a.dir });
    if (this.adj[n].length < 3) return undefined;
    // Past the line: clear the junction.
    if (rem < 2.5 && a.v > 1) return undefined;
    const impatient = a.wait > 4 + (a.id % 7) * 0.5;
    const [nx, , nz] = [this.graph.nodes[n * 3], 0, this.graph.nodes[n * 3 + 2]];
    const [dx, dz] = this.dirAtEnd({ edge: a.edge, dir: a.dir });
    const turnA = this.turnAngle({ edge: a.edge, dir: a.dir }, a.next!);
    const etaA = rem / Math.max(a.v, 2);
    for (const b of this.agents) {
      if (b === a || b.crashed > 0) continue;
      // Someone already crossing the junction from another road.
      if (b.prev && node(b.prev) === n && b.prev.edge !== a.edge && b.s < BLEND * 1.5) {
        // Ahead of us on our way (we follow it) or leaving on our own road in the other lane: no conflict.
        if (sameLane(b, a.next!) || b.edge === a.edge) continue;
        if (b.v > 0.5 || (b.s < 4 && !impatient)) return `#${b.id} in der Kreuzung`;
        continue;
      }
      if (!b.next || b.edge === a.edge) continue;
      const bLane = { edge: b.edge, dir: b.dir };
      if (node(bLane) !== n) continue;
      const remB = b.edge.length - b.s;
      if (remB > LOOK) continue;
      // Both turning right into different roads do not conflict.
      const turnB = this.turnAngle(bLane, b.next);
      if (turnA > 0.6 && turnB > 0.6 && !sameLane(a.next, b.next)) continue;
      const committed = remB < 2.5 && b.v > 1;
      if (committed && remB < rem) return `#${b.id} fährt schon ein`;
      if (impatient) continue;
      const rankA = a.edge.rank, rankB = b.edge.rank;
      let priority: boolean;
      if (rankB !== rankA) priority = rankB > rankA;
      else {
        // Where does b come from, seen from a?
        const rx = b.x - nx, rz = b.z - nz;
        const l = Math.hypot(rx, rz) || 1;
        const side = (-dz * rx + dx * rz) / l; // > 0: b is on a's right
        const along = (dx * rx + dz * rz) / l; // > 0: b is ahead, i.e. oncoming
        if (side > 0.5) priority = true;
        else if (along > 0.7 && turnA < -0.6 && turnB > -0.6) priority = true; // turning left: oncoming traffic first
        else priority = false;
      }
      if (!priority) continue;
      const etaB = remB / Math.max(b.v, 1.5);
      if (etaB < etaA + 3.5 || b.v < 0.5) return `Vorfahrt #${b.id}`;
    }
    return undefined;
  }

  /** How far before the junction centre to stop: half the widest crossing road plus a little. */
  private stopOffset(a: Agent) {
    const n = node({ edge: a.edge, dir: a.dir });
    let w = 0;
    for (const id of this.adj[n]) if (this.graph.edges[id] !== a.edge) w = Math.max(w, ROAD_WIDTH[this.graph.edges[id].rank] ?? 6);
    return w / 2 + 1.5 + a.spec.length / 2;
  }

  /** Signed turn angle from one lane into the next at their shared node; positive = right. */
  turnAngle(from: Lane, to: Lane): number {
    const [ax, az] = this.dirAtEnd(from);
    const [bx, bz] = this.dirAtStart(to);
    // Local frame: x east, z south. Turning right (clockwise from above) is a positive cross product here.
    return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
  }

  private dirAtEnd(l: Lane): [number, number] {
    const e = l.edge;
    const a0 = l.dir > 0 ? Math.max(0, e.length - 6) : Math.min(e.length, 6);
    const a1 = l.dir > 0 ? e.length : 0;
    return unit(pointAt(e.p, e.cum, a0), pointAt(e.p, e.cum, a1));
  }

  private dirAtStart(l: Lane): [number, number] {
    const e = l.edge;
    const a0 = l.dir > 0 ? 0 : e.length;
    const a1 = l.dir > 0 ? Math.min(e.length, 6) : Math.max(0, e.length - 6);
    return unit(pointAt(e.p, e.cum, a0), pointAt(e.p, e.cum, a1));
  }

  /** Comfortable speed at each polyline point of an edge, from the bend radius there. */
  private curveSpeeds(e: Edge): Float32Array {
    let c = this.curveCache.get(e.id);
    if (c) return c;
    const n = e.cum.length;
    c = new Float32Array(n).fill(99);
    const p = e.p;
    for (let i = 1; i < n - 1; i++) {
      const ax = p[i * 3] - p[i * 3 - 3], az = p[i * 3 + 2] - p[i * 3 - 1];
      const bx = p[i * 3 + 3] - p[i * 3], bz = p[i * 3 + 5] - p[i * 3 + 2];
      const ang = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      if (ang < 0.02) continue;
      const seg = Math.min(Math.hypot(ax, az), Math.hypot(bx, bz));
      const radius = Math.max(4, seg / ang);
      c[i] = Math.sqrt(LAT_ACC * radius);
    }
    this.curveCache.set(e.id, c);
    return c;
  }

  // --- pose ---

  /** Lane point and driving direction at a distance along a lane. */
  private lanePoint(l: Lane, s: number): [number, number, number, number, number] {
    const e = l.edge;
    const along = l.dir > 0 ? s : e.length - s;
    const [x, y, z] = pointAt(e.p, e.cum, along);
    const [ax, , az] = pointAt(e.p, e.cum, along - 1.5 * l.dir);
    const [bx, , bz] = pointAt(e.p, e.cum, along + 1.5 * l.dir);
    let dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const off = laneOffset(e);
    // Right of the driving direction in the local frame (x east, z south).
    return [x - dz * off, y, z + dx * off, dx, dz];
  }

  private pose(a: Agent) {
    const lane: Lane = { edge: a.edge, dir: a.dir };
    let px: number, py: number, pz: number, dx: number, dz: number;
    const r0 = Math.min(BLEND, a.edge.length / 3);
    // Round the corner between the end of one edge and the start of the next.
    let from: Lane | undefined, to: Lane | undefined, t = 0, rIn = 0, rOut = 0;
    if (a.next && a.s > a.edge.length - r0) {
      from = lane; to = a.next; rIn = r0; rOut = Math.min(BLEND, a.next.edge.length / 3);
      t = (a.s - (a.edge.length - rIn)) / (rIn + rOut);
    } else if (a.prev && a.s < Math.min(BLEND, a.edge.length / 3)) {
      from = a.prev; to = lane; rIn = Math.min(BLEND, a.prev.edge.length / 3); rOut = r0;
      t = (rIn + a.s) / (rIn + rOut);
    }
    if (from && to && rIn + rOut > 0.5) {
      const P0 = this.lanePoint(from, from.edge.length - rIn);
      const P2 = this.lanePoint(to, rOut);
      // Control point: where the two lane lines meet, near the junction node.
      const n = startNode(to);
      const nx = this.graph.nodes[n * 3], ny = this.graph.nodes[n * 3 + 1], nz = this.graph.nodes[n * 3 + 2];
      const ux = -P0[4] - P2[4], uz = P0[3] + P2[3];
      const u2 = Math.max(ux * ux + uz * uz, 0.6);
      const off = (laneOffset(from.edge) + laneOffset(to.edge)) / 2;
      const cx = nx + (ux * 2 * off) / u2, cz = nz + (uz * 2 * off) / u2;
      const it = 1 - t;
      px = it * it * P0[0] + 2 * it * t * cx + t * t * P2[0];
      pz = it * it * P0[2] + 2 * it * t * cz + t * t * P2[2];
      py = it * it * P0[1] + 2 * it * t * ny + t * t * P2[1];
      dx = 2 * it * (cx - P0[0]) + 2 * t * (P2[0] - cx);
      dz = 2 * it * (cz - P0[2]) + 2 * t * (P2[2] - cz);
    } else {
      [px, py, pz, dx, dz] = this.lanePoint(lane, a.s);
    }
    a.x = px; a.y = py; a.z = pz;
    if (Math.hypot(dx, dz) > 1e-4) a.yaw = Math.atan2(dx, dz);
    // Pitch from the height difference over the wheelbase.
    const e = a.edge;
    const along = a.dir > 0 ? a.s : e.length - a.s;
    const h = a.spec.length * 0.35;
    const y0 = pointAt(e.p, e.cum, along - h * a.dir)[1];
    const y1 = pointAt(e.p, e.cum, along + h * a.dir)[1];
    a.pitch = Math.atan2(y1 - y0, 2 * h);
  }
}

function unit(a: [number, number, number], b: [number, number, number]): [number, number] {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}
