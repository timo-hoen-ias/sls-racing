import type { Agent } from '../traffic/trafficSim.ts';
import type { RoadGraph } from '../world/roadGraph.ts';

// Style moves while driving: near misses, slipstream, oncoming lane, drifts, jumps, knocked-over street
// furniture and rammed traffic. Each one gives nitro straight away and points for the combo (score.ts).
// Pure logic without three.js, so it runs in tests.

export type StyleKind = 'nearMiss' | 'slipstream' | 'oncoming' | 'drift' | 'air' | 'smash' | 'takedown' | 'speed';

export const STYLE_LABELS: Record<StyleKind, string> = {
  nearMiss: 'Knapp vorbei', slipstream: 'Windschatten', oncoming: 'Gegenverkehr', drift: 'Drift', air: 'Sprung',
  smash: 'Umgefahren', takedown: 'Gerammt', speed: 'Vollgas',
};

export interface StyleEvent {
  kind: StyleKind;
  label: string;
  points: number;
  /** Tank share added to the nitro (0..1). */
  nitro: number;
  /** Detail for the popup, e.g. "1,8 s" or "24 m". */
  detail?: string;
  /** For near misses: the side it passed on, -1 left .. 1 right (sound panning). */
  side?: number;
  /** Measured value: jump distance (m). */
  value?: number;
}

export interface StyleInput {
  dt: number;
  x: number;
  z: number;
  /** Velocity (m/s, world x/z). */
  vx: number;
  vz: number;
  /** Heading 0 = north (−z), clockwise. */
  heading: number;
  airborne: boolean;
  /** Seconds in the air so far (0 on the ground). */
  airTime: number;
  halfLength: number;
  halfWidth: number;
}

/** Nitro and points per move; style.* commands change them. */
export const STYLE_TUNING = {
  nearMissGap: 1.3, nearMissSpeed: 8, nearMissNitro: 0.07, nearMissPoints: 150,
  slipNitro: 0.06, slipPoints: 120, slipSpeed: 22,
  oncomingNitro: 0.04, oncomingPoints: 100, oncomingSpeed: 14,
  driftAngle: 0.26, driftSpeed: 11, driftNitro: 0.09, driftPoints: 160,
  airMin: 0.35, airNitro: 0.12, airPoints: 220,
  smashNitro: 0.02, smashPoints: 40,
  takedownNitro: 0.1, takedownPoints: 300,
  speedKmh: 230, speedPoints: 60,
};

interface Pass { gap: number; overlap: boolean; seen: number }

export class StyleTracker {
  enabled = true;
  readonly tuning = STYLE_TUNING;
  onEvent?: (e: StyleEvent) => void;
  /** Nitro trickling in while a move lasts (slipstream, oncoming lane, drift), as tank share. */
  onNitro?: (amount: number) => void;
  /** Running chains (seconds), for the HUD. */
  readonly chain = { drift: 0, slip: 0, oncoming: 0, speed: 0 };
  readonly totals: Record<StyleKind, number> = { nearMiss: 0, slipstream: 0, oncoming: 0, drift: 0, air: 0, smash: 0, takedown: 0, speed: 0 };
  private passes = new Map<number, Pass>();
  private graph?: RoadGraph;
  private takeoff?: { x: number; z: number };
  private frame = 0;
  private driftAngle = 0;
  private lastAir = 0;

  constructor(graph?: RoadGraph) {
    this.graph = graph;
  }

  private emit(kind: StyleKind, points: number, nitro: number, detail?: string, side?: number, value?: number) {
    this.totals[kind]++;
    this.onEvent?.({ kind, label: STYLE_LABELS[kind], points: Math.round(points), nitro, detail, side, value });
  }

  /** After a reset, teleport or rewind: forget take-offs and running moves (no fake jump on the drop). */
  reset() {
    this.takeoff = undefined;
    this.lastAir = 0;
    this.passes.clear();
    this.driftAngle = 0;
    for (const k of Object.keys(this.chain) as (keyof StyleTracker['chain'])[]) this.chain[k] = 0;
  }

  /** The car knocked something over (lamp, sign, fence …). */
  smash() {
    if (this.enabled) this.emit('smash', this.tuning.smashPoints, this.tuning.smashNitro);
  }

  /** The car rammed a vehicle out of traffic. */
  takedown(strength: number) {
    if (this.enabled) this.emit('takedown', this.tuning.takedownPoints * (0.6 + strength), this.tuning.takedownNitro);
  }

  update(p: StyleInput, agents: readonly Agent[]) {
    if (!this.enabled || p.dt <= 0) return;
    const t = this.tuning;
    const dt = p.dt;
    this.frame++;
    const speed = Math.hypot(p.vx, p.vz);
    const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
    // Right of the heading in the x-east, z-south frame.
    const rx = -fz, rz = fx;

    // Near misses and slipstream against every vehicle close by.
    let slip = false;
    for (const a of agents) {
      const dx = a.x - p.x, dz = a.z - p.z;
      if (dx * dx + dz * dz > 40 * 40) continue;
      const f = dx * fx + dz * fz;
      const l = dx * rx + dz * rz;
      const ax = Math.sin(a.yaw), az = Math.cos(a.yaw);
      const avx = ax * a.v, avz = az * a.v;
      const rel = Math.hypot(p.vx - avx, p.vz - avz);
      const along = p.halfLength + a.spec.length / 2;
      const gap = Math.abs(l) - p.halfWidth - a.spec.width / 2;
      let s = this.passes.get(a.id);
      if (!s) { s = { gap: Infinity, overlap: false, seen: 0 }; this.passes.set(a.id, s); }
      s.seen = this.frame;
      if (Math.abs(f) < along) {
        s.overlap = true;
        s.gap = Math.min(s.gap, gap);
      } else if (s.overlap) {
        // Passed it: a near miss if it was close, quick and without contact.
        if (s.gap > 0.02 && s.gap < t.nearMissGap && rel > t.nearMissSpeed && a.crashed <= 0) {
          const close = 1 - s.gap / t.nearMissGap;
          this.emit('nearMiss', t.nearMissPoints * (0.5 + close) * Math.min(2, rel / 15), t.nearMissNitro * (0.6 + close * 0.6), `${s.gap.toFixed(1)} m`, l >= 0 ? 1 : -1);
        }
        s.overlap = false;
        s.gap = Infinity;
      }
      // Right behind a vehicle going the same way, fast.
      if (f > along && f < along + 20 && Math.abs(l) < 1.3 && speed > t.slipSpeed && a.v > 8 && ax * fx + az * fz > 0.85) slip = true;
    }
    for (const [id, s] of this.passes) if (s.seen !== this.frame) this.passes.delete(id);
    this.run('slip', 'slipstream', slip, dt, t.slipNitro, t.slipPoints);

    // Oncoming lane of a two-way road.
    let oncoming = false;
    if (this.graph && speed > t.oncomingSpeed && !p.airborne) {
      const s = this.graph.snap(p.x, p.z, 12, (e) => !e.oneway && e.rank >= 3 && !e.noCars);
      if (s && s.dist < s.edge.width / 2) {
        const dir = Math.sign(s.dx * p.vx + s.dz * p.vz) || 1;
        const lat = ((p.x - s.x) * -s.dz + (p.z - s.z) * s.dx) * dir;
        oncoming = lat < -0.6;
      }
    }
    this.run('oncoming', 'oncoming', oncoming, dt, t.oncomingNitro, t.oncomingPoints);

    // Drift: slip angle between where the car points and where it goes.
    let drifting = false;
    if (!p.airborne && speed > t.driftSpeed) {
      const fwd = p.vx * fx + p.vz * fz;
      const side = p.vx * rx + p.vz * rz;
      const angle = Math.abs(Math.atan2(side, Math.max(0.1, fwd)));
      if (fwd > 0 && angle > t.driftAngle && angle < 1.6) { drifting = true; this.driftAngle = Math.max(this.driftAngle, angle); }
    }
    if (!drifting && this.chain.drift > 0.6) {
      const deg = Math.round((this.driftAngle * 180) / Math.PI);
      this.emit('drift', t.driftPoints * this.chain.drift * (0.6 + this.driftAngle), 0, `${this.chain.drift.toFixed(1)} s · ${deg}°`);
    }
    if (!drifting) this.driftAngle = 0;
    this.run('drift', null, drifting, dt, t.driftNitro, 0);

    // Jumps: points by time in the air, distance from take-off to landing.
    if (p.airborne && !this.takeoff) this.takeoff = { x: p.x, z: p.z };
    if (!p.airborne && this.takeoff) {
      const air = this.lastAir;
      const dist = Math.hypot(p.x - this.takeoff.x, p.z - this.takeoff.z);
      // A real jump goes somewhere: dropping onto the road after a reset does not count.
      if (air > t.airMin && dist > 5) {
        this.emit('air', t.airPoints * air + dist * 4, t.airNitro * Math.min(2, air), `${dist.toFixed(0)} m · ${air.toFixed(1)} s`, undefined, dist);
      }
      this.takeoff = undefined;
    }
    this.lastAir = p.airTime;

    // Flat out.
    this.run('speed', 'speed', speed * 3.6 > t.speedKmh && !p.airborne, dt, 0, t.speedPoints);
  }

  /** A move that lasts: nitro while it runs, points when it ends (after at least a second). */
  private run(key: keyof StyleTracker['chain'], kind: StyleKind | null, active: boolean, dt: number, nitro: number, points: number) {
    if (active) {
      this.chain[key] += dt;
      if (nitro > 0) this.onNitro?.(nitro * dt);
      return;
    }
    const time = this.chain[key];
    this.chain[key] = 0;
    if (kind && time >= 1) this.emit(kind, points * time, 0, `${time.toFixed(1)} s`);
  }
}
