import { describe, expect, it } from 'vitest';
import { Details } from '../pipeline/lib/details.ts';
import { buildLeisure, orientedRect, pitchSurface } from '../pipeline/lib/leisure.ts';
import type { OsmData, Polygon } from '../pipeline/lib/osm.ts';
import { TileMap } from '../pipeline/lib/tilebuf.ts';
import type { WorldInfo } from '../src/world/format.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1100, N = 1100;
// A ring rotated by 30°, l × w metres, centred at (e, n).
const rect = (e: number, n: number, l: number, w: number, deg = 30): [number, number][] => {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  const pts: [number, number][] = [[-l / 2, -w / 2], [l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2], [-l / 2, -w / 2]];
  return pts.map(([x, y]) => [e + x * c - y * s, n + x * s + y * c]);
};
const area = (id: number, tags: Record<string, string>, outer: [number, number][]): Polygon => ({ id, tags, outer, holes: [] });

describe('leisure grounds', () => {
  it('finds the rectangle of a rotated pitch', () => {
    const r = orientedRect(rect(E, N, 100, 64))!;
    expect(r.a).toBeCloseTo(50, 1);
    expect(r.b).toBeCloseTo(32, 1);
    expect(Math.abs(r.ue * Math.cos(Math.PI / 6) + r.un * Math.sin(Math.PI / 6))).toBeCloseTo(1, 3);
  });

  it('colours courts by sport and surface', () => {
    expect(pitchSurface({ sport: 'soccer', surface: 'grass' })).toBeUndefined();
    expect(pitchSurface({ sport: 'tennis' })).toEqual(pitchSurface({ sport: 'tennis', surface: 'clay' }));
    expect(pitchSurface({ sport: 'soccer', surface: 'artificial_turf' })).toBeDefined();
  });

  it('marks a football pitch with goals and floodlights, a tennis court with a net, and fills a playground and a pool', () => {
    const tiles = new TileMap(256);
    tiles.at(E, N);
    const details = new Details(world, tiles);
    const osm: Pick<OsmData, 'polygons' | 'points' | 'extra'> = {
      polygons: [
        area(1, { leisure: 'pitch', sport: 'soccer' }, rect(E, N, 100, 64)),
        area(2, { leisure: 'pitch', sport: 'tennis' }, rect(E + 80, N, 36, 18, 0)),
        area(3, { leisure: 'playground' }, rect(E - 80, N, 30, 20, 0)),
      ],
      points: [],
      extra: { ways: [], areas: [area(4, { leisure: 'swimming_pool' }, rect(E, N + 70, 25, 12, 0))] },
    };
    const s = buildLeisure(osm, details, () => 0);
    expect(s.pitches).toBe(2);
    expect(s.goals).toBe(2);
    expect(s.floodlights).toBe(4);
    expect(s.nets).toBe(1);
    expect(s.equipment).toBeGreaterThanOrEqual(4);
    expect(s.pools).toBe(1);
    expect(tiles.at(E, N).collide.idx.length).toBeGreaterThan(0);
    // The pool water is flat.
    const t = tiles.at(E, N).details, mz = -(N + 70 - world.originN), mx = E - world.originE;
    const ys = new Set<number>();
    for (let i = 0; i < t.pos.length; i += 3) if (Math.abs(t.pos[i] - mx) < 14 && Math.abs(t.pos[i + 2] - mz) < 7) ys.add(Math.round(t.pos[i + 1] * 100));
    expect([...ys].some((y) => y === 0)).toBe(true);
  });
});
