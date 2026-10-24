import { describe, expect, it } from 'vitest';
import { CAR } from '../src/vehicle/tuning.ts';
import { lateralCurve, loadedMu, splitAxle, tyreForce, type TyreOutput } from '../src/vehicle/tyres.ts';

const spec = CAR.tyre;
const out = (): TyreOutput => ({ fx: 0, fy: 0, alpha: 0, spin: 0, lock: 0, usage: 0 });
const base = { vx: 30, vy: 0, load: 3500, capX: 4000, capY: 4000, drive: 0, brake: 0, abs: true, mass: 357, dt: 1 / 120 };

describe('tyre model', () => {
  it('peaks at the peak slip angle and falls towards sliding grip', () => {
    expect(lateralCurve(0, spec)).toBe(0);
    expect(lateralCurve(spec.peakSlip, spec)).toBeCloseTo(1, 5);
    expect(lateralCurve(spec.peakSlip / 2, spec)).toBeGreaterThan(0.7);
    expect(lateralCurve(1, spec)).toBeLessThan(0.95);
    expect(lateralCurve(1, spec)).toBeGreaterThanOrEqual(spec.slide);
  });

  it('loses grip per kilo under load', () => {
    expect(loadedMu(spec, 7000, 3500)).toBeLessThan(loadedMu(spec, 3500, 3500));
    expect(loadedMu(spec, 7000, 3500) * 7000).toBeGreaterThan(loadedMu(spec, 3500, 3500) * 3500);
  });

  it('pushes against the sideways slide', () => {
    const o = tyreForce({ ...base, vy: 2 }, spec, out());
    expect(o.fy).toBeLessThan(0);
    expect(o.alpha).toBeGreaterThan(0);
  });

  it('shares one friction ellipse: wheelspin costs cornering grip', () => {
    const corner = tyreForce({ ...base, vy: 3 }, spec, out()).fy;
    const spinning = tyreForce({ ...base, vy: 3, drive: 8000 }, spec, out());
    expect(Math.abs(spinning.fy)).toBeLessThan(Math.abs(corner) * 0.6);
    expect(spinning.spin).toBeGreaterThan(0.5);
  });

  it('ABS keeps the wheel rolling, without ABS it locks and slides', () => {
    const abs = tyreForce({ ...base, vy: 1, brake: 9000 }, spec, out());
    expect(abs.lock).toBe(0);
    expect(abs.fx).toBeLessThan(-3000);
    const locked = tyreForce({ ...base, vy: 1, brake: 9000, abs: false }, spec, out());
    expect(locked.lock).toBe(1);
    // A locked wheel cannot steer: almost all its force goes against the slide.
    expect(Math.abs(locked.fy)).toBeLessThan(Math.abs(abs.fy));
  });

  it('never overshoots at a standstill', () => {
    const o = tyreForce({ ...base, vx: 0.01, vy: 0.02, brake: 5000 }, spec, out());
    expect(Math.abs(o.fx) * base.dt).toBeLessThanOrEqual(base.mass * 0.01 + 1e-9);
    expect(Math.abs(o.fy) * base.dt).toBeLessThanOrEqual(base.mass * 0.02 + 1e-9);
  });

  it('splits drive through open, limited-slip and locked diffs', () => {
    expect(splitAxle(4000, 3000, 3000, 1)).toEqual([2000, 2000]);
    // Weak left wheel (1000 N of grip): an open diff gives the right wheel no more than the left can take.
    expect(splitAxle(6000, 1000, 4000, 1)[1]).toBe(1000);
    expect(splitAxle(6000, 1000, 4000, 2.5)[1]).toBe(2500);
    expect(splitAxle(6000, 1000, 4000, 100)[1]).toBe(3000);
  });
});
