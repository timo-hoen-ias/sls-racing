// Fits the terrain mesh to the roads. With 1 m terrain the road follows embankments and cuttings that a
// 4 m mesh cannot show, so the mesh would poke through the road in a cutting or leave a gap under its
// edge on a slope. Vertices under and beside a road take its height (the nearest road's, where roads
// overlap); every vertex close enough to share a triangle with a road is pushed below it. Bridges and
// lifted roads only push the terrain down, they never pull it up to the deck.
import { ROAD_LIFT } from './roads.ts';

const CELL = 16;
/** Vertices this far beyond the road edge still take the road's height, so the verge meets the road. */
const FLAT = 2;

interface Seg { e0: number; n0: number; y0: number; e1: number; n1: number; y1: number; hw: number; cw: number; drape: boolean }

export class RoadCarve {
  private cells = new Map<string, Seg[]>();
  /** Reach beyond the road edge where the mesh is kept below the road: one mesh cell diagonal. */
  readonly reach: number;

  constructor(meshStep: number) {
    this.reach = meshStep * Math.SQRT2;
  }

  /**
   * One road segment with its surface heights at both ends and its half width; `drape` false for decks. `cap`
   * is the half width on its wider side where the two differ (a road narrowed on one side only): the mesh is
   * kept below the road out to there, draped only within the narrower one.
   */
  add(e0: number, n0: number, y0: number, e1: number, n1: number, y1: number, hw: number, drape = true, cap = hw) {
    const cw = Math.max(hw, cap);
    const s: Seg = { e0, n0, y0, e1, n1, y1, hw, cw, drape };
    const r = cw + this.reach;
    for (let cx = Math.floor((Math.min(e0, e1) - r) / CELL); cx <= Math.floor((Math.max(e0, e1) + r) / CELL); cx++)
      for (let cy = Math.floor((Math.min(n0, n1) - r) / CELL); cy <= Math.floor((Math.max(n0, n1) + r) / CELL); cy++) {
        const k = `${cx}_${cy}`;
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k)!.push(s);
      }
  }

  /** Terrain height at a mesh vertex after fitting it to nearby roads. */
  apply(e: number, n: number, h: number): number {
    let flat = Infinity, near = Infinity, cap = Infinity;
    for (const s of this.cells.get(`${Math.floor(e / CELL)}_${Math.floor(n / CELL)}`) ?? []) {
      const dx = s.e1 - s.e0, dy = s.n1 - s.n0;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((e - s.e0) * dx + (n - s.n0) * dy) / len2));
      const d = Math.hypot(e - s.e0 - dx * t, n - s.n0 - dy * t);
      if (d > s.cw + this.reach) continue;
      const y = s.y0 + (s.y1 - s.y0) * t - ROAD_LIFT;
      cap = Math.min(cap, y);
      if (s.drape && d <= s.hw + FLAT && d < near) { near = d; flat = y; }
    }
    return Math.min(flat < Infinity ? flat : h, cap);
  }
}
