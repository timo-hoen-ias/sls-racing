import { describe, expect, it } from 'vitest';
import { Details } from '../pipeline/lib/details.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { TRACK, buildRail } from '../pipeline/lib/rail.ts';
import { TileMap } from '../pipeline/lib/tilebuf.ts';
import type { WorldInfo } from '../src/world/format.ts';
import { PROP_STRIDE, Prop } from '../src/world/propKinds.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1100, N = 1100;

// An electrified line running east 200 m, and a residential street crossing it north-south at E + 100.
const line: Way = { id: 1, tags: { railway: 'rail', electrified: 'contact_line' }, pts: [[E, N], [E + 100, N], [E + 200, N]], ids: [1, 2, 3], closed: false };
const street: Way = { id: 2, tags: { highway: 'residential' }, pts: [[E + 100, N - 50], [E + 100, N], [E + 100, N + 50]], ids: [4, 2, 5], closed: false };
const osm = (): Pick<OsmData, 'ways' | 'points' | 'extra'> => ({
  ways: [street], points: [{ id: 2, tags: { railway: 'level_crossing' }, e: E + 100, n: N }], extra: { ways: [line], areas: [] },
});

describe('railways', () => {
  it('lays track with catenary and puts St Andrew’s crosses at the level crossing', () => {
    const tiles = new TileMap(256);
    // Details only go into tiles the roads and terrain made.
    tiles.at(E, N);
    const details = new Details(world, tiles);
    const r = buildRail(osm(), world, details, () => 0);
    expect(r.km).toBeCloseTo(0.2, 2);
    expect(r.masts).toBeGreaterThanOrEqual(3);
    expect(r.crossings).toBe(1);
    const crosses = [...r.props.values()].flatMap((l) => l.filter((_, i) => i % PROP_STRIDE === 0)).filter((k) => k === Prop.railCross);
    expect(crosses).toHaveLength(2);
    // Away from the road the rail tops stand on bed and sleepers; at the crossing they are flush with the road.
    const ys = [...tiles.at(E + 50, N).details.pos.filter((_, i) => i % 3 === 1)];
    expect(Math.max(...ys)).toBeGreaterThan(TRACK.bedH + TRACK.sleeperH);
    expect(details.tris).toBeGreaterThan(1000);
  });

  it('leaves tunnels and razed lines out', () => {
    const tiles = new TileMap(256);
    const o = osm();
    o.extra!.ways = [{ ...line, tags: { railway: 'rail', tunnel: 'yes' } }, { ...line, id: 7, tags: { railway: 'razed' } }];
    expect(buildRail(o, world, new Details(world, tiles), () => 0).km).toBe(0);
  });
});
