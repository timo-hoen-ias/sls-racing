import { Ground } from '../../src/world/format.ts';
import { pointInPolygon, type Polygon } from './osm.ts';

type GroundClass = (typeof Ground)[keyof typeof Ground];

export function groundClassOf(tags: Record<string, string>): { cls: GroundClass; prio: number } | undefined {
  const lu = tags.landuse, nat = tags.natural, lei = tags.leisure;
  if (nat === 'water' || tags.waterway === 'riverbank' || lu === 'reservoir' || lu === 'basin') return { cls: Ground.water, prio: 5 };
  if (tags.amenity === 'parking' || tags.amenity === 'fuel') return { cls: Ground.urban, prio: 4 };
  if (lu === 'forest' || nat === 'wood' || nat === 'scrub') return { cls: Ground.forest, prio: 3 };
  if (['grass', 'meadow', 'recreation_ground', 'village_green', 'cemetery', 'allotments', 'orchard', 'vineyard'].includes(lu) ||
      ['park', 'garden', 'pitch', 'playground'].includes(lei) || nat === 'grassland') return { cls: Ground.grass, prio: 2 };
  if (lu === 'farmland' || lu === 'farmyard') return { cls: Ground.farmland, prio: 1 };
  if (['residential', 'commercial', 'industrial', 'retail', 'railway', 'construction'].includes(lu)) return { cls: Ground.urban, prio: 0 };
  return undefined;
}

/**
 * Point lookup of ground classes with a coarse grid index. Per cell it keeps the polygons that reach into it,
 * by priority; a polygon none of whose edges crosses the cell covers the whole cell (or none of it, then it
 * is left out), so most lookups in large woods and fields need no point-in-polygon test.
 */
export class GroundIndex {
  private cells = new Map<number, { p: Polygon; cls: GroundClass; prio: number; box: number[]; full: boolean }[]>();
  private cell: number;
  constructor(polys: Polygon[], cell = 64) {
    this.cell = cell;
    for (const p of polys) {
      const g = groundClassOf(p.tags);
      if (!g) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of p.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      // Cells an edge of the outline or a hole runs through (or touches).
      const edge = new Set<number>();
      for (const ring of [p.outer, ...p.holes])
        for (let i = 1; i < ring.length; i++) {
          const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
          for (let cx = Math.floor(Math.min(ax, bx) / cell); cx <= Math.floor(Math.max(ax, bx) / cell); cx++)
            for (let cy = Math.floor(Math.min(ay, by) / cell); cy <= Math.floor(Math.max(ay, by) / cell); cy++)
              if (segmentTouchesBox(ax, ay, bx, by, cx * cell, cy * cell, (cx + 1) * cell, (cy + 1) * cell)) edge.add(this.key(cx, cy));
        }
      const box = [x0, y0, x1, y1];
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          const k = this.key(cx, cy);
          const crossed = edge.has(k);
          if (!crossed && !pointInPolygon((cx + 0.5) * cell, (cy + 0.5) * cell, p)) continue;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k)!.push({ p, ...g, box, full: !crossed });
        }
    }
    for (const list of this.cells.values()) list.sort((a, b) => b.prio - a.prio);
  }

  /** Numeric cell key (UTM metres / cell stay far below 2^20 east and 2^22 north). */
  private key(cx: number, cy: number) {
    return cx * 4_194_304 + cy;
  }

  /** Tags of the area that decides the ground class at (e, n), if any. */
  tagsAt(e: number, n: number): Record<string, string> | undefined {
    const list = this.cells.get(this.key(Math.floor(e / this.cell), Math.floor(n / this.cell)));
    if (list) for (const g of list) if (g.full || pointInPolygon(e, n, g.p)) return g.p.tags;
    return undefined;
  }

  at(e: number, n: number, fallback: GroundClass): GroundClass {
    const list = this.cells.get(this.key(Math.floor(e / this.cell), Math.floor(n / this.cell)));
    if (list) for (const g of list) if (g.full || (e >= g.box[0] && e <= g.box[2] && n >= g.box[1] && n <= g.box[3] && pointInPolygon(e, n, g.p))) return g.cls;
    return fallback;
  }
}

/** Whether the segment a–b touches the box (borders included). */
function segmentTouchesBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  // Liang–Barsky clipping of the segment against the box, with a small tolerance.
  const eps = 1e-6;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - (x0 - eps)], [dx, x1 + eps - ax], [-dy, ay - (y0 - eps)], [dy, y1 + eps - ay]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/** Deterministic pseudo-random numbers per position. */
export function rand(a: number, b: number, s = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
