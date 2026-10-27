import { describe, expect, it } from 'vitest';
import { fillSlots } from '../pipeline/lib/slots.ts';
import { TileMap } from '../pipeline/lib/tilebuf.ts';

const world = { originE: 0, originN: 16, tileSize: 16 } as never;

/** A flat road rectangle over local x0…x1 and z 0…16 at height y. */
function road(tiles: TileMap, x0: number, x1: number, y: number) {
  const t = tiles.at(1, 1);
  const v = [[x0, 0], [x1, 0], [x1, 16], [x0, 16]].map(([x, z]) => t.roads.vertex(x, y, z, { uv: [0.5, 0] }));
  t.roads.tri(v[0], v[3], v[1]);
  t.roads.tri(v[1], v[3], v[2]);
}

describe('slots between carriageways', () => {
  it('patches a 1 m slot between two roads at about one height, drawn and collidable', () => {
    const tiles = new TileMap(16);
    road(tiles, 0, 4, 1);
    road(tiles, 5, 9, 1.2);
    const t = tiles.at(1, 1);
    const before = t.roads.idx.length;
    // Two cells across the slot on every row of the 16 m long strip.
    expect(fillSlots(tiles, world)).toBe(2 * 32);
    expect(t.roads.idx.length - before).toBe(2 * 32 * 6);
    expect(t.collide.idx.length).toBe(2 * 32 * 6);
    // Heights between the two roads (a little under them where a patch reaches onto one), every patch facing up.
    for (let i = before; i < t.roads.idx.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => t.roads.idx[i + k]).map((k) => t.roads.pos.slice(k * 3, k * 3 + 3));
      expect(a[1]).toBeGreaterThanOrEqual(0.98 - 1e-6);
      expect(a[1]).toBeLessThan(1.2);
      // Half a cell onto the road beside the slot, at that road's height: no saw-tooth left against its edge.
      if (a[0] < 4) expect(a[1]).toBeCloseTo(0.98, 5);
      if (a[0] > 5) expect(a[1]).toBeCloseTo(1.18, 5);
      expect((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])).toBeGreaterThan(0);
    }
  });

  it('closes what one pass leaves: short runs between the patches of a junction corner', () => {
    const tiles = new TileMap(16);
    road(tiles, 0, 4, 1);
    // A second road ending 1 m to the right of the first, beside a third further right: an L-shaped slot.
    const t = tiles.at(1, 1);
    const v = [[5, 0], [9, 0], [9, 6], [5, 6]].map(([x, z]) => t.roads.vertex(x, 1, z, { uv: [0.5, 0] }));
    t.roads.tri(v[0], v[3], v[1]);
    t.roads.tri(v[1], v[3], v[2]);
    const w = [[4, 7], [9, 7], [9, 16], [4, 16]].map(([x, z]) => t.roads.vertex(x, 1, z, { uv: [0.5, 0] }));
    t.roads.tri(w[0], w[3], w[1]);
    t.roads.tri(w[1], w[3], w[2]);
    fillSlots(tiles, world);
    // Afterwards no slot remains anywhere.
    expect(fillSlots(tiles, world)).toBe(0);
  });

  it('leaves wide gaps and roads at different levels alone', () => {
    const wide = new TileMap(16);
    road(wide, 0, 4, 1);
    road(wide, 6, 9, 1);
    expect(fillSlots(wide, world)).toBe(0);
    const levels = new TileMap(16);
    road(levels, 0, 4, 1);
    road(levels, 5, 9, 2);
    expect(fillSlots(levels, world)).toBe(0);
  });
});

describe('pockets between carriageways', () => {
  /** A 12 m square of road at height 1 with a hole of n × n cells (0.5 m) in the middle, as a grid of 0.5 m quads. */
  function holed(n: number) {
    const tiles = new TileMap(16);
    const t = tiles.at(1, 1);
    const lo = 12 - n / 2, hi = 12 + n / 2;
    for (let i = 0; i < 24; i++)
      for (let j = 0; j < 24; j++) {
        if (i >= lo && i < hi && j >= lo && j < hi) continue;
        const v = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([x, z]) => t.roads.vertex(x / 2, 1, z / 2, { uv: [0.5, 0] }));
        t.roads.tri(v[0], v[3], v[1]);
        t.roads.tri(v[1], v[3], v[2]);
      }
    return tiles;
  }

  it('patches a closed hole wider than a slot whole, at the height around it', () => {
    const tiles = holed(4);
    expect(fillSlots(tiles, world)).toBe(16);
    expect(fillSlots(tiles, world)).toBe(0);
    const t = tiles.at(1, 1);
    for (let i = 1; i < t.collide.pos.length; i += 3) expect(t.collide.pos[i]).toBeCloseTo(1 - 0.02 - 0.05, 5);
  });

  it('leaves larger holes (a verge between two roads) alone', () => {
    expect(fillSlots(holed(6), world)).toBe(0);
  });
});
