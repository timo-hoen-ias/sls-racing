import { describe, expect, it } from 'vitest';
import { Discovery } from '../src/game/discovery.ts';
import { districtList } from '../pipeline/lib/districts.ts';

describe('discovering the town (W5)', () => {
  it('reveals each district once, by the nearest centre, and viewpoints when stopping close by', () => {
    const d = new Discovery(['district:Roden']);
    d.districts = [{ name: 'Innenstadt', x: 0, z: 0 }, { name: 'Roden', x: 0, z: -2000 }, { name: 'Lisdorf', x: 500, z: 1200 }];
    d.viewpoints = [{ id: 'rathaus', name: 'Rathaus', x: 100, z: 0, radius: 30 }];
    const log: string[] = [];
    d.onDistrict = (x, n, total) => log.push(`${x.name} ${n}/${total}`);
    d.onViewpoint = (v) => log.push(v.name);
    d.update(10, 10, 20);
    d.update(20, 10, 20);
    d.update(0, -1500, 20);
    d.update(90, 20, 20);
    d.update(90, 20, 3);
    d.update(400, 900, 20);
    d.update(9000, 0, 20);
    expect(log).toEqual(['Innenstadt 2/3', 'Rathaus', 'Lisdorf 3/3']);
    expect(d.at(9000, 0)).toBeUndefined();
  });

  it('takes the place nodes inside the boundary, the town node as the old town', () => {
    const list = districtList({
      boundary: [[[0, 0], [100, 0], [100, 100], [0, 100]]],
      points: [
        { id: 1, tags: { place: 'town', name: 'Saarlouis' }, e: 50, n: 50 },
        { id: 2, tags: { place: 'suburb', name: 'Roden' }, e: 20, n: 80 },
        { id: 3, tags: { place: 'village', name: 'Bous' }, e: 300, n: 50 },
        { id: 4, tags: { place: 'farm', name: 'Sandhof' }, e: 30, n: 30 },
      ],
    }, (e, n) => [e, -n]);
    expect(list).toEqual([{ name: 'Innenstadt', x: 50, z: -50 }, { name: 'Roden', x: 20, z: -80 }]);
  });
});
