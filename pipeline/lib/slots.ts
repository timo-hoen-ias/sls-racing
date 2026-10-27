// Narrow slots between drawn carriageways. Where two roads run close side by side, fork or meet at a junction
// corner, their surfaces can leave a strip of a few decimetres up to 1.5 m undrawn between them: too narrow for
// a verge, and a wheel over it drops onto the terrain or a collision bevel below (the surface check's `gap`).
// Wider game-profile roads leave many more of them. Each such cell gets a small patch of asphalt at the height
// between both roads, drawn and collidable like the road. Found exactly as the surface check finds them
// (src/world/surfaceScan.ts slotCells), on the same 0.5 m grid of local coordinates.
import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import { decodeRoad, encodeRoad } from '../../src/render/pbr/roadCode.ts';
import { type CellGrid, SURFACE_LIMITS, gridCols, slotCells } from '../../src/world/surfaceScan.ts';
import type { TileBuild, TileMap } from './tilebuf.ts';

const CELL = 0.5;
/**
 * A patch reaches from its cell to the centres of the cells around it (half a cell into each neighbour), so the
 * saw-tooth slivers a square per cell left against a road edge running at an angle are covered too (just short of
 * the centres, so the patch never decides on its own whether a neighbouring cell counts as drawn). Its corners
 * take the height of the road drawn there (or the slot's own height) and sit SINK below it, hidden under the
 * road where the two overlap.
 */
const REACH = CELL / 2 - 0.01;
/** Where a patch does not reach on, it still overlaps the road edge beside it this far (no hairline crack). */
const OVERLAP = 0.04;
const SINK = 0.02;
/** The collision surface sits this far under the drawn one, as for the road strips. */
const STRIP_DROP = 0.05;

/** Drawn height and road look of every cell of the grid covered by a road triangle. */
function rasterize(t: TileBuild, g: CellGrid, levels: Map<number, number[]>, looks: Map<number, number>) {
  const { pos, idx, uv } = t.roads;
  const hasUv = uv.length === (pos.length / 3) * 2;
  const C = g.cell, cols = gridCols(g);
  for (let k = 0; k + 2 < idx.length; k += 3) {
    const a = idx[k], b = idx[k + 1], c = idx[k + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const i0 = Math.max(g.c0, Math.floor(Math.min(ax, bx, cx) / C - 0.5)), i1 = Math.min(g.c1 - 1, Math.ceil(Math.max(ax, bx, cx) / C - 0.5));
    const j0 = Math.max(g.r0, Math.floor(Math.min(az, bz, cz) / C - 0.5)), j1 = Math.min(g.r1 - 1, Math.ceil(Math.max(az, bz, cz) / C - 0.5));
    if (i0 > i1 || j0 > j1) continue;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const x = (i + 0.5) * C, z = (j + 0.5) * C;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const key = (j - g.r0) * cols + (i - g.c0);
        let ys = levels.get(key);
        if (!ys) levels.set(key, (ys = []));
        ys.push(l1 * ay + l2 * by + l3 * cy);
        if (hasUv && !looks.has(key)) looks.set(key, uv[a * 2 + 1]);
      }
  }
}

/**
 * Patching passes: patches across one direction can leave short runs between them along the other, and a closed
 * pocket wider than a slot (the wedge where two carriageways meet) is filled from its rim one ring per pass.
 */
const PASSES = 10;

/** Fills the slots of every tile; returns how many 0.5 m cells were patched. */
export function fillSlots(tiles: TileMap, world: WorldInfo): number {
  let filled = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const n = fillPass(tiles, world);
    filled += n;
    if (!n) break;
  }
  return filled;
}

function fillPass(tiles: TileMap, world: WorldInfo): number {
  const T = world.tileSize;
  let filled = 0;
  for (const t of tiles.tiles.values()) {
    if (!t.roads.idx.length) continue;
    // The tile's area in local coordinates (north is -z), one slot width of cells beyond it for the context.
    const [x0, z1] = utmToLocal(world, t.ix * T, t.iy * T);
    const [x1, z0] = utmToLocal(world, (t.ix + 1) * T, (t.iy + 1) * T);
    const m = SURFACE_LIMITS.slot + 1;
    const g: CellGrid = { cell: CELL, c0: Math.floor(x0 / CELL) - m, c1: Math.ceil(x1 / CELL) + m, r0: Math.floor(z0 / CELL) - m, r1: Math.ceil(z1 / CELL) + m };
    const levels = new Map<number, number[]>(), looks = new Map<number, number>();
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const n = tiles.tiles.get(`${t.ix + dx}_${t.iy + dy}`);
        if (n) rasterize(n, g, levels, looks);
      }
    const cols = gridCols(g);
    const slots = slotCells(levels, g);
    // Road level drawn in cell k closest to the slot height y (within half a metre), or undefined.
    const near = (k: number, y: number) => {
      let best: number | undefined;
      for (const l of levels.get(k) ?? []) if (Math.abs(l - y) < 0.5 && (best === undefined || Math.abs(l - y) < Math.abs(best - y))) best = l;
      return best;
    };
    // A patch reaches half a cell into a neighbour only where that is more slot or a road at about the slot's
    // height and nothing else: never over terrain or over a road at another level (a bridge deck or the road
    // under it), where it would stand up as a step.
    const fits = (k: number, y: number) => {
      if (slots.has(k)) return true;
      const ls = levels.get(k);
      return !!ls?.length && ls.every((l) => Math.abs(l - y) < 0.5);
    };
    for (const [key, [y]] of slots) {
      const c = key % cols, r = (key - c) / cols;
      const x = (g.c0 + c) * CELL, z = (g.r0 + r) * CELL;
      // Each patch is drawn by the tile it lies in.
      if (x + CELL / 2 < x0 || x + CELL / 2 >= x1 || z + CELL / 2 < z0 || z + CELL / 2 >= z1) continue;
      const look = nearLook(looks, key, cols);
      const r0 = decodeRoad(look);
      const plain = encodeRoad({ ...r0, lines: 0, gutter: false });
      const fit = (dc: number, dr: number) => fits(key + dr * cols + dc, y);
      const W = fit(-1, 0), E = fit(1, 0), N = fit(0, -1), S = fit(0, 1);
      // Corners: into the diagonal neighbour only where it fits as well, else on the cell's own corner line on that
      // side; height from the road (or slot) the corner lies on, else the slot's own.
      const corner = (dc: number, dr: number, ex: boolean, ez: boolean): [number, number, number] => {
        const diag = ex && ez && fit(dc, dr);
        const ks = diag ? [key + dr * cols + dc, key + dc, key + dr * cols] : ex && !ez ? [key + dc] : ez && !ex ? [key + dr * cols] : [];
        const ox = ex && (diag || !ez) ? REACH : OVERLAP, oz = ez && (diag || !ex) ? REACH : OVERLAP;
        const cx = dc < 0 ? x - ox : x + CELL + ox, cz = dr < 0 ? z - oz : z + CELL + oz;
        for (const k of ks) {
          const l = near(k, y);
          if (l !== undefined) return [cx, l - SINK, cz];
        }
        for (const k of ks) {
          const sl = slots.get(k)?.[0];
          if (sl !== undefined) return [cx, sl - SINK, cz];
        }
        return [cx, y - SINK, cz];
      };
      quad(t, [corner(-1, -1, W, N), corner(1, -1, E, N), corner(1, 1, E, S), corner(-1, 1, W, S)], plain);
      filled++;
    }
  }
  return filled;
}

/** Look of the nearest drawn cell (searching outwards up to the slot width). */
function nearLook(looks: Map<number, number>, key: number, cols: number): number {
  for (let d = 1; d <= SURFACE_LIMITS.slot + 1; d++)
    for (const k of [key - d, key + d, key - d * cols, key + d * cols]) {
      const l = looks.get(k);
      if (l !== undefined) return l;
    }
  return 0;
}

/** A quad of road (drawn and collision) through corners [x, y, z] at the north-west, north-east, south-east and south-west, facing up. */
function quad(t: TileBuild, c: readonly [number, number, number][], look: number) {
  for (const [buf, drop, uv] of [[t.roads, 0, true], [t.collide, STRIP_DROP, false]] as const) {
    const v = c.map(([x, y, z]) => buf.vertex(x, y - drop, z, uv ? { uv: [0.5, look] } : {}));
    // Wound so the normal points up (+y) with x east and z south.
    buf.tri(v[0], v[3], v[1]);
    buf.tri(v[1], v[3], v[2]);
  }
}
