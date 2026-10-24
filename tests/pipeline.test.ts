import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { densify, roadWidth } from '../pipeline/lib/roads.ts';
import { buildingHeight } from '../pipeline/lib/buildings.ts';
import { joinRings } from '../pipeline/lib/osm.ts';
import { TERRAIN_N, decodeF32, decodeU32, tileOfLocal, type TileData, type WorldIndex } from '../src/world/format.ts';

describe('pipeline helpers', () => {
  it('derives road widths from OSM tags', () => {
    expect(roadWidth({ highway: 'residential' })).toBe(6);
    expect(roadWidth({ highway: 'primary', lanes: '4' })).toBeCloseTo(14);
    expect(roadWidth({ highway: 'footway' })).toBeUndefined();
  });

  it('derives building heights', () => {
    expect(buildingHeight({ building: 'yes', height: '21.5' })).toBe(21.5);
    expect(buildingHeight({ building: 'yes', 'building:levels': '3' })).toBe(10);
    expect(buildingHeight({ building: 'garage' })).toBe(2.8);
  });

  it('densifies polylines to at most 4 m steps', () => {
    const pts = densify([[0, 0], [10, 0]]);
    expect(pts.length).toBe(4);
    expect(pts[pts.length - 1]).toEqual([10, 0]);
  });

  it('joins multipolygon ways into rings', () => {
    const rings = joinRings([[[0, 0], [1, 0], [1, 1]], [[0, 0], [0, 1], [1, 1]]]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
  });
});

describe('fixture world build', () => {
  it('writes an index and consistent tiles', () => {
    execFileSync(process.execPath, ['pipeline/build.ts', 'fixture'], { stdio: 'pipe' });
    const index: WorldIndex = JSON.parse(readFileSync('public/tiles/index.json', 'utf8'));
    expect(index.tiles.length).toBeGreaterThan(20);
    const [sx, sy] = tileOfLocal(index.world, index.spawn.x, index.spawn.z);
    expect(index.tiles.some(([x, y]) => x === sx && y === sy)).toBe(true);
    const tile: TileData = JSON.parse(readFileSync(`public/tiles/t/${sx}_${sy}.json`, 'utf8'));
    expect(decodeF32(tile.terrain)).toHaveLength(TERRAIN_N * TERRAIN_N);
    const pos = decodeF32(tile.roads!.pos);
    const idx = decodeU32(tile.roads!.idx!);
    expect(Math.max(...idx)).toBeLessThan(pos.length / 3);
  });
});
