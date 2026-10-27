import { describe, expect, it } from 'vitest';
import { fieldPathCandidate, promoteFieldPaths } from '../pipeline/lib/fieldWays.ts';
import type { Polygon, Way } from '../pipeline/lib/osm.ts';
import { decodeRoad, encodeRoad, fieldGrass, isFieldWay, roadLook, roadSurface, SURFACE } from '../src/render/pbr/roadCode.ts';
import { bollardedEntry, FIELD_WAY, roadSection } from '../src/world/roadSpec.ts';

const way = (id: number, tags: Record<string, string>, e0 = 0): Way => ({ id, tags, pts: [[e0, 0], [e0 + 200, 0]], ids: [1, 2], closed: false });
const town: Polygon = { id: 9, tags: { landuse: 'residential' }, outer: [[1000, -500], [2000, -500], [2000, 500], [1000, 500], [1000, -500]], holes: [] };

describe('Feldwege', () => {
  it('promotes unpaved paths outside town to tracks, keeps paved and town paths', () => {
    const ways = [
      way(1, { highway: 'path' }),
      way(2, { highway: 'footway', surface: 'ground' }),
      way(3, { highway: 'cycleway', surface: 'asphalt' }),
      way(4, { highway: 'path', surface: 'dirt' }, 1200),
      way(5, { highway: 'footway' }),
      way(6, { highway: 'path', bridge: 'yes' }),
      way(7, { highway: 'steps' }),
    ];
    expect(promoteFieldPaths(ways, [town])).toBe(2);
    expect(ways.map((w) => w.tags.highway)).toEqual(['track', 'track', 'cycleway', 'path', 'footway', 'path', 'steps']);
    expect(ways[0].tags['sls:path']).toBe('path');
    expect(fieldPathCandidate({ highway: 'footway', footway: 'sidewalk', surface: 'gravel' })).toBe(false);
  });

  it('tracks are at least FIELD_WAY.min wide, 4 m by default, also over a narrow width tag', () => {
    expect(roadSection({ highway: 'track' })!.width).toBeCloseTo(4);
    expect(roadSection({ highway: 'track', width: '2.5' })!.width).toBeCloseTo(FIELD_WAY.min);
    expect(roadSection({ highway: 'track', width: '5' })!.width).toBeCloseTo(5);
  });

  it('unpaved tracks get the Feldweg look, paved farm roads stay asphalt', () => {
    expect(isFieldWay({ highway: 'track', tracktype: 'grade3' })).toBe(true);
    expect(isFieldWay({ highway: 'track', surface: 'gravel' })).toBe(true);
    expect(isFieldWay({ highway: 'track', tracktype: 'grade1' })).toBe(false);
    expect(isFieldWay({ highway: 'track', surface: 'asphalt' })).toBe(false);
    expect(roadSurface({ highway: 'track', surface: 'gravel' }, 1)).toBe(SURFACE.field);
    expect(roadSurface({ highway: 'track', surface: 'concrete' }, 1)).toBeLessThanOrEqual(SURFACE.asphalt_cracked);
    const look = roadLook({ highway: 'track', tracktype: 'grade4' }, 1, { width: 4, oneway: false, outer: 0, inner: 0 }, false);
    expect(look).toMatchObject({ surface: SURFACE.field, lines: 3, gutter: false });
    expect(decodeRoad(encodeRoad(look))).toMatchObject({ surface: SURFACE.field, lines: 3, width: 4 });
    expect(roadLook({ highway: 'track', surface: 'gravel', tracktype: 'grade2' }, 1, { width: 4, oneway: false, outer: 0, inner: 0 }, false).gutter).toBe(true);
    expect(fieldGrass({ highway: 'track', 'sls:path': 'path' })).toBe(3);
  });

  it('no bollards across Feldwege', () => {
    expect(bollardedEntry({ highway: 'track', motor_vehicle: 'no' })).toBe(false);
    expect(bollardedEntry({ highway: 'service', motor_vehicle: 'no' })).toBe(true);
  });
});
