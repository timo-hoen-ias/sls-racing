import type { WorldInfo } from '../../src/world/format.ts';
import { utmToLocal } from '../../src/world/format.ts';
import type { Way } from './osm.ts';
import type { TileMap } from './tilebuf.ts';

interface RoadClass {
  width: number;
  /** Draw order at overlaps: higher sits a little higher. */
  rank: number;
  centreLine: boolean;
}

export const ROAD_CLASSES: Record<string, RoadClass> = {
  motorway: { width: 11, rank: 9, centreLine: false },
  trunk: { width: 10, rank: 8, centreLine: true },
  primary: { width: 8.5, rank: 7, centreLine: true },
  secondary: { width: 7.5, rank: 6, centreLine: true },
  tertiary: { width: 7, rank: 5, centreLine: true },
  motorway_link: { width: 5.5, rank: 8, centreLine: false },
  trunk_link: { width: 5.5, rank: 7, centreLine: false },
  primary_link: { width: 5.5, rank: 6, centreLine: false },
  secondary_link: { width: 5.5, rank: 5, centreLine: false },
  tertiary_link: { width: 5.5, rank: 4, centreLine: false },
  unclassified: { width: 6, rank: 3, centreLine: false },
  residential: { width: 6, rank: 3, centreLine: false },
  living_street: { width: 5, rank: 2, centreLine: false },
  pedestrian: { width: 6, rank: 2, centreLine: false },
  service: { width: 4, rank: 1, centreLine: false },
  track: { width: 3, rank: 0, centreLine: false },
};

const LANE_WIDTH = 3.25;
const STEP = 4; // metres between road samples
export const ROAD_LIFT = 0.15; // road surface above the terrain mesh

export function roadWidth(tags: Record<string, string>): number | undefined {
  const cls = ROAD_CLASSES[tags.highway];
  if (!cls) return undefined;
  const w = parseFloat(tags.width);
  if (w > 2 && w < 40) return w;
  const lanes = parseInt(tags.lanes);
  if (lanes > 0 && lanes < 10) return Math.max(cls.width * 0.6, lanes * LANE_WIDTH + (tags.oneway === 'yes' ? 0.5 : 1));
  return tags.oneway === 'yes' && cls.rank >= 4 ? cls.width * 0.7 : cls.width;
}

export function isDrivable(tags: Record<string, string>) {
  return !!ROAD_CLASSES[tags.highway] && tags.tunnel !== 'yes' && tags.area !== 'yes' && tags.access !== 'no';
}

export function densify(pts: [number, number][], step = STEP): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

export interface RoadSample {
  x: number;
  z: number;
  y: number;
  heading: number;
}

/**
 * Emits road ribbons (and dashed centre lines) into the tiles they cross.
 * Returns all centreline samples so callers can pick a spawn point.
 */
export function buildRoads(ways: Way[], world: WorldInfo, height: (e: number, n: number) => number, tiles: TileMap): RoadSample[] {
  const samples: RoadSample[] = [];
  for (const way of ways) {
    if (!isDrivable(way.tags)) continue;
    const width = roadWidth(way.tags)!;
    const cls = ROAD_CLASSES[way.tags.highway];
    const pts = densify(way.pts);
    if (pts.length < 2) continue;
    const lift = ROAD_LIFT + cls.rank * 0.008;
    const bridge = way.tags.bridge && way.tags.bridge !== 'no';
    const h0 = height(...pts[0]);
    const h1 = height(...pts[pts.length - 1]);
    const len = pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

    let dist = 0;
    const ring = pts.map((p, i) => {
      if (i) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const y = bridge ? h0 + (h1 - h0) * (dist / (len || 1)) + 0.4 : height(p[0], p[1]) + lift;
      return { e: p[0], n: p[1], dx, dy, y, dist };
    });

    for (const r of ring) {
      const [x, z] = utmToLocal(world, r.e, r.n);
      // Heading in the local frame (x east, z south), 0 = facing -z (north).
      samples.push({ x, z, y: r.y, heading: Math.atan2(r.dx, r.dy) });
    }

    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1];
      const b = ring[i];
      const tile = tiles.at((a.e + b.e) / 2, (a.n + b.n) / 2);
      const quad = (buf: typeof tile.roads, half: number, dy: number, uvs: boolean) => {
        const v: number[] = [];
        for (const [p, s] of [[a, -1], [a, 1], [b, -1], [b, 1]] as const) {
          // Left normal of direction (dx, dy) in UTM is (-dy, dx).
          const [x, z] = utmToLocal(world, p.e - p.dy * half * s, p.n + p.dx * half * s);
          v.push(buf.vertex(x, p.y + dy, z, uvs ? { uv: [s < 0 ? 0 : 1, p.dist / width] } : {}));
        }
        // Winding chosen so faces point up (+y) in the local frame.
        buf.tri(v[0], v[2], v[1]);
        buf.tri(v[1], v[2], v[3]);
      };
      quad(tile.roads, width / 2, 0, true);
      if (bridge) quad(tile.collide, width / 2 + 0.5, 0, false);
      // Dashes: 3 m line, 6 m gap.
      if (cls.centreLine && way.tags.oneway !== 'yes' && Math.floor(a.dist / 9) === Math.floor(b.dist / 9) && a.dist % 9 < 3) {
        quad(tile.markings, 0.07, 0.02, false);
      }
    }
  }
  return samples;
}
