import { describe, expect, it } from 'vitest';
import { PoseFlag } from '../src/net/protocol.ts';
import { RemoteRev } from '../src/net/remoteSound.ts';
import { carSound, findCar } from '../src/vehicle/cars.ts';
import { ENGINE_SOUND } from '../src/vehicle/tuning.ts';

describe('carSound', () => {
  it("gives another car's sound without touching the player's", () => {
    const before = JSON.stringify(ENGINE_SOUND);
    const gt = carSound(findCar('gt')!);
    expect(gt.profile.voice.layout).toBe('v8');
    expect(gt.profile.voice.idleRpm).toBe(gt.engine.idleRpm);
    expect(carSound(findCar('hothatch')!).profile.turbo).toBeDefined();
    expect(JSON.stringify(ENGINE_SOUND)).toBe(before);
  });
});

describe('RemoteRev', () => {
  const e = carSound(findCar('sportscar')!).engine;

  it('climbs through the gears when accelerating, the revs dropping at each upshift', () => {
    const r = new RemoteRev(e);
    const dt = 1 / 60;
    let v = 0, ups = 0, maxRpm = 0, drop = false;
    for (let i = 0; i < 60 * 14; i++) {
      v += 6 * dt;
      const before = r.rpm;
      const s = r.update(v, dt, 0);
      if (s === 'up') ups++;
      for (let k = 0; k < 6; k++) r.update(v, 0.001, 0);
      if (s === 'up' && r.rpm < before) drop = true;
      maxRpm = Math.max(maxRpm, r.rpm);
      expect(r.rpm).toBeGreaterThanOrEqual(e.idleRpm - 1);
    }
    expect(ups).toBeGreaterThanOrEqual(4);
    expect(drop).toBe(true);
    expect(maxRpm).toBeLessThanOrEqual(e.maxRpm);
    expect(r.load).toBeGreaterThan(0.8);
  });

  it('is off the throttle when braking and on full load with nitro', () => {
    const r = new RemoteRev(e);
    for (let i = 0; i < 60; i++) r.update(30, 1 / 60, PoseFlag.brake);
    expect(r.load).toBeLessThan(0.05);
    for (let i = 0; i < 60; i++) r.update(30, 1 / 60, PoseFlag.boost);
    expect(r.load).toBeGreaterThan(0.95);
  });

  it('idles when standing and uses reverse when the pose says so', () => {
    const r = new RemoteRev(e);
    for (let i = 0; i < 60; i++) r.update(0, 1 / 60, 0);
    expect(r.rpm).toBeCloseTo(e.idleRpm, -1);
    r.update(-2, 1 / 60, PoseFlag.reverse);
    expect(r.gear).toBe(-1);
  });
});
