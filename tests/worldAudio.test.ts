import { describe, expect, it } from 'vitest';
import { ambienceLevels } from '../src/audio/ambience.ts';
import { reverbMix } from '../src/audio/envReverb.ts';

describe('reverbMix', () => {
  it('is mostly dry and open on a free road', () => {
    const m = reverbMix({ left: Infinity, right: Infinity, up: Infinity });
    expect(m.open).toBe(1);
    expect(m.street + m.tunnel).toBe(0);
    expect(m.slapGainL + m.slapGainR).toBe(0);
  });

  it('turns into a street canyon between house fronts with echoes from both sides', () => {
    const m = reverbMix({ left: 6, right: 9, up: Infinity });
    expect(m.street).toBeGreaterThan(0.75);
    expect(m.tunnel).toBe(0);
    // Echo delay is the round trip to the wall.
    expect(m.slapL).toBeCloseTo((2 * 6 * 1000) / 343, 0);
    expect(m.slapGainL).toBeGreaterThan(m.slapGainR);
    expect(m.wet).toBeGreaterThan(reverbMix({ left: Infinity, right: Infinity, up: Infinity }).wet);
  });

  it('sounds like a tunnel under a bridge between walls', () => {
    const m = reverbMix({ left: 5, right: 5, up: 4 });
    expect(m.tunnel).toBeGreaterThan(0.9);
    expect(m.open + m.street + m.tunnel).toBeCloseTo(1, 5);
  });
});

describe('ambienceLevels', () => {
  it('fades the motorway and the river in with distance', () => {
    const far = ambienceLevels({ urban: 0, green: 1, motorway: { x: 0, y: 0, z: 0, d: 600 } });
    const near = ambienceLevels({ urban: 0, green: 1, motorway: { x: 0, y: 0, z: 0, d: 40 }, water: { x: 0, y: 0, z: 0, d: 20 } });
    expect(far.autobahn).toBe(0);
    expect(near.autobahn).toBe(1);
    expect(near.wasser).toBe(1);
  });

  it('prefers the city layer in built-up areas and birds in green ones', () => {
    const town = ambienceLevels({ urban: 0.9, green: 0.2 });
    const park = ambienceLevels({ urban: 0.05, green: 0.9 });
    expect(town.stadt).toBeGreaterThan(town.gruen);
    expect(park.gruen).toBeGreaterThan(park.stadt);
  });
});
