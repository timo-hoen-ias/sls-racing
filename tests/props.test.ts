import { describe, expect, it } from 'vitest';
import { RoadMask } from '../pipeline/lib/clearance.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { buildProps, mapillarySignType, osmSignType } from '../pipeline/lib/props.ts';
import type { WorldInfo } from '../src/world/format.ts';
import { PROP_STRIDE, Prop, type PropKind, isDetected, signTypeOf } from '../src/world/propKinds.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1000, N = 1000;

/** Straight residential street running east from (E, N), 200 m long. */
function street(tags: Record<string, string> = {}): Way {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) pts.push([E + i * 20, N]);
  return { id: 1, tags: { highway: 'residential', ...tags }, pts, ids: pts.map((_, i) => i + 1), closed: false };
}

function run(osm: Partial<OsmData>, detected?: { kind: PropKind; e: number; n: number; size?: number }[]) {
  const data: OsmData = { ways: [], polygons: [], trees: [], points: [], ...osm };
  const lanes = new RoadMask(data.ways, -0.5);
  return buildProps(data, { world, height: () => 0, onLanes: (e, n) => lanes.has(e, n), junctions: [], detected });
}

const records = (tiles: Map<string, number[]>) => [...tiles.values()].flatMap((d) => {
  const out: number[][] = [];
  for (let i = 0; i < d.length; i += PROP_STRIDE) out.push(d.slice(i, i + PROP_STRIDE));
  return out;
});

describe('street furniture', () => {
  it('adds features from photos only where OSM has none of the kind nearby', () => {
    const r = run(
      { ways: [street({ 'parking:both': 'no' })], points: [{ id: 10, tags: { traffic_sign: 'DE:206' }, e: E + 50, n: N + 4 }] },
      [
        { kind: Prop.stopSign, e: E + 53, n: N + 4.5 }, // the mapped sign again
        { kind: Prop.bench, e: E + 120, n: N + 5 },
        { kind: Prop.bench, e: E + 122, n: N + 5 }, // seen twice
      ],
    );
    const recs = records(r.tiles);
    expect(r.detected).toBe(1);
    expect(recs.filter((p) => p[0] === Prop.stopSign || p[0] === Prop.sign)).toHaveLength(1);
    const bench = recs.filter((p) => p[0] === Prop.bench);
    expect(bench).toHaveLength(1);
    expect(isDetected(Prop.bench, bench[0][5])).toBe(true);
  });

  it('moves a hydrant mapped on the carriageway to the kerb and drops a bollard there', () => {
    const r = run({
      ways: [street({ 'parking:both': 'no' })],
      points: [
        { id: 10, tags: { emergency: 'fire_hydrant' }, e: E + 50, n: N + 0.5 },
        { id: 11, tags: { barrier: 'bollard' }, e: E + 80, n: N },
      ],
    });
    const recs = records(r.tiles);
    expect(recs.filter((p) => p[0] === Prop.bollard)).toHaveLength(0);
    const hyd = recs.find((p) => p[0] === Prop.hydrant)!;
    expect(hyd).toBeDefined();
    // Local z = -(n - originN): beside the road, not on its lanes.
    expect(Math.abs(hyd[3])).toBeGreaterThan(2.5);
  });

  it('parks cars beside residential streets unless parking is tagged off', () => {
    const parked = records(run({ ways: [street({ 'parking:both': 'lane' })] }).tiles).filter((p) => p[0] === Prop.parkedCar);
    expect(parked.length).toBeGreaterThan(8);
    for (const p of parked) {
      // Half on the kerb: centre just outside the carriageway, facing along the street (east or west).
      expect(Math.abs(Math.abs(p[3]) - 3.35)).toBeLessThan(1);
      expect(Math.abs(Math.sin(p[4]))).toBeCloseTo(1, 3);
    }
    // Right-hand side of an eastbound street is south (local z > 0); those cars face east.
    for (const p of parked.filter((q) => q[3] > 0)) expect(Math.sin(p[4])).toBeGreaterThan(0.99);
    expect(records(run({ ways: [street({ 'parking:both': 'no' })] }).tiles).filter((p) => p[0] === Prop.parkedCar)).toHaveLength(0);
  });

  it('keeps kerb parkers off narrow lanes and to one side of tight streets', () => {
    const parked = (width: string) => records(run({ ways: [street({ 'parking:both': 'lane', width })] }).tiles).filter((p) => p[0] === Prop.parkedCar);
    expect(parked('3.5')).toHaveLength(0);
    const tight = parked('5.4');
    expect(tight.length).toBeGreaterThan(4);
    // Only the right-hand (south, z > 0) side of the eastbound street.
    for (const p of tight) expect(p[3]).toBeGreaterThan(0);
  });

  it('cuts fences into pieces of at most 4 m along the way', () => {
    const fence: Way = { id: 2, tags: { barrier: 'fence' }, pts: [[E, N + 30], [E + 30, N + 30]], ids: [1, 2], closed: false };
    const pieces = records(run({ ways: [fence] }).tiles).filter((p) => p[0] === Prop.fence);
    expect(pieces.length).toBe(8);
    expect(pieces.reduce((s, p) => s + p[5], 0)).toBeCloseTo(30, 1);
  });

  it('reads the sign type from OSM traffic_sign values', () => {
    expect(osmSignType('DE:306')).toBe('vorfahrtstrasse');
    expect(osmSignType('DE:274[50]')).toBe('tempo-50');
    expect(osmSignType('DE:274.1')).toBe('tempo-30');
    expect(osmSignType('DE:1020-30,DE:205')).toBe('vorfahrt-achten');
    expect(osmSignType('DE:101')).toBeUndefined();
    expect(mapillarySignType('regulatory--maximum-speed-limit-50--g1')).toBe('tempo-50');
    expect(mapillarySignType('regulatory--priority-road--g4')).toBe('vorfahrtstrasse');
    expect(mapillarySignType('information--general-directions--g1')).toBeUndefined();
  });

  it('keeps the sign type of detected signs', () => {
    const r = run({ ways: [street({ 'parking:both': 'no' })] }, [{ kind: Prop.sign, e: E + 50, n: N + 5, size: 7 }]);
    const sign = records(r.tiles).find((p) => p[0] === Prop.sign)!;
    expect(isDetected(Prop.sign, sign[5])).toBe(true);
    expect(signTypeOf(Prop.sign, sign[5])).toBe('tempo-50');
    expect(signTypeOf(Prop.sign, 7)).toBe('tempo-50');
    expect(signTypeOf(Prop.bench, -1)).toBeUndefined();
  });
});
