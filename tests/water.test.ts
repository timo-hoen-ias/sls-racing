import { describe, expect, it } from 'vitest';
import { waterAttributes } from '../src/render/water.ts';
import { waterLevels, type TileGrid } from '../pipeline/lib/waterLevel.ts';

const N = 17;
const STEP = 8;

/** A straight channel 5 cells wide, either running north-south (along z) or east-west (along x). */
const channel = (alongZ: boolean) => (i: number) => {
  const r = Math.floor(i / N), c = i % N;
  return Math.abs((alongZ ? c : r) - 8) <= 2;
};

describe('waterAttributes', () => {
  it('measures the distance to the bank', () => {
    const { shore } = waterAttributes(channel(true), N, STEP, 0, 0);
    expect(shore[8 * N + 5]).toBe(0); // dry
    expect(shore[8 * N + 6]).toBe(STEP); // first water column
    expect(shore[8 * N + 8]).toBe(3 * STEP); // middle
  });

  it('flows along the channel, downstream to the north without waterway lines', () => {
    const { flow } = waterAttributes(channel(true), N, STEP, 0, 0);
    const i = 8 * N + 8;
    expect(Math.abs(flow[i * 2])).toBeLessThan(0.05);
    expect(flow[i * 2 + 1]).toBeLessThan(-0.5); // -z is north
  });

  it('follows the direction of a waterway line when the tile has one', () => {
    // East-west channel, line drawn from west to east: water must flow east (+x).
    const line = new Float32Array([2, 30, 0, 0, 8 * STEP, (N - 1) * STEP, 0, 8 * STEP]);
    const { flow } = waterAttributes(channel(false), N, STEP, 0, 0, line);
    const i = 8 * N + 8;
    expect(flow[i * 2]).toBeGreaterThan(0.5);
    expect(Math.abs(flow[i * 2 + 1])).toBeLessThan(0.05);
  });

  it('is slow at the banks and fastest mid-stream', () => {
    const { flow } = waterAttributes(channel(true), N, STEP, 0, 0);
    const speed = (c: number) => Math.hypot(flow[(8 * N + c) * 2], flow[(8 * N + c) * 2 + 1]);
    expect(speed(8)).toBeGreaterThan(speed(6));
  });
});

describe('waterLevels', () => {
  const n = 17;
  const WATER = 3;
  /** Two tiles side by side, a lake across the border with bumps, a sloped bank around it. */
  const make = () => {
    const tiles = new Map<string, TileGrid>();
    for (const ix of [0, 1]) {
      const h = new Float32Array(n * n), g = new Uint8Array(n * n);
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) {
          const x = ix * (n - 1) + c, i = r * n + c;
          const lake = r >= 4 && r <= 12 && x >= 6 && x <= 26;
          g[i] = lake ? WATER : 1;
          h[i] = lake ? 100 + ((x * 7 + r * 3) % 5 === 0 ? 4 : 0) + (x === 16 ? 6 : 0) : 103;
        }
      tiles.set(`${ix}_0`, { h, g });
    }
    return tiles;
  };

  it('makes a bumpy lake flat across the tile border and presses the ground below it', () => {
    const tiles = make();
    const levels = waterLevels(tiles, n, WATER);
    const all: number[] = [];
    for (const [k, t] of tiles)
      for (let i = 0; i < n * n; i++)
        if (t.g[i] === WATER) {
          const lv = levels.get(k)![i];
          all.push(lv);
          expect(t.h[i]).toBeLessThanOrEqual(lv);
        }
    expect(Math.max(...all) - Math.min(...all)).toBeLessThan(0.01);
    expect(all[0]).toBeCloseTo(100, 1);
    // The shared border column has the same level in both tiles.
    expect(levels.get('0_0')![8 * n + 16]).toBe(levels.get('1_0')![8 * n]);
  });

  it('gives bank samples the level and leaves dry land without one', () => {
    const tiles = make();
    const levels = waterLevels(tiles, n, WATER);
    const lv = levels.get('0_0')!;
    expect(lv[3 * n + 6]).toBeCloseTo(100, 1); // bank row above the lake
    expect(Number.isNaN(lv[0])).toBe(true);
    expect(tiles.get('0_0')!.h[3 * n + 6]).toBe(103); // banks keep their height
  });
});
