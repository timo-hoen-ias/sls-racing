import { describe, expect, it } from 'vitest';
import { Details } from '../pipeline/lib/details.ts';
import { buildIndustry, tagHeight } from '../pipeline/lib/industry.ts';
import type { OsmData } from '../pipeline/lib/osm.ts';
import { TileMap } from '../pipeline/lib/tilebuf.ts';
import type { WorldInfo } from '../src/world/format.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1100, N = 1100;

describe('industry structures', () => {
  it('reads height tags', () => {
    expect(tagHeight({ height: '45 m' })).toBe(45);
    expect(tagHeight({})).toBeUndefined();
  });

  it('builds a chimney, a tank, a pipeline kept off the road and a weir', () => {
    const tiles = new TileMap(256);
    tiles.at(E, N);
    const details = new Details(world, tiles);
    const tank: [number, number][] = Array.from({ length: 13 }, (_, i) => [E + 40 + Math.cos((i / 12) * Math.PI * 2) * 8, N + Math.sin((i / 12) * Math.PI * 2) * 8]);
    const osm: Pick<OsmData, 'points' | 'polygons' | 'extra'> = {
      points: [{ id: 1, tags: { man_made: 'chimney', height: '80' }, e: E, n: N }],
      polygons: [],
      extra: {
        ways: [
          { id: 3, tags: { man_made: 'pipeline', location: 'overhead' }, pts: [[E - 50, N + 30], [E + 50, N + 30]], ids: [1, 2], closed: false },
          { id: 4, tags: { waterway: 'weir' }, pts: [[E, N - 40], [E + 20, N - 40]], ids: [5, 6], closed: false },
        ],
        areas: [{ id: 2, tags: { man_made: 'storage_tank' }, outer: tank, holes: [] }],
      },
    };
    // A road runs north-south through E: no pipe support may stand on it.
    const s = buildIndustry(osm, details, () => 0, (e) => Math.abs(e - E) < 4);
    expect(s.chimneys).toBe(1);
    expect(s.tanks).toBe(1);
    expect(s.pipesKm).toBeCloseTo(0.1, 2);
    expect(s.weirs).toBe(1);
    const t = tiles.at(E, N).details;
    let top = 0;
    for (let i = 1; i < t.pos.length; i += 3) top = Math.max(top, t.pos[i]);
    expect(top).toBeCloseTo(80, 0);
    // Collision near the road line at the pipeline: none.
    const c = tiles.at(E, N).collide, x = E - world.originE, z = -(N + 30 - world.originN);
    for (let i = 0; i < c.pos.length; i += 3) expect(Math.abs(c.pos[i] - x) < 1.5 && Math.abs(c.pos[i + 2] - z) < 1.5).toBe(false);
  });
});
