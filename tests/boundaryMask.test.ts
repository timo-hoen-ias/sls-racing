import { describe, expect, it } from 'vitest';
import { boundaryMask } from '../pipeline/lib/pbf.ts';

describe('boundaryMask (administrative region cut)', () => {
  // A 0.1° × 0.1° square near Saarlouis (about 7.3 × 11.1 km).
  const ring: [number, number][] = [[6.7, 49.3], [6.8, 49.3], [6.8, 49.4], [6.7, 49.4], [6.7, 49.3]];
  const box = { south: 49.3, west: 6.7, north: 49.4, east: 6.8 };
  const near = boundaryMask([ring], box, 300);
  const mLat = 1 / 111_320, mLon = 1 / (111_320 * Math.cos((49.35 * Math.PI) / 180));

  it('keeps the inside and the boundary', () => {
    expect(near(49.35, 6.75)).toBe(true);
    expect(near(49.3, 6.75)).toBe(true);
  });
  it('keeps a margin outside and drops what lies beyond it', () => {
    expect(near(49.3 - 200 * mLat, 6.75)).toBe(true);
    expect(near(49.35, 6.8 + 200 * mLon)).toBe(true);
    expect(near(49.3 - 600 * mLat, 6.75)).toBe(false);
    expect(near(49.35, 6.7 - 600 * mLon)).toBe(false);
  });
  it('cuts the empty corners of an L-shaped district out of its box', () => {
    const l: [number, number][] = [[6.7, 49.3], [6.8, 49.3], [6.8, 49.35], [6.75, 49.35], [6.75, 49.4], [6.7, 49.4], [6.7, 49.3]];
    const m = boundaryMask([l], box, 300);
    expect(m(49.32, 6.78)).toBe(true);
    expect(m(49.38, 6.78)).toBe(false);
  });
});
