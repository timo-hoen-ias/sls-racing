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
    const [[r0, n0], [r1, n1]] = ENGINE.torque;
    expect(torqueAt(ENGINE, r0)).toBe(n0);
    expect(torqueAt(ENGINE, (r0 + r1) / 2)).toBeCloseTo((n0 + n1) / 2, 6);
    expect(torqueAt(ENGINE, 99999)).toBe(ENGINE.torque[ENGINE.torque.length - 1][1]);
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
    const vShift = (ENGINE.shiftRpm / d.gearRpm(1, 1)); // speed at which first gear hits the shift point
    run(d, { speed: vShift * 0.9, throttle: 1 }, 0.5);
    expect(d.gear).toBe(1);
    const ev = run(d, { speed: vShift * 1.01, throttle: 1 }, 0.02);
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

describe('Drivetrain: engine braking and manual mode', () => {
  it('holds the gear off throttle and changes down as the revs fall', () => {
    const d = new Drivetrain(ENGINE);
    d.gear = 3;
    const v = 6000 / d.gearRpm(1, 1) / (ENGINE.gears[2] / ENGINE.gears[0]); // 6 000/min in third
    for (let i = 0; i < 60; i++) d.update(input({ speed: v }));
    expect(d.gear).toBe(3);
    expect(d.force).toBeLessThan(-1000);
    for (let s = v; s > 3; s -= 0.05) d.update(input({ speed: s }));
    expect(d.gear).toBeLessThanOrEqual(2);
  });

  it('stops engine braking when the clutch opens near idle', () => {
    const d = new Drivetrain(ENGINE);
    for (let i = 0; i < 30; i++) d.update(input({ speed: 2 }));
    expect(d.gear).toBe(1);
    expect(d.force).toBe(0);
  });

  it('shifts only on request in manual mode and refuses an over-revving downshift', () => {
    const d = new Drivetrain(ENGINE);
    d.manual = true;
    run(d, { speed: 30, throttle: 1 }, 1);
    expect(d.gear).toBe(1); // no automatic upshift, sits on the limiter
    expect(d.limiter).toBe(true);
    d.shift(1);
    d.update(input({ speed: 30, throttle: 1 }));
    expect(d.gear).toBe(2);
    expect(d.shifted).toBe('up');
    d.shift(-1);
    d.update(input({ speed: 30, throttle: 1 }));
    expect(d.gear).toBe(2); // first gear would exceed the rev limit at this speed
    d.shift(-1);
    d.update(input({ speed: 10, throttle: 1 }));
    expect(d.gear).toBe(1);
  });
});
