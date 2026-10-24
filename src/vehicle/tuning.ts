import type { EngineSpec } from './drivetrain.ts';

// Arcade tuning for the first test car. All units SI (m, kg, N, m/s).
// Drivetrain: a 3.0 l turbo straight six with a six-speed automatic, roughly a sporty saloon.
export const ENGINE: EngineSpec = {
  idleRpm: 850,
  shiftRpm: 6800,
  maxRpm: 7200,
  // Turbo plateau from 1 800 to 5 000/min, ~250 kW at 6 000/min.
  torque: [[800, 230], [1500, 360], [1800, 450], [5000, 450], [6000, 400], [6800, 350], [7200, 300]],
  gears: [4.11, 2.32, 1.54, 1.18, 1.0, 0.85],
  reverse: 3.6,
  final: 3.15,
  efficiency: 0.88,
  wheelRadius: 0.34,
  stallRpm: 2600,
  shiftTime: 0.16,
  engineBrake: { base: 18, perRpm: 0.009 },
};

export const CAR = {
  mass: 1350,
  halfExtents: { x: 0.92, y: 0.42, z: 2.2 },
  /** Chassis collider centre above the body origin. */
  colliderY: 0.38,
  wheel: { radius: ENGINE.wheelRadius, x: 0.8, front: 1.35, rear: -1.3, y: 0.32, rest: 0.32, travel: 0.25, width: 0.24 },
  suspension: { stiffness: 38, compression: 4.2, relaxation: 3.4, maxForce: 60000 },
  grip: { front: 2.6, rear: 2.5, side: 1.0, driftRear: 1.25 },
  /** Longitudinal grip in g: drive force beyond this spins the wheels (arcade traction control caps it). */
  traction: 0.95,
  /** Aerodynamic drag (N per (m/s)²) and rolling resistance coefficient. */
  aero: { drag: 0.52, rolling: 0.014 },
  reverseSpeed: 9,
  nitro: { torque: 1.45, traction: 1.25, push: 2000, drain: 0.28, refill: 0.05, driftRefill: 0.12 },
  brake: { force: 140, handbrake: 35 },
  steer: { lowSpeed: 0.62, highSpeed: 0.14, fadeSpeed: 45, rate: 3.2 },
  downforce: 3.2, // N per (m/s)²
  airControl: 2200,
} as const;
