import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isPath, meshHeight } from '../pipeline/lib/paths.ts';
import { isDrivable, isMotorRoad } from '../pipeline/lib/roads.ts';
import { PROP_STRIDE, Prop } from '../src/world/propKinds.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';
import { noCars, pathWidth } from '../src/world/roadSpec.ts';
import { TileContent, type RoadGraphData, type WorldIndex } from '../src/world/format.ts';

describe('ways without cars', () => {
  it('tells roads, roads closed to cars and paths apart', () => {
    expect(noCars({ highway: 'residential' })).toBe(false);
    expect(noCars({ highway: 'pedestrian' })).toBe(true);
    expect(noCars({ highway: 'service', access: 'private' })).toBe(true);
    expect(noCars({ highway: 'track', motor_vehicle: 'agricultural' })).toBe(true);
    // The most specific tag wins.
    expect(noCars({ highway: 'service', access: 'private', motor_vehicle: 'permissive' })).toBe(false);
    expect(noCars({ highway: 'residential', motor_vehicle: 'destination' })).toBe(false);
    // Closed roads keep their carriageway (seamless with the network) but are no motor roads.
    expect(isDrivable({ highway: 'service', access: 'no' })).toBe(true);
    expect(isMotorRoad({ highway: 'service', access: 'no' })).toBe(false);
    expect(isMotorRoad({ highway: 'pedestrian' })).toBe(false);
    expect(isDrivable({ highway: 'footway' })).toBe(false);
  });

  it('draws standalone paths only', () => {
    expect(isPath({ highway: 'footway' })).toBe(true);
    expect(isPath({ highway: 'cycleway' })).toBe(true);
    expect(isPath({ highway: 'steps' })).toBe(true);
    expect(isPath({ highway: 'footway', footway: 'sidewalk' })).toBe(false);
    expect(isPath({ highway: 'footway', footway: 'crossing' })).toBe(false);
    expect(isPath({ highway: 'footway', bridge: 'yes' })).toBe(false);
    expect(isPath({ highway: 'path', tunnel: 'building_passage' })).toBe(false);
    expect(isPath({ highway: 'pedestrian', area: 'yes' })).toBe(false);
    expect(isPath({ highway: 'residential' })).toBe(false);
    expect(pathWidth({ highway: 'path' })).toBe(1.5);
    expect(pathWidth({ highway: 'footway', width: '3' })).toBe(3);
    expect(pathWidth({ highway: 'footway', width: '40' })).toBe(2);
  });

  it('drapes paths on the terrain mesh triangles', () => {
    // A plane is reproduced exactly, between and on the 4 m grid nodes.
    const h = meshHeight((e, n) => 0.1 * e - 0.05 * n);
    for (const [e, n] of [[1, 1], [3.9, 0.2], [6, -7], [10, 10]]) expect(h(e, n)).toBeCloseTo(0.1 * e - 0.05 * n, 5);
  });

  it('routes around roads closed to cars', () => {
    // A square a-b-c-d with a short closed side a-d: the route from a to d goes the long way round.
    const p = (...xz: number[][]) => xz.flatMap(([x, z]) => [x, 0, z]);
    const data: RoadGraphData = {
      v: 1, names: ['Ring', 'Zone'], nodes: p([0, 0], [100, 0], [100, 100], [0, 100]),
      edges: [
        { a: 0, b: 1, n: 0, c: 3, p: p([0, 0], [100, 0]) },
        { a: 1, b: 2, n: 0, c: 3, p: p([100, 0], [100, 100]) },
        { a: 2, b: 3, n: 0, c: 3, p: p([100, 100], [0, 100]) },
        { a: 0, b: 3, n: 1, c: 2, x: 1, p: p([0, 0], [0, 100]) },
      ],
      w: [{ k: 0, w: 2, s: 7, p: p([20, 50], [80, 50]) }],
    };
    const g = new RoadGraph(data);
    expect(g.edges[3].noCars).toBe(true);
    const from = g.snap(1, 1, 10, (e) => !e.noCars)!;
    const to = g.snap(1, 99, 10, (e) => !e.noCars)!;
    expect(g.route(from, to)!.length).toBeGreaterThan(250);
    expect(g.paths[0].kind).toBe('footway');
    expect(g.pathNear(50, 51, 5)!.dist).toBeCloseTo(1);
  });
});

describe('fixture paths and pedestrian zone', () => {
  it('builds paths off the roads, flags closed roads and puts bollards at the zone entrance', () => {
    execFileSync(process.execPath, ['pipeline/build.ts', 'fixture'], { stdio: 'pipe' });
    const graph: RoadGraphData = JSON.parse(readFileSync('public/tiles/graph.json', 'utf8'));
    const g = new RoadGraph(graph);
    expect(g.paths.map((p) => p.kind).sort()).toEqual(['cycleway', 'footway', 'path', 'steps']);
    expect(g.edges.filter((e) => e.noCars).map((e) => e.name).sort()).toEqual(['', 'Fußgängerzone']);

    const index: WorldIndex = JSON.parse(readFileSync('public/tiles/index.json', 'utf8'));
    let vertices = 0, bollards: number[][] = [];
    for (const [ix, iy] of index.tiles) {
      const buf = gunzipSync(readFileSync(`public/tiles/t/${ix}_${iy}.bin`));
      const t = new TileContent(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      const pos = t.f32('paths.pos');
      if (pos)
        for (let i = 0; i < pos.length; i += 3) {
          vertices++;
          // No path vertex on a carriageway open to cars.
          const s = g.snap(pos[i], pos[i + 2], 20, (e) => !e.noCars);
          if (s) expect(s.dist).toBeGreaterThan(s.edge.width / 2);
        }
      const props = t.f32('props');
      if (props) for (let i = 0; i < props.length; i += PROP_STRIDE) if (props[i] === Prop.bollard) bollards.push([props[i + 1], props[i + 3]]);
    }
    expect(vertices).toBeGreaterThan(50);
    // The bollard row stands inside the pedestrian zone, off the street it leaves.
    const zone = g.edges.find((e) => e.name === 'Fußgängerzone')!;
    expect(bollards.length).toBeGreaterThanOrEqual(2);
    for (const [x, z] of bollards) {
      expect(g.snap(x, z, 10)!.edge).toBe(zone);
      const road = g.snap(x, z, 20, (e) => !e.noCars)!;
      expect(road.dist).toBeGreaterThan(road.edge.width / 2);
    }
  });
});
