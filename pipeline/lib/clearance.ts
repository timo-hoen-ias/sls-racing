import { pointInRing, type Way } from './osm.ts';
import { densify, isDrivable, roadWidth } from './roads.ts';

/** Marks the drivable road surface plus a safety margin on a 2 m grid, so trees never stand on a road. */
export class RoadMask {
  private cells = new Set<number>();
  private static readonly CELL = 2;

  constructor(ways: Way[], margin = 1.5, only: (tags: Record<string, string>) => boolean = () => true) {
    const C = RoadMask.CELL;
    for (const w of ways) {
      if (!isDrivable(w.tags) || !only(w.tags)) continue;
      const r = roadWidth(w.tags)! / 2 + margin;
      const k = Math.ceil(r / C);
      for (const [e, n] of densify(w.pts, C)) {
        const ce = Math.round(e / C), cn = Math.round(n / C);
        for (let dx = -k; dx <= k; dx++)
          for (let dy = -k; dy <= k; dy++)
            if (Math.hypot(dx * C, dy * C) <= r + C * 0.5) this.cells.add(RoadMask.key(ce + dx, cn + dy));
      }
    }
  }

  private static key(cx: number, cy: number) {
    return cx * 4_000_000 + cy;
  }

  has(e: number, n: number) {
    return this.cells.has(RoadMask.key(Math.round(e / RoadMask.CELL), Math.round(n / RoadMask.CELL)));
  }
}

/** Points every 2 m on the centrelines of drivable roads, to find buildings standing on a road. */
export class RoadLines {
  private cells = new Map<number, [number, number, number][]>();
  private static readonly CELL = 16;

  constructor(ways: Way[]) {
    const C = RoadLines.CELL;
    for (const w of ways) {
      if (!isDrivable(w.tags)) continue;
      for (const [e, n] of densify(w.pts, 2)) {
        const k = Math.floor(e / C) * 4_000_000 + Math.floor(n / C);
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k)!.push([e, n, w.id]);
      }
    }
  }

  /** A way whose centreline crosses the ring (UTM east, north), if any. */
  through(ring: [number, number][]) {
    const C = RoadLines.CELL;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    for (let x = Math.floor(x0 / C); x <= Math.floor(x1 / C); x++)
      for (let y = Math.floor(y0 / C); y <= Math.floor(y1 / C); y++)
        for (const [e, n, id] of this.cells.get(x * 4_000_000 + y) ?? []) if (pointInRing(e, n, ring)) return id;
    return undefined;
  }
}
