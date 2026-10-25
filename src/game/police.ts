import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { DriveInput } from '../input/input.ts';
import { CarPhysics } from '../vehicle/carPhysics.ts';
import type { CarView } from '../vehicle/carView.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { RaceLine, RivalDriver } from './rivals.ts';

// Police and chases (V4): patrol cars cruise around the player; speeding past one or ramming it raises the
// wanted level (1–5 stars). Then units hunt the player over the road graph with the rival autopilot, close
// in directly at short range, and with more stars come more units, road blocks and spike strips. Out of their
// sight long enough and the chase is over; boxed in and stopped, the player is caught and fined.

type R = typeof RAPIER_NS;

/** Per wanted level: units hunting, their top speed (m/s), escape time out of sight (s). */
export const HEAT = [
  { units: 0, cruise: 0, escape: 0 },
  { units: 1, cruise: 42, escape: 8 },
  { units: 2, cruise: 50, escape: 10 },
  { units: 3, cruise: 58, escape: 12 },
  { units: 4, cruise: 66, escape: 14 },
  { units: 5, cruise: 74, escape: 16 },
] as const;
export const MAX_HEAT = HEAT.length - 1;
/** Seconds of chase per extra star. */
const ESCALATE = 45;
/** Seconds stopped next to a police car until caught. */
export const BUST = 3.5;

export interface WantedInput {
  /** A police car sees the player. */
  seen: boolean;
  /** A police car is right beside the stopped player. */
  caught: boolean;
}

/** The wanted level and its timers, without any physics (tested on its own). */
export class Wanted {
  heat = 0;
  /** Seconds out of sight / boxed in / in this chase. */
  hidden = 0;
  boxed = 0;
  chase = 0;
  onChange?: (heat: number, why: string) => void;
  onEscape?: (heat: number, seconds: number) => void;
  onBust?: (heat: number) => void;

  get escapeNeeded() { return HEAT[this.heat].escape; }

  raise(to: number, why: string) {
    const h = Math.max(this.heat, Math.min(MAX_HEAT, Math.round(to)));
    if (h === this.heat) return;
    if (!this.heat) this.chase = 0;
    this.heat = h;
    this.hidden = 0;
    this.onChange?.(h, why);
  }

  clear() {
    this.heat = 0;
    this.hidden = this.boxed = this.chase = 0;
  }

  update(dt: number, s: WantedInput) {
    if (!this.heat) return;
    this.chase += dt;
    if (this.heat < MAX_HEAT && this.chase > ESCALATE * this.heat) this.raise(this.heat + 1, 'Verfolgung dauert an');
    this.hidden = s.seen ? 0 : this.hidden + dt;
    this.boxed = s.caught ? this.boxed + dt : Math.max(0, this.boxed - dt * 2);
    if (this.boxed >= BUST) {
      const h = this.heat;
      this.clear();
      this.onBust?.(h);
    } else if (this.hidden >= this.escapeNeeded) {
      const h = this.heat, t = this.chase;
      this.clear();
      this.onEscape?.(h, t);
    }
  }
}

export interface PoliceOptions {
  R: R;
  world: RAPIER_NS.World;
  scene: THREE.Scene;
  graph: RoadGraph;
  makeView(color: string): Promise<CarView | undefined>;
  groundAt(x: number, z: number): number | undefined;
  loaded(x: number, z: number): boolean;
  feel(): CarPhysics['feel'];
}

export interface PlayerNow {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** m/s */
  speed: number;
  heading: number;
}

type Mode = 'patrol' | 'chase' | 'block';

interface Unit {
  car: CarPhysics;
  view?: CarView;
  bar?: THREE.Group;
  mode: Mode;
  driver?: RivalDriver;
  /** Points on the driver's current line. */
  linePts: number;
  replan: number;
  stuck: number;
  /** Road blocks are cleared after a while. */
  life: number;
  prev: { p: THREE.Vector3; q: THREE.Quaternion };
  curr: { p: THREE.Vector3; q: THREE.Quaternion };
}

const PATROL_LEVEL = { lat: 6, cruise: 15, brake: 6, torque: 0.85 };
const POLICE_PAINT = '#e8ecef';

export class Police {
  enabled = true;
  /** Patrol cars around the player in free roam. */
  patrols = 2;
  /** Speeding past a patrol (km/h) in town / on expressways. */
  limitTown = 95;
  limitFast = 170;
  /** How far a police car sees (m), plus per star. */
  sight = 70;
  readonly wanted = new Wanted();
  readonly units: Unit[] = [];
  /** Spike strips lying on the road: x, z, direction across, half length. */
  readonly spikes: { x: number; z: number; ax: number; az: number; half: number; life: number; mesh: THREE.Mesh }[] = [];
  /** Seconds the player's tyres stay punctured. */
  flat = 0;
  /** Set while a chase runs inside an escape event: no patrol spawns, no fines. */
  event = false;
  onRam?: () => void;
  private o: PoliceOptions;
  private blockTimer = 20;
  private time = 0;
  private flatTorque = 1;

  constructor(o: PoliceOptions) {
    this.o = o;
  }

  get heat() { return this.wanted.heat; }

  /** One physics step (before world.step). */
  step(dt: number, player: PlayerNow, playerCar: CarPhysics) {
    this.time += dt;
    for (const u of this.units) { u.prev.p.copy(u.curr.p); u.prev.q.copy(u.curr.q); }
    if (!this.enabled) { if (this.units.length) this.clear(); return; }
    const heat = this.wanted.heat;
    this.keepUnits(player, heat);
    let seen = false, caught = false;
    const sight = this.sight + heat * 15;
    // A copy: drive() takes a flipped unit out of the world, and its car must not be stepped after that.
    for (const u of [...this.units]) {
      const t = u.car.body.translation();
      const d = Math.hypot(t.x - player.x, t.z - player.z);
      if (u.mode === 'block') {
        u.car.update({ throttle: 0, brake: 1, steer: 0, nitro: false, handbrake: true, lookBack: false }, dt);
        u.life -= dt;
      } else {
        const input = this.drive(u, player, d, dt);
        if (!this.units.includes(u)) continue;
        u.car.update(input, dt);
      }
      if (d < sight) seen = true;
      if (d < 7.5 && player.speed < 3) caught = true;
      // Ramming: close and closing fast.
      if (d < 3.6) {
        const lv = u.car.body.linvel();
        const closing = ((player.vx - lv.x) * (t.x - player.x) + (player.vz - lv.z) * (t.z - player.z)) / (d || 1);
        if (closing > 6 && this.time > 1) {
          this.wanted.raise(Math.max(2, this.wanted.heat + 1), 'Polizei gerammt');
          this.onRam?.();
          this.time = 0;
        }
      }
      // Speeding past a patrol.
      if (!heat && u.mode === 'patrol' && d < 60) {
        const fast = this.o.graph.snap(player.x, player.z, 20);
        const limit = fast && fast.edge.rank >= 8 ? this.limitFast : this.limitTown;
        if (player.speed * 3.6 > limit) this.wanted.raise(1, `Zu schnell (${Math.round(player.speed * 3.6)} km/h)`);
      }
    }
    this.wanted.update(dt, { seen, caught });
    this.stepSpikes(dt, player, playerCar);
    // Road blocks and spikes ahead of the player from 4 stars.
    if (heat >= 4 && (this.blockTimer -= dt) <= 0) {
      this.blockTimer = 40;
      this.roadBlock(player, heat >= 5);
    }
  }

  /** After world.step: read poses back. */
  capture() {
    for (const u of this.units) {
      const t = u.car.body.translation(), q = u.car.body.rotation();
      u.curr.p.set(t.x, t.y, t.z);
      u.curr.q.set(q.x, q.y, q.z, q.w);
    }
  }

  private ip = new THREE.Vector3();
  private iq = new THREE.Quaternion();

  render(alpha: number, time: number, night: number) {
    const on = this.wanted.heat > 0;
    for (const u of this.units) {
      if (!u.view) continue;
      this.ip.lerpVectors(u.prev.p, u.curr.p, alpha);
      this.iq.slerpQuaternions(u.prev.q, u.curr.q, alpha);
      u.view.setNight(night);
      u.view.sync(u.car, this.ip, this.iq, false, time);
      if (u.bar) {
        // Blue lights flash during a chase and at road blocks.
        const flash = (on || u.mode === 'block') && Math.floor(time * 6) % 2 === 0;
        const [a, b] = u.bar.children as THREE.Mesh[];
        (a.material as THREE.MeshStandardMaterial).emissiveIntensity = flash ? 6 : on ? 0.3 : 0.05;
        (b.material as THREE.MeshStandardMaterial).emissiveIntensity = !flash && (on || u.mode === 'block') ? 6 : on ? 0.3 : 0.05;
      }
    }
  }

  /** Nearest police car with its distance and side (-1 left … 1 right of the player's heading). */
  nearest(p: PlayerNow) {
    let best: { d: number; side: number } | undefined;
    for (const u of this.units) {
      const t = u.car.body.translation();
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (best && d >= best.d) continue;
      const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
      const side = ((t.x - p.x) * -fz + (t.z - p.z) * fx) / (d || 1);
      best = { d, side };
    }
    return best;
  }

  isPolice(body: RAPIER_NS.RigidBody | null) {
    return !!body && this.units.some((u) => u.car.body === body);
  }

  clear() {
    for (const u of [...this.units]) this.remove(u);
    for (const s of this.spikes) this.o.scene.remove(s.mesh);
    this.spikes.length = 0;
  }

  /** Enough units for the level: patrols in free roam, hunters in a chase; far ones leave. */
  private keepUnits(p: PlayerNow, heat: number) {
    for (const u of [...this.units]) {
      const t = u.car.body.translation();
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      const gone = u.mode === 'block' ? u.life <= 0 || d > 600 : d > (u.mode === 'chase' ? 450 : 420);
      if (gone || !this.o.loaded(t.x, t.z)) this.remove(u);
    }
    if (heat) {
      for (const u of this.units) if (u.mode === 'patrol') { u.mode = 'chase'; u.replan = 0; }
      const hunters = this.units.filter((u) => u.mode === 'chase').length;
      if (hunters < HEAT[heat].units) this.spawn(p, 'chase', 140 + Math.random() * 60);
    } else {
      for (const u of this.units) if (u.mode === 'chase') { u.mode = 'patrol'; u.replan = 0; }
      const patrols = this.units.filter((u) => u.mode === 'patrol').length;
      if (!this.event && patrols < this.patrols && Math.random() < 0.02) this.spawn(p, 'patrol', 180 + Math.random() * 120);
    }
  }

  /** A unit on a road at about `dist` from the player, behind them in a chase. */
  private spawn(p: PlayerNow, mode: Mode, dist: number) {
    const g = this.o.graph;
    const back = mode === 'chase' && p.speed > 5 ? Math.atan2(-p.vx, p.vz) : Math.random() * Math.PI * 2;
    for (let k = 0; k < 6; k++) {
      const a = back + (k ? (Math.random() - 0.5) * 2 : 0);
      const x = p.x + Math.sin(a) * dist, z = p.z - Math.cos(a) * dist;
      const s = g.snap(x, z, 80, (e) => !e.noCars && e.rank >= 2);
      if (!s || !this.o.loaded(s.x, s.z)) continue;
      const y = this.o.groundAt(s.x, s.z);
      if (y === undefined) continue;
      // Facing the player in a chase, along the road on patrol.
      const toward = Math.sign((p.x - s.x) * s.dx + (p.z - s.z) * s.dz) || 1;
      const heading = Math.atan2(s.dx * toward, -s.dz * toward);
      this.add(s.x, y, s.z, heading, mode);
      return true;
    }
    return false;
  }

  private add(x: number, y: number, z: number, heading: number, mode: Mode) {
    const car = new CarPhysics(this.o.R, this.o.world, { x, y: y + 0.9, z }, heading);
    Object.assign(car.feel, this.o.feel());
    car.burst.enabled = false;
    const t = car.body.translation(), r = car.body.rotation();
    const pose = () => ({ p: new THREE.Vector3(t.x, t.y, t.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) });
    const u: Unit = { car, mode, linePts: 0, replan: 0, stuck: 0, life: 40, prev: pose(), curr: pose() };
    this.units.push(u);
    void this.o.makeView(POLICE_PAINT).then((v) => {
      if (!v || !this.units.includes(u)) return;
      u.view = v;
      u.bar = lightBar();
      v.root.add(u.bar);
      this.o.scene.add(v.root);
    });
    return u;
  }

  private remove(u: Unit) {
    u.car.dispose();
    if (u.view) this.o.scene.remove(u.view.root);
    this.units.splice(this.units.indexOf(u), 1);
  }

  private drive(u: Unit, p: PlayerNow, d: number, dt: number): DriveInput {
    const c = u.car;
    const t = c.body.translation();
    const heat = this.wanted.heat;
    // Stuck: back up a little, then a new plan.
    const r2 = c.body.rotation();
    const flipped = 1 - 2 * (r2.x * r2.x + r2.z * r2.z) < 0.4;
    u.stuck = Math.abs(c.speed) < 1.5 && (u.mode === 'chase' || u.driver) ? u.stuck + dt : 0;
    if (flipped && u.stuck > 2) { this.remove(u); return idle(); }
    if (u.stuck > 1.5 && u.stuck < 2.6) return { throttle: 0, brake: 1, steer: 0, nitro: false, handbrake: false, lookBack: false };
    if (u.stuck >= 2.6) { u.stuck = 0; u.replan = 0; }
    if (u.mode === 'chase' && d < 32) {
      // Close: straight at where the player will be in a moment.
      const lead = Math.min(1.2, d / 25);
      const tx = p.x + p.vx * lead, tz = p.z + p.vz * lead;
      const want = Math.atan2(tx - t.x, -(tz - t.z));
      let a = want - c.heading();
      a = Math.atan2(Math.sin(a), Math.cos(a));
      const goal = Math.max(p.speed + 4, 12);
      return { throttle: c.speed < goal ? 1 : 0.2, brake: Math.abs(a) > 1.4 && c.speed > 12 ? 0.6 : 0, steer: Math.max(-1, Math.min(1, a * 2.5)), nitro: false, handbrake: false, lookBack: false };
    }
    if ((u.replan -= dt) <= 0 || !u.driver) {
      u.replan = u.mode === 'chase' ? 1.2 : 30;
      const g = this.o.graph;
      const from = g.snap(t.x, t.z, 60, (e) => !e.noCars);
      let to;
      if (u.mode === 'chase') to = g.snap(p.x + p.vx * 1.5, p.z + p.vz * 1.5, 60, (e) => !e.noCars);
      else {
        const a = Math.random() * Math.PI * 2;
        to = g.snap(t.x + Math.sin(a) * 500, t.z - Math.cos(a) * 500, 120, (e) => !e.noCars && e.rank >= 2);
      }
      const route = from && to ? g.route(from, to) : undefined;
      if (route && route.pts.length >= 6) {
        const path: number[] = [];
        for (let i = 0; i < route.pts.length; i += 3) path.push(route.pts[i], route.pts[i + 2]);
        const line = new RaceLine(path, false);
        u.driver = new RivalDriver(line);
        u.linePts = line.count;
        u.driver.level = u.mode === 'chase' ? { lat: 11, cruise: HEAT[Math.max(1, heat)].cruise, brake: 10, torque: 1.1 } : PATROL_LEVEL;
        u.driver.offset = u.mode === 'patrol' ? 1.8 : 0;
      } else if (!u.driver) return idle();
    }
    const inp = u.driver!.drive({ x: t.x, z: t.z, heading: c.heading(), speed: c.speed });
    // Patrols stop at the end of their route and plan again.
    if (u.mode === 'patrol' && u.driver!.index >= u.linePts - 3) u.replan = 0;
    return inp;
  }

  /** Two parked units across the road some way ahead, from 5 stars with a spike strip in front. */
  private roadBlock(p: PlayerNow, spikes: boolean) {
    if (p.speed < 8) return;
    const ux = p.vx / p.speed, uz = p.vz / p.speed;
    const g = this.o.graph;
    const s = g.snap(p.x + ux * 260, p.z + uz * 260, 60, (e) => !e.noCars);
    if (!s || !this.o.loaded(s.x, s.z)) return;
    const y = this.o.groundAt(s.x, s.z);
    if (y === undefined) return;
    const ax = -s.dz, az = s.dx;
    const across = Math.atan2(ax, -az);
    for (const off of [-1.6, 1.6]) {
      const u = this.add(s.x + ax * off * 1.4, y, s.z + az * off * 1.4, across + (off > 0 ? 0 : Math.PI), 'block');
      u.life = 40;
    }
    if (spikes) {
      const dir = Math.sign((s.x - p.x) * s.dx + (s.z - p.z) * s.dz) || 1;
      const x = s.x - s.dx * dir * 25, z = s.z - s.dz * dir * 25;
      const half = s.edge.width / 2;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.06, 0.35), new THREE.MeshStandardMaterial({ color: 0x1b1d20, metalness: 0.6, roughness: 0.4 }));
      mesh.position.set(x, (this.o.groundAt(x, z) ?? y) + 0.05, z);
      mesh.rotation.y = -Math.atan2(az, ax);
      this.o.scene.add(mesh);
      this.spikes.push({ x, z, ax, az, half, life: 40, mesh });
    }
  }

  private stepSpikes(dt: number, p: PlayerNow, car: CarPhysics) {
    for (const s of [...this.spikes]) {
      s.life -= dt;
      const along = (p.x - s.x) * s.ax + (p.z - s.z) * s.az;
      const across = Math.abs((p.x - s.x) * s.az - (p.z - s.z) * s.ax);
      if (Math.abs(along) < s.half && across < 1.2 && this.flat <= 0) {
        this.flat = 10;
        this.flatTorque = car.feel.torque;
        car.feel.torque *= 0.45;
        this.onSpikes?.();
      }
      if (s.life <= 0) { this.o.scene.remove(s.mesh); this.spikes.splice(this.spikes.indexOf(s), 1); }
    }
    if (this.flat > 0 && (this.flat -= dt) <= 0) car.feel.torque = this.flatTorque;
  }

  onSpikes?: () => void;

  info() {
    const w = this.wanted;
    return `Fahndungsstufe ${w.heat} · ${this.units.length} Streifen (${this.units.map((u) => u.mode).join(', ') || '–'})${w.heat ? ` · außer Sicht ${w.hidden.toFixed(1)}/${w.escapeNeeded} s · gestellt ${w.boxed.toFixed(1)}/${BUST} s · Verfolgung ${w.chase.toFixed(0)} s` : ''}${this.flat > 0 ? ` · Reifen platt ${this.flat.toFixed(0)} s` : ''}`;
  }

  registerCommands() {
    registerToggle('police', 'Polizei: Streifen, Fahndung und Verfolgungen', () => this.enabled, (v) => (this.enabled = v));
    registerCommand({ name: 'police.wanted', help: 'Fahndungsstufe setzen (0 beendet die Verfolgung)', args: '<0..5>', run: ([v]) => {
      const h = parseNum(v ?? '1', 'Stufe', 0, MAX_HEAT);
      if (!h) this.wanted.clear(); else this.wanted.raise(h, 'Debug');
      return this.info();
    } });
    registerCommand({ name: 'police.info', help: 'Fahndung, Streifen und Zeiten', run: () => this.info() });
    registerCommand({ name: 'police.clear', help: 'Alle Polizeiautos entfernen und die Fahndung beenden', run: () => { this.wanted.clear(); this.clear(); return 'keine Polizei'; } });
    registerValue('police.patrols', 'Streifenwagen in der freien Fahrt', () => this.patrols, (v) => (this.patrols = Math.round(v)), [0, 6]);
    registerValue('police.limit', 'Tempo (km/h), ab dem eine Streife in der Stadt eingreift', () => this.limitTown, (v) => (this.limitTown = v), [50, 250]);
    registerValue('police.sight', 'Sichtweite der Polizei (m, plus 15 je Stern)', () => this.sight, (v) => (this.sight = v), [20, 200]);
  }
}

const idle = (): DriveInput => ({ throttle: 0, brake: 0.5, steer: 0, nitro: false, handbrake: false, lookBack: false });

/** Roof light bar: blue on both sides. */
function lightBar() {
  const g = new THREE.Group();
  g.name = 'lightbar';
  for (const x of [-0.32, 0.32]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.11, 0.24), new THREE.MeshStandardMaterial({ color: 0x0a2a9a, emissive: 0x2a5bff, emissiveIntensity: 0.05, roughness: 0.3 }));
    m.position.set(x, 0, 0);
    g.add(m);
  }
  g.position.set(0, 0.92, -0.15);
  return g;
}
