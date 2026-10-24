import type { EngineSoundProfile } from '../audio/engineSound.ts';
import type { EngineSpec } from './drivetrain.ts';

// The player car: a generic rear-biased sports coupé (no real make or model).
// 4.0 l naturally aspirated flat six revving to 9 000/min with a seven-speed dual-clutch box.
// All units SI (m, kg, N, m/s); handling stays arcade with assists and nitro.
export const ENGINE: EngineSpec = {
  idleRpm: 950,
  shiftRpm: 8800,
  maxRpm: 9000,
  // Flat curve with a top-end peak, ~370 kW at 8 400/min.
  torque: [[900, 290], [2500, 380], [4500, 430], [6250, 470], [7500, 460], [8500, 420], [9000, 390]],
  gears: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84],
  reverse: 3.4,
  final: 3.6,
  efficiency: 0.9,
  wheelRadius: 0.35,
  // Launch control holds the revs here against a stationary car.
  stallRpm: 3800,
  shiftTime: 0.07,
  // Friction and pumping losses off throttle: ~70 Nm at 3 000/min, ~150 Nm near the limiter.
  engineBrake: { base: 30, perRpm: 0.0135 },
};

export const ENGINE_SOUND: EngineSoundProfile = {
  voice: {
    cylinders: 6,
    idleRpm: ENGINE.idleRpm,
    maxRpm: ENGINE.maxRpm,
    lumpy: 0.08,
    irregular: 0.1,
    pulse: { noise: 0.3, tone: 0.72, toneHz: 340, decay: 0.78, color: 0.9 },
  },
  resonances: [
    { freq: 170, q: 2, gain: 5 }, // exhaust body
    { freq: 1100, q: 2.5, gain: 5 }, // flat-six "howl"
    { freq: 3400, q: 3, gain: 5 }, // intake rasp at the top end
  ],
  drive: 0.62,
  lpIdle: 1300,
  lpFull: 8000,
  intake: 0.09,
  pops: 0.55,
  shiftPop: 0.6,
};

export const CAR = {
  mass: 1430,
  halfExtents: { x: 0.94, y: 0.38, z: 2.25 },
  /** Chassis collider centre above the body origin. */
  colliderY: 0.28,
  wheel: { radius: ENGINE.wheelRadius, x: 0.8, front: 1.27, rear: -1.2, y: 0.3, rest: 0.28, travel: 0.18, width: 0.3 },
  /**
   * Springs in N/m per kg of car (Rapier scales by the chassis mass): 50 ≈ 2.2 Hz ride.
   * Dampers likewise; bump softer than rebound like a road car (ζ ≈ 0.45 / 0.65).
   */
  suspension: { stiffness: 50, compression: 3.2, relaxation: 4.6, maxForce: 70000 },
  /** Anti-roll bars (N per m of left/right travel difference); stiffer front = stable understeer at the limit. */
  arb: { front: 30000, rear: 17000 },
  /**
   * Tyres: friction coefficient, slip angle of peak lateral grip (rad), grip left when fully sliding,
   * how fast grip falls past the peak, load sensitivity (heavily loaded tyres grip less per kg),
   * and how much of the tyre force acts at road level (roll and pitch; the rest acts at the centre of mass).
   */
  tyre: { mu: 1.55, peakSlip: 0.11, slide: 0.88, falloff: 1.4, loadSens: 0.08, rearMu: 1.12, roll: 0.45, pitch: 0.8, minSpeed: 3 },
  /** Limited-slip differentials as torque bias ratio (1 = open, 2–3 = LSD, ≥ 50 = locked). */
  diff: { front: 1.4, rear: 2.6 },
  /** Drive split to the front axle (the rest goes to the rear). */
  frontDrive: 0.3,
  /** Aerodynamic drag and downforce (N per (m/s)²), share of downforce on the front axle, rolling resistance coefficient. */
  aero: { drag: 0.48, downforce: 0.9, balance: 0.42, rolling: 0.013 },
  reverseSpeed: 9,
  nitro: { torque: 1.4, traction: 1.25, push: 2200, drain: 0.28, refill: 0.05, driftRefill: 0.12 },
  /** Brakes in N at the contact patches (all four wheels), front share, handbrake on the rear axle. */
  brake: { force: 17500, bias: 0.64, handbrake: 9000, hold: 2500 },
  /** Lock 0.6 rad when parking, ~0.16 at 100 km/h, ~0.08 at 200 km/h; drift keeps 0.3 with the handbrake. */
  steer: { lowSpeed: 0.6, highSpeed: 0.045, fadeSpeed: 14, rate: 3.8, rateSpeed: 35, drift: 0.3 },
  airControl: 2200,
} as const;

/** Driving aids, each 0 (off) .. 1 (full). Arcade turns all on, sim keeps only ABS. */
export interface Assists {
  /** Anti-lock brakes: the foot brake never locks a wheel. */
  abs: boolean;
  /** Traction control: 1 cuts drive at the grip limit, 0 lets the wheels spin freely. */
  tcs: number;
  /** Stability control: limits yaw rate and drift angle. */
  esp: number;
  /** Drift assist: extra yaw while steering, keeps speed in slides. */
  drift: number;
  /** Steering assist: keeps the front tyres at their peak slip angle instead of pushing them wide. */
  steer: number;
}

export const ASSIST_PRESETS: Record<'arcade' | 'sim', Assists> = {
  arcade: { abs: true, tcs: 1, esp: 1, drift: 1, steer: 1 },
  sim: { abs: true, tcs: 0, esp: 0, drift: 0, steer: 0 },
};
