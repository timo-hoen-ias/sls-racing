// Pedestrians on the sidewalks of town streets. They stroll along the road graph at a sidewalk offset, cross at
// junctions, jump aside when the player's car comes at them, and get knocked over (and back up) if it does not miss.
// Pure simulation without three.js.

import { type Edge, type RoadGraph, pointAt } from '../world/roadGraph.ts';

/** Road ranks with sidewalks in the pipeline: living streets/pedestrian zones (2), residential (3), tertiary to primary (5–7). */
const WALKABLE = new Set([2, 3, 5, 6, 7]);
/** Carriageway width per rank, as in the pipeline. */
const ROAD_WIDTH = [3, 4, 5, 6, 5.5, 7, 7.5, 8.5, 10, 11];
const SIDEWALK = 2.2;

export type PedState = 'walk' | 'cross' | 'dodge' | 'down' | 'stand';

export interface Ped {
  id: number;
  edge: Edge;
  dir: 1 | -1;
  /** Distance along the edge in walking direction. */
  s: number;
  /** +1 walks on the right-hand sidewalk, -1 on the left. */
  side: 1 | -1;
  /** Extra offset within the sidewalk. */
  lane: number;
  speed: number;
  state: PedState;
  /** Seconds left in the current state (dodge, down, stand). */
  timer: number;
  /** Sideways jump: direction and progress. */
  dodgeX: number;
  dodgeZ: number;
  dodged: number;
  /** Walking cycle phase (rad) for the leg swing. */
  phase: number;
  /** Look: shirt, trousers, skin, height factor. */
  shirt: number;
  trousers: number;
  skin: number;
  height: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 0 standing … 1 lying on the ground. */
  fall: number;
}

export interface Threat {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Half width of the car. */
  halfWidth: number;
}

export interface PedEvents {
  knocked?(p: Ped, speed: number): void;
  dodged?(p: Ped): void;
}

export class PedSim {
  readonly peds: Ped[] = [];
  density = 0.6;
  maxPeds: number;
  spawnMin = 35;
  spawnMax = 170;
  frozen = false;
  events: PedEvents = {};
  readonly graph: RoadGraph;
  private adj: number[][];
  private rng: () => number;
  private nextId = 1;
  private spawnTimer = 0;

  constructor(graph: RoadGraph, opts: { maxPeds?: number; rng?: () => number } = {}) {
    this.graph = graph;
    this.maxPeds = opts.maxPeds ?? 40;
    this.rng = opts.rng ?? Math.random;
    this.adj = Array.from({ length: graph.nodes.length / 3 }, () => []);
    for (const e of graph.edges) {
      this.adj[e.a].push(e.id);
      if (e.b !== e.a) this.adj[e.b].push(e.id);
    }
  }

  get target() {
    return Math.round(this.density * this.maxPeds);
  }

  static walkable(e: Edge) {
    return WALKABLE.has(e.rank) && e.length > 8;
  }

  /** Pedestrians crossing a road right now, as obstacles for traffic. */
  crossing(): Ped[] {
    return this.peds.filter((p) => p.state === 'cross' && p.fall < 0.5);
  }

  update(dt: number, focus: { x: number; z: number } | undefined, threat?: Threat, view?: { x: number; z: number; fx: number; fz: number }) {
    if (focus) this.populate(dt, focus, view);
    if (this.frozen || dt <= 0) return;
    for (const p of this.peds) this.step(p, dt, threat);
  }

  spawn(edge: Edge, dir: 1 | -1, s: number, side: 1 | -1): Ped {
    const r = this.rng;
    const shirts = [0x2b4a7a, 0x8a2d2d, 0x2f5d3a, 0xd9d4c7, 0x1e1e22, 0x6b4f8a, 0xc98a2b, 0x4f7f8f, 0x9a9a9a, 0xb84d6b];
    const trousers = [0x1f2a44, 0x2a2a2e, 0x4a4136, 0x3b4b5e, 0x6e6250, 0x1a1a1a];
    const skins = [0xf1c8a8, 0xe0ac87, 0xc68863, 0x8d5a3b, 0x5e3a24];
    const p: Ped = {
      id: this.nextId++, edge, dir, s, side, lane: (r() - 0.5) * 1.1, speed: 1.05 + r() * 0.55, state: 'walk', timer: 0,
      dodgeX: 0, dodgeZ: 0, dodged: 0, phase: r() * Math.PI * 2,
      shirt: shirts[Math.floor(r() * shirts.length)], trousers: trousers[Math.floor(r() * trousers.length)], skin: skins[Math.floor(r() * skins.length)],
      height: 0.9 + r() * 0.2, x: 0, y: 0, z: 0, yaw: 0, fall: 0,
    };
    // Some stand around for a while (chatting, waiting, looking at shop windows).
    if (r() < 0.15) { p.state = 'stand'; p.timer = 3 + r() * 12; }
    this.place(p);
    this.peds.push(p);
    return p;
  }

  private populate(dt: number, f: { x: number; z: number }, view?: { x: number; z: number; fx: number; fz: number }) {
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      if (Math.hypot(p.x - f.x, p.z - f.z) > this.spawnMax + 40) this.peds.splice(i, 1);
    }
    const missing = this.target - this.peds.length;
    if (missing <= 0) return;
    this.spawnTimer -= dt;
    const burst = this.peds.length < this.target * 0.3;
    if (!burst && this.spawnTimer > 0) return;
    this.spawnTimer = 0.2;
    const edges: Edge[] = [];
    let total = 0;
    this.graph.forEachEdgeNear(f.x, f.z, this.spawnMax, (e) => {
      if (!PedSim.walkable(e)) return;
      edges.push(e);
      // Busier on bigger streets and in pedestrian zones.
      total += e.length * (e.rank === 2 ? 3 : e.rank >= 5 ? 1.5 : 1);
    });
    if (!edges.length) return;
    for (let tries = burst ? 60 : 4, made = 0; tries > 0 && made < Math.min(missing, burst ? 15 : 1); tries--) {
      let r = this.rng() * total;
      let e = edges[0];
      for (const c of edges) { r -= c.length * (c.rank === 2 ? 3 : c.rank >= 5 ? 1.5 : 1); if (r <= 0) { e = c; break; } }
      const s = 2 + this.rng() * (e.length - 4);
      const [x, , z] = pointAt(e.p, e.cum, s);
      const d = Math.hypot(x - f.x, z - f.z);
      if (d < (burst ? 12 : this.spawnMin) || d > this.spawnMax) continue;
      if (!burst && view && d < 120 && ((x - view.x) * view.fx + (z - view.z) * view.fz) / d > 0.3) continue;
      this.spawn(e, this.rng() < 0.5 ? 1 : -1, s, this.rng() < 0.5 ? 1 : -1);
      made++;
    }
  }

  private step(p: Ped, dt: number, threat?: Threat) {
    // Knocked over: lie there a moment, then get up.
    if (p.state === 'down') {
      p.timer -= dt;
      p.fall = Math.min(1, p.fall + dt * 5);
      if (p.timer <= 0) { p.state = 'stand'; p.timer = 1.5; }
      this.place(p);
      return;
    }
    p.fall = Math.max(0, p.fall - dt * 1.5);

    if (threat && p.fall < 0.3) {
      // Where will the car pass relative to the pedestrian?
      const v = Math.hypot(threat.vx, threat.vz);
      const rx = p.x - threat.x, rz = p.z - threat.z;
      const dist = Math.hypot(rx, rz);
      if (v > 2 && dist < 2 + threat.halfWidth && this.isHit(p, threat)) {
        p.state = 'down';
        p.timer = 3 + this.rng() * 2;
        p.yaw = Math.atan2(threat.vx, threat.vz);
        this.events.knocked?.(p, v);
        return;
      }
      if (v > 3 && dist < 30 && p.state !== 'dodge') {
        const ux = threat.vx / v, uz = threat.vz / v;
        const ahead = rx * ux + rz * uz;
        const lateral = -rx * uz + rz * ux;
        const t = ahead / v;
        if (ahead > 0 && t < 1.6 && Math.abs(lateral) < threat.halfWidth + 1.4) {
          // Jump away from the car's path.
          const away = lateral >= 0 ? 1 : -1;
          p.dodgeX = -uz * away;
          p.dodgeZ = ux * away;
          p.state = 'dodge';
          p.timer = 0.55;
          p.dodged = 0;
          this.events.dodged?.(p);
        }
      }
    }

    if (p.state === 'dodge') {
      const k = Math.min(dt, p.timer) * 5.5;
      p.dodged += k;
      p.timer -= dt;
      p.x += p.dodgeX * k;
      p.z += p.dodgeZ * k;
      p.phase += dt * 16;
      if (p.timer <= 0) { p.state = 'stand'; p.timer = 1 + this.rng() * 1.5; }
      return;
    }
    if (p.state === 'stand') {
      p.timer -= dt;
      // Ease back onto the sidewalk after a jump.
      if (p.dodged > 0) {
        const back = Math.min(p.dodged, dt * 1.2);
        p.dodged -= back;
        p.x -= p.dodgeX * back;
        p.z -= p.dodgeZ * back;
        p.phase += dt * 6;
        return;
      }
      if (p.timer <= 0) p.state = 'walk';
      return;
    }

    p.s += p.speed * dt;
    p.phase += dt * p.speed * 5.2;
    while (p.s >= p.edge.length) {
      p.s -= p.edge.length;
      this.turn(p);
    }
    const rem = p.edge.length - p.s;
    // Crossing the junction area at either end of the edge.
    const corner = (ROAD_WIDTH[p.edge.rank] ?? 6) / 2 + SIDEWALK;
    p.state = p.s < corner * 0.6 || rem < corner * 0.6 ? 'cross' : 'walk';
    this.place(p);
  }

  private isHit(p: Ped, t: Threat) {
    const v = Math.hypot(t.vx, t.vz);
    const ux = t.vx / v, uz = t.vz / v;
    const rx = p.x - t.x, rz = p.z - t.z;
    return Math.abs(rx * ux + rz * uz) < 2.4 && Math.abs(-rx * uz + rz * ux) < t.halfWidth + 0.35;
  }

  /** Continue on another walkable street at the end of this one; mostly straight on, sometimes round the corner. */
  private turn(p: Ped) {
    const n = p.dir > 0 ? p.edge.b : p.edge.a;
    const options: { e: Edge; dir: 1 | -1; w: number }[] = [];
    for (const id of this.adj[n]) {
      const e = this.graph.edges[id];
      if (e === p.edge || !PedSim.walkable(e)) continue;
      options.push({ e, dir: e.a === n ? 1 : -1, w: 1 + e.rank / 4 });
    }
    if (!options.length || this.rng() < 0.05) {
      // Turn round on the same sidewalk.
      p.dir = p.dir > 0 ? -1 : 1;
      p.side = p.side > 0 ? -1 : 1;
      return;
    }
    let r = this.rng() * options.reduce((s, o) => s + o.w, 0);
    for (const o of options) {
      if ((r -= o.w) <= 0) { p.edge = o.e; p.dir = o.dir; return; }
    }
  }

  private place(p: Ped) {
    if (p.state === 'dodge') return;
    const e = p.edge;
    const along = p.dir > 0 ? p.s : e.length - p.s;
    const [x, y, z] = pointAt(e.p, e.cum, along);
    const [ax, , az] = pointAt(e.p, e.cum, along - 1);
    const [bx, , bz] = pointAt(e.p, e.cum, along + 1);
    let dx = (bx - ax) * p.dir, dz = (bz - az) * p.dir;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    // Pedestrian zones: spread over the whole width; streets: on the sidewalk beyond the kerb.
    const off = e.rank === 2 ? (ROAD_WIDTH[2] / 2) * 0.8 * p.side + p.lane : p.side * ((ROAD_WIDTH[e.rank] ?? 6) / 2 + SIDEWALK / 2 + p.lane * 0.6);
    const ox = x - dz * off, oz = z + dx * off;
    if (p.dodged > 0) {
      p.x = ox + p.dodgeX * p.dodged;
      p.z = oz + p.dodgeZ * p.dodged;
    } else {
      p.x = ox;
      p.z = oz;
    }
    p.y = y + (e.rank === 2 ? 0 : 0.14);
    if (p.state !== 'down') p.yaw = Math.atan2(dx, dz);
  }
}
