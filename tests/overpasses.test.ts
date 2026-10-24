import { describe, expect, it } from 'vitest';
import type { Way } from '../pipeline/lib/osm.ts';
import { CLEARANCE, liftOverpasses } from '../pipeline/lib/overpasses.ts';
import { roadSurfaceHeights } from '../pipeline/lib/roads.ts';

const way = (id: number, ids: number[], pts: [number, number][], tags: Record<string, string>): Way => ({ id, ids, pts, tags, closed: false });

describe('liftOverpasses', () => {
  // A road running east-west, crossed by a north-south road whose middle part is a bridge.
  const flat = () => 100;
  const make = () => [
    way(1, [1, 2], [[-300, 0], [300, 0]], { highway: 'primary' }),
    way(2, [10, 11], [[0, -300], [0, -20]], { highway: 'secondary' }),
    way(3, [11, 12], [[0, -20], [0, 20]], { highway: 'secondary', bridge: 'yes' }),
    way(4, [12, 13], [[0, 20], [0, 300]], { highway: 'secondary' }),
  ];

  it('lifts the bridge and its approaches but not the road below', () => {
    const ways = make();
    const r = liftOverpasses(ways, flat);
    expect(r.crossings).toBe(1);
    expect(r.minClearance).toBeGreaterThanOrEqual(CLEARANCE - 1e-6);
    expect(ways[0].raise).toBeUndefined();
    const deck = roadSurfaceHeights(ways[2], flat);
    expect(Math.min(...deck)).toBeGreaterThan(100 + CLEARANCE);
    // Approach ramps come down to the terrain far from the bridge.
    expect(roadSurfaceHeights(ways[1], flat)[0]).toBeLessThan(101);
    expect(roadSurfaceHeights(ways[1], flat)[1]).toBeGreaterThan(100 + CLEARANCE);
  });

  it('leaves roads that meet at a junction alone', () => {
    const ways = [way(1, [1, 2, 3], [[-50, 0], [0, 0], [50, 0]], { highway: 'primary' }), way(2, [4, 2, 5], [[0, -50], [0, 0], [0, 50]], { highway: 'residential' })];
    expect(liftOverpasses(ways, flat).crossings).toBe(0);
    expect(ways.every((w) => !w.raise)).toBe(true);
  });
});
