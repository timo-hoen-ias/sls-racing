import { describe, expect, it } from 'vitest';
import type { Way } from '../pipeline/lib/osm.ts';
import { SPLINE, splineCurves, splinePiece } from '../pipeline/lib/smooth.ts';
import { activeRoadProfile, setRoadProfile } from '../src/world/roadSpec.ts';

describe('round curves', () => {
  it('a bend drawn as a 12-gon becomes a fine curve through the same nodes', () => {
    const prev = activeRoadProfile();
    setRoadProfile('game');
    try {
      // Quarter circle of radius 40 m drawn with 4 nodes (30° per piece).
      const pts: [number, number][] = [0, 1, 2, 3].map((k) => [40 * Math.cos((k * Math.PI) / 6), 40 * Math.sin((k * Math.PI) / 6)]);
      const w: Way = { id: 1, tags: { highway: 'residential' }, pts: pts.map((p) => [...p] as [number, number]), ids: [10, 11, 12, 13], closed: false };
      const stats = splineCurves([w]);
      expect(stats.ways).toBe(1);
      for (const id of [10, 11, 12, 13]) expect(w.pts[w.ids.indexOf(id)]).toEqual(pts[[10, 11, 12, 13].indexOf(id)]);
      // Inner nodes see a turn of at most a few degrees per piece now, and the curve hugs the circle.
      let worst = 0;
      for (let i = 1; i < w.pts.length - 1; i++) {
        const a = Math.atan2(w.pts[i][1] - w.pts[i - 1][1], w.pts[i][0] - w.pts[i - 1][0]);
        const b = Math.atan2(w.pts[i + 1][1] - w.pts[i][1], w.pts[i + 1][0] - w.pts[i][0]);
        worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))));
      }
      expect(worst).toBeLessThan(2.5 * SPLINE.turn);
      // The 1.4 m sagitta of each piece is capped at the 1 m town deviation, so the curve runs a little inside.
      for (const [x, y] of w.pts.slice(1, -1)) expect(Math.abs(Math.hypot(x, y) - 40)).toBeLessThan(1);
    } finally {
      setRoadProfile(prev);
    }
  });

  it('leaves straight pieces alone and keeps a bulge within the allowed deviation', () => {
    expect(splinePiece([-10, 0], [0, 0], [10, 0], [20, 0], 1)).toHaveLength(0);
    const p = splinePiece([0, -60], [0, 0], [60, 0], [60, 60], 1);
    for (const [, y] of p) expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('does nothing in the real road profile', () => {
    setRoadProfile('real');
    const w: Way = { id: 1, tags: { highway: 'residential' }, pts: [[0, 0], [20, 5], [40, 0]], ids: [1, 2, 3], closed: false };
    expect(splineCurves([w]).ways).toBe(0);
  });
});
