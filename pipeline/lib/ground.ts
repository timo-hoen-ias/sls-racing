import { Ground } from '../../src/world/format.ts';
import { pointInPolygon, type Polygon } from './osm.ts';

type GroundClass = (typeof Ground)[keyof typeof Ground];

export function groundClassOf(tags: Record<string, string>): { cls: GroundClass; prio: number } | undefined {
  const lu = tags.landuse, nat = tags.natural, lei = tags.leisure;
  if (nat === 'water' || tags.waterway === 'riverbank' || lu === 'reservoir' || lu === 'basin') return { cls: Ground.water, prio: 5 };
  if (tags.amenity === 'parking') return { cls: Ground.urban, prio: 4 };
  if (lu === 'forest' || nat === 'wood' || nat === 'scrub') return { cls: Ground.forest, prio: 3 };
  if (['grass', 'meadow', 'recreation_ground', 'village_green', 'cemetery', 'allotments', 'orchard', 'vineyard'].includes(lu) ||
      ['park', 'garden', 'pitch', 'playground'].includes(lei) || nat === 'grassland') return { cls: Ground.grass, prio: 2 };
  if (lu === 'farmland' || lu === 'farmyard') return { cls: Ground.farmland, prio: 1 };
  if (['residential', 'commercial', 'industrial', 'retail', 'railway', 'construction'].includes(lu)) return { cls: Ground.urban, prio: 0 };
  return undefined;
}

/** Point lookup of ground classes with a coarse grid index over polygon bounding boxes. */
export class GroundIndex {
  private cells = new Map<string, { p: Polygon; cls: GroundClass; prio: number; box: number[] }[]>();
  private cell: number;
  constructor(polys: Polygon[], cell = 64) {
    this.cell = cell;
    for (const p of polys) {
      const g = groundClassOf(p.tags);
      if (!g) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of p.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          const k = `${cx}_${cy}`;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k)!.push({ p, ...g, box: [x0, y0, x1, y1] });
        }
    }
    for (const list of this.cells.values()) list.sort((a, b) => b.prio - a.prio);
  }

  /** Tags of the area that decides the ground class at (e, n), if any. */
  tagsAt(e: number, n: number): Record<string, string> | undefined {
    const list = this.cells.get(`${Math.floor(e / this.cell)}_${Math.floor(n / this.cell)}`);
    if (list) for (const g of list) if (pointInPolygon(e, n, g.p)) return g.p.tags;
    return undefined;
  }

  at(e: number, n: number, fallback: GroundClass): GroundClass {
    const list = this.cells.get(`${Math.floor(e / this.cell)}_${Math.floor(n / this.cell)}`);
    if (list) for (const g of list) if (e >= g.box[0] && e <= g.box[2] && n >= g.box[1] && n <= g.box[3] && pointInPolygon(e, n, g.p)) return g.cls;
    return fallback;
  }
}

/** Deterministic pseudo-random numbers per position. */
export function rand(a: number, b: number, s = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
