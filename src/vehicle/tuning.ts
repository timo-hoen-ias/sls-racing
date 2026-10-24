// Arcade tuning for the first test car. All units SI (m, kg, N, m/s).
export const CAR = {
  mass: 1350,
  halfExtents: { x: 0.92, y: 0.42, z: 2.2 },
  /** Chassis collider centre above the body origin. */
  colliderY: 0.38,
  wheel: { radius: 0.34, x: 0.8, front: 1.35, rear: -1.3, y: 0.32, rest: 0.32, travel: 0.25 },
  suspension: { stiffness: 38, compression: 4.2, relaxation: 3.4, maxForce: 60000 },
  grip: { front: 2.6, rear: 2.5, side: 1.0, driftRear: 1.25 },
  engine: { force: 9200, topSpeed: 68, reverseSpeed: 14 }, // 68 m/s ≈ 245 km/h
  nitro: { force: 1.75, topSpeed: 1.32, drain: 0.28, refill: 0.05, driftRefill: 0.12 },
  brake: { force: 140, handbrake: 35 },
  steer: { lowSpeed: 0.62, highSpeed: 0.14, fadeSpeed: 45, rate: 3.2 },
  downforce: 3.2, // N per (m/s)²
  airControl: 2200,
  gears: [0, 3.4, 2.2, 1.6, 1.25, 1.0, 0.82],
  rpm: { idle: 900, max: 7200 },
} as const;
