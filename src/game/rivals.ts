import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { DriveInput } from '../input/input.ts';
import { CarPhysics, maxSteerAngle } from '../vehicle/carPhysics.ts';
import { CAR } from '../vehicle/tuning.ts';
import type { CarView } from '../vehicle/carView.ts';

// Rival drivers for races (V3): cars with the same physics as the player and an autopilot that follows an
// ideal line (apexes cut within the carriageway) and plans its speed from the bends ahead. Each rival has a
// character (aggression, focus, reaction at the start), overtakes on a free side or follows when there is no
// room, makes the odd mistake in a bend and is held near the player by a mild rubber band. Rivals far from
// the player (where the tiles may not be loaded) run on rails along the line and drop back into the physics
// when they come near again.

type R = typeof RAPIER_NS;

export type RivalLevel = 'leicht' | 'mittel' | 'schwer';

export const RIVAL_LEVELS: Record<RivalLevel, { lat: number; cruise: number; brake: number; torque: number }> = {
  leicht: { lat: 7.5, cruise: 38, brake: 7, torque: 0.85 },
  mittel: { lat: 9.5, cruise: 52, brake: 9, torque: 1 },
  schwer: { lat: 11.5, cruise: 70, brake: 11, torque: 1.1 },
};

/**
 * Autopilot gains: pure-pursuit arc and direct heading feedback, look-ahead (s of speed), and the brake that
 * starts b0 m/s over the goal and is full b1 m/s over it.
 */
export const STEER_GAIN = { arc: 1.3, heading: 0.6, look: 0.28, b0: 0.5, b1: 2.5 };


/** Chance of a mistake per bend by level, before the driver's focus and ai.mistakes. */
const MISTAKE_CHANCE: Record<RivalLevel, number> = { leicht: 0.22, mittel: 0.1, schwer: 0.04 };

/** Radius (m) of a line through three points; large on straights. */
function radius3(ax: number, az: number, bx: number, bz: number, cx: number, cz: number) {
  const a1 = Math.atan2(bx - ax, bz - az);
  const a2 = Math.atan2(cx - bx, cz - bz);
  const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
  const len = Math.hypot(bx - ax, bz - az) + Math.hypot(cx - bx, cz - bz);
  return len > 0.5 ? len / 2 / Math.max(turn, 1e-3) : 1e4;
}

/** A race line: points every few metres with the distance along it and the speed each bend allows. */
export class RaceLine {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly cum: Float32Array;
  readonly length: number;
  /** Turn radius the drivers plan with (m): of the centre line, or of the ideal line after racing(). */
  readonly radius: Float32Array;
  /** Unit normal to the right of the direction of travel at each point. */
  readonly nx: Float32Array;
  readonly nz: Float32Array;
  /** Ideal line: offset from the centre line (m, + = right); zero until racing() is called. */
  readonly side: Float32Array;
  /** How far from the centre line a car may go (m) on either side; unlimited until racing() is called. */
  readonly room: Float32Array;
  readonly loop: boolean;
  readonly spacing: number;

  constructor(path: number[], loop = false, spacing = 4) {
    const xs: number[] = [], zs: number[] = [];
    for (let i = 0; i + 1 < path.length; i += 2) {
      const x = path[i], z = path[i + 1];
      if (xs.length) {
        const px = xs[xs.length - 1], pz = zs[zs.length - 1];
        const d = Math.hypot(x - px, z - pz);
        if (d < 0.5) continue;
        for (let k = 1; k < d / spacing; k++) { xs.push(px + ((x - px) * k * spacing) / d); zs.push(pz + ((z - pz) * k * spacing) / d); }
      }
      xs.push(x); zs.push(z);
    }
    this.x = Float32Array.from(xs);
    this.z = Float32Array.from(zs);
    const n = xs.length;
    this.cum = new Float32Array(n);
    for (let i = 1; i < n; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    this.length = this.cum[n - 1] ?? 0;
    this.loop = loop;
    this.spacing = spacing;
    this.nx = new Float32Array(n);
    this.nz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.at(i - 1), c = this.at(i + 1);
      const dx = c[0] - a[0], dz = c[1] - a[1], l = Math.hypot(dx, dz) || 1;
      this.nx[i] = -dz / l;
      this.nz[i] = dx / l;
    }
    this.side = new Float32Array(n);
    this.room = new Float32Array(n).fill(1e3);
    this.radius = new Float32Array(n);
    this.measure();
  }

  get count() { return this.x.length; }

  private wrap(i: number) {
    const n = this.x.length;
    return this.loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
  }

  /** Point i (wrapping on loops, clamped otherwise). */
  at(i: number): [number, number] {
    const j = this.wrap(i);
    return [this.x[j], this.z[j]];
  }

  /** Point i moved sideways by lat metres (+ = right). */
  offsetAt(i: number, lat: number): [number, number] {
    const j = this.wrap(i);
    return [this.x[j] + this.nx[j] * lat, this.z[j] + this.nz[j] * lat];
  }

  /** Distance of (x, z) along the line past point i (m, negative before it). */
  along(x: number, z: number, i: number) {
    const j = this.wrap(i);
    return (x - this.x[j]) * this.nz[j] - (z - this.z[j]) * this.nx[j];
  }

  /** Signed distance of (x, z) from the centre line at point i (+ = right). */
  lateral(x: number, z: number, i: number) {
    const j = this.wrap(i);
    return (x - this.x[j]) * this.nx[j] + (z - this.z[j]) * this.nz[j];
  }

  /** Radius at each point along the planning line (centre plus side), from the points 8 m either side. */
  private measure() {
    const k = Math.max(1, Math.round(8 / this.spacing));
    for (let i = 0; i < this.x.length; i++) {
      const a = this.offsetAt(i - k, this.side[this.wrap(i - k)]), b = this.offsetAt(i, this.side[i]), c = this.offsetAt(i + k, this.side[this.wrap(i + k)]);
      this.radius[i] = radius3(a[0], a[1], b[0], b[1], c[0], c[1]);
    }
  }

  /**
   * Builds the ideal line: the smoothest line between the road edges (wide entry, apex, wide exit), which
   * raises the bend radius. widthAt gives the carriageway width at a point (undefined:
   * unknown, a narrow corridor is used); apex 0..1 is the share of the free width the line may use.
   */
  racing(widthAt?: (x: number, z: number) => number | undefined, apex = 1, carHalf = 1) {
    const n = this.x.length;
    if (n < 5) return this;
    const free = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = widthAt?.(this.x[i], this.z[i]);
      free[i] = Math.max(0, Math.min(4.5, w === undefined ? 1.2 : w / 2 - carHalf - 0.4));
    }
    // The narrowest point nearby counts (junctions, the crossing street's width must not widen the corridor).
    for (let i = 0; i < n; i++) {
      let m = free[i];
      for (let k = -3; k <= 3; k++) if (this.loop || (i + k >= 0 && i + k < n)) m = Math.min(m, free[this.wrap(i + k)]);
      this.room[i] = m;
    }
    const lim = Float32Array.from(this.room, (r) => r * Math.max(0, Math.min(1, apex)));
    const s = this.side;
    s.fill(0);
    // K1999 (Coulom): each point moves sideways until its curvature is the mean of its neighbours', which gives
    // the minimum-curvature line (wide entry, apex, wide exit) clamped to the road. Coarse to fine: every k-th
    // point first, the points between filled in linearly, then the next finer step.
    const X = this.x, Z = this.z, NX = this.nx, NZ = this.nz;
    const curv = (ia: number, ib: number, ic: number) => {
      const ax = X[ia] + NX[ia] * s[ia], az = Z[ia] + NZ[ia] * s[ia];
      const bx = X[ib] + NX[ib] * s[ib], bz = Z[ib] + NZ[ib] * s[ib];
      const cx = X[ic] + NX[ic] * s[ic], cz = Z[ic] + NZ[ic] * s[ic];
      const ux = bx - ax, uz = bz - az, vx = cx - bx, vz = cz - bz;
      const den = Math.sqrt((ux * ux + uz * uz) * (vx * vx + vz * vz) * ((cx - ax) ** 2 + (cz - az) ** 2));
      return den > 1e-6 ? (2 * (ux * vz - uz * vx)) / den : 0;
    };
    for (const [k, iters] of [[16, 150], [8, 120], [4, 100], [2, 80], [1, 40]]) {
      const nodes: number[] = [];
      for (let i = 0; i < n; i += k) nodes.push(i);
      if (!this.loop && nodes[nodes.length - 1] !== n - 1) nodes.push(n - 1);
      const m = nodes.length;
      if (m < 5) continue;
      const node = (j: number) => nodes[this.loop ? ((j % m) + m) % m : Math.max(0, Math.min(m - 1, j))];
      const from = this.loop ? 0 : 1, to = this.loop ? m : m - 1;
      for (let it = 0; it < iters; it++) {
        for (let j = from; j < to; j++) {
          const i = node(j);
          const target = (curv(node(j - 2), node(j - 1), i) + curv(i, node(j + 1), node(j + 2))) / 2;
          const s0 = s[i], c0 = curv(node(j - 1), i, node(j + 1));
          s[i] = s0 + 0.05;
          const dc = (curv(node(j - 1), i, node(j + 1)) - c0) / 0.05;
          s[i] = s0;
          if (Math.abs(dc) < 1e-7) continue;
          s[i] = Math.max(-lim[i], Math.min(lim[i], s0 + (target - c0) / dc));
        }
      }
      // Fill in between the nodes.
      for (let j = 0; j < (this.loop ? m : m - 1); j++) {
        const a = nodes[j], b = j + 1 < m ? nodes[j + 1] : nodes[0] + n;
        for (let i = a + 1; i < b; i++) {
          const t = (i - a) / (b - a), w = this.wrap(i);
          s[w] = Math.max(-lim[w], Math.min(lim[w], s[a] + (s[this.wrap(b)] - s[a]) * t));
        }
      }
    }
    // Ease onto the centre line at the ends of a sprint (the start grid and the finish gate).
    if (!this.loop) for (let i = 0; i < Math.min(8, n); i++) { const f = i / 8; s[i] *= f; s[n - 1 - i] *= f; }
    this.measure();
    return this;
  }

  /** Nearest point to (x, z), searching from hint a little back and ahead (or everywhere without a hint). */
  nearest(x: number, z: number, hint = -1, back = 3, ahead = 12) {
    const n = this.x.length;
    let best = Math.max(0, hint), bd = Infinity;
    const from = hint < 0 ? 0 : hint - back, to = hint < 0 ? n : hint + ahead;
    for (let i = from; i < to; i++) {
      const j = this.loop ? ((i % n) + n) % n : i;
      if (j < 0 || j >= n) continue;
      const d = (this.x[j] - x) ** 2 + (this.z[j] - z) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    return { index: best, dist: Math.sqrt(bd) };
  }

  /** Position and direction at a distance along the line (on the ideal line with ideal = true). */
  pose(d: number, ideal = false) {
    const L = this.length;
    if (this.loop && L > 0) d = ((d % L) + L) % L;
    d = Math.max(0, Math.min(L, d));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= d) lo = m; else hi = m; }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (d - this.cum[lo]) / seg;
    const [ax, az] = ideal ? this.offsetAt(lo, this.side[lo]) : [this.x[lo], this.z[lo]];
    const [bx, bz] = ideal ? this.offsetAt(hi, this.side[hi]) : [this.x[hi], this.z[hi]];
    const dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    return { x: ax + dx * t, z: az + dz * t, dx: dx / l, dz: dz / l, heading: Math.atan2(dx / l, -dz / l) };
  }
}

/** Distance raced along a line (laps included), from positions; robust to the loop closing at the start. */
export class LineTracker {
  index = 0;
  raced: number;
  private line: RaceLine;

  constructor(line: RaceLine, start = 0) {
    this.line = line;
    this.raced = start;
    // Behind the start of a loop the car stands at the end of the line.
    if (start) { const p = line.pose(start); this.index = line.nearest(p.x, p.z).index; }
  }

  update(x: number, z: number) {
    const L = this.line;
    const i = L.nearest(x, z, this.index, 4, 16).index;
    let d = L.cum[i] - L.cum[this.index];
    if (L.loop) { if (d < -L.length / 2) d += L.length; else if (d > L.length / 2) d -= L.length; }
    this.raced += d;
    this.index = i;
  }

  /** After a jump (reset, teleport): find the line point anywhere, keep the laps. */
  relocate(x: number, z: number) {
    const L = this.line;
    const i = L.nearest(x, z).index;
    let d = L.cum[i] - L.cum[this.index];
    if (L.loop) { if (d < -L.length / 2) d += L.length; else if (d > L.length / 2) d -= L.length; }
    this.raced += d;
    this.index = i;
  }

  /** Sets the raced distance directly (on rails). */
  set(d: number) {
    const L = this.line;
    const p = L.pose(d);
    this.index = L.nearest(p.x, p.z, this.index, 4, Math.max(16, Math.ceil((d - this.raced) / L.spacing) + 8)).index;
    this.raced = d;
  }

  get lap() { return Math.max(1, Math.floor(this.raced / Math.max(1, this.line.length)) + 1); }
}

export interface DriverState {
  x: number;
  z: number;
  heading: number;
  /** m/s along the car. */
  speed: number;
}

/**
 * The autopilot: pure pursuit on the ideal line (or a lateral goal while overtaking), speed from the bends
 * ahead (v = √(lat·R)) braked down to in time. Also used by the police and the event route test (G3).
 */
export class RivalDriver {
  index = -1;
  /** Lateral offset from the ideal line (m, + = right), so rivals do not drive in one file. */
  offset = 0;
  level = RIVAL_LEVELS.mittel;
  /** Extra speed factor from the rubber band and the driver's skill. */
  pace = 1;
  /** Brakes later by this factor (aggressive drivers). */
  brakeMul = 1;
  /** Lateral goal from the centre line while overtaking (m), or undefined for the ideal line. */
  override?: number;
  /** Lateral goal limits from the centre line (m) that keep off cars alongside. */
  lo = -Infinity;
  hi = Infinity;
  /** Speed limit from the car ahead (m/s). */
  cap = Infinity;
  /** A mistake: plans bends this much faster (> 1 overcooks, < 1 brakes too early) while err.t runs. */
  err = { lat: 1, t: 0 };
  /** Uses nitro on straights. */
  nitro = true;
  /** Speed goal of the last step (m/s). */
  goal = 0;
  /** Lateral goal of the last step, from the centre line (m). */
  aim = 0;
  private shift = 0;
  private line: RaceLine;
  private input: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };

  constructor(line: RaceLine) {
    this.line = line;
  }

  /** Speed goal at point index for a car at speed v: the slowest bend ahead, braked down to in time. */
  plan(index: number, v: number) {
    const L = this.line;
    const lv = this.level;
    const lat = lv.lat * this.pace * (this.err.t > 0 ? this.err.lat : 1);
    const brake = lv.brake * this.brakeMul;
    let goal = lv.cruise * this.pace;
    const ahead = Math.min(L.count, 150, Math.ceil((v * v / (2 * brake) + 40) / L.spacing));
    for (let k = 0; k < ahead; k++) {
      const i = index + k;
      if (!L.loop && i >= L.count) break;
      const r = L.radius[((i % L.count) + L.count) % L.count];
      const vc = Math.sqrt(lat * r);
      const dist = Math.max(0, k * L.spacing - 3);
      goal = Math.min(goal, Math.sqrt(vc * vc + 2 * brake * dist));
    }
    return goal;
  }

  drive(s: DriverState, dt = 1 / 60): DriveInput {
    const L = this.line;
    const near = L.nearest(s.x, s.z, this.index);
    this.index = near.index;
    const v = Math.abs(s.speed);
    const look = Math.max(1, Math.round((3 + v * STEER_GAIN.look) / L.spacing));
    const j = (((this.index + look) % L.count) + L.count) % L.count;
    const jj = L.loop ? j : Math.min(L.count - 1, this.index + look);
    // Lateral goal: the ideal line plus the own offset, or the overtaking side; moved over smoothly.
    const want = this.override !== undefined ? this.override - L.side[jj] : this.offset;
    this.shift += Math.max(-4.5 * dt, Math.min(4.5 * dt, want - this.shift));
    const room = L.room[jj];
    const lat = Math.max(-room, Math.min(room, Math.max(this.lo, Math.min(this.hi, L.side[jj] + this.shift))));
    this.aim = lat;
    const [tx, tz] = L.offsetAt(jj, lat);
    const wantH = Math.atan2(tx - s.x, -(tz - s.z));
    let d = wantH - s.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (this.err.t > 0) this.err.t -= dt;
    const goal = Math.min(this.plan(this.index, v), this.cap);
    this.goal = goal;
    const inp = this.input;
    inp.throttle = s.speed < goal ? Math.min(1, (goal - s.speed) / 3 + 0.4) : 0;
    inp.brake = s.speed > goal + STEER_GAIN.b0 ? Math.min(1, (s.speed - goal) / STEER_GAIN.b1) : 0;
    // Pure pursuit: the wheel angle that puts the car on an arc through the target point, as a share of the
    // speed-dependent lock (tyres slip a little, hence the extra gain), plus a little straight heading feedback.
    const wb = CAR.wheel.front - CAR.wheel.rear;
    const ld = Math.max(4, Math.hypot(tx - s.x, tz - s.z));
    const delta = Math.atan2(2 * wb * Math.sin(d), ld) * STEER_GAIN.arc;
    inp.steer = Math.max(-1, Math.min(1, delta / maxSteerAngle(v) + d * STEER_GAIN.heading));
    inp.nitro = this.nitro && goal - s.speed > 12 && Math.abs(d) < 0.08 && v > 15 && this.cap === Infinity;
    inp.handbrake = false;
    return inp;
  }

  /** Distance along the line at the current point. */
  get distance() {
    return this.index < 0 ? 0 : this.line.cum[this.index];
  }
}

export interface RivalOptions {
  R: R;
  world: RAPIER_NS.World;
  scene: THREE.Scene;
  /** A new car model for a rival (colour). */
  makeView(color: string): Promise<CarView | undefined>;
  /** Ground height for spawning, or undefined. */
  groundAt(x: number, z: number): number | undefined;
  /** True where colliders exist (rivals there drive with physics). */
  loaded(x: number, z: number): boolean;
  /** The player's car feel, copied onto the rivals. */
  feel(): CarPhysics['feel'];
  /** Carriageway width at a point (m), for the ideal line; undefined where unknown. */
  roadWidth?(x: number, z: number): number | undefined;
}

/** A rival's character: speed factor, aggression (later braking, closer following, keener to pass), focus. */
export interface Persona {
  name: string;
  color: string;
  trait: string;
  skill: number;
  aggr: number;
  focus: number;
  /** Reaction at the start (s). */
  react: number;
}

export const PERSONAS: Persona[] = [
  { name: 'Kai', color: '#1f5bd6', trait: 'aggressiv', skill: 1.02, aggr: 0.85, focus: 0.55, react: 0.22 },
  { name: 'Mara', color: '#f2f2f2', trait: 'sauber', skill: 1, aggr: 0.4, focus: 0.95, react: 0.3 },
  { name: 'Jonas', color: '#f4b400', trait: 'vorsichtig', skill: 0.97, aggr: 0.15, focus: 0.8, react: 0.45 },
  { name: 'Lea', color: '#2f9e44', trait: 'kurvenstark', skill: 1.015, aggr: 0.5, focus: 0.7, react: 0.3 },
  { name: 'Emre', color: '#7a2fd0', trait: 'Draufgänger', skill: 1.03, aggr: 1, focus: 0.3, react: 0.18 },
  { name: 'Nina', color: '#111418', trait: 'konstant', skill: 0.99, aggr: 0.35, focus: 0.9, react: 0.35 },
];

interface Rival {
  name: string;
  persona: Persona;
  car: CarPhysics;
  view?: CarView;
  driver: RivalDriver;
  track: LineTracker;
  finished?: number;
  /** Running on rails (far from the player). */
  rail: boolean;
  /** Seconds stuck (crawling while the race runs); a rival stuck too long backs out, then is put back on the line. */
  stuck: number;
  /** Seconds left reversing out of a jam. */
  backing: number;
  railSpeed: number;
  /** What the driver does now (ai.info): Linie, überholt, folgt, Fehler. */
  mode: string;
  /** Lateral goal from the centre line while overtaking, the side (-1 left, 1 right) and the car passed. */
  pass?: number;
  passSide?: number;
  passWho?: unknown;
  /** Seconds the passing side is still held after the other car is behind. */
  passHold: number;
  /** Seconds before a new attempt after giving one up. */
  passCool: number;
  /** In a bend at the last step (a mistake is rolled once per bend). */
  inBend: boolean;
  mistakes: number;
  passes: number;
  prev: { p: THREE.Vector3; q: THREE.Quaternion };
  curr: { p: THREE.Vector3; q: THREE.Quaternion };
}

/** A car in the race as the drivers see it. */
interface Seen { raced: number; lat: number; v: number; x: number; z: number; rival?: Rival; who: unknown }

export class Rivals {
  level: RivalLevel = 'mittel';
  /** Rubber band strength 0..1: rivals behind the player speed up, those ahead ease off a little. */
  rubber = 0.5;
  enabled = true;
  /** Rivals drive on rails beyond this distance from the player (m). */
  railRange = 220;
  /** Share of the free road width the ideal line uses (ai.apex; 0 = centre line). */
  apex = 1;
  /** Rivals overtake on a free side (otherwise they only follow). */
  overtake = true;
  /** Mistake frequency factor (ai.mistakes; 0 = none). */
  mistakes = 1;
  /** Speed factor on all rivals (ai.skill). */
  skill = 1;
  /** Added to every rival's aggression (ai.aggr). */
  aggr = 0;
  line?: RaceLine;
  laps = 1;
  readonly list: Rival[] = [];
  private o: RivalOptions;
  private time = 0;
  private playerRaced = 0;
  private player = { x: 0, z: 0, v: 0, index: 0, known: false };
  private lineView?: THREE.Line;
  private showLine = false;

  constructor(o: RivalOptions) {
    this.o = o;
  }

  get active() { return this.list.length > 0; }
  get total() { return (this.line?.length ?? 0) * this.laps; }

  /** Puts n rivals on the grid behind the start, the player in the second row. */
  async start(path: number[], laps: number | undefined, n: number) {
    this.clear();
    if (!this.enabled || n <= 0 || path.length < 4) return;
    const loop = !!laps;
    this.line = new RaceLine(path, loop).racing(this.o.roadWidth, this.apex);
    this.laps = laps ?? 1;
    this.time = 0;
    this.playerRaced = 0;
    this.player.known = false;
    this.rescues = 0;
    const lv = RIVAL_LEVELS[this.level];
    const slots = [[-6, -1.6], [-6, 1.6], [-22, -1.6], [-22, 1.6], [-30, 0], [-38, 0]];
    for (let i = 0; i < Math.min(n, slots.length); i++) {
      const [back, side] = slots[i];
      const persona = PERSONAS[i];
      const p = this.line.pose(0);
      const x = p.x + p.dx * back - p.dz * side, z = p.z + p.dz * back + p.dx * side;
      const y = (this.o.groundAt(x, z) ?? 0) + 0.9;
      const car = new CarPhysics(this.o.R, this.o.world, { x, y, z }, p.heading);
      Object.assign(car.feel, this.o.feel());
      car.feel.torque *= lv.torque;
      car.burst.enabled = false;
      const driver = new RivalDriver(this.line);
      driver.level = lv;
      driver.index = 0;
      const track = new LineTracker(this.line, back);
      const t = car.body.translation(), r = car.body.rotation();
      const pose = () => ({ p: new THREE.Vector3(t.x, t.y, t.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) });
      const rival: Rival = {
        name: persona.name, persona, car, driver, track, rail: false, stuck: 0, backing: 0, railSpeed: 0, mode: 'Start',
        passHold: 0, passCool: 0, inBend: false, mistakes: 0, passes: 0, prev: pose(), curr: pose(),
      };
      this.list.push(rival);
      void this.o.makeView(persona.color).then((v) => {
        if (!v || !this.list.includes(rival)) return;
        rival.view = v;
        this.o.scene.add(v.root);
      });
    }
    this.drawLine();
  }

  clear() {
    for (const r of this.list) {
      r.car.dispose();
      if (r.view) this.o.scene.remove(r.view.root);
    }
    this.list.length = 0;
    this.line = undefined;
    this.drawLine();
  }

  /** The player's distance raced, for the rubber band and the places. */
  setPlayer(raced: number) {
    this.playerRaced = raced;
  }

  /** Aggression of a rival with the global offset, 0..1. */
  private aggrOf(r: Rival) {
    return Math.max(0, Math.min(1, r.persona.aggr + this.aggr));
  }

  /** Rubber band: pace factor from the gap to the player (m, + = rival ahead). */
  band(gap: number) {
    // Close ahead of the player the rival races for real; further ahead it eases off, behind it pushes.
    let b = Math.max(-0.1, Math.min(0.22, -gap / 350));
    if (gap > 0 && gap < 60) b = 0;
    // In the last fifth the field fights for the places: half the catch-up.
    if (b > 0 && this.total > 0 && this.playerRaced > this.total * 0.8) b *= 0.5;
    return 1 + b * this.rubber * 2;
  }

  /** One physics step (before world.step). go: the race is running (during the countdown they wait). */
  step(dt: number, go: boolean, player: { x: number; z: number }) {
    if (!this.line) return;
    this.time += go ? dt : 0;
    const L = this.line;
    // The player as the drivers see them: speed from the last positions, place on the line.
    const P = this.player;
    const jump = Math.hypot(player.x - P.x, player.z - P.z);
    P.v = P.known && jump < 5 ? P.v + (jump / dt - P.v) * Math.min(1, dt * 8) : 0;
    P.index = L.nearest(player.x, player.z, P.known && jump < 5 ? P.index : -1, 4, 16).index;
    P.x = player.x; P.z = player.z; P.known = true;
    const seen: Seen[] = [{ who: P, raced: this.playerRaced + L.along(player.x, player.z, P.index), lat: L.lateral(player.x, player.z, P.index), v: P.v, x: player.x, z: player.z }];
    for (const r of this.list) {
      const t = r.car.body.translation();
      seen.push({ who: r, raced: r.track.raced + (r.rail ? 0 : L.along(t.x, t.z, r.track.index)), lat: r.rail ? L.side[r.track.index] : L.lateral(t.x, t.z, r.track.index), v: r.rail ? r.railSpeed : Math.abs(r.car.speed), x: r.rail ? r.curr.p.x : t.x, z: r.rail ? r.curr.p.z : t.z, rival: r });
    }
    for (const r of this.list) {
      const c = r.car;
      r.prev.p.copy(r.curr.p);
      r.prev.q.copy(r.curr.q);
      if (r.finished !== undefined) {
        // Over the line: roll out.
        r.mode = 'im Ziel';
        c.update({ throttle: 0, brake: 0.3, steer: 0, nitro: false, handbrake: false, lookBack: false }, dt);
        continue;
      }
      // Rubber band and the driver's own skill on the target speed.
      const gap = r.track.raced - this.playerRaced;
      r.driver.pace = this.band(gap) * r.persona.skill * this.skill;
      r.driver.brakeMul = 1 + this.aggrOf(r) * 0.12;
      const t = c.body.translation();
      const far = Math.hypot(t.x - player.x, t.z - player.z) > this.railRange || !this.o.loaded(t.x, t.z);
      if (far && !r.rail) {
        r.rail = true;
        r.railSpeed = Math.max(10, Math.abs(c.speed));
        c.body.setEnabled(false);
      }
      if (r.rail) {
        // On rails: along the ideal line at the speed the driver would plan there.
        r.mode = 'auf Schiene';
        if (go) {
          const goal = r.driver.plan(r.track.index, r.railSpeed);
          const dv = goal - r.railSpeed;
          r.railSpeed += dv > 0 ? Math.min(dv, 5 * dt) : Math.max(dv, -r.driver.level.brake * dt);
        }
        r.track.set(r.track.raced + (go ? r.railSpeed * dt : 0));
        r.driver.index = r.track.index;
        const p = L.pose(r.track.raced, true);
        this.finish(r);
        const y = this.o.groundAt(p.x, p.z);
        const yaw = Math.PI - p.heading;
        if (y !== undefined) r.curr.p.set(p.x, y + 0.6, p.z);
        else r.curr.p.set(p.x, r.curr.p.y, p.z);
        r.curr.q.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        const near = Math.hypot(p.x - player.x, p.z - player.z) < this.railRange * 0.8 && this.o.loaded(p.x, p.z) && y !== undefined;
        if (near) {
          // Back into the physics, at speed.
          r.rail = false;
          c.body.setEnabled(true);
          c.reset({ x: p.x, y: y! + 0.9, z: p.z }, p.heading);
          c.body.setLinvel({ x: p.dx * r.railSpeed, y: 0, z: p.dz * r.railSpeed }, true);
        }
        continue;
      }
      let input: DriveInput;
      if (!go || this.time < r.persona.react) {
        input = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: true, lookBack: false };
      } else if (r.backing > 0) {
        // Backing out of a jam: reverse with the wheel turned away from the line.
        r.backing -= dt;
        r.mode = 'setzt zurück';
        const want = L.offsetAt(r.track.index + 3, L.side[r.track.index]);
        const side = Math.sign(Math.sin(Math.atan2(want[0] - t.x, -(want[1] - t.z)) - c.heading())) || 1;
        input = { throttle: 0, brake: 1, steer: -side, nitro: false, handbrake: false, lookBack: false };
      } else {
        this.think(r, seen, dt);
        input = r.driver.drive({ x: t.x, z: t.z, heading: c.heading(), speed: c.speed }, dt);
      }
      c.update(input, dt);
      r.track.update(t.x, t.z);
      this.finish(r);
      // Stuck on a sign, a wall or on its roof: first back out, then back onto the line a little further on.
      const r2 = c.body.rotation();
      const flipped = 1 - 2 * (r2.x * r2.x + r2.z * r2.z) < 0.4;
      const racing = go && this.time > r.persona.react + 0.5;
      r.stuck = racing && r.backing <= 0 && (Math.abs(c.speed) < 2 || flipped) ? r.stuck + dt : r.backing > 0 ? r.stuck : 0;
      if (r.stuck > 1.2 && r.stuck - dt <= 1.2 && !flipped) r.backing = 1.1;
      if (r.stuck > 3.5) {
        r.stuck = 0;
        r.backing = 0;
        this.rescues++;
        let d = r.track.raced + 25;
        // Not on top of another car.
        for (let k = 0; k < 6 && seen.some((o) => o.rival !== r && Math.abs(o.raced - d) < 7); k++) d += 8;
        const p = L.pose(d, true);
        const y = this.o.groundAt(p.x, p.z);
        if (y === undefined) continue;
        c.reset({ x: p.x, y: y + 0.9, z: p.z }, p.heading);
        c.body.setLinvel({ x: p.dx * 8, y: 0, z: p.dz * 8 }, true);
        r.track.set(d);
        r.driver.index = r.track.index;
      }
    }
  }

  /** Racecraft: overtake on a free side or follow the car ahead, keep off cars alongside, the odd mistake. */
  private think(r: Rival, seen: Seen[], dt: number) {
    const L = this.line!;
    const d = r.driver;
    const me = seen.find((s) => s.rival === r)!;
    const aggr = this.aggrOf(r);
    let ahead: Seen | undefined, aheadGap = Infinity, lo = -Infinity, hi = Infinity, yieldTo = Infinity, target: Seen | undefined;
    const range = 10 + me.v * 1.1;
    // Car size at the current vehicle scale.
    const len = CAR.halfExtents.z * 2, side = CAR.halfExtents.x * 2 + 1;
    for (const o of seen) {
      if (o === me || o.rival?.finished !== undefined) continue;
      const gap = o.raced - me.raced, dl = o.lat - me.lat;
      // Alongside: never steer towards the other car closer than a car's width between the doors.
      if (Math.abs(gap) < len + 1) {
        if (dl >= 0) hi = Math.min(hi, o.lat - side); else lo = Math.max(lo, o.lat + side);
        // Too close alongside with the other car's nose ahead: the one behind lifts and lets it go.
        if (gap > 0.5 && Math.abs(dl) < side - 0.3) yieldTo = Math.min(yieldTo, o.v - 2);
      }
      if (gap > 1 && gap < range && Math.abs(dl) < side - 0.6 && gap < aheadGap) { ahead = o; aheadGap = gap; }
      if (o.who === r.passWho && gap > -7 && gap < range) target = o;
    }
    let room = Infinity;
    for (let k = 0; k < 8; k++) room = Math.min(room, L.room[(((r.track.index + k) % L.count) + L.count) % L.count]);
    d.cap = Infinity;
    // Done passing (or the car is gone): back onto the ideal line after a moment.
    if (r.passSide !== undefined && !target) {
      r.passHold -= dt;
      if (r.passHold <= 0) { r.passSide = undefined; r.passWho = undefined; }
    }
    // A new car to pass: keen drivers go for it when only just as fast, careful ones need a clear advantage.
    const closing = ahead ? me.v - ahead.v : 0;
    r.passCool -= dt;
    if (ahead && r.passSide === undefined && r.passCool <= 0 && this.overtake && (closing > 1.5 - aggr * 2 || (aheadGap < 7 && closing > -1))) {
      const opts = [-1, 1].filter((sd) => Math.abs(ahead!.lat + sd * (side + 0.2)) <= room);
      if (opts.length) {
        r.passSide = opts.reduce((a, b) => (Math.abs(ahead!.lat + a * side - me.lat) <= Math.abs(ahead!.lat + b * side - me.lat) ? a : b));
        r.passWho = ahead.who;
        r.passes++;
        target = ahead;
      }
    }
    r.pass = undefined;
    if (r.passSide !== undefined && target) {
      const tg = target.raced - me.raced;
      // Overlapping: stay on the side we are on now (the other car may have moved across), never go through it.
      if (tg < 6) r.passSide = Math.sign(me.lat - target.lat) || r.passSide;
      const goal = Math.max(-room, Math.min(room, target.lat + r.passSide * (side + 0.2)));
      if (Math.abs(goal - target.lat) < side - 0.5 && tg > len * 0.5) {
        // The gap closed before we got past: give up and fall in behind.
        r.passSide = undefined;
        r.passWho = undefined;
        r.passCool = 1.5;
        if (tg < 6) d.cap = Math.max(0, target.v - 1.5);
      } else {
        // Alongside and squeezed: hold the lane rather than cut back across the other car.
        r.pass = tg > len * 0.5 ? goal : r.passSide > 0 ? Math.max(goal, Math.min(room, me.lat)) : Math.min(goal, Math.max(-room, me.lat));
        r.passHold = 0.8;
        r.mode = 'überholt';
        // Not yet beside it: do not run into its back while moving over.
        if (tg > 0 && Math.abs(target.lat - me.lat) < side - 0.6) d.cap = target.v + Math.sqrt(2 * 6 * Math.max(0, tg - len - 1));
      }
    } else if (r.passSide !== undefined) {
      r.pass = d.override;
    }
    // Anything else in the way: follow at a distance.
    if (ahead && (r.pass === undefined || ahead.who !== r.passWho)) {
      r.mode = 'folgt';
      // Close up to the following distance, never faster than it can still brake to the other car's speed.
      const follow = len + 2 + me.v * 0.3 * (1 - aggr * 0.5);
      d.cap = Math.min(d.cap, Math.max(0, ahead.v + Math.min((aheadGap - follow) * 0.6, Math.sqrt(2 * 6 * Math.max(0, aheadGap - len - 1)))));
    }
    if (!ahead && r.pass === undefined) r.mode = d.err.t > 0 ? 'Fehler' : 'Linie';
    d.override = r.pass;
    d.cap = Math.min(d.cap, Math.max(0, yieldTo));
    // Squeezed between two cars: the middle.
    if (lo > hi) lo = hi = (lo + hi) / 2;
    d.lo = lo;
    d.hi = hi;
    // A mistake once in a while on the way into a bend: too fast (runs wide) or braking too early.
    const lv = this.level;
    const bend = L.radius[(((r.track.index + 6) % L.count) + L.count) % L.count] < 70;
    if (bend && !r.inBend && d.err.t <= 0) {
      const chance = MISTAKE_CHANCE[lv] * (1.2 - r.persona.focus) * this.mistakes;
      if (Math.random() < chance) this.mistake(r);
    }
    r.inBend = bend;
  }

  /** Makes a rival misjudge the next bend (ai.mistake). */
  mistake(r: Rival, kind = Math.random() < 0.6 ? 'spät' : 'früh') {
    r.driver.err.lat = kind === 'spät' ? 1.22 : 0.75;
    r.driver.err.t = 2.5;
    r.mistakes++;
    r.mode = 'Fehler';
  }

  /** Rivals put back on the line since the start (rivals.info). */
  rescues = 0;

  private finish(r: Rival) {
    if (r.finished === undefined && r.track.raced >= this.total - 3) r.finished = this.time;
  }

  /** After world.step: read the poses back. */
  capture() {
    for (const r of this.list) {
      if (r.rail) continue;
      const t = r.car.body.translation(), q = r.car.body.rotation();
      r.curr.p.set(t.x, t.y, t.z);
      r.curr.q.set(q.x, q.y, q.z, q.w);
    }
  }

  private ip = new THREE.Vector3();
  private iq = new THREE.Quaternion();

  render(alpha: number, time: number, night: number) {
    for (const r of this.list) {
      if (!r.view) continue;
      this.ip.lerpVectors(r.prev.p, r.curr.p, alpha);
      this.iq.slerpQuaternions(r.prev.q, r.curr.q, alpha);
      r.view.setNight(night);
      r.view.sync(r.car, this.ip, this.iq, r.driver.goal < Math.abs(r.car.speed) - 1.5, time);
    }
  }

  /** The ideal line as a thin line over the road (ai.line). */
  private drawLine() {
    if (this.lineView) {
      this.o.scene.remove(this.lineView);
      this.lineView.geometry.dispose();
      (this.lineView.material as THREE.Material).dispose();
      this.lineView = undefined;
    }
    const L = this.line;
    if (!this.showLine || !L) return;
    const pts: number[] = [];
    let y = 0;
    for (let i = 0; i <= L.count; i++) {
      if (i === L.count && !L.loop) break;
      const [x, z] = L.offsetAt(i, L.side[i % L.count]);
      y = this.o.groundAt(x, z) ?? y;
      pts.push(x, y + 0.35, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.lineView = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x33ff88, depthTest: false, transparent: true }));
    this.lineView.renderOrder = 10;
    this.o.scene.add(this.lineView);
  }

  /** Place of the player (1 = leading) among the rivals still racing or finished. */
  place(playerRaced: number) {
    return 1 + this.list.filter((r) => r.finished !== undefined || r.track.raced > playerRaced).length;
  }

  /** Rivals that crossed the finish before the player. */
  finishedBefore() {
    return this.list.filter((r) => r.finished !== undefined).length;
  }

  /** Is this collider one of the rivals' cars? */
  isRival(body: RAPIER_NS.RigidBody | null) {
    return !!body && this.list.some((r) => r.car.body === body);
  }

  info() {
    if (!this.line) return 'keine Rivalen';
    return `${this.rescues} Mal zurück auf die Linie gesetzt\n` + this.list.map((r) => `${r.name} (${r.persona.trait}): ${(r.track.raced / 1000).toFixed(2)} km · Runde ${Math.min(this.laps, r.track.lap)} · ${(Math.abs(r.car.speed) * 3.6).toFixed(0)} km/h · ${r.mode} · Tempo ×${r.driver.pace.toFixed(2)} · ${r.passes} Überholversuche · ${r.mistakes} Fehler${r.finished !== undefined ? ` · im Ziel ${r.finished.toFixed(1)} s` : ''}`).join('\n');
  }

  /** ai.* debug commands (the race setup rivals.* is registered by the game). */
  registerCommands() {
    registerCommand({ name: 'ai.info', help: 'KI-Gegner: Position, Tempo, was sie gerade tun (Linie, überholt, folgt, Fehler)', run: () => this.info() });
    registerCommand({ name: 'ai.drivers', help: 'Charaktere der KI-Fahrer', run: () => PERSONAS.map((p) => `${p.name}: ${p.trait} · Tempo ×${p.skill} · Aggression ${p.aggr} · Konzentration ${p.focus} · Reaktion ${p.react} s`).join('\n') });
    registerToggle('ai.line', 'Ideallinie der Gegner auf der Straße anzeigen', () => this.showLine, (v) => { this.showLine = v; this.drawLine(); });
    registerValue('ai.apex', 'Anteil der Fahrbahnbreite für die Ideallinie 0..1 (0 = Straßenmitte, gilt ab dem nächsten Rennen)', () => this.apex, (v) => (this.apex = v), [0, 1]);
    registerToggle('ai.overtake', 'Gegner überholen auf einer freien Seite (aus: nur hinterherfahren)', () => this.overtake, (v) => (this.overtake = v));
    registerValue('ai.mistakes', 'Häufigkeit von Fahrfehlern in Kurven (0 = keine, 1 = normal)', () => this.mistakes, (v) => (this.mistakes = v), [0, 3]);
    registerValue('ai.skill', 'Tempofaktor aller Gegner', () => this.skill, (v) => (this.skill = v), [0.7, 1.3]);
    registerValue('ai.aggr', 'Aggression aller Gegner verschieben (-1..1): später bremsen, dichter auffahren, eher überholen', () => this.aggr, (v) => (this.aggr = v), [-1, 1]);
    registerValue('ai.rubber', 'Gummiband 0..1 (wie rivals.rubber)', () => this.rubber, (v) => (this.rubber = v), [0, 1]);
    registerCommand({ name: 'ai.mistake', help: 'Einen Gegner die nächste Kurve verpatzen lassen (spät = zu schnell, früh = zu früh gebremst)', args: '[name] [spät|früh]',
      complete: () => this.list.map((r) => r.name),
      run: ([name, kind]) => {
        const r = name ? this.list.find((x) => x.name.toLowerCase() === name.toLowerCase()) : this.list[0];
        if (!r) return 'kein solcher Gegner im Rennen';
        this.mistake(r, kind === 'früh' ? 'früh' : 'spät');
        return `${r.name} verpatzt die nächste Kurve (${kind === 'früh' ? 'zu früh gebremst' : 'zu schnell'})`;
      } });
    registerCommand({ name: 'ai.react', help: 'Reaktionszeit am Start für alle Fahrer setzen (s)', args: '<s>', run: ([v]) => {
      const s = parseNum(v ?? '0.3', 'Sekunden', 0, 3);
      for (const p of PERSONAS) p.react = s;
      return `Reaktion ${s} s`;
    } });
  }
}
