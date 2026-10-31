import { type Fillet, inFillet } from './fillets.ts';
import { pointInRing, type Way } from './osm.ts';
import { densify, isDrivable, roadWidth } from './roads.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import { CellSet } from './cellset.ts';

/** Marks the drivable road surface plus a safety margin on a 2 m grid, so trees never stand on a road. */
export class RoadMask {
  private cells = new CellSet();
  private static readonly CELL = 2;

  private margin: number;

  constructor(ways: Way[], margin = 1.5, only: (tags: Record<string, string>) => boolean = () => true) {
    const C = RoadMask.CELL;
    this.margin = margin;
    for (const w of ways) {
      if (!isDrivable(w.tags) || !only(w.tags)) continue;
      // Carriageways placed off the OSM line (motorway junction lanes) reach further to one side.
      const r = roadWidth(w.tags)! / 2 + Math.abs(roadSection(w.tags)!.shift) + margin;
      const k = Math.ceil(r / C);
      for (const [e, n] of densify(w.pts, C)) {
        const ce = Math.round(e / C), cn = Math.round(n / C);
        for (let dx = -k; dx <= k; dx++)
          for (let dy = -k; dy <= k; dy++)
            if (Math.hypot(dx * C, dy * C) <= r + C * 0.5) this.cells.add(ce + dx, cn + dy);
      }
    }
  }

  /** Other strips (railway tracks …) as polylines with a half width, plus the margin. */
  addLines(lines: { pts: [number, number][]; half: number }[]) {
    const C = RoadMask.CELL;
    for (const { pts, half } of lines) {
      const r = half + this.margin, k = Math.ceil(r / C);
      for (const [e, n] of densify(pts, C)) {
        const ce = Math.round(e / C), cn = Math.round(n / C);
        for (let dx = -k; dx <= k; dx++)
          for (let dy = -k; dy <= k; dy++)
            if (Math.hypot(dx * C, dy * C) <= r + C * 0.5) this.cells.add(ce + dx, cn + dy);
      }
    }
  }

  /** Rounded junction corners (fillets.ts) count as carriageway too, with the same margin. */
  addFillets(fillets: Fillet[]) {
    const C = RoadMask.CELL, m = this.margin;
    for (const f of fillets) {
      const pad = Math.max(0, m) + C;
      for (let cx = Math.floor((Math.min(...f.e) - pad) / C); cx <= Math.ceil((Math.max(...f.e) + pad) / C); cx++)
        for (let cy = Math.floor((Math.min(...f.n) - pad) / C); cy <= Math.ceil((Math.max(...f.n) + pad) / C); cy++)
          if (inFillet(f, cx * C, cy * C, m + C * 0.5)) this.cells.add(cx, cy);
    }
  }

  has(e: number, n: number) {
    return this.cells.has(Math.round(e / RoadMask.CELL), Math.round(n / RoadMask.CELL));
  }
}

/** Points every 2 m on the centrelines of drivable roads with their half width, to find buildings standing on a road. */
export class RoadLines {
  /** Per 16 m cell: east, north, half width, way id and the previous sample (NaN at a way's start or a gap) of each point, flat. */
  private cells = new Map<number, number[]>();
  private static readonly CELL = 16;

  /** `keep` leaves out points of a way (a tunnel deep enough under the ground for a building on top). */
  constructor(ways: Way[], keep: (w: Way, e: number, n: number) => boolean = () => true) {
    const C = RoadLines.CELL;
    for (const w of ways) {
      if (!isDrivable(w.tags)) continue;
      const hw = roadWidth(w.tags)! / 2;
      let pe = NaN, pn = NaN;
      for (const [e, n] of densify(w.pts, 1)) {
        if (!keep(w, e, n)) { pe = pn = NaN; continue; }
        const k = Math.floor(e / C) * 4_000_000 + Math.floor(n / C);
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k)!.push(e, n, hw, w.id, pe, pn);
        pe = e; pn = n;
      }
    }
  }

  /**
   * A way the ring (UTM east, north) stands on, if any: its centreline runs through the ring, or a corner of
   * the ring reaches more than `margin` metres onto the carriageway.
   */
  through(ring: [number, number][], margin = 1) {
    const C = RoadLines.CELL;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    const r = 12;
    for (let x = Math.floor((x0 - r) / C); x <= Math.floor((x1 + r) / C); x++)
      for (let y = Math.floor((y0 - r) / C); y <= Math.floor((y1 + r) / C); y++)
        for (let j = 0, c = this.cells.get(x * 4_000_000 + y) ?? []; j < c.length; j += 6) {
          const e = c[j], n = c[j + 1], hw = c[j + 2], id = c[j + 3], pe = c[j + 4], pn = c[j + 5];
          if (e >= x0 && e <= x1 && n >= y0 && n <= y1 && pointInRing(e, n, ring)) return id;
          for (const [re, rn] of ring) if (Math.hypot(re - e, rn - n) < hw - margin) return id;
          // A wall thinner than the sample step: the centreline crosses one of its edges.
          if (pe === pe && Math.max(e, pe) >= x0 && Math.min(e, pe) <= x1 && Math.max(n, pn) >= y0 && Math.min(n, pn) <= y1)
            for (let i = 0; i < ring.length; i++) if (crosses(pe, pn, e, n, ring[i], ring[(i + 1) % ring.length])) return id;
        }
    return undefined;
  }
}

/** Whether segment a–b and segment p–q cross. */
function crosses(ae: number, an: number, be: number, bn: number, [pe, pn]: [number, number], [qe, qn]: [number, number]) {
  const side = (e: number, n: number, e0: number, n0: number, e1: number, n1: number) => (e1 - e0) * (n - n0) - (n1 - n0) * (e - e0);
  const d1 = side(pe, pn, ae, an, be, bn), d2 = side(qe, qn, ae, an, be, bn);
  const d3 = side(ae, an, pe, pn, qe, qn), d4 = side(be, bn, pe, pn, qe, qn);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
