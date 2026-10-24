import { describe, expect, it } from 'vitest';
import { farWanted, orientedBox } from '../pipeline/lib/far.ts';

describe('far view', () => {
  it('fits a rotated rectangle tightly', () => {
    const a = Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
    // 20 × 8 m house rotated by 30°, centred at (100, 50), with an extra vertex on one side.
    const corners: [number, number][] = [[-10, -4], [0, -4], [10, -4], [10, 4], [-10, 4]].map(([u, v]) => [100 + u * c - v * s, 50 + u * s + v * c]);
    const [cx, cy, hl, hw, ang] = orientedBox(corners);
    expect(cx).toBeCloseTo(100, 6);
    expect(cy).toBeCloseTo(50, 6);
    expect(hl * hw * 4).toBeCloseTo(160, 4);
    expect(Math.max(hl, hw)).toBeCloseTo(10, 4);
    // The box is aligned with the house, either along its length or its width.
    expect(Math.abs(Math.sin(2 * (ang - a)))).toBeLessThan(1e-6);
  });

  it('keeps buildings and land cover, not roads', () => {
    expect(farWanted({ building: 'yes' })).toBe(true);
    expect(farWanted({ landuse: 'forest' })).toBe(true);
    expect(farWanted({ natural: 'water' })).toBe(true);
    expect(farWanted({ highway: 'primary' })).toBe(false);
  });
});
