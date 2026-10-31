import { describe, expect, it } from 'vitest';
import { Details } from '../pipeline/lib/details.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { buildPower, clearOfRoads, footings, pylonHeight, pylonSlots } from '../pipeline/lib/power.ts';
import { TileMap } from '../pipeline/lib/tilebuf.ts';
import type { WorldInfo } from '../src/world/format.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1050, N = 1050;

const line: Way = { id: 1, tags: { power: 'line', voltage: '110000', cables: '6' }, pts: [[E, N], [E + 150, N]], ids: [1, 2], closed: false };
const minor: Way = { id: 2, tags: { power: 'minor_line' }, pts: [[E, N + 40], [E + 40, N + 40], [E + 80, N + 40]], ids: [3, 4, 5], closed: false };
const solarRing: [number, number][] = [[E + 10, N + 60], [E + 70, N + 60], [E + 70, N + 100], [E + 10, N + 100], [E + 10, N + 60]];

const osm = (): Pick<OsmData, 'points' | 'extra'> => ({
  points: [
    { id: 1, tags: { power: 'tower' }, e: E, n: N },
    { id: 2, tags: { power: 'tower' }, e: E + 150, n: N },
    { id: 9, tags: { power: 'transformer' }, e: E + 120, n: N + 80 },
  ],
  extra: { ways: [line, minor], areas: [{ id: 3, tags: { power: 'generator', 'generator:source': 'solar' }, outer: solarRing, holes: [] }] },
});

describe('power lines', () => {
  it('sizes pylons by voltage and hangs a conductor per cable', () => {
    expect(pylonHeight('380000;110000')).toBeGreaterThan(pylonHeight('110000'));
    expect(pylonSlots(6, 34)).toHaveLength(6);
    expect(pylonSlots(12, 50)).toHaveLength(12);
  });

  it('draws pylons, poles, sagging wires, a kiosk and solar rows', () => {
    const tiles = new TileMap(256);
    tiles.at(E, N);
    const details = new Details(world, tiles);
    const s = buildPower(osm(), details, () => 0);
    expect(s.pylons).toBe(2);
    expect(s.poles).toBe(3);
    expect(s.spans).toBe(3);
    expect(s.kiosks).toBe(1);
    expect(s.solarRows).toBeGreaterThanOrEqual(5);
    // Footings and the kiosk are solid.
    expect(tiles.at(E, N).collide.idx.length).toBeGreaterThan(0);
    // The wires sag: below the attachment height mid-span, but well above the ground.
    const t = tiles.at(E, N).details;
    const mx = E + 75 - world.originE, mz = -(N - world.originN);
    let low = Infinity;
    for (let i = 0; i < t.pos.length; i += 3) if (Math.abs(t.pos[i] - mx) < 3 && Math.abs(t.pos[i + 2] - mz) < 10 && t.pos[i + 1] > 5) low = Math.min(low, t.pos[i + 1]);
    expect(low).toBeLessThan(34 * 0.7 - 2.6 - 1);
    expect(low).toBeGreaterThan(9);
  });

  it('moves a support along its line until no footing stands on a road', () => {
    // A road 8 m wide along north–south at e = 0; the line runs east (across = south), the pylon legs reach 3 m.
    const onRoad = (e: number) => Math.abs(e) < 4;
    const feet = footings(34, false);
    expect(clearOfRoads(20, 0, 0, -1, feet, onRoad)).toEqual([20, 0]);
    const [e, n] = clearOfRoads(5, 0, 0, -1, feet, onRoad);
    expect(n).toBe(0);
    expect(feet.every(([x, z]) => !onRoad(e + z))).toBe(true);
    expect(Math.abs(e - 5)).toBeLessThanOrEqual(4);
    // A line along the road: moving along it never clears the legs, moving across does.
    const [ae2, an2] = [1, 0];
    const along = clearOfRoads(1, 50, ae2, an2, feet, onRoad);
    expect(feet.every(([x]) => !onRoad(along[0] + x))).toBe(true);
    expect(along[1]).toBe(50);
    // In the middle of a wide road nothing within reach clears it: it stays.
    expect(clearOfRoads(0, 0, 0, -1, feet, () => true)).toEqual([0, 0]);
  });

  it('counts the supports it moved off a road as details spots', () => {
    const tiles = new TileMap(256);
    const stats = buildPower(osm(), new Details(world, tiles), () => 200, (e) => Math.abs(e - E) < 3);
    expect(stats.moved).toBeGreaterThan(0);
    expect(stats.spots.some((s) => s.kind === 'mast-verschoben')).toBe(true);
  });
});
