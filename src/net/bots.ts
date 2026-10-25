import { EventRunner } from '../game/events/runner.ts';
import type { GameEvent } from '../game/events/types.ts';
import { RaceLine } from '../game/rivals.ts';
import { type Edge, pointAt, type RoadGraph } from '../world/roadGraph.ts';
import { gridSlot } from './grid.ts';
import type { LobbyCore } from './lobbyCore.ts';
import { PoseFlag, POSE_LEN, PROTOCOL, type RaceInfo, type ServerMsg } from './protocol.ts';

// Test players for the local server (net.local, net.bots): they connect like a real player, cruise the road
// network in free roam, join every race, line up on the grid and drive the race line with their own event
// runner, so places, finishes and results go through the same server code as with real friends.

export interface BotDeps {
  graph: RoadGraph;
  events(): GameEvent[];
  /** Where the bots start cruising (around the player). */
  near(): { x: number; z: number };
}

const NAMES = ['Anna', 'Jonas', 'Lea', 'Felix', 'Mia', 'Lukas', 'Emma'];
const COLORS = ['#1f6feb', '#f2c037', '#2ea043', '#8957e5', '#f0883e', '#e8e8e8', '#da3633'];
const CARS = ['hothatch', 'gt', 'muscle', 'rally', 'sportscar', 'hyper', 'coupe'];
/** Body origin above the road surface (m): road lift plus ride height at the game's vehicle scale. */
const ABOVE_ROAD = 0.4;

/** Index of the line point at a distance along it (points lie `spacing` apart). */
function indexAt(L: RaceLine, d: number) {
  const n = L.count;
  const i = Math.round(d / L.spacing);
  return L.loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
}

export class Bot {
  readonly id: number;
  readonly name: string;
  private core: LobbyCore;
  private d: BotDeps;
  private x = 0; private y = 0; private z = 0; private heading = 0; private pitch = 0;
  private speed = 0;
  private edge?: Edge;
  private along = 0;
  private dir = 1;
  /** Race: the line, distance along it, start time and the bot's own runner. */
  private line?: RaceLine;
  private raced = 0;
  private side = 0;
  private startAt = 0;
  private runner?: EventRunner;
  private event?: GameEvent;
  private joinAt = 0;
  private finished = false;
  private skill: number;
  private race: RaceInfo | null = null;
  private steer = 0;

  constructor(core: LobbyCore, d: BotDeps, i: number) {
    this.core = core;
    this.d = d;
    this.name = `Bot ${NAMES[i % NAMES.length]}`;
    this.skill = 0.82 + ((i * 37) % 11) / 60;
    const peer = core.add(`bot-${i}`, this.name, (m) => this.receive(m));
    if (!peer) throw new Error('Server voll');
    this.id = peer.info.id;
    core.message(this.id, { t: 'hello', v: PROTOCOL, car: CARS[i % CARS.length], color: COLORS[i % COLORS.length] });
    this.placeNear(d.near(), i);
  }

  /** Onto a street near a point, a little apart from the other bots. */
  private placeNear(p: { x: number; z: number }, i: number) {
    const a = i * 2.4;
    const s = this.d.graph.snap(p.x + Math.cos(a) * (40 + i * 15), p.z + Math.sin(a) * (40 + i * 15), 300, (e) => e.rank >= 2 && !e.noCars)
      ?? this.d.graph.snap(p.x, p.z, 2000);
    if (!s) return;
    this.edge = s.edge;
    this.along = s.along;
    this.dir = s.edge.oneway || i % 2 ? 1 : -1;
    this.speed = 8;
  }

  private receive(m: ServerMsg) {
    if (m.t !== 'race' && m.t !== 'welcome') return;
    const prev = this.race;
    this.race = m.race;
    const r = m.race;
    if (!r) { this.endRace(); return; }
    if (r.phase === 'gather' && !r.entrants.includes(this.id) && prev?.phase !== 'gather') this.joinAt = this.core.now() + 800 + Math.random() * 2500;
    if (r.phase === 'countdown' && r.entrants.includes(this.id) && !this.runner) this.startRace(r);
  }

  private startRace(r: RaceInfo) {
    const e = this.d.events().find((x) => x.id === r.event);
    if (!e?.path) { this.core.message(this.id, { t: 'quit' }); return; }
    const slot = gridSlot(e, r.entrants.indexOf(this.id));
    this.event = e;
    this.line = new RaceLine(e.path, !!e.laps);
    this.raced = -6 - 8 * Math.floor(r.entrants.indexOf(this.id) / 2);
    this.side = slot.side;
    this.startAt = r.startAt ?? this.core.now();
    this.speed = 0;
    this.finished = false;
    this.x = slot.x; this.z = slot.z; this.heading = slot.heading;
    const runner = (this.runner = new EventRunner());
    runner.startRace(e, Math.max(0.1, (this.startAt - this.core.now()) / 1000));
    runner.onFinish = (res) => {
      this.finished = true;
      this.core.message(this.id, { t: 'finish', time: res.value });
    };
    runner.onFail = () => this.core.message(this.id, { t: 'quit' });
  }

  private endRace() {
    if (!this.line) return;
    // Back to cruising from where the race left the bot.
    const s = this.d.graph.snap(this.x, this.z, 60, (e) => !e.noCars);
    if (s) { this.edge = s.edge; this.along = s.along; this.dir = s.edge.oneway ? 1 : Math.sign(s.dx * Math.sin(this.heading) - s.dz * Math.cos(this.heading)) || 1; }
    this.line = undefined;
    this.runner = undefined;
    this.event = undefined;
  }

  step(dt: number) {
    if (this.joinAt && this.core.now() >= this.joinAt) {
      this.joinAt = 0;
      if (this.race?.phase === 'gather') this.core.message(this.id, { t: 'join' });
    }
    if (this.line) this.drive(dt);
    else this.cruise(dt);
    this.send();
  }

  /** Free roam: along the streets at a pace that fits the road, a random turn at each junction. */
  private cruise(dt: number) {
    const g = this.d.graph;
    let e = this.edge;
    if (!e) return;
    const target = e.rank >= 5 ? 26 : e.rank >= 3 ? 16 : 11;
    this.speed += Math.max(-6 * dt, Math.min(3 * dt, target - this.speed));
    this.along += this.dir * this.speed * dt;
    for (let guard = 0; guard < 4 && (this.along < 0 || this.along > e.length); guard++) {
      const cur: Edge = e;
      const node: number = this.along < 0 ? cur.a : cur.b;
      const over = this.along < 0 ? -this.along : this.along - cur.length;
      const options = g.adj[node].filter(([id]) => id !== cur.id && !g.edges[id].noCars && (!g.edges[id].oneway || g.edges[id].a === node));
      const pick = options.length ? options[Math.floor(Math.random() * options.length)] : g.adj[node].find(([id]) => id === cur.id);
      if (!pick) return;
      e = this.edge = g.edges[pick[0]];
      this.dir = e.a === node ? 1 : -1;
      this.along = this.dir > 0 ? over : e.length - over;
    }
    const [x, y, z] = pointAt(e.p, e.cum, this.along);
    const [ax, ay, az] = pointAt(e.p, e.cum, this.along + this.dir * 3);
    const dx = ax - x, dz = az - z, l = Math.hypot(dx, dz) || 1;
    // Keep right: the lane centre right of the direction of travel.
    const off = e.oneway ? 0 : Math.max(1.4, e.rightLane * 0.65);
    const nh = Math.atan2(dx / l, -dz / l);
    this.steer = Math.max(-0.5, Math.min(0.5, Math.atan2(Math.sin(nh - this.heading), Math.cos(nh - this.heading)) * 4));
    this.heading = nh;
    this.pitch = Math.atan2(ay - y, l);
    this.x = x - (dz / l) * off;
    this.z = z + (dx / l) * off;
    this.y = y + ABOVE_ROAD;
  }

  /** Race: waits on the grid for the start signal, then drives the race line at the speed each bend allows. */
  private drive(dt: number) {
    const L = this.line!, r = this.runner!;
    const go = this.core.now() >= this.startAt;
    if (go && !this.finished) {
      // Speed for the tightest bend in the next 60 m, as far as braking allows.
      let target = 62 * this.skill;
      for (let k = 0; k < 60; k += 6) {
        const v = Math.sqrt(10 * this.skill * L.radius[indexAt(L, this.raced + k)]);
        target = Math.min(target, Math.sqrt(v * v + 2 * 9 * k));
      }
      this.speed += Math.max(-11 * dt, Math.min(6.5 * this.skill * dt, target - this.speed));
    } else if (this.finished) this.speed = Math.max(0, this.speed - 6 * dt);
    if (go) this.raced += this.speed * dt;
    // Behind the start (the grid): straight back from the line's first point.
    const p = this.raced >= 0 ? L.pose(this.raced) : (() => { const b = L.pose(0); return { ...b, x: b.x + b.dx * this.raced, z: b.z + b.dz * this.raced }; })();
    const fade = Math.max(0, 1 - Math.max(0, this.raced) / 120);
    const off = this.side * fade;
    const prevH = this.heading;
    this.x = p.x - p.dz * off;
    this.z = p.z + p.dx * off;
    this.heading = p.heading;
    this.steer = Math.max(-0.5, Math.min(0.5, Math.atan2(Math.sin(this.heading - prevH), Math.cos(this.heading - prevH)) / Math.max(dt, 1e-3) * 0.25));
    const s = this.d.graph.snap(this.x, this.z, 30);
    const ny = (s?.y ?? this.y - ABOVE_ROAD) + ABOVE_ROAD;
    this.pitch = this.speed > 1 ? Math.atan2(ny - this.y, this.speed * dt) * 0.5 : 0;
    this.y = ny;
    r.update(dt, { x: this.x, z: this.z, speed: this.speed });
  }

  private pose = new Array<number>(POSE_LEN).fill(0);

  private send() {
    const p = this.pose;
    // Body yaw π − heading about y (as CarPhysics.reset), then the pitch about x (nose up = −x).
    const yaw = (Math.PI - this.heading) / 2, pit = -this.pitch / 2;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit);
    p[0] = this.x; p[1] = this.y; p[2] = this.z;
    p[3] = cy * sp; p[4] = sy * cp; p[5] = -sy * sp; p[6] = cy * cp;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    p[7] = fx * this.speed; p[8] = 0; p[9] = fz * this.speed;
    p[10] = this.steer;
    p[11] = this.line ? PoseFlag.race : 0;
    const r = this.runner, e = this.event;
    if (r && e) {
      const g = e.gates[r.next];
      p[12] = r.state === 'done' ? 1e6 : (r.lap - 1) * e.gates.length + r.next;
      p[13] = g ? Math.hypot(g.x - this.x, g.z - this.z) : 0;
    } else p[12] = p[13] = 0;
    this.core.message(this.id, { t: 's', p: p.map((v, i) => (i < 3 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000)) });
  }

  leave() {
    this.core.remove(this.id);
  }
}
