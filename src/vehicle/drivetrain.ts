// Engine and automatic gearbox: torque curve, converter slip at launch, shift cut,
// downshift blips, rev limiter and free revving in the air. Pure model (no Rapier, no audio)
// so the physics, the engine sound and the rev counter all read the same state.

export interface EngineSpec {
  idleRpm: number;
  /** Full-throttle upshift point. */
  shiftRpm: number;
  /** Rev limiter. */
  maxRpm: number;
  /** Torque curve as [rpm, Nm] pairs, ascending. */
  torque: readonly (readonly [number, number])[];
  /** Forward gear ratios, index 0 = first gear. */
  gears: readonly number[];
  reverse: number;
  final: number;
  efficiency: number;
  wheelRadius: number;
  /** Torque converter stall speed: the engine revs this high against a stationary car. */
  stallRpm: number;
  /** Time without drive while changing up (s). */
  shiftTime: number;
  /** Engine braking torque at idle and per rpm (Nm). */
  engineBrake: { base: number; perRpm: number };
}

export interface DrivetrainInput {
  /** Signed speed along the car's forward axis (m/s). */
  speed: number;
  /** 0..1 pedal in the current direction of travel (brake pedal when reversing). */
  throttle: number;
  /** 0..1 brake pedal: no upshifts, earlier downshifts with blips. */
  brake: number;
  reverse: boolean;
  airborne: boolean;
  /** Clutch open (handbrake turn): the engine revs freely. */
  freeRev: boolean;
  /** Torque multiplier (nitro). */
  boost: number;
  /** Wheelspin 0..1 measured by the physics last step: lets the revs flare. */
  wheelspin: number;
  dt: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function torqueAt(spec: EngineSpec, rpm: number): number {
  const t = spec.torque;
  if (rpm <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (rpm <= t[i][0]) {
      const [r0, n0] = t[i - 1];
      const [r1, n1] = t[i];
      return lerp(n0, n1, (rpm - r0) / (r1 - r0));
    }
  }
  return t[t.length - 1][1];
}

export class Drivetrain {
  /** -1 = reverse, 1.. = forward gears. */
  gear = 1;
  rpm: number;
  /** Engine load 0..1 as the exhaust hears it (0 during a shift cut). */
  load = 0;
  /** Drive force at the contact patches (N), negative = backwards or engine braking. */
  force = 0;
  /** True while the upshift cut is running. */
  cut = false;
  /** True while a downshift blip is running. */
  blip = false;
  /** True when the rev limiter is bouncing. */
  limiter = false;
  /** Set for exactly one update after a gear change. */
  shifted: 'up' | 'down' | null = null;
  private cutTimer = 0;
  private blipTimer = 0;
  private lock = 0;
  private limPhase = 0;

  readonly spec: EngineSpec;

  constructor(spec: EngineSpec) {
    this.spec = spec;
    this.rpm = spec.idleRpm;
  }

  /** Engine speed the wheels impose in a gear (no slip). */
  gearRpm(gear: number, speed: number): number {
    const s = this.spec;
    const ratio = gear < 0 ? s.reverse : s.gears[gear - 1];
    return (Math.abs(speed) / (2 * Math.PI * s.wheelRadius)) * 60 * ratio * s.final;
  }

  /** Upshift point: light throttle changes up early, like a real automatic. */
  upRpm(throttle: number) {
    return lerp(2000, this.spec.shiftRpm, clamp(throttle, 0, 1) ** 1.6);
  }

  downRpm(throttle: number) {
    return lerp(1100, 3000, clamp(throttle, 0, 1) ** 1.3);
  }

  update(i: DrivetrainInput) {
    const s = this.spec;
    const dt = clamp(i.dt, 0, 0.1);
    const thr = clamp(i.throttle, 0, 1);
    this.shifted = null;
    this.cutTimer = Math.max(0, this.cutTimer - dt);
    this.blipTimer = Math.max(0, this.blipTimer - dt);
    this.lock = Math.max(0, this.lock - dt);
    const top = s.gears.length;

    // Gear selection.
    if (i.reverse) {
      if (this.gear !== -1) { this.gear = -1; this.shifted = 'down'; }
    } else {
      if (this.gear < 1) { this.gear = 1; this.shifted = 'up'; }
      if (!i.airborne && !i.freeRev && this.lock <= 0) {
        const cur = this.gearRpm(this.gear, i.speed);
        const up = i.boost > 1 ? s.shiftRpm : i.brake > 0.1 ? Infinity : this.upRpm(thr);
        const down = Math.max(this.downRpm(thr), i.brake > 0.1 ? 2600 : 0);
        if (this.gear < top && cur >= up && this.gearRpm(this.gear + 1, i.speed) > down + 300) {
          this.gear++;
          this.cutTimer = s.shiftTime;
          this.lock = s.shiftTime + 0.35;
          this.shifted = 'up';
        } else if (
          this.gear > 1 &&
          (cur < down || (thr > 0.95 && this.gearRpm(this.gear - 1, i.speed) < s.shiftRpm * 0.82 && cur < 4200)) &&
          this.gearRpm(this.gear - 1, i.speed) < s.shiftRpm * 0.95
        ) {
          this.gear--;
          this.blipTimer = 0.12;
          this.lock = 0.45;
          this.shifted = 'down';
        }
      }
    }
    this.cut = this.cutTimer > 0;
    this.blip = this.blipTimer > 0;

    // Engine speed.
    let target: number;
    let rate: number;
    if (i.airborne || i.freeRev) {
      target = thr > 0.1 ? s.maxRpm * 0.98 : s.idleRpm;
      rate = thr > 0.1 ? 9 : 3;
    } else {
      const locked = this.gearRpm(this.gear, i.speed);
      // Converter slip: at low speed the engine runs up to stall speed with the throttle.
      const conv = s.idleRpm + thr * (s.stallRpm - s.idleRpm);
      target = Math.max(locked, conv) + i.wheelspin * 2200 * thr;
      if (this.blip) target = Math.max(target, locked + 600);
      rate = target > this.rpm ? 14 : 18;
    }
    this.rpm += (target - this.rpm) * Math.min(1, dt * rate);
    this.rpm = clamp(this.rpm, s.idleRpm * 0.9, s.maxRpm);

    // Limiter: bounces the fuel on and off.
    this.limPhase = (this.limPhase + dt * 14) % 1;
    this.limiter = this.rpm >= s.maxRpm - 40 && thr > 0.1;
    const fuel = this.limiter ? (this.limPhase < 0.5 ? 0 : 1) : 1;

    // Drive force.
    const ratio = this.gear < 0 ? s.reverse : s.gears[this.gear - 1];
    const toForce = (ratio * s.final * s.efficiency) / s.wheelRadius;
    const cutMul = this.cut ? 0.15 : 1;
    const engineTorque = torqueAt(s, this.rpm) * thr * fuel * cutMul * i.boost;
    this.load = this.cut ? 0.05 : this.blip ? 0.8 : thr * fuel;
    if (i.airborne || i.freeRev) {
      this.force = 0;
      return;
    }
    let f = engineTorque * toForce;
    // Engine braking off throttle (only while rolling in the gear's direction).
    if (thr < 0.05 && Math.abs(i.speed) > 1.5) {
      f -= (s.engineBrake.base + s.engineBrake.perRpm * this.rpm) * toForce;
    }
    this.force = this.gear < 0 ? -f : f;
  }
}
