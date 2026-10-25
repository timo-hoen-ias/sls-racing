import { describe, expect, it } from 'vitest';
import { Progress, xpForLevel } from '../src/game/progress.ts';
import { SaveGame } from '../src/game/save.ts';
import { applyParts, applySpec, carStats, partFor, ratingOf, recommendedLs, Workshop } from '../src/game/workshop.ts';
import type { GameEvent } from '../src/game/events/types.ts';
import { applyCar, findCar } from '../src/vehicle/cars.ts';
import { CAR, ENGINE } from '../src/vehicle/tuning.ts';

const event = (level: number): GameEvent => ({
  id: 'e', type: 'sprint', name: 'Test', where: '', start: { x: 0, y: 0, z: 0, dx: 0, dz: 1, w: 5 }, gates: [], medals: [40, 30, 20, 15], higher: false, unit: 's', level,
});

function shop() {
  const save = new SaveGame();
  const progress = new Progress(save);
  let current = 'sportscar', retunes = 0;
  const w = new Workshop({ save, progress, current: () => current, select: async (id) => { current = id; }, retune: () => retunes++, toast: () => {} });
  return { save, progress, w, retunes: () => retunes };
}

describe('parts and performance level (P3)', () => {
  it('raises the car figures and the rating with every part, and puts the car back without them', () => {
    const spec = findCar('sportscar')!;
    applyCar(spec);
    const torque = ENGINE.torque[3][1], mu = CAR.tyre.mu, brake = CAR.brake.force;
    const before = carStats();
    applyParts({ motor: 5, reifen: 5, bremsen: 5, fahrwerk: 2 });
    expect(ENGINE.torque[3][1]).toBeCloseTo(torque * 1.3);
    expect(CAR.tyre.mu).toBeGreaterThan(mu);
    expect(CAR.brake.force).toBeGreaterThan(brake);
    const after = carStats();
    expect(after.accel).toBeGreaterThan(before.accel);
    expect(after.handling).toBeGreaterThan(before.handling);
    applyCar(spec);
    expect(ENGINE.torque[3][1]).toBe(torque);
    expect(ratingOf('sportscar', { motor: 2 })).toBeGreaterThan(ratingOf('sportscar'));
    expect(ratingOf('gt')).toBeGreaterThan(ratingOf('hothatch'));
    expect(recommendedLs(event(6))).toBeGreaterThan(recommendedLs(event(1)));
  });

  it('wins better parts for better medals and harder events', () => {
    expect(partFor(event(4), 0, 0)).toBeUndefined();
    expect(partFor(event(4), 1, 0.9)).toBeUndefined();
    const bronze = partFor(event(2), 1, 0)!, gold = partFor(event(2), 3, 0.99)!, plat = partFor(event(8), 4, 0.5)!;
    expect(gold.level).toBeGreaterThan(bronze.level);
    expect(plat.level).toBe(5);
  });

  it('fits won parts, swaps them with the spares and fits the best on request', () => {
    const { w, retunes } = shop();
    expect(w.reward(event(4), 3)).toContain('eingebaut');
    const fitted = Object.values(w.parts()).filter((l) => (l ?? 0) > 0).length;
    expect(fitted).toBe(1);
    expect(retunes()).toBe(1);
    w.autofit = false;
    w.give('motor', 2);
    w.give('motor', 4);
    expect(w.fitBest()).toBeGreaterThanOrEqual(1);
    expect(w.parts().motor).toBe(4);
    w.fit('motor', 2);
    expect(w.spare('motor', 4)).toBe(1);
    expect(() => w.fit('reifen', 5)).toThrow();
    w.fit('motor', 0);
    expect(w.spare('motor', 2)).toBe(1);
  });
});

describe('dealer (P4)', () => {
  it('sells cars for credits from their level, then they can be driven', async () => {
    const { w, save, progress } = shop();
    save.data.credits = 100000;
    expect(w.buy('gt')).toContain('ab Stufe');
    save.data.xp = xpForLevel(6);
    expect(w.buy('gt')).toContain('gekauft');
    expect(progress.credits).toBe(55000);
    expect(w.buy('gt')).toContain('schon');
    await w.use('gt');
    expect(save.data.car).toBe('gt');
    await expect(w.use('hothatch')).rejects.toThrow();
  });
});

describe('builds per car (A2)', () => {
  it('drift and off-road change the setup, and applyCar puts the street car back', () => {
    const spec = findCar('sportscar')!;
    applyCar(spec);
    const rear = CAR.tyre.rearMu, travel = CAR.wheel.travel, rest = CAR.wheel.rest;
    applySpec('drift');
    expect(CAR.tyre.rearMu).toBeLessThan(rear);
    applyCar(spec);
    applySpec('offroad');
    expect(CAR.wheel.travel).toBeGreaterThan(travel);
    expect(CAR.wheel.rest).toBeGreaterThan(rest);
    applyCar(spec);
    expect(CAR.wheel.travel).toBe(travel);
    expect(CAR.tyre.rearMu).toBe(rear);
  });

  it('a build is bought once per car, keeps its own parts, and the street parts stay under the old key', () => {
    const { save, progress, w, retunes } = shop();
    w.give('motor', 3);
    w.fit('motor', 3);
    expect(save.data.parts.sportscar.motor).toBe(3);
    expect(w.buySpec('drift')).toMatch(/ab Stufe/);
    save.data.xp = xpForLevel(3);
    save.data.credits += 20000;
    const credits = progress.credits;
    expect(w.buySpec('drift')).toMatch(/gebaut/);
    expect(progress.credits).toBe(credits - 8000);
    expect(w.spec()).toBe('drift');
    expect(w.parts().motor ?? 0).toBe(0);
    w.useSpec('street');
    expect(w.parts().motor).toBe(3);
    expect(w.buySpec('drift')).toMatch(/Drift-Version/);
    expect(progress.credits).toBe(credits - 8000);
    expect(() => w.useSpec('offroad')).toThrow();
    expect(retunes()).toBeGreaterThan(2);
  });
});

describe('visual tuning (P5)', () => {
  it('keeps a look per car in the save and falls back on broken values', async () => {
    const { lookFrom } = await import('../src/vehicle/looks.ts');
    const { save, w } = shop();
    let calls = 0;
    w.onLook = () => calls++;
    w.setLook({ color: '#1d4fd8', finish: 'matte', wing: false, glow: '#00e5ff' });
    expect(calls).toBe(1);
    expect(w.look()).toMatchObject({ color: '#1d4fd8', finish: 'matte', wing: false, glow: '#00e5ff' });
    expect(save.data.looks.sportscar.wing).toBe(0);
    expect(w.look('gt').color).toBe('#c0141c');
    expect(lookFrom({ color: 'rot', finish: 'gold', glow: 'x' })).toMatchObject({ color: '#c0141c', finish: 'metallic', glow: '' });
  });
});
