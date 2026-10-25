import type { StyleEvent } from '../style.ts';
import { crossed, type EventResult, type GameEvent, type Gate, medalFor, RACE_TYPES } from './types.ts';

// Runs one event at a time. Races (sprint, circuit, duel, missions) start with a countdown at their start
// gate and run through checkpoints; skills start when the car drives through their start gate in free roam
// and end at their end gate (speed traps measure on the spot). Zones are lost when the car leaves their
// corridor or runs out of time.

export type RunState = 'idle' | 'countdown' | 'running' | 'done';

export interface CarSample {
  x: number;
  z: number;
  /** Speed (m/s). */
  speed: number;
}

/** Base XP and credits per event type for a bronze medal; better medals pay more. */
const PAY: Record<string, [number, number]> = {
  sprint: [600, 900], circuit: [900, 1300], duel: [800, 1200], escape: [700, 1000], delivery: [500, 700],
  speedtrap: [150, 150], speedzone: [250, 250], drift: [300, 300], nearmiss: [300, 300], slalom: [250, 250], jump: [200, 200],
};
const MEDAL_PAY = [0.3, 1, 1.4, 1.9, 2.6];

export function rewardFor(e: GameEvent, medal: number) {
  const [xp, cr] = PAY[e.type] ?? [200, 200];
  const k = MEDAL_PAY[medal] * (1 + (e.level - 1) * 0.08);
  return { xp: Math.round(xp * k), credits: Math.round(cr * k) };
}

export class EventRunner {
  state: RunState = 'idle';
  event?: GameEvent;
  /** Seconds since the start signal. */
  time = 0;
  countdown = 0;
  /** Index of the next gate; lap (1-based). */
  next = 0;
  lap = 1;
  /** Running measure: zone distance, drift points, near misses, slalom misses. */
  points = 0;
  misses = 0;
  /** Last result, until the next start. */
  result?: EventResult;
  failReason = '';
  /** Results of the ghost (best run) at each gate, for the split display. */
  splits: number[] = [];
  /** Where the car restarts after a reset in a race: the last gate passed. */
  lastGate?: Gate;
  onStart?: (e: GameEvent) => void;
  onCountdown?: (n: number) => void;
  onGo?: () => void;
  onGate?: (index: number, lap: number) => void;
  onLap?: (lap: number) => void;
  onFinish?: (r: EventResult) => void;
  onFail?: (e: GameEvent, why: string) => void;
  /** Best result per event id (from the save), for "new best". */
  best: (id: string) => number | undefined = () => undefined;
  private distance = 0;
  private prev?: CarSample;

  get busy() {
    return this.state === 'countdown' || this.state === 'running';
  }

  get racing() {
    return this.busy && !!this.event && RACE_TYPES.has(this.event.type);
  }

  /** Starts a race with a countdown (the caller has put the car on the start gate). */
  startRace(e: GameEvent, countdown = 3) {
    this.reset(e);
    this.state = 'countdown';
    this.countdown = countdown;
    this.lastGate = e.start;
    this.onStart?.(e);
    this.onCountdown?.(Math.ceil(countdown));
  }

  /** Starts a skill immediately (the car just crossed its start gate). */
  startSkill(e: GameEvent, speed: number) {
    this.reset(e);
    this.state = 'running';
    this.onStart?.(e);
    if (e.type === 'speedtrap') this.finish(speed * 3.6);
  }

  private reset(e: GameEvent) {
    this.event = e;
    this.time = 0;
    this.next = 0;
    this.lap = 1;
    this.points = 0;
    this.misses = 0;
    this.distance = 0;
    this.result = undefined;
    this.failReason = '';
    this.prev = undefined;
  }

  abort(why = 'Abgebrochen') {
    if (!this.busy || !this.event) return;
    const e = this.event;
    this.state = 'idle';
    this.event = undefined;
    this.failReason = why;
    this.onFail?.(e, why);
  }

  /** The car jumped (reset, teleport): no gate checks across the jump. */
  skip() {
    this.prev = undefined;
  }

  /** Close the result and go back to free roam. */
  close() {
    if (this.state === 'done') { this.state = 'idle'; this.event = undefined; }
  }

  /** Points from style moves while a drift or near-miss zone runs. */
  style(e: StyleEvent) {
    if (this.state !== 'running' || !this.event) return;
    if (this.event.type === 'drift' && e.kind === 'drift') this.points += e.points;
    if (this.event.type === 'nearmiss' && e.kind === 'nearMiss') this.points += 1;
    // Jumps end on landing with the distance flown.
    if (this.event.type === 'jump' && e.kind === 'air') this.finish(e.value ?? 0);
  }

  update(dt: number, car: CarSample) {
    const e = this.event;
    if (!e) return;
    if (this.state === 'countdown') {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const now = Math.ceil(this.countdown);
      if (this.countdown <= 0) {
        this.state = 'running';
        this.onGo?.();
      } else if (now !== before) this.onCountdown?.(now);
      this.prev = car;
      return;
    }
    if (this.state !== 'running') return;
    this.time += dt;
    const p = this.prev ?? car;
    this.prev = car;
    this.distance += Math.hypot(car.x - p.x, car.z - p.z);
    if (e.limit && this.time > e.limit) { this.fail('Zeit abgelaufen'); return; }
    // Zones: stay on the road they cover.
    if (e.path && !RACE_TYPES.has(e.type) && distanceToPath(e.path, car.x, car.z) > 35) { this.fail('Zone verlassen'); return; }
    // Slalom: every cone pair has to be passed between the cones.
    const cones = e.extra?.cones;
    if (cones) {
      for (let i = this.points; i < cones.length; i++) {
        const g = cones[i];
        const a = (p.x - g.x) * g.dx + (p.z - g.z) * g.dz;
        const b = (car.x - g.x) * g.dx + (car.z - g.z) * g.dz;
        if (a < 0 && b >= 0) {
          if (!crossed(g, p.x, p.z, car.x, car.z)) this.misses++;
          this.points = i + 1;
        }
      }
    }
    const g = e.gates[this.next];
    if (!g) return;
    if (crossed(g, p.x, p.z, car.x, car.z, 3)) {
      this.lastGate = g;
      const last = this.next === e.gates.length - 1;
      this.onGate?.(this.next, this.lap);
      if (!last) { this.next++; return; }
      if (e.laps && this.lap < e.laps) {
        this.lap++;
        this.next = 0;
        this.onLap?.(this.lap);
        return;
      }
      this.finish(this.value());
    }
  }

  /** The result as it stands (zone average speed, points, time with penalties). */
  value() {
    const e = this.event!;
    if (e.type === 'speedzone') return this.time > 0 ? (this.distance / this.time) * 3.6 : 0;
    if (e.type === 'drift' || e.type === 'nearmiss') return this.points;
    if (e.type === 'slalom') return this.time + this.misses * 2;
    return this.time;
  }

  private fail(why: string) {
    const e = this.event!;
    this.state = 'idle';
    this.event = undefined;
    this.failReason = why;
    this.onFail?.(e, why);
  }

  /** Ends the run with a value; place for races with rivals. */
  finish(value: number, place?: number) {
    const e = this.event!;
    let medal = medalFor(e, value);
    // Losing a race against rivals caps the medal at bronze.
    if (place !== undefined && place > 1) medal = Math.min(medal, 1) as typeof medal;
    const prev = this.best(e.id);
    const best = prev === undefined || (e.higher ? value > prev : value < prev);
    const pay = rewardFor(e, medal);
    this.result = { event: e, value, medal, best, xp: pay.xp, credits: pay.credits, place };
    this.state = 'done';
    this.onFinish?.(this.result);
  }
}

/** Distance from (x, z) to a polyline of x, z pairs. */
export function distanceToPath(path: number[], x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i + 3 < path.length; i += 2) {
    const ax = path[i], az = path[i + 1], dx = path[i + 2] - ax, dz = path[i + 3] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}
