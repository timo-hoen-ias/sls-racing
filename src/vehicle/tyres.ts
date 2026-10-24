// Tyre model: lateral grip from the slip angle (rises to a peak, then falls towards sliding grip),
// longitudinal force from drive and brakes, both sharing one friction ellipse. Load sensitivity
// makes a heavily loaded tyre grip less per kilo, so weight transfer costs total grip.
// Pure functions (no Rapier) so they can be tested and plotted from the debug console.

export interface TyreSpec {
  /** Friction coefficient at the reference load. */
  mu: number;
  /** Slip angle of peak lateral force (rad). */
  peakSlip: number;
  /** Share of peak grip left when fully sliding. */
  slide: number;
  /** How fast grip drops past the peak. */
  falloff: number;
  /** Grip lost per unit of load above the reference load. */
  loadSens: number;
  /** Below this speed (m/s) the slip angle is taken against this speed (no division by ~0). */
  minSpeed: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clampMag = (v: number, max: number) => clamp(v, -max, max);

/** Lateral force as a share of the available grip (0..1) at a slip angle magnitude (rad). */
export function lateralCurve(alpha: number, s: TyreSpec) {
  const x = Math.abs(alpha) / s.peakSlip;
  if (x < 1) return x * (2 - x);
  return s.slide + (1 - s.slide) * Math.exp(-(x - 1) * s.falloff);
}

/** Friction coefficient at a load, falling slowly as the load rises above the reference load. */
export function loadedMu(s: TyreSpec, load: number, refLoad: number) {
  return s.mu * clamp(1 - s.loadSens * (load / refLoad - 1), 0.6, 1.25);
}

export interface TyreInput {
  /** Contact patch velocity along the wheel's rolling and lateral axes (m/s). */
  vx: number;
  vy: number;
  /** Vertical load (N). */
  load: number;
  /** Grip for driving/braking and for cornering, already multiplied by load and surface (N). */
  capX: number;
  capY: number;
  /** Drive force asked of this wheel (N, signed along vx). */
  drive: number;
  /** Brake force asked of this wheel (N, ≥ 0). */
  brake: number;
  /** Anti-lock: the brake force never exceeds the grip. */
  abs: boolean;
  /** Mass this wheel may stop within one step without overshooting (kg). */
  mass: number;
  dt: number;
}

export interface TyreOutput {
  /** Force along the rolling and the lateral axis (N). */
  fx: number;
  fy: number;
  /** Slip angle (rad), wheelspin and lock 0..1, and the share of the friction ellipse in use. */
  alpha: number;
  spin: number;
  lock: number;
  usage: number;
}

export function tyreForce(i: TyreInput, s: TyreSpec, out: TyreOutput): TyreOutput {
  out.fx = 0; out.fy = 0; out.alpha = 0; out.spin = 0; out.lock = 0; out.usage = 0;
  if (i.load <= 0 || i.capX <= 0 || i.capY <= 0) return out;
  // Never apply more than what stops the patch this step: keeps low speeds and standstill stable.
  const stopX = (i.mass * Math.abs(i.vx)) / i.dt;
  const stopY = (i.mass * Math.abs(i.vy)) / i.dt;
  const alpha = Math.atan2(i.vy, Math.max(Math.abs(i.vx), s.minSpeed));
  out.alpha = alpha;

  // A locked wheel slides: the friction opposes the whole sliding velocity.
  const brake = i.abs ? Math.min(i.brake, i.capX * 0.97) : i.brake;
  const speed = Math.hypot(i.vx, i.vy);
  if (brake > i.capX && Math.abs(i.vx) > 1) {
    const f = i.capX * s.slide;
    out.fx = clampMag((-i.vx / speed) * f, stopX);
    out.fy = clampMag((-i.vy / speed) * (i.capY / i.capX) * f, stopY);
    out.lock = 1;
    out.usage = 1;
    return out;
  }

  let fy = -Math.sign(i.vy) * lateralCurve(alpha, s) * i.capY;
  fy = clampMag(fy, stopY);
  const fb = -Math.sign(i.vx) * Math.min(brake, stopX);
  let fx = i.drive + fb;
  // Friction ellipse: past it the tyre slides and both forces drop towards sliding grip.
  const sx = fx / i.capX;
  const sy = fy / i.capY;
  const u = Math.hypot(sx, sy);
  out.usage = Math.min(u, 2);
  if (u > 1) {
    const k = lerp(1, s.slide, clamp((u - 1) / 0.5, 0, 1)) / u;
    fx *= k;
    fy *= k;
    // Driven past the grip: the wheel spins up.
    if (i.drive !== 0 && Math.sign(i.drive) === Math.sign(sx)) out.spin = clamp((Math.abs(sx) - 0.95) / 0.8, 0, 1);
  }
  out.fx = fx;
  out.fy = fy;
  return out;
}

/**
 * Splits an axle's drive force between its two wheels through a differential with a torque bias ratio:
 * 1 is an open diff (both wheels get what the weaker one can take), larger values lock more.
 * The weaker wheel still asks for its full half so it can spin; the stronger one gets at most bias × the weaker grip.
 */
export function splitAxle(force: number, capA: number, capB: number, bias: number): [number, number] {
  const half = force / 2;
  const lo = Math.min(capA, capB);
  if (Math.abs(half) <= lo) return [half, half];
  const strong = Math.sign(half) * Math.min(Math.abs(half), Math.max(lo, 0) * bias);
  return capA <= capB ? [half, strong] : [strong, half];
}
