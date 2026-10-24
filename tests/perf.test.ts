import { describe, expect, it } from 'vitest';
import { Samples, quantile, summarize } from '../src/debug/perf.ts';

describe('perf stats', () => {
  it('keeps a rolling window in time order', () => {
    const s = new Samples(3);
    for (const v of [1, 2, 3, 4, 5]) s.push(v);
    expect(s.ordered()).toEqual([3, 4, 5]);
    expect(s.avg()).toBe(4);
    expect(s.max()).toBe(5);
    expect(s.last()).toBe(5);
  });

  it('computes quantiles', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(quantile([], 0.5)).toBe(0);
  });

  it('counts hitches in a recording', () => {
    const frames = [...Array(100).fill(16.7), 50, 40];
    const out = summarize(frames, { stream: [0.5, 8] });
    expect(out).toContain('102 Frames');
    expect(out).toMatch(/Ruckler: 2 über 1,5 × Median, 2 über 33 ms/);
    expect(out).toContain('stream');
  });
});
