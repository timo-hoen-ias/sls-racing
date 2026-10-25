import { describe, expect, it } from 'vitest';
import { Leaf, dedupeBorders, extractTrees, type LidarTree } from '../pipeline/lib/lidar.ts';
import type { LasPoints } from '../pipeline/lib/laz.ts';
import { StreetArea, measureStreets, measuredWidth, streetSpace, type AlkisRoads } from '../pipeline/lib/alkis.ts';
import { categorize } from '../pipeline/lib/mapillary.ts';
import { readDbf, readShpPolygons } from '../pipeline/lib/shp.ts';
import type { Way } from '../pipeline/lib/osm.ts';
import { setRoadProfile } from '../src/world/roadSpec.ts';

/** Synthetic 100 m tile: flat ground at 200 m, optional building block, and crowns given as height functions. */
function cloud(crowns: { e: number; n: number; h: number; r: number; cone?: boolean }[], building?: [number, number, number, number]) {
  const x: number[] = [], y: number[] = [], z: number[] = [], cls: number[] = [];
  for (let e = 0.25; e < 100; e += 0.5)
    for (let n = 0.25; n < 100; n += 0.5) {
      let top = 0;
      for (const c of crowns) {
        const d = Math.hypot(e - c.e, n - c.n);
        if (d > c.r) continue;
        // Cone: linear falloff; broadleaf: half sphere on a trunk.
        const h = c.cone ? c.h * (1 - (0.7 * d) / c.r) : c.h * (0.6 + 0.4 * Math.sqrt(1 - (d / c.r) ** 2));
        top = Math.max(top, h);
      }
      const inB = building && e >= building[0] && e <= building[2] && n >= building[1] && n <= building[3];
      x.push(e); y.push(n);
      if (inB) { z.push(212); cls.push(6); }
      else if (top > 0) { z.push(200 + top); cls.push(20); }
      else { z.push(200); cls.push(2); }
    }
  const p: LasPoints = {
    count: x.length, x: Float64Array.from(x), y: Float64Array.from(y), z: Float32Array.from(z), cls: Uint8Array.from(cls),
    ret: new Uint8Array(x.length).fill(1), nret: new Uint8Array(x.length).fill(1),
  };
  return p;
}

describe('LiDAR trees', () => {
  it('finds single trees with height and crown radius', () => {
    const trees = extractTrees(cloud([{ e: 30, n: 30, h: 15, r: 4 }, { e: 70, n: 60, h: 9, r: 3 }]), 0, 0, 100);
    expect(trees).toHaveLength(2);
    const big = trees.find((t) => t[2] > 12)!;
    expect(Math.hypot(big[0] - 30, big[1] - 30)).toBeLessThan(1.5);
    expect(big[2]).toBeCloseTo(15, 0);
    expect(big[3]).toBeGreaterThan(3);
    expect(big[3]).toBeLessThan(5);
    expect(big[4]).toBe(Leaf.broadleaf);
  });

  it('tells conifers from broadleaf trees by crown shape', () => {
    const [t] = extractTrees(cloud([{ e: 50, n: 50, h: 20, r: 3, cone: true }]), 0, 0, 100);
    expect(t[4]).toBe(Leaf.conifer);
  });

  it('ignores roofs and low vegetation', () => {
    const trees = extractTrees(cloud([{ e: 20, n: 20, h: 2, r: 3 }], [50, 50, 80, 80]), 0, 0, 100);
    expect(trees).toHaveLength(0);
  });

  it('keeps one tree where a crown crosses a tile border', () => {
    const a: LidarTree = [999.5, 500, 14, 4, 0], b: LidarTree = [1001, 500.5, 13, 3, 0];
    const out = dedupeBorders([a, b, [500, 500, 10, 3, 0]]);
    expect(out).toHaveLength(2);
    expect(out[0][3]).toBe(4);
  });
});

describe('ALKIS street space', () => {
  const way = (id: number, highway: string, pts: [number, number][]): Way => ({ id, tags: { highway }, pts, ids: pts.map((_, i) => i), closed: false });
  // A 12 m wide street parcel from x = 0 to 200 along y = 0.
  const area = new StreetArea([{ rings: [[[0, -6], [0, 6], [200, 6], [200, -6], [0, -6]]], bbox: [0, -6, 200, 6] }]);

  it('measures the parcel width across a way', () => {
    const ways = measureStreets([way(1, 'residential', [[10, 0], [190, 0]])], area);
    expect(ways[1].street).toBeCloseTo(12, 0);
    expect(ways[1].hit).toBe(1);
  });

  it('estimates a carriageway only for town streets and within bounds', () => {
    const data: AlkisRoads = { crs: 'EPSG:25832', attribution: '', ways: { 1: { street: 12, hit: 1 }, 2: { street: 30, hit: 1 }, 3: { street: 12, hit: 0.3 } } };
    expect(measuredWidth(way(1, 'residential', []), data)).toBeCloseTo(7.2);
    expect(measuredWidth(way(2, 'residential', []), data)).toBe(9); // capped at 150 % of the OSM width (6 m)
    expect(streetSpace(way(3, 'residential', []), data)).toBeUndefined();
    expect(measuredWidth(way(1, 'motorway', []), data)).toBeUndefined();
    // Measured against the mapped width also with the game profile, which widens the result only once.
    setRoadProfile('game');
    try {
      expect(measuredWidth(way(2, 'residential', []), data)).toBe(9);
    } finally {
      setRoadProfile('real');
    }
  });
});

describe('Mapillary categories', () => {
  it('maps object values to game categories', () => {
    expect(categorize('object--traffic-light--general-upright')).toBe('trafficLight');
    expect(categorize('object--traffic-light--pedestrians')).toBe('pedestrianLight');
    expect(categorize('regulatory--yield--g1')).toBe('giveWay');
    expect(categorize('regulatory--no-entry--g1')).toBe('sign');
    expect(categorize('object--street-light')).toBe('streetLight');
    expect(categorize('object--sign--store')).toBeUndefined();
  });
});

describe('shapefile reader', () => {
  it('reads polygons and text columns', () => {
    // One polygon record (type 5) with one ring of 4 points.
    const shp = new DataView(new ArrayBuffer(100 + 8 + 44 + 4 + 4 * 16));
    shp.setInt32(100, 1, false);
    shp.setInt32(104, (44 + 4 + 64) / 2, false);
    shp.setInt32(108, 5, true);
    [0, 0, 2, 2].forEach((v, i) => shp.setFloat64(112 + i * 8, v, true));
    shp.setInt32(144, 1, true);
    shp.setInt32(148, 4, true);
    shp.setInt32(152, 0, true);
    [[0, 0], [0, 2], [2, 2], [0, 0]].forEach(([a, b], i) => { shp.setFloat64(156 + i * 16, a, true); shp.setFloat64(164 + i * 16, b, true); });
    const [poly] = readShpPolygons(new Uint8Array(shp.buffer));
    expect(poly!.rings[0]).toHaveLength(4);
    expect(poly!.bbox).toEqual([0, 0, 2, 2]);

    // dBase header with one character field NUTZART (8 bytes) and one record.
    const dbf = new Uint8Array(32 + 32 + 1 + 9);
    const dv = new DataView(dbf.buffer);
    dv.setUint32(4, 1, true);
    dv.setUint16(8, 65, true);
    dv.setUint16(10, 9, true);
    dbf.set(new TextEncoder().encode('NUTZART'), 32);
    dbf[43] = 67;
    dbf[48] = 8;
    dbf[64] = 0x0d;
    dbf.set(new TextEncoder().encode(' Weg     '), 65);
    expect(readDbf(dbf, ['NUTZART'])).toEqual([{ NUTZART: 'Weg' }]);
  });
});
