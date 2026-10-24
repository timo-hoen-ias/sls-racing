import type { Way } from './osm.ts';
import { densify, isDrivable, roadWidth } from './roads.ts';
import { roadSection } from '../../src/world/roadSpec.ts';

/** Marks the drivable road surface plus a safety margin on a 2 m grid, so trees never stand on a road. */
export class RoadMask {
  private cells = new Set<number>();
  private static readonly CELL = 2;

  constructor(ways: Way[], margin = 1.5, only: (tags: Record<string, string>) => boolean = () => true) {
    const C = RoadMask.CELL;
    for (const w of ways) {
      if (!isDrivable(w.tags) || !only(w.tags)) continue;
      // Carriageways placed off the OSM line (motorway junction lanes) reach further to one side.
      const r = roadWidth(w.tags)! / 2 + Math.abs(roadSection(w.tags)!.shift) + margin;
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
