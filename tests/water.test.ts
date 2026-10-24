import { describe, expect, it } from 'vitest';
import { waterAttributes } from '../src/render/water.ts';

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
