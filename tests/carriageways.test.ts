import { describe, expect, it } from 'vitest';
import { MEDIAN, separateCarriageways } from '../pipeline/lib/carriageways.ts';
import type { Way } from '../pipeline/lib/osm.ts';
import { SYNTHETIC_NODE } from '../pipeline/lib/osm.ts';

const way = (id: number, tags: Record<string, string>, pts: [number, number][], ids: number[]): Way => ({ id, tags, pts, ids, closed: false });
const mw = { highway: 'motorway', oneway: 'yes', lanes: '2' };

describe('motorway medians', () => {
  it('moves carriageways drawn too close apart, eased in, and the roads at their nodes along', () => {
    // Lines 9 m apart: the inner lanes (3.75 m left of each line) leave 1.5 m, so each moves 1 m outwards.
    const east = way(1, mw, [[0, 0], [1000, 0], [2000, 0]], [1, 2, 3]);
    const west = way(2, mw, [[1000, 9], [0, 9]], [4, 5]);
    // A slip road leaving the eastbound carriageway at x 1000 to the south.
    const link = way(3, { highway: 'motorway_link', oneway: 'yes' }, [[1000, 0], [1050, -30], [1100, -200]], [2, 6, 7]);
    const stats = separateCarriageways([east, west, link]);
    expect(stats.ways).toBe(2);
    expect(stats.maxMove).toBeCloseTo((MEDIAN.lanes - 1.5) / 2);
    // Eastbound: its right is south.
    const y = (w: Way, x: number) => w.pts.find((p) => Math.abs(p[0] - x) < 1e-6)![1];
    expect(y(east, 500)).toBeCloseTo(-1);
    expect(y(west, 500)).toBeCloseTo(10);
    // Long segments got extra nodes, mapped ids stay in place.
    expect(east.ids.filter((id) => id < SYNTHETIC_NODE).length).toBeGreaterThan(40);
    expect(east.ids[0]).toBe(1);
    expect(east.ids[east.ids.length - 1]).toBe(3);
    // Beyond the end of the westbound carriageway the move eases out at 1:40.
    expect(y(east, 1020)).toBeCloseTo(-1 + 20 * MEDIAN.slope, 1);
    expect(y(east, 2000)).toBeCloseTo(0);
    // The slip road keeps its junction node on the carriageway and eases back to its course.
    expect(link.pts[0]).toEqual(east.pts[east.ids.indexOf(2)]);
    expect(link.pts[1][1]).toBeLessThan(-30);
    expect(link.pts[1][1]).toBeGreaterThan(-31);
    expect(link.pts[2]).toEqual([1100, -200]);
  });

  it('leaves medians that are wide enough alone', () => {
    const east = way(1, mw, [[0, 0], [1000, 0]], [1, 2]);
    const west = way(2, mw, [[1000, 12], [0, 12]], [3, 4]);
    expect(separateCarriageways([east, west]).ways).toBe(0);
    expect(east.pts).toEqual([[0, 0], [1000, 0]]);
  });
});
