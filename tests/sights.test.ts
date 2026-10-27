import { describe, expect, it } from 'vitest';
import { buildSights, limitOf } from '../pipeline/lib/sights.ts';
import type { OsmData } from '../pipeline/lib/osm.ts';
import { SpeedCameras } from '../src/game/speedCameras.ts';
import { strokesFor } from '../src/audio/bells.ts';
import type { WorldInfo } from '../src/world/format.ts';

const world: WorldInfo = { zone: 32, originE: 1000, originN: 1000, tileSize: 256 };

describe('sights, speed cameras and bells', () => {
  it('reads speed limits', () => {
    expect(limitOf({ maxspeed: '70' })).toBe(70);
    expect(limitOf({ maxspeed: 'DE:urban' })).toBe(50);
    expect(limitOf({})).toBeUndefined();
  });

  it('collects named sights, churches and cameras with the road limit and direction', () => {
    const church: [number, number][] = [[1100, 1100], [1130, 1100], [1130, 1120], [1100, 1120], [1100, 1100]];
    const osm: Pick<OsmData, 'points' | 'polygons' | 'ways' | 'extra'> = {
      points: [
        { id: 1, tags: { historic: 'memorial', name: 'Ehrenmal' }, e: 1050, n: 1050 },
        { id: 2, tags: { historic: 'memorial', memorial: 'stolperstein', name: 'X' }, e: 1060, n: 1050 },
        { id: 3, tags: { highway: 'speed_camera' }, e: 1205, n: 1003 },
      ],
      polygons: [{ id: 4, tags: { amenity: 'place_of_worship', religion: 'christian', building: 'church', name: 'St. Ludwig' }, outer: church, holes: [] }],
      ways: [{ id: 5, tags: { highway: 'primary', maxspeed: '70', name: 'Lisdorfer Straße' }, pts: [[1100, 1000], [1300, 1000]], ids: [6, 7], closed: false }],
    };
    const s = buildSights(osm, world, () => 200, () => true);
    expect(s.sights.map((x) => x.name)).toEqual(['Ehrenmal']);
    expect(s.churches).toHaveLength(1);
    expect(s.churches[0].big).toBe(true);
    expect(s.cameras).toHaveLength(1);
    expect(s.cameras[0]).toMatchObject({ limit: 70, street: 'Lisdorfer Straße', dx: 1 });
  });

  it('measures a car crossing the camera line and pays for a new best', () => {
    const cams = new SpeedCameras();
    cams.list = [{ id: 'a', x: 0, y: 0, z: 0, limit: 50, street: 'Test', dx: 1, dz: 0 }];
    const passes: number[] = [];
    cams.onPass = (p) => passes.push(p.kmh);
    cams.update(-5, 3, 30);
    cams.update(5, 3, 30);
    expect(passes).toEqual([108]);
    // Far beside the road: no measurement.
    cams.update(-5, 30, 30);
    cams.update(5, 30, 30);
    expect(passes).toHaveLength(1);
    expect(SpeedCameras.reward({ camera: cams.list[0], kmh: 108, best: 108, record: false, over: 58 }, 0).xp).toBeGreaterThan(0);
    expect(SpeedCameras.reward({ camera: cams.list[0], kmh: 100, best: 108, record: false, over: 50 }, 108).xp).toBe(0);
  });

  it('strikes the hour on the 12-hour clock', () => {
    expect(strokesFor(0)).toBe(12);
    expect(strokesFor(13)).toBe(1);
    expect(strokesFor(12)).toBe(12);
  });
});
