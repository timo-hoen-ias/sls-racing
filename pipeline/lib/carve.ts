// Fits the terrain mesh to the roads. With 1 m terrain the road follows embankments and cuttings that a
// 4 m mesh cannot show, so the mesh would poke through the road in a cutting or leave a gap under its
// edge on a slope. Vertices under a carriageway take its height less ROAD_LIFT (the nearest road's, where
// roads overlap), under a pavement less EDGE; vertices beside it, out to FLAT past the paved edge (pavement included), meet the paved surface
// just below its edge (EDGE), so the road does not float on a ledge above the verge. Every vertex close
// enough to share a triangle with a road is pushed below it. Bridges and lifted roads only push the terrain
// down, they never pull it up to the deck.
import { ROAD_LIFT } from './roads.ts';

const CELL = 16;
/** Vertices this far beyond the paved edge still take the road's height, so the verge meets the road. */
const FLAT = 2;
/** The verge lies this far below the paved edge beside it (carriageway, or pavement top). */
export const EDGE = 0.04;
/**
 * Past FLAT, out to one mesh cell diagonal from the paved edge, the ground falls away from the road no steeper
 * than this (metres per metre): where the road runs on an embankment, a mesh triangle reaching under its edge
 * then sags a little instead of dropping to the foot of the bank under the pavement.
 */
export const BANK_SLOPE = 0.8;

/** Numeric cell key (UTM metres / CELL stay far below 2^20 east and 2^22 north): no string per lookup. */
const cellKey = (cx: number, cy: number) => cx * 4_194_304 + cy;

/**
 * Paved extent on each side of a segment, from its line: carriageway plus pavement (l, r, metres) and the top
 * of the pavement above the road there (tl, tr; 0 without one).
 */
export interface Paved { l: number; r: number; tl: number; tr: number }

interface Seg {
  e0: number; n0: number; y0: number; e1: number; n1: number; y1: number; hw: number; cw: number; drape: boolean;
  paved: Paved;
  /** Cross slope at start / end (rise per metre to the left). */
  x0: number; x1: number;
  /** The road continues past the start / end (another segment of it carries on there). */
  on0: boolean; on1: boolean;
}

export class RoadCarve {
  private cells = new Map<number, Seg[]>();
  /** Reach beyond the road edge where the mesh is kept below the road: one mesh cell diagonal. */
  readonly reach: number;

  constructor(meshStep: number) {
    this.reach = meshStep * Math.SQRT2;
  }

  /**
   * One road segment with its surface heights at both ends and its half width; `drape` false for decks. `cap`
   * is the half width on its wider side where the two differ (a road narrowed on one side only): the mesh is
   * kept below the road out to there, draped only within the narrower one. `on` says whether the road carries
   * on past the start and the end of this segment.
   */
  add(
    e0: number, n0: number, y0: number, e1: number, n1: number, y1: number, hw: number, drape = true, cap = hw, paved?: Paved,
    on: [boolean, boolean] = [false, false], cross: [number, number] = [0, 0],
  ) {
    const cw = Math.max(hw, cap);
    const s: Seg = { e0, n0, y0, e1, n1, y1, hw, cw, drape, paved: paved ?? { l: cw, r: cw, tl: 0, tr: 0 }, on0: on[0], on1: on[1], x0: cross[0], x1: cross[1] };
    const r = Math.max(cw, s.paved.l, s.paved.r) + Math.max(this.reach, FLAT);
    for (let cx = Math.floor((Math.min(e0, e1) - r) / CELL); cx <= Math.floor((Math.max(e0, e1) + r) / CELL); cx++)
      for (let cy = Math.floor((Math.min(n0, n1) - r) / CELL); cy <= Math.floor((Math.max(n0, n1) + r) / CELL); cy++) {
        const k = cellKey(cx, cy);
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k)!.push(s);
      }
  }

  /** Terrain height at a mesh vertex after fitting it to nearby roads. */
  apply(e: number, n: number, h: number): number {
    let flat = Infinity, near = Infinity, cap = Infinity, floor = -Infinity;
    for (const s of this.cells.get(cellKey(Math.floor(e / CELL), Math.floor(n / CELL))) ?? []) {
      const dx = s.e1 - s.e0, dy = s.n1 - s.n0;
      const len2 = dx * dx + dy * dy || 1;
      const u = ((e - s.e0) * dx + (n - s.n0) * dy) / len2;
      const t = Math.min(1, Math.max(0, u));
      const d = Math.hypot(e - s.e0 - dx * t, n - s.n0 - dy * t);
      // Left of the segment (positive) or right, and how far the paved surface reaches on that side.
      const left = (e - s.e0) * -dy + (n - s.n0) * dx > 0;
      const pave = Math.max(s.cw, left ? s.paved.l : s.paved.r);
      if (d > Math.max(s.cw, pave) + this.reach) continue;
      // Past an end where the road carries on, the grade is extended: the next segment holds the road there, and
      // the end height would pull the verge of a climbing road down into a ledge beside it.
      // A road tilted across (junction plateau on a slope, profiles.ts) rises by its cross slope to the left, up to
      // its paved edge.
      const road = s.y0 + (s.y1 - s.y0) * ((u < 0 && s.on0) || (u > 1 && s.on1) ? u : t) + (s.x0 + (s.x1 - s.x0) * t) * Math.min(d, pave) * (left ? 1 : -1);
      // Under the carriageway the mesh stays ROAD_LIFT down, under a pavement just below the road's level (so it
      // never reaches over the kerb into the carriageway); beside a draped road it meets the paved edge.
      const y = !s.drape || d <= s.cw ? road - ROAD_LIFT : d <= pave ? road - EDGE : road + (left ? s.paved.tl : s.paved.tr) - EDGE;
      if (d <= s.cw + this.reach || (s.drape && d <= pave + FLAT)) cap = Math.min(cap, y);
      if (s.drape && d <= pave + FLAT && d < near) { near = d; flat = y; }
      else if (s.drape && d > pave + FLAT) floor = Math.max(floor, y - BANK_SLOPE * (d - pave - FLAT));
    }
    return Math.min(flat < Infinity ? flat : Math.max(h, floor), cap);
  }
}
