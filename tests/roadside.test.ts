import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../src/vehicle/roadSurface.ts';
import { Ground, type WorldInfo } from '../src/world/format.ts';
import { GUARD_RAIL, RAIL_FLAGS, addRailColliders, railHeightFactor, railRuns } from '../src/world/guardRail.ts';
import { railGeometry } from '../src/world/rails.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';
import { GuardRails, railAlongRoad } from '../pipeline/lib/guardRails.ts';
import { isExpressway, planKerbs, taggedSidewalks } from '../pipeline/lib/kerbs.ts';
import type { Polygon, Way } from '../pipeline/lib/osm.ts';
import { bendRadius, buildRoadside } from '../pipeline/lib/roadside.ts';
import { Prop } from '../src/world/propKinds.ts';

beforeAll(async () => {
  await RAPIER.init();
});

const world: WorldInfo = { zone: 32, originE: 0, originN: 0, tileSize: 256 };
const way = (id: number, tags: Record<string, string>, pts: [number, number][]): Way => ({ id, tags, pts, ids: pts.map((_, i) => id * 100 + i), closed: false });
const town: Polygon = { id: 1, tags: { landuse: 'residential' }, outer: [[-500, -500], [500, -500], [500, 500], [-500, 500], [-500, -500]], holes: [] };

describe('kerbs', () => {
  it('reads sidewalk sides from the tags', () => {
    expect(taggedSidewalks({ sidewalk: 'right' })).toEqual({ left: false, right: true });
    expect(taggedSidewalks({ sidewalk: 'both' })).toEqual({ left: true, right: true });
    expect(taggedSidewalks({ 'sidewalk:left': 'yes', 'sidewalk:right': 'no' })).toEqual({ left: true, right: false });
    expect(taggedSidewalks({ sidewalk: 'no' })).toEqual({ left: false, right: false });
    expect(taggedSidewalks({ highway: 'residential' })).toBeUndefined();
  });

  it('puts kerbs only on town streets, never on Schnellstraßen', () => {
    const inTown = way(1, { highway: 'residential' }, [[0, 0], [100, 0]]);
    const rural = way(2, { highway: 'secondary' }, [[2000, 0], [2200, 0]]);
    const motorroad = way(3, { highway: 'primary', motorroad: 'yes', sidewalk: 'both' }, [[0, 50], [100, 50]]);
    const trunk = way(4, { highway: 'trunk' }, [[0, 80], [100, 80]]);
    const fast = way(5, { highway: 'tertiary', maxspeed: '100' }, [[0, 120], [100, 120]]);
    planKerbs([inTown, rural, motorroad, trunk, fast], [town]);
    expect(inTown.sidewalks).toEqual({ left: true, right: true });
    expect(inTown.urban).toBe(true);
    expect(rural.sidewalks).toEqual({ left: false, right: false });
    expect(rural.urban).toBe(false);
    expect(motorroad.sidewalks).toEqual({ left: false, right: false });
    expect(trunk.sidewalks).toEqual({ left: false, right: false });
    expect(fast.urban).toBe(false);
    expect(isExpressway({ highway: 'motorway_link' })).toBe(true);
    expect(isExpressway({ highway: 'primary', expressway: 'yes' })).toBe(true);
    expect(isExpressway({ highway: 'primary' })).toBe(false);
  });

  it('marks lowered kerbs at mapped crossings', () => {
    const w = way(1, { highway: 'residential' }, [[0, 0], [30, 0], [60, 0]]);
    planKerbs([w], [town], [{ id: w.ids[1], tags: { highway: 'crossing' }, e: 30, n: 0 }]);
    expect(w.lowered).toEqual([30]);
  });

  it('the car only finds a pavement on the sides that have one', () => {
    const g = (k: number) => new RoadGraph({ v: 1, names: ['x'], nodes: [0, 0, 0, 100, 0, 0], edges: [{ a: 0, b: 1, n: 0, c: 5, w: 6, k, p: [0, 0, 0, 100, 0, 0] }] });
    // Along +x, right of the direction is +z (south).
    expect(classify(g(1), () => Ground.grass, 50, 4.5).kind).toBe('gehweg');
    expect(classify(g(1), () => Ground.grass, 50, -4.5).kind).toBe('gras');
    expect(classify(g(2), () => Ground.grass, 50, -4.5).kind).toBe('gehweg');
    expect(classify(g(0), () => Ground.grass, 50, 4.5).kind).toBe('gras');
  });
});

describe('guard rails', () => {
  it('cuts runs at tile edges and keeps terminals measured along the whole run', () => {
    const rails = new GuardRails(world);
    const pts = Array.from({ length: 41 }, (_, i) => ({ e: 200 + i * 4, n: 10, y: 5 }));
    rails.add(pts);
    const tiles = rails.tiles();
    expect([...tiles.keys()].sort()).toEqual(['0_0', '1_0']);
    const a = railRuns(Float32Array.from(tiles.get('0_0')!))[0];
    const b = railRuns(Float32Array.from(tiles.get('1_0')!))[0];
    expect(a.total).toBeCloseTo(160);
    // The cut point is in both pieces.
    expect(b.cum[0]).toBeCloseTo(a.cum[a.cum.length - 1]);
    expect(railHeightFactor(a, 0)).toBe(0);
    expect(railHeightFactor(a, GUARD_RAIL.terminal)).toBe(1);
    expect(railHeightFactor(b, 160)).toBe(0);
    expect(railHeightFactor(b, 100)).toBe(1);
  });

  it('runs beside a road keep the road on their left', () => {
    const ring = Array.from({ length: 11 }, (_, i) => ({ e: i * 4, n: 0, dx: 1, dy: 0, y: 0, dist: i * 4 }));
    const [right] = railAlongRoad(ring, 1, () => 4, () => true);
    const [left] = railAlongRoad(ring, -1, () => 4, () => true);
    // Right of an eastbound road is south (n < 0); its rail runs east, the left one runs west.
    expect(right[0].n).toBeCloseTo(-4);
    expect(right[1].e).toBeGreaterThan(right[0].e);
    expect(left[0].n).toBeCloseTo(4);
    expect(left[1].e).toBeLessThan(left[0].e);
    // A gap where the rail is not wanted splits the run.
    expect(railAlongRoad(ring, 1, () => 4, (p) => p.dist !== 20)).toHaveLength(2);
  });

  it('builds a mesh and colliders that stand behind the face', () => {
    const d = Float32Array.from([3, RAIL_FLAGS.startEnd | RAIL_FLAGS.endEnd, 0, 40, 0, 0, 0, 20, 0, 0, 40, 0, 0]);
    const runs = railRuns(d);
    const g = railGeometry(runs);
    expect(g.getAttribute('position').count).toBeGreaterThan(100);
    const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    let n = 0;
    addRailColliders(RAPIER, w, body, d, (c) => {
      n++;
      // Run along +x: the road is on the left (-z), the collider behind it (+z).
      expect(c.translation().z).toBeGreaterThan(0);
    });
    expect(n).toBeGreaterThan(5);
  });
});

describe('roadside', () => {
  it('measures bend radii', () => {
    const R = 100;
    const ring = Array.from({ length: 30 }, (_, i) => {
      const a = (i * 4) / R;
      return { dx: Math.cos(a), dy: Math.sin(a), dist: i * 4 };
    });
    expect(bendRadius(ring, 10)).toBeCloseTo(R, 0);
    expect(bendRadius(Array.from({ length: 10 }, (_, i) => ({ dx: 1, dy: 0, dist: i * 4 })), 5)).toBe(Infinity);
  });

  it('puts delineators along rural roads, chevrons in sharp bends, nothing in town', () => {
    const R = 60;
    const bend: [number, number][] = Array.from({ length: 30 }, (_, i) => {
      const a = (i * 4) / R;
      return [3000 + Math.sin(a) * R, R - Math.cos(a) * R];
    });
    const straight: [number, number][] = [[1000, 0], [1400, 0]];
    const rural = way(1, { highway: 'secondary' }, straight);
    const curvy = way(2, { highway: 'tertiary' }, bend);
    const urban = way(3, { highway: 'residential' }, [[0, 0], [200, 0]]);
    planKerbs([rural, curvy, urban], [town]);
    const out = buildRoadside([rural, curvy, urban], { world, height: () => 0, onLanes: () => false });
    const kinds: number[] = [];
    let urbanProps = 0;
    for (const list of out.props.values())
      for (let i = 0; i < list.length; i += 6) {
        kinds.push(list[i]);
        if (list[i + 1] < 300) urbanProps++;
      }
    expect(urbanProps).toBe(0);
    // 400 m straight: posts every 50 m on both sides.
    expect(kinds.filter((k) => k === Prop.delineator).length).toBeGreaterThanOrEqual(16);
    expect(kinds.some((k) => k === Prop.chevronLeft)).toBe(true);
    expect(kinds.some((k) => k === Prop.chevronRight)).toBe(true);
  });

  it('rails motorways and embankments, never across a junction', () => {
    const mw = way(1, { highway: 'motorway' }, [[1000, 0], [1400, 0]]);
    const side = way(2, { highway: 'tertiary' }, [[1200, 0], [1200, -200]]);
    side.ids[0] = mw.ids[0] + 50;
    mw.ids = [mw.ids[0], mw.ids[0] + 50, mw.ids[1]];
    mw.pts = [[1000, 0], [1200, 0], [1400, 0]];
    const dyke = way(3, { highway: 'secondary' }, [[3000, 0], [3200, 0]]);
    // The ground falls 4 m away from the second road between x 3050 and 3150.
    const height = (e: number, n: number) => (e > 3050 && e < 3150 && Math.abs(n) > 6 ? -4 : 0);
    planKerbs([mw, side, dyke], []);
    const out = buildRoadside([mw, side, dyke], { world, height, onLanes: () => false });
    expect(out.counts.motorway).toBeGreaterThan(0);
    expect(out.counts.embankments).toBe(1);
    // No rail point within the junction mouth at x 1200.
    for (const r of out.rails.runs) for (const p of r.pts) if (Math.abs(p.n) < 12) expect(Math.abs(p.e - 1200)).toBeGreaterThan(5);
  });

  it('builds one double rail in a narrow median, single rails beside a wide one', () => {
    const tags = { highway: 'motorway', oneway: 'yes', lanes: '2' };
    // Two carriageways 15 m apart (centre to centre) from x 0 to 400, then 40 m apart.
    const east = way(1, tags, [[0, 0], [400, 0]]);
    const west = way(2, tags, [[400, 15], [0, 15]]);
    const eastFar = way(3, tags, [[2000, 0], [2400, 0]]);
    const westFar = way(4, tags, [[2400, 40], [2000, 40]]);
    const all = [east, west, eastFar, westFar];
    planKerbs(all, []);
    const out = buildRoadside(all, { world, height: () => 0, onLanes: () => false });
    const double = out.rails.runs.filter((r) => r.flags & RAIL_FLAGS.double);
    expect(double.length).toBe(1);
    // In the middle of the median, built once (by the lower id), nearly the whole length.
    for (const p of double[0].pts) expect(p.n).toBeCloseTo(7.5, 1);
    expect(double[0].length).toBeGreaterThan(380);
    expect(out.counts.medianKm).toBeGreaterThan(0.3);
    // No single rails on the median side of the close pair; the far pair keeps a single rail each side.
    const single = out.rails.runs.filter((r) => !(r.flags & RAIL_FLAGS.double));
    expect(single.some((r) => r.pts[0].e < 500 && r.pts.every((p) => p.n > 0 && p.n < 15))).toBe(false);
    expect(single.filter((r) => r.pts[0].e > 1500 && r.pts.every((p) => p.n > 0 && p.n < 40)).length).toBe(2);
  });
});
