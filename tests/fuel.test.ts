import { describe, expect, it } from 'vitest';
import { RoadMask } from '../pipeline/lib/clearance.ts';
import { minRect, planFuel, type FuelBuilding } from '../pipeline/lib/fuel.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { localToUtm, type WorldInfo } from '../src/world/format.ts';
import { fuelBoxes } from '../src/world/fuelColliders.ts';
import { FUEL_STRIDE, NO_PYLON, fuelIslands, fuelLayout, fuelPrices } from '../src/world/fuelKinds.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1000, N = 1000;

const line = (id: number, highway: string, pts: [number, number][]): Way => ({ id, tags: { highway }, pts, ids: pts.map((_, i) => id * 100 + i), closed: false });

/** East-west street at n = N, a petrol station point 22 m north of it, optionally a driveway through it. */
function run(opts: { driveway?: boolean; buildings?: FuelBuilding[]; polygon?: boolean } = {}) {
  const street: [number, number][] = [];
  for (let i = 0; i <= 12; i++) street.push([E - 60 + i * 10, N]);
  const ways = [line(1, 'secondary', street)];
  // Driveway in from the street, along the forecourt and back out.
  if (opts.driveway) ways.push(line(2, 'service', [[E - 20, N + 4], [E - 14, N + 22], [E + 14, N + 22], [E + 20, N + 4]]));
  const ring: [number, number][] = [[E - 25, N + 8], [E + 25, N + 8], [E + 25, N + 45], [E - 25, N + 45], [E - 25, N + 8]];
  const data: OsmData = {
    ways, trees: [],
    polygons: opts.polygon ? [{ id: 9, tags: { amenity: 'fuel', name: 'Testtanke' }, outer: ring, holes: [] }] : [],
    points: opts.polygon ? [] : [{ id: 5, tags: { amenity: 'fuel', brand: 'Marke' }, e: E, n: N + 22 }],
  };
  const lanes = new RoadMask(ways, 0.5, (t) => t.highway !== 'service'), road = new RoadMask(ways);
  return planFuel(data, { world, height: () => 0, nearLanes: (e, n) => lanes.has(e, n), onRoad: (e, n) => road.has(e, n), buildings: opts.buildings ?? [] });
}

const records = (tiles: Map<string, number[]>) => [...tiles.values()].flatMap((d) => {
  const out: Float32Array[] = [];
  for (let i = 0; i < d.length; i += FUEL_STRIDE) out.push(new Float32Array(d.slice(i, i + FUEL_STRIDE)));
  return out;
});

/** Distance (m) from a UTM point to the driveway centreline of run({ driveway: true }). */
function drivewayDistance(e: number, n: number) {
  const pts: [number, number][] = [[E - 20, N + 4], [E - 14, N + 22], [E + 14, N + 22], [E + 20, N + 4]];
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ae, an] = pts[i - 1], [be, bn] = pts[i];
    const de = be - ae, dn = bn - an;
    const t = Math.max(0, Math.min(1, ((e - ae) * de + (n - an) * dn) / (de * de + dn * dn)));
    best = Math.min(best, Math.hypot(ae + de * t - e, an + dn * t - n));
  }
  return best;
}

describe('petrol stations', () => {
  it('finds the smallest rectangle around a rotated outline', () => {
    const a = 0.5, c = Math.cos(a), s = Math.sin(a);
    const pts = ([[-10, -4], [10, -4], [10, 4], [-10, 4]] as [number, number][]).map(([x, y]) => [x * c - y * s + 100, x * s + y * c + 50] as [number, number]);
    const r = minRect(pts);
    expect(r.l).toBeCloseTo(20, 3);
    expect(r.w).toBeCloseTo(8, 3);
    expect(r.c[0]).toBeCloseTo(100, 3);
    expect(Math.abs(r.ax[0] * c + r.ax[1] * s)).toBeCloseTo(1, 3);
  });

  it('places a canopy at a mapped point, along the street and facing it, with shop and pylon', () => {
    const r = run();
    expect(r.list).toHaveLength(1);
    const [d] = records(r.tiles);
    // Along the east-west street: the front faces south (+z local), heading 0.
    expect(Math.abs(Math.sin(d[3]))).toBeLessThan(1e-3);
    expect(Math.cos(d[3])).toBeGreaterThan(0.99);
    expect(d[6]).toBe((1 << fuelIslands(d[4], d[5]).length) - 1);
    // Generated shop behind the canopy (further from the street), pylon at the street but off the carriageway.
    expect(d[12]).toBeGreaterThan(0);
    expect(-d[10]).toBeGreaterThan(-d[2]);
    expect(d[15]).toBeGreaterThan(NO_PYLON + 1);
    const [, pn] = localToUtm(world, d[14], d[16]);
    expect(pn - N).toBeGreaterThan(4);
    expect(r.list[0]).toMatchObject({ name: 'Marke', shop: 'modell', pylon: true });
  });

  it('keeps every solid part off a driveway through the forecourt', () => {
    const r = run({ driveway: true, polygon: true });
    expect(r.list).toHaveLength(1);
    const [d] = records(r.tiles);
    for (const b of fuelBoxes(d, 0)) {
      if (b.part === 'roof') continue;
      // Box corners and centre.
      for (const [sx, sz] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const lx = sx * b.hx, lz = sz * b.hz, c = Math.cos(b.heading), s = Math.sin(b.heading);
        const [e, n] = localToUtm(world, b.x + lx * c + lz * s, b.z - lx * s + lz * c);
        expect(drivewayDistance(e, n), b.part).toBeGreaterThan(1.5);
      }
    }
  });

  it('replaces a surveyed canopy block with its own canopy and keeps the station building', () => {
    const canopy: [number, number][] = [[E - 9, N + 20], [E + 9, N + 20], [E + 9, N + 31], [E - 9, N + 31]];
    const shop: [number, number][] = [[E - 8, N + 36], [E + 8, N + 36], [E + 8, N + 44], [E - 8, N + 44]];
    const r = run({ polygon: true, buildings: [{ ring: canopy, kind: 'canopy' }, { ring: shop, kind: 'shop' }] });
    expect(r.skip(canopy)).toBe(true);
    expect(r.skip(shop)).toBe(false);
    expect(r.list[0]).toMatchObject({ mapped: true, shop: 'gebaeude', length: 18, width: 11 });
    const [d] = records(r.tiles);
    expect(d[12]).toBe(0);
    const [ce, cn] = localToUtm(world, d[0], d[2]);
    expect(Math.hypot(ce - E, cn - (N + 25.5))).toBeLessThan(3.5);
  });

  it('lays out islands with pumps and columns under the roof', () => {
    const parts = fuelLayout(24, 13, 0b1111);
    expect(parts.filter((p) => p.part === 'island')).toHaveLength(4);
    expect(parts.filter((p) => p.part === 'pump')).toHaveLength(8);
    const roof = parts.find((p) => p.part === 'roof')!;
    for (const p of parts) if (p.part !== 'roof') {
      expect(Math.abs(p.x) + p.w / 2).toBeLessThanOrEqual(roof.w / 2);
      expect(Math.abs(p.z) + p.d / 2).toBeLessThanOrEqual(roof.d / 2);
      expect(p.y + p.h).toBeLessThanOrEqual(roof.y + 1e-6);
    }
    expect(fuelLayout(24, 13, 0b0101).filter((p) => p.part === 'island')).toHaveLength(2);
    const [e5, e10, diesel] = fuelPrices(3);
    expect(e5).toBeGreaterThan(e10);
    expect(e10).toBeGreaterThan(diesel);
    expect(Math.round(e10 * 1000) % 10).toBe(9);
  });
});
