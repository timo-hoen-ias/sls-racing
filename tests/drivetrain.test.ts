import { describe, expect, it } from 'vitest';
import { Drivetrain, type DrivetrainInput, torqueAt } from '../src/vehicle/drivetrain.ts';
import { ENGINE } from '../src/vehicle/tuning.ts';

const input = (p: Partial<DrivetrainInput>): DrivetrainInput => ({
  speed: 0, throttle: 0, brake: 0, reverse: false, airborne: false, freeRev: false, boost: 1, wheelspin: 0, dt: 1 / 60, ...p,
});

function run(d: Drivetrain, p: Partial<DrivetrainInput>, seconds: number) {
  const events: string[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    d.update(input(p));
    if (d.shifted) events.push(d.shifted);
  }
  return events;
}

describe('Drivetrain', () => {
  it('interpolates the torque curve', () => {
    expect(torqueAt(ENGINE, 3000)).toBe(450);
    expect(torqueAt(ENGINE, 6400)).toBeCloseTo(375, 0);
    expect(torqueAt(ENGINE, 9000)).toBe(300);
  });

  it('idles at standstill and revs to stall speed against the brakes', () => {
    const d = new Drivetrain(ENGINE);
    run(d, {}, 1);
    expect(d.rpm).toBeCloseTo(ENGINE.idleRpm, -1);
    run(d, { throttle: 1 }, 1);
    expect(d.rpm).toBeGreaterThan(ENGINE.stallRpm - 100);
    expect(d.rpm).toBeLessThan(ENGINE.stallRpm + 100);
  });

  it('holds a gear until the shift point at full throttle, then cuts drive briefly', () => {
    const d = new Drivetrain(ENGINE);
    const v1 = 17; // ~61 km/h: still first gear at full throttle
    run(d, { speed: v1, throttle: 1 }, 0.5);
    expect(d.gear).toBe(1);
    const ev = run(d, { speed: 20, throttle: 1 }, 0.02);
    expect(ev).toEqual(['up']);
    expect(d.gear).toBe(2);
    expect(d.cut).toBe(true);
    expect(d.force).toBeLessThan(2000);
  });

  it('changes up early when cruising and kicks down at full throttle', () => {
    const d = new Drivetrain(ENGINE);
    for (let v = 0; v < 14; v += 0.05) d.update(input({ speed: v, throttle: 0.25 }));
    expect(d.gear).toBeGreaterThanOrEqual(3);
    expect(d.rpm).toBeLessThan(2600);
    run(d, { speed: 14, throttle: 1 }, 1.5);
    expect(d.gear).toBeLessThanOrEqual(2);
  });

  it('changes down with a blip while braking', () => {
    const d = new Drivetrain(ENGINE);
    for (let v = 0; v < 40; v += 0.2) d.update(input({ speed: v, throttle: 1 }));
    const g = d.gear;
    const ev: string[] = [];
    for (let v = 40; v > 5; v -= 0.15) {
      d.update(input({ speed: v, brake: 1 }));
      if (d.shifted) ev.push(d.shifted);
      expect(d.shifted).not.toBe('up');
    }
    expect(ev.length).toBeGreaterThan(0);
    expect(d.gear).toBeLessThan(g);
  });

  it('brakes with the engine off throttle and drives backwards in reverse', () => {
    const d = new Drivetrain(ENGINE);
    run(d, { speed: 20 }, 0.5);
    expect(d.force).toBeLessThan(0);
    run(d, { speed: 0, reverse: true, throttle: 1 }, 0.5);
    expect(d.gear).toBe(-1);
    expect(d.force).toBeLessThan(-1000);
  });

  it('revs freely in the air and bounces off the limiter', () => {
    const d = new Drivetrain(ENGINE);
    run(d, { speed: 20, throttle: 1, airborne: true }, 1.5);
    expect(d.force).toBe(0);
    expect(d.rpm).toBeGreaterThan(ENGINE.maxRpm * 0.95);
  });
});
