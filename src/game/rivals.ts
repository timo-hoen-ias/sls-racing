import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { DriveInput } from '../input/input.ts';
import { CarPhysics } from '../vehicle/carPhysics.ts';
import type { CarView } from '../vehicle/carView.ts';

// Rival drivers for races (V3): cars with the same physics as the player, an autopilot that follows the
// race line and plans its speed from the bends ahead, three strengths and a mild rubber band that keeps
// the field together. Rivals far from the player (where the tiles may not be loaded) run on rails along
// the line and drop back into the physics when they come near again.

type R = typeof RAPIER_NS;

export type RivalLevel = 'leicht' | 'mittel' | 'schwer';

export const RIVAL_LEVELS: Record<RivalLevel, { lat: number; cruise: number; brake: number; torque: number }> = {
  leicht: { lat: 7.5, cruise: 38, brake: 7, torque: 0.85 },
  mittel: { lat: 9.5, cruise: 52, brake: 9, torque: 1 },
  schwer: { lat: 11.5, cruise: 70, brake: 11, torque: 1.1 },
};

/** A race line: points every few metres with the distance along it and the speed each bend allows. */
export class RaceLine {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly cum: Float32Array;
  readonly length: number;
  /** Turn radius at each point (m), from the points 8 m either side. */
  readonly radius: Float32Array;
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
    this.radius = new Float32Array(n);
    const k = Math.max(1, Math.round(8 / spacing));
    for (let i = 0; i < n; i++) {
      const a = this.at(i - k), c = this.at(i + k);
      const a1 = Math.atan2(xs[i] - a[0], zs[i] - a[1]);
      const a2 = Math.atan2(c[0] - xs[i], c[1] - zs[i]);
      const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      const len = Math.hypot(xs[i] - a[0], zs[i] - a[1]) + Math.hypot(c[0] - xs[i], c[1] - zs[i]);
      this.radius[i] = len > 0.5 ? len / 2 / Math.max(turn, 1e-3) : 1e4;
    }
  }

  get count() { return this.x.length; }

  /** Point i (wrapping on loops, clamped otherwise). */
  at(i: number): [number, number] {
    const n = this.x.length;
    const j = this.loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return [this.x[j], this.z[j]];
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

  /** Position and direction at a distance along the line. */
  pose(d: number) {
    const L = this.length;
    if (this.loop && L > 0) d = ((d % L) + L) % L;
    d = Math.max(0, Math.min(L, d));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= d) lo = m; else hi = m; }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (d - this.cum[lo]) / seg;
    const dx = this.x[hi] - this.x[lo], dz = this.z[hi] - this.z[lo];
    const l = Math.hypot(dx, dz) || 1;
    return { x: this.x[lo] + dx * t, z: this.z[lo] + dz * t, dx: dx / l, dz: dz / l, heading: Math.atan2(dx / l, -dz / l) };
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
    this.index = L.nearest(p.x, p.z, this.index, 4, 16).index;
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
 * The autopilot: pure pursuit on the race line, speed from the bends ahead (v = √(lat·R)) braked down to
 * in time. Also used by the event route test (G3).
 */
export class RivalDriver {
  index = -1;
  /** Lateral offset from the line (m, + = right), so rivals do not drive in one file. */
  offset = 0;
  level = RIVAL_LEVELS.mittel;
  /** Extra speed factor from the rubber band. */
  pace = 1;
  /** Speed goal of the last step (m/s). */
  goal = 0;
  private line: RaceLine;
  private input: DriveInput = { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };

  constructor(line: RaceLine) {
    this.line = line;
  }

  drive(s: DriverState): DriveInput {
    const L = this.line;
    const near = L.nearest(s.x, s.z, this.index);
    this.index = near.index;
    const v = Math.abs(s.speed);
    const look = Math.max(1, Math.round((3 + v * 0.28) / L.spacing));
    let [tx, tz] = L.at(this.index + look);
    if (this.offset) {
      const [ax, az] = L.at(this.index + look - 1);
      const dx = tx - ax, dz = tz - az, l = Math.hypot(dx, dz) || 1;
      tx += (-dz / l) * this.offset;
      tz += (dx / l) * this.offset;
    }
    const want = Math.atan2(tx - s.x, -(tz - s.z));
    let d = want - s.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const lv = this.level;
    const cruise = lv.cruise * this.pace;
    let goal = cruise;
    const ahead = Math.min(L.count * (L.loop ? 1 : 0) || L.count, 80);
    for (let k = 0; k < ahead; k++) {
      const i = this.index + k;
      if (!L.loop && i >= L.count) break;
      const r = L.radius[((i % L.count) + L.count) % L.count];
      const vc = Math.sqrt(lv.lat * this.pace * r);
      const dist = Math.max(0, k * L.spacing - 3);
      goal = Math.min(goal, Math.sqrt(vc * vc + 2 * lv.brake * dist));
    }
    this.goal = goal;
    const inp = this.input;
    inp.throttle = s.speed < goal ? Math.min(1, (goal - s.speed) / 3 + 0.4) : 0;
    inp.brake = s.speed > goal + 1.5 ? Math.min(1, (s.speed - goal) / 6) : 0;
    inp.steer = Math.max(-1, Math.min(1, d * (2.2 + v * 0.02)));
    inp.nitro = goal - s.speed > 12 && Math.abs(d) < 0.08 && v > 15;
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
}

const COLORS = ['#1f5bd6', '#f2f2f2', '#f4b400', '#2f9e44', '#7a2fd0', '#111418'];
const NAMES = ['Kai', 'Mara', 'Jonas', 'Lea', 'Emre', 'Nina'];

interface Rival {
  name: string;
  car: CarPhysics;
  view?: CarView;
  driver: RivalDriver;
  track: LineTracker;
  finished?: number;
  /** Running on rails (far from the player). */
  rail: boolean;
  /** Seconds stuck (crawling while the race runs); a rival stuck too long is put back on the line. */
  stuck: number;
  railSpeed: number;
  prev: { p: THREE.Vector3; q: THREE.Quaternion };
  curr: { p: THREE.Vector3; q: THREE.Quaternion };
}

export class Rivals {
  level: RivalLevel = 'mittel';
  /** Rubber band strength 0..1: rivals behind the player speed up, those ahead ease off a little. */
  rubber = 0.5;
  enabled = true;
  /** Rivals drive on rails beyond this distance from the player (m). */
  railRange = 220;
  line?: RaceLine;
  laps = 1;
  readonly list: Rival[] = [];
  private o: RivalOptions;
  private time = 0;
  private playerRaced = 0;

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
    this.line = new RaceLine(path, loop);
    this.laps = laps ?? 1;
    this.time = 0;
    this.playerRaced = 0;
    this.rescues = 0;
    const lv = RIVAL_LEVELS[this.level];
    const slots = [[-6, -1.6], [-6, 1.6], [-22, -1.6], [-22, 1.6], [-30, 0], [-38, 0]];
    for (let i = 0; i < Math.min(n, slots.length); i++) {
      const [back, side] = slots[i];
      const p = this.line.pose(0);
      const x = p.x + p.dx * back - p.dz * side, z = p.z + p.dz * back + p.dx * side;
      const y = (this.o.groundAt(x, z) ?? 0) + 0.9;
      const car = new CarPhysics(this.o.R, this.o.world, { x, y, z }, p.heading);
      Object.assign(car.feel, this.o.feel());
      car.feel.torque *= lv.torque;
      car.burst.enabled = false;
      const driver = new RivalDriver(this.line);
      driver.level = lv;
      driver.offset = side * 0.6;
      driver.index = 0;
      const track = new LineTracker(this.line, back);
      const t = car.body.translation(), r = car.body.rotation();
      const pose = () => ({ p: new THREE.Vector3(t.x, t.y, t.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) });
      const rival: Rival = { name: NAMES[i], car, driver, track, rail: false, stuck: 0, railSpeed: 0, prev: pose(), curr: pose() };
      this.list.push(rival);
      void this.o.makeView(COLORS[i]).then((v) => {
        if (!v || !this.list.includes(rival)) return;
        rival.view = v;
        this.o.scene.add(v.root);
      });
    }
  }

  clear() {
    for (const r of this.list) {
      r.car.dispose();
      if (r.view) this.o.scene.remove(r.view.root);
    }
    this.list.length = 0;
    this.line = undefined;
  }

  /** The player's distance raced, for the rubber band and the places. */
  setPlayer(raced: number) {
    this.playerRaced = raced;
  }

  /** One physics step (before world.step). go: the race is running (during the countdown they wait). */
  step(dt: number, go: boolean, player: { x: number; z: number }) {
    if (!this.line) return;
    this.time += go ? dt : 0;
    const L = this.line;
    for (const r of this.list) {
      const c = r.car;
      r.prev.p.copy(r.curr.p);
      r.prev.q.copy(r.curr.q);
      if (r.finished !== undefined) {
        // Over the line: roll out.
        c.update({ throttle: 0, brake: 0.3, steer: 0, nitro: false, handbrake: false, lookBack: false }, dt);
        continue;
      }
      // Rubber band on the target speed.
      const gap = r.track.raced - this.playerRaced;
      r.driver.pace = 1 + Math.max(-0.12, Math.min(0.25, -gap / 400)) * this.rubber * 2;
      const t = c.body.translation();
      const far = Math.hypot(t.x - player.x, t.z - player.z) > this.railRange || !this.o.loaded(t.x, t.z);
      if (far && !r.rail) {
        r.rail = true;
        r.railSpeed = Math.max(10, Math.abs(c.speed));
        c.body.setEnabled(false);
      }
      if (r.rail) {
        // On rails: along the line at about the speed the driver would aim for.
        if (go) r.railSpeed += (Math.min(r.driver.level.cruise * r.driver.pace, 45) - r.railSpeed) * Math.min(1, dt * 0.5);
        r.track.set(r.track.raced + (go ? r.railSpeed * dt : 0));
        r.driver.index = r.track.index;
        const p = L.pose(r.track.raced);
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
      const input = go
        ? r.driver.drive({ x: t.x, z: t.z, heading: c.heading(), speed: c.speed })
        : { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: true, lookBack: false };
      c.update(input, dt);
      r.track.update(t.x, t.z);
      this.finish(r);
      // Stuck on a sign, a wall or on its roof: back onto the line a little further on.
      const r2 = c.body.rotation();
      const flipped = 1 - 2 * (r2.x * r2.x + r2.z * r2.z) < 0.4;
      r.stuck = go && (Math.abs(c.speed) < 2 || flipped) ? r.stuck + dt : 0;
      if (r.stuck > 2.5) {
        r.stuck = 0;
        this.rescues++;
        const p = L.pose(r.track.raced + 25);
        const y = this.o.groundAt(p.x, p.z);
        if (y === undefined) continue;
        c.reset({ x: p.x, y: y + 0.9, z: p.z }, p.heading);
        c.body.setLinvel({ x: p.dx * 8, y: 0, z: p.dz * 8 }, true);
        r.track.set(r.track.raced + 25);
        r.driver.index = r.track.index;
      }
    }
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
    return `${this.rescues} Mal zurück auf die Linie gesetzt\n` + this.list.map((r) => `${r.name}: ${(r.track.raced / 1000).toFixed(2)} km · Runde ${Math.min(this.laps, r.track.lap)} · ${(Math.abs(r.car.speed) * 3.6).toFixed(0)} km/h${r.rail ? ' · auf Schiene' : ''}${r.finished !== undefined ? ` · im Ziel ${r.finished.toFixed(1)} s` : ''}`).join('\n');
  }
}
