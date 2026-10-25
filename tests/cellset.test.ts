import { describe, expect, it } from 'vitest';
import { CellSet } from '../pipeline/lib/cellset.ts';

describe('CellSet', () => {
  it('holds cells on a UTM-sized grid, also across chunk borders and below zero', () => {
    const s = new CellSet();
    const cells: [number, number][] = [[336_512, 5_464_700], [336_575, 5_464_700], [336_576, 5_464_700], [0, 0], [-1, -1], [-64, 63], [700_000, 2_700_000]];
    for (const [x, y] of cells) s.add(x, y);
    for (const [x, y] of cells) expect(s.has(x, y)).toBe(true);
    expect(s.has(336_513, 5_464_700)).toBe(false);
    expect(s.has(336_512, 5_464_701)).toBe(false);
    expect(s.has(-1, 0)).toBe(false);
    expect(s.has(1, 1)).toBe(false);
  });
});
