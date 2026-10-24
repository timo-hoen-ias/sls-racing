// Linear waterways (rivers, streams, canals, ditches, drains). Areas of water come from polygons
// (ground.ts); these lines add the brooks too narrow to be mapped as areas, as water cells on the
// terrain grid and as per-tile polylines with their flow direction for the water shader.
import { utmToLocal, type WorldInfo } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
import { densify } from './roads.ts';

const DEFAULT_WIDTH: Record<string, number> = { river: 12, canal: 8, stream: 3, ditch: 1.5, drain: 1.5 };
/** Narrower than this, a waterway only gets a polyline: the 4 m terrain grid cannot show it as cells. */
const MIN_CELL_WIDTH = 2.5;

export const isWaterway = (t: Record<string, string>) =>
  t.waterway in DEFAULT_WIDTH && !t.tunnel && t.intermittent !== 'yes' && t.layer !== '-1';

export function waterwayWidth(t: Record<string, string>) {
  const w = parseFloat(t.width ?? '');
  return Number.isFinite(w) && w > 0 && w < 200 ? w : DEFAULT_WIDTH[t.waterway];
}

/** Cells (2 m grid) covered by waterways wide enough to show on the terrain. */
export class WaterLines {
  private cells = new Set<number>();
  private static readonly C = 2;
  readonly ways: Way[];

  constructor(ways: Way[]) {
    this.ways = ways.filter((w) => isWaterway(w.tags));
    const C = WaterLines.C;
    for (const w of this.ways) {
      const r = waterwayWidth(w.tags) / 2;
      if (r * 2 < MIN_CELL_WIDTH) continue;
      const k = Math.ceil(r / C);
      for (const [e, n] of densify(w.pts, C)) {
        const ce = Math.round(e / C), cn = Math.round(n / C);
        for (let dx = -k; dx <= k; dx++)
          for (let dy = -k; dy <= k; dy++)
            if (Math.hypot(dx * C, dy * C) <= r + C * 0.5) this.cells.add((ce + dx) * 4_000_000 + cn + dy);
      }
    }
  }

  has(e: number, n: number) {
    return this.cells.has(Math.round(e / WaterLines.C) * 4_000_000 + Math.round(n / WaterLines.C));
  }

  /**
   * Polylines per tile as `[count, width, x0, y0, z0, …]` runs in local coordinates, points every 4 m in OSM
   * order (downstream), y the water surface. A run that leaves the tile keeps its first point outside.
   */
  polylines(world: WorldInfo, height: (e: number, n: number) => number): Map<string, number[]> {
    const T = world.tileSize;
    const out = new Map<string, number[]>();
    for (const w of this.ways) {
      const width = waterwayWidth(w.tags);
      let run: number[] = [];
      let runKey = '';
      let last: number[] | undefined;
      const flush = () => {
        if (run.length >= 6) {
          if (!out.has(runKey)) out.set(runKey, []);
          out.get(runKey)!.push(run.length / 3, width, ...run);
        }
        run = [];
      };
      for (const [e, n] of densify(w.pts, 4)) {
        const [x, z] = utmToLocal(world, e, n);
        const p = [x, Math.round((height(e, n) - 0.1) * 100) / 100, z].map((v) => Math.round(v * 100) / 100);
        const key = `${Math.floor(e / T)}_${Math.floor(n / T)}`;
        if (key !== runKey) {
          if (run.length) { run.push(...p); flush(); }
          runKey = key;
          if (last) run.push(...last);
        }
        run.push(...p);
        last = p;
      }
      flush();
    }
    return out;
  }
}
