import { describe, expect, it } from 'vitest';
import { RoadMask } from '../pipeline/lib/clearance.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { buildShops, shopKindOf } from '../pipeline/lib/shops.ts';
import type { WorldInfo } from '../src/world/format.ts';
import { SHOP_TYPES } from '../src/world/shopGlb.ts';
import { SHOP_KINDS, SHOP_STRIDE, ShopFlag } from '../src/world/shopKinds.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1000, N = 1000;

/** East-west street at n = N and a 20 × 10 m building north of it, 6 m from the centre line. */
function scene() {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) pts.push([E - 50 + i * 10, N]);
  const street: Way = { id: 1, tags: { highway: 'residential' }, pts, ids: pts.map((_, i) => i + 1), closed: false };
  const outer: [number, number][] = [[E - 10, N + 6], [E + 10, N + 6], [E + 10, N + 16], [E - 10, N + 16]];
  return { street, outer };
}

function run(points: OsmData['points'], shopWindows = false) {
  const { street, outer } = scene();
  const data: OsmData = { ways: [street], polygons: [], trees: [], points };
  const road = new RoadMask(data.ways), lanes = new RoadMask(data.ways, -0.5);
  return buildShops(data, { world, height: () => 0, onRoad: (e, n) => road.has(e, n), onLanes: (e, n) => lanes.has(e, n), buildings: [{ id: 7, outer, shopWindows, centre: 100 }] });
}

const records = (tiles: Map<string, number[]>) => [...tiles.values()].flatMap((d) => {
  const out: number[][] = [];
  for (let i = 0; i < d.length; i += SHOP_STRIDE) out.push(d.slice(i, i + SHOP_STRIDE));
  return out;
});

describe('shop fronts', () => {
  it('uses the same type order as shops.glb', () => {
    expect([...SHOP_KINDS]).toEqual([...SHOP_TYPES]);
    expect(shopKindOf({ shop: 'bakery' })).toBe('baeckerei');
    expect(shopKindOf({ amenity: 'cafe' })).toBe('cafe');
    expect(shopKindOf({ shop: 'vacant' })).toBeUndefined();
  });

  it('puts a mapped shop on the street side of its building, facing the street', () => {
    const r = run([{ id: 3, tags: { amenity: 'cafe' }, e: E + 2, n: N + 10 }]);
    const recs = records(r.tiles);
    expect(recs).toHaveLength(1);
    const [kind, x, , z, heading, width] = recs[0];
    expect(SHOP_KINDS[kind]).toBe('cafe');
    // On the south wall (n = N + 6 → local z = -6), facing south (+z local): heading 0.
    expect(z).toBeCloseTo(-6, 1);
    expect(Math.abs(x - 2)).toBeLessThan(0.01);
    expect(Math.cos(heading)).toBeCloseTo(1, 3);
    expect(width).toBeGreaterThan(4);
  });

  it('adds generic fronts to shop-window façades and keeps tables off the lanes', () => {
    const recs = records(run([], true).tiles);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    for (const r of recs) if (r[6] & ShopFlag.tables) expect(Math.abs(r[3]) - 2.6).toBeGreaterThan(2.5);
  });
});
