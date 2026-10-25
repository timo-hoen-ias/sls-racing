import { afterEach, describe, expect, it } from 'vitest';
import { halfWidthAt, halfWidths } from '../pipeline/lib/overlap.ts';
import type { Way } from '../pipeline/lib/osm.ts';
import type { WorldInfo } from '../src/world/format.ts';
import { roadSection, setRoadProfile } from '../src/world/roadSpec.ts';

const world = { originE: 0, originN: 0, tileSize: 256 } as WorldInfo;
const way = (id: number, n: number): Way =>
  ({ id, ids: [id * 10, id * 10 + 1], pts: [[0, n], [100, n]], closed: false, urban: true, tags: { highway: 'residential' } });
/** Two parallel streets 8 m apart, the northern one 1.2 m higher (on an embankment). */
const ways = () => [way(1, 0), way(2, 8)];
const height = (_e: number, n: number) => (n > 4 ? 1.2 : 0);

afterEach(() => setRoadProfile('real'));

describe('roads side by side at different heights', () => {
  it('real profile: 6 m streets 8 m apart do not touch and keep their width', () => {
    const ws = ways();
    const [left, right] = halfWidthAt(halfWidths(ws, height, world).get(ws[0])!, 50);
    expect(left).toBeCloseTo(3);
    expect(right).toBeCloseTo(3);
  });

  it('game profile: widened streets keep a bank between them, but stay at least as wide as the real ones', () => {
    setRoadProfile('game');
    const ws = ways();
    const h = halfWidths(ws, height, world);
    const [left, right] = halfWidthAt(h.get(ws[0])!, 50);
    // 8 m between centrelines, 1.8 m bank for 1.2 m height: 3.1 m each side facing the other road.
    expect(left).toBeCloseTo(3.1, 1);
    expect(right).toBeCloseTo(4.05, 1);
    const [l2, r2] = halfWidthAt(h.get(ws[1])!, 50);
    expect(r2).toBeCloseTo(3.1, 1);
    expect(l2).toBeCloseTo(4.05, 1);
  });

  it('game profile: counts the shift of a motorway towards its hard shoulder', () => {
    setRoadProfile('game');
    // Motorway heading east, a track 12.6 m to its right (south) and 1.2 m lower.
    const mw: Way = { id: 1, ids: [1, 2], pts: [[0, 0], [100, 0]], closed: false, urban: false, tags: { highway: 'motorway', oneway: 'yes', lanes: '2' } };
    const track: Way = { id: 2, ids: [3, 4], pts: [[0, -12.6], [100, -12.6]], closed: false, urban: false, tags: { highway: 'track' } };
    const h = halfWidths([mw, track], (_e, n) => (n < -6 ? 0 : 1.2), world);
    const sec = roadSection(mw.tags)!;
    const [, right] = halfWidthAt(h.get(mw)!, 50);
    const edge = sec.width / 2 + sec.shift - (sec.width / 2 - right);
    const [left] = halfWidthAt(h.get(track)!, 50);
    // Room for a 1:1.5 bank (1.8 m) stays between the hard shoulder and the track.
    expect(12.6 - edge - left).toBeGreaterThan(1.7);
  });
});
