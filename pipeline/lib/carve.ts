// Fits the terrain mesh to the roads. With 1 m terrain the road follows embankments and cuttings that a
// 4 m mesh cannot show, so the mesh would poke through the road in a cutting or leave a gap under its
// edge on a slope. Vertices under a road take its height; vertices close enough to share a triangle
// with the road are pushed below it.
import { ROAD_LIFT } from './roads.ts';

const CELL = 16;
/** Vertices this far beyond the road edge still take the road's height, so the car rolls on a level mesh. */
const FLAT = 2;

interface Seg { e0: number; n0: number; y0: number; e1: number; n1: number; y1: number; hw: number }

export class RoadCarve {
  private cells = new Map<string, Seg[]>();
  /** Reach beyond the road edge where the mesh is kept below the road: one mesh cell diagonal. */
  readonly reach: number;

  constructor(meshStep: number) {
    this.reach = meshStep * Math.SQRT2;
  }

  /** One road segment with its surface heights at both ends and its half width. */
  add(e0: number, n0: number, y0: number, e1: number, n1: number, y1: number, hw: number) {
    const s: Seg = { e0, n0, y0, e1, n1, y1, hw };
    const r = hw + this.reach;
    for (let cx = Math.floor((Math.min(e0, e1) - r) / CELL); cx <= Math.floor((Math.max(e0, e1) + r) / CELL); cx++)
      for (let cy = Math.floor((Math.min(n0, n1) - r) / CELL); cy <= Math.floor((Math.max(n0, n1) + r) / CELL); cy++) {
        const k = `${cx}_${cy}`;
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k)!.push(s);
      }
  }

  /** Terrain height at a mesh vertex after fitting it to nearby roads. */
  apply(e: number, n: number, h: number): number {
    // Under a road: the nearest road's height (where two roads overlap at different heights, the lower one
    // must not dig a pit into the higher one). Beside it: below every road that is close enough.
    let flat = Infinity, near = Infinity, cap = Infinity;
    for (const s of this.cells.get(`${Math.floor(e / CELL)}_${Math.floor(n / CELL)}`) ?? []) {
      const dx = s.e1 - s.e0, dy = s.n1 - s.n0;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((e - s.e0) * dx + (n - s.n0) * dy) / len2));
      const d = Math.hypot(e - s.e0 - dx * t, n - s.n0 - dy * t);
      if (d > s.hw + this.reach) continue;
      const y = s.y0 + (s.y1 - s.y0) * t - ROAD_LIFT;
      if (d <= s.hw + FLAT) {
        if (d < near) { near = d; flat = y; }
      } else cap = Math.min(cap, y);
    }
    return flat < Infinity ? flat : Math.min(h, cap);
  }
}
