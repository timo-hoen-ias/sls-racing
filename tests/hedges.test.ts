import { describe, expect, it } from 'vitest';
import { centreLines, narrowRuns, thin, traceChains, traceHedges } from '../pipeline/lib/hedges.ts';
import { rasterize } from '../pipeline/lib/landcover.ts';

const N = 40;
const grid = (fill: (r: number, c: number) => boolean) => {
  const m = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) m[r * N + c] = fill(r, c) ? 1 : 0;
  return m;
};
const none = new Uint8Array(N * N);
const count = (m: Uint8Array) => m.reduce((a, v) => a + v, 0);

describe('hedges from the laser heights', () => {
  it('keeps narrow runs and drops wide patches', () => {
    const strip = grid((r, c) => (r === 10 || r === 11) && c >= 5 && c < 35);
    expect(count(narrowRuns(strip, none, N))).toBe(60);
    const patch = grid((r, c) => r >= 5 && r < 25 && c >= 5 && c < 25);
    expect(count(narrowRuns(patch, none, N))).toBe(0);
  });

  it('drops the low rim around crowns', () => {
    const crown = grid((r, c) => Math.hypot(r - 20, c - 20) < 4);
    const rim = grid((r, c) => { const d = Math.hypot(r - 20, c - 20); return d >= 4 && d < 5.5; });
    expect(count(narrowRuns(rim, crown, N))).toBe(0);
  });

  it('thins a strip to one chain', () => {
    const strip = grid((r, c) => r >= 10 && r <= 12 && c >= 5 && c < 35);
    const sk = thin(strip.slice(), N);
    const chains = traceChains(sk, N);
    expect(chains.length).toBe(1);
    expect(chains[0].length).toBeGreaterThan(20);
  });

  it('traces an L-shaped hedge into a simplified polyline in UTM', () => {
    const l = grid((r, c) => (r === 30 && c >= 5 && c <= 30) || (c === 30 && r >= 5 && r <= 30));
    const out = traceHedges(l, none, N, 1000, 2000, 2);
    expect(out.length).toBe(1);
    const p = out[0];
    expect(p.length).toBeLessThanOrEqual(4);
    // The corner cell (r 30, c 30) sits at e 1061, n 1939.
    expect(p.some(([e, n]) => Math.hypot(e - 1061, n - 1939) < 2.5)).toBe(true);
    const short = traceHedges(grid((r, c) => r === 5 && c >= 5 && c < 7), none, N, 0, 0, 2);
    expect(short.length).toBe(0);
  });

  it('finds the centre line of a thin L-shaped wall polygon', () => {
    // 20 m east, then 10 m north, 0.4 m thick.
    const ring: [number, number][] = [[100, 100], [120.4, 100], [120.4, 110], [120, 110], [120, 100.4], [100, 100.4], [100, 100]];
    const lines = centreLines([ring], 0.25, rasterize);
    const total = lines.reduce((s, l) => s + l.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0), 0);
    expect(total).toBeGreaterThan(27);
    expect(total).toBeLessThan(31);
    for (const l of lines) for (const [e, n] of l) expect(Math.min(Math.abs(n - 100.2), Math.abs(e - 120.2))).toBeLessThan(0.6);
  });
});
