import { describe, expect, it } from 'vitest';
import { RoadMask } from '../pipeline/lib/clearance.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { buildProps, mapillarySignType, osmSignType } from '../pipeline/lib/props.ts';
import type { WorldInfo } from '../src/world/format.ts';
import { PROP_STRIDE, Prop, type PropKind, isDetected, isMeasured, linearLength, signTypeOf } from '../src/world/propKinds.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1000, N = 1000;

/** Straight residential street running east from (E, N), 200 m long. */
function street(tags: Record<string, string> = {}): Way {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) pts.push([E + i * 20, N]);
  return { id: 1, tags: { highway: 'residential', ...tags }, pts, ids: pts.map((_, i) => i + 1), closed: false };
}

function run(osm: Partial<OsmData>, detected?: { kind: PropKind; e: number; n: number; size?: number }[], hedges?: [number, number][][]) {
  const data: OsmData = { ways: [], polygons: [], trees: [], points: [], ...osm };
  const lanes = new RoadMask(data.ways, -0.5);
  return buildProps(data, { world, height: () => 0, onLanes: (e, n) => lanes.has(e, n), junctions: [], detected, hedges });
}

const records = (tiles: Map<string, number[]>) => [...tiles.values()].flatMap((d) => {
  const out: number[][] = [];
  for (let i = 0; i < d.length; i += PROP_STRIDE) out.push(d.slice(i, i + PROP_STRIDE));
  return out;
});

describe('street furniture', () => {
  it('paints stall lines on paved car parks only', () => {
    const lot = (tags: Record<string, string>) => {
      const outer: [number, number][] = [[E, N + 20], [E + 40, N + 20], [E + 40, N + 40], [E, N + 40], [E, N + 20]];
      return { id: 3, tags: { amenity: 'parking', ...tags }, outer, holes: [] };
    };
    const paved = run({ polygons: [lot({})] }).stallLines;
    // Two rows of 15 stalls, 16 separators each.
    expect(paved.length / 4).toBe(32);
    for (let i = 0; i < paved.length; i += 4) expect(Math.hypot(paved[i + 2], paved[i + 3])).toBeCloseTo(1, 2);
    expect(run({ polygons: [lot({ surface: 'gravel' })] }).stallLines.length).toBe(0);
  });

  it('places measured hedges off the lanes and not beside a mapped hedge', () => {
    const mapped: Way = { id: 2, tags: { barrier: 'hedge' }, pts: [[E + 20, N + 10], [E + 60, N + 10]], ids: [20, 21], closed: false };
    const r = run({ ways: [street({ 'parking:both': 'no' }), mapped] }, undefined, [
      [[E + 20, N + 11], [E + 60, N + 11]], // the mapped hedge again
      [[E + 100, N + 12], [E + 120, N + 12]],
      [[E + 150, N - 6], [E + 150, N + 6]], // across the street
    ]);
    const hedges = records(r.tiles).filter((p) => p[0] === Prop.hedge);
    const measured = hedges.filter((p) => isMeasured(Prop.hedge, p[5]));
    expect(hedges.length - measured.length).toBe(10);
    expect(measured.length).toBe(5);
    expect(r.measuredHedges).toBe(5);
    for (const p of measured) expect(linearLength(p[5])).toBeCloseTo(4);
  });

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

describe('OSM detail props', () => {
  const pt = (e: number, n: number, tags: Record<string, string>, id = 50) => ({ id, tags, e, n });

  it('places the new furniture with its variant', () => {
    const recs = records(run({ ways: [street()], points: [
      pt(E + 30, N + 8, { amenity: 'vending_machine', vending: 'parking_tickets' }, 51),
      pt(E + 60, N + 8, { historic: 'memorial', memorial: 'stele' }, 52),
      pt(E + 90, N + 8, { highway: 'speed_camera' }, 53),
      pt(E + 120, N + 9, { tourism: 'information', information: 'map' }, 54),
      pt(E + 150, N + 8, { historic: 'memorial', memorial: 'stolperstein' }, 55),
      pt(E + 30, N - 30, { amenity: 'hunting_stand' }, 56),
    ] }).tiles);
    const of = (k: PropKind) => recs.filter((r) => r[0] === k);
    expect(of(Prop.vending)[0][5]).toBe(1);
    expect(of(Prop.memorial)).toHaveLength(1);
    expect(of(Prop.memorial)[0][5]).toBe(1);
    expect(of(Prop.speedCamera)).toHaveLength(1);
    expect(of(Prop.infoBoard)[0][5]).toBe(1);
    expect(of(Prop.huntingStand)).toHaveLength(1);
  });

  it('opens a gate mapped on a road and moves it to the kerb, keeps big props off the lanes', () => {
    const recs = records(run({ ways: [street()], points: [pt(E + 50, N, { barrier: 'gate' }), pt(E + 100, N + 2, { advertising: 'billboard' }, 60)] }).tiles);
    const gate = recs.find((r) => r[0] === Prop.gate)!;
    expect(gate[5]).toBe(1);
    expect(Math.abs(gate[3])).toBeGreaterThan(2);
    // The billboard (3.8 m wide) is moved off the street, never left on it.
    for (const b of recs.filter((r) => r[0] === Prop.billboard)) expect(Math.abs(b[3])).toBeGreaterThan(2);
  });

  it('lays retaining walls along their way and adds mapped lamps', () => {
    const wall: Way = { id: 9, tags: { barrier: 'retaining_wall' }, pts: [[E, N + 20], [E + 40, N + 20]], ids: [90, 91], closed: false };
    const out = run({ ways: [street()], extra: { ways: [wall], areas: [] }, points: [pt(E + 70, N + 6, { highway: 'street_lamp' })] });
    const walls = records(out.tiles).filter((r) => r[0] === Prop.retainingWall);
    expect(walls.reduce((a, r) => a + linearLength(r[5]), 0)).toBeCloseTo(40, 0);
    expect(out.lamps).toHaveLength(1);
  });
});
