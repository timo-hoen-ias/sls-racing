import { describe, expect, it } from 'vitest';
import { RoadMask } from '../pipeline/lib/clearance.ts';
import type { OsmData, Way } from '../pipeline/lib/osm.ts';
import { buildProps, osmSignType } from '../pipeline/lib/props.ts';
import type { WorldInfo } from '../src/world/format.ts';
import { PROP_STRIDE, Prop } from '../src/world/propKinds.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };
const E = 1000, N = 1000;

/** Straight residential street running east from (E, N), 200 m long. */
function street(tags: Record<string, string> = {}): Way {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) pts.push([E + i * 20, N]);
  return { id: 1, tags: { highway: 'residential', ...tags }, pts, ids: pts.map((_, i) => i + 1), closed: false };
}

function run(osm: Partial<OsmData>) {
  const data: OsmData = { ways: [], polygons: [], trees: [], points: [], ...osm };
  const lanes = new RoadMask(data.ways, -0.5);
  return buildProps(data, { world, height: () => 0, onLanes: (e, n) => lanes.has(e, n), junctions: [] });
}

const records = (tiles: Map<string, number[]>) => [...tiles.values()].flatMap((d) => {
  const out: number[][] = [];
  for (let i = 0; i < d.length; i += PROP_STRIDE) out.push(d.slice(i, i + PROP_STRIDE));
  return out;
});

describe('street furniture', () => {
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
  });
});
