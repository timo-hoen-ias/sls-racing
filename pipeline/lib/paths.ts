// Footpaths, cycle paths, bridleways and steps: narrow paved or gravel strips draped on the terrain mesh,
// kept off the carriageways and sidewalks, and never part of the road network (no graph edges, no junctions).
import type { WorldInfo } from '../../src/world/format.ts';
import { TERRAIN_STEP, utmToLocal } from '../../src/world/format.ts';
import { encodeRoad, roadSurface } from '../../src/render/pbr/roadCode.ts';
import { PATH_KINDS, type PathKind, pathWidth } from '../../src/world/roadSpec.ts';
import { densify, isBridge } from './roads.ts';
import type { Way } from './osm.ts';
import type { TileBuild, TileMap } from './tilebuf.ts';
import { CellSet } from './cellset.ts';

/** Path surface above the terrain mesh: enough that the mesh never shows through between samples. */
export const PATH_LIFT = 0.06;
/** Metres between the samples that test for roads; vertices are emitted every EMIT samples. */
const TEST = 1;
const EMIT = 2;

/** A footpath, cycle path or steps that is drawn: not in a tunnel or building, not on a bridge, not an area. */
export function isPath(tags: Record<string, string>): boolean {
  if (!PATH_KINDS.includes(tags.highway as PathKind)) return false;
  if (tags.area === 'yes' || (tags.tunnel && tags.tunnel !== 'no') || tags.covered === 'yes' || tags.indoor === 'yes' || isBridge(tags)) return false;
  if (parseInt(tags.layer) < 0 || tags.level) return false;
  // Sidewalks and crossings are drawn with the road (pipeline/lib/roads.ts).
  return tags.footway !== 'sidewalk' && tags.footway !== 'crossing' && tags.cycleway !== 'crossing' && tags.path !== 'crossing';
}

/**
 * Height of the terrain mesh at (e, n) given its node heights: the same 4 m grid and triangles as the tile
 * meshes (pipeline/build.ts, src/world/vegetation.ts sample()).
 */
export function meshHeight(node: (e: number, n: number) => number) {
  const S = TERRAIN_STEP;
  return (e: number, n: number) => {
    const c = Math.floor(e / S), top = Math.ceil(n / S);
    const u = e / S - c, v = top - n / S;
    const E = c * S, N = top * S;
    const a = node(E, N), b = node(E + S, N), d = node(E, N - S), f = node(E + S, N - S);
    return u + v <= 1 ? a + (b - a) * u + (d - a) * v : f + (d - f) * (1 - u) + (b - f) * (1 - v);
  };
}

export interface PathLine {
  /** Kind index into PATH_KINDS. */
  k: number;
  /** Width, metres. */
  w: number;
  /** Surface (SURFACE in src/render/pbr/roadCode.ts). */
  s: number;
  /** Polyline x, y, z (local), original OSM nodes. */
  p: number[];
}

export interface PathStats {
  lines: PathLine[];
  /** Drawn length per kind, metres. */
  drawn: Record<string, number>;
  /** Length left out because it lies on a road or sidewalk, metres. */
  clipped: number;
}

/**
 * Emits path strips into tile.paths. `blocked(x, z)` is true on carriageways and sidewalks (local coordinates):
 * path pieces there are left out, so a path stops at the kerb instead of running over the road.
 */
export function buildPaths(
  ways: Way[], world: WorldInfo, ground: (e: number, n: number) => number, tiles: TileMap, blocked: (x: number, z: number) => boolean,
): PathStats {
  const stats: PathStats = { lines: [], drawn: {}, clipped: 0 };
  const r1 = (v: number) => Math.round(v * 10) / 10;
  for (const way of ways) {
    if (!isPath(way.tags) || way.pts.length < 2) continue;
    const kind = way.tags.highway as PathKind;
    const width = pathWidth(way.tags);
    const surface = roadSurface(way.tags, way.id);
    const look = encodeRoad({ surface, lines: 0, gutter: false, shoulder: 0.25, width });
    stats.lines.push({
      k: PATH_KINDS.indexOf(kind), w: r1(width), s: surface,
      p: way.pts.flatMap(([e, n]) => { const [x, z] = utmToLocal(world, e, n); return [r1(x), r1(ground(e, n) + PATH_LIFT), r1(z)]; }),
    });
    const pts = densify(way.pts, TEST);
    const local = pts.map(([e, n]) => utmToLocal(world, e, n));
    const free = local.map(([x, z]) => !blocked(x, z));
    // Runs of samples off the roads, drawn as one strip per tile.
    let i = 0;
    while (i < pts.length) {
      if (!free[i]) { if (i) stats.clipped += TEST; i++; continue; }
      let j = i;
      while (j + 1 < pts.length && free[j + 1]) j++;
      if (j > i) emitRun(i, j);
      i = j + 1;
    }
    function emitRun(i0: number, i1: number) {
      const keep: number[] = [];
      for (let k = i0; k <= i1; k++) if ((k - i0) % EMIT === 0 || k === i1) keep.push(k);
      const hw = width / 2;
      // Right (uv.x 0) and left (uv.x 1) edge per kept sample, draped on the terrain mesh.
      const edges = keep.map((k, q) => {
        const a = pts[keep[Math.max(0, q - 1)]], b = pts[keep[Math.min(keep.length - 1, q + 1)]];
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl; dy /= dl;
        const [e, n] = pts[k];
        return [-hw, hw].map((o) => {
          const ce = e - dy * o, cn = n + dx * o;
          const [x, z] = utmToLocal(world, ce, cn);
          return [x, ground(ce, cn) + PATH_LIFT, z] as const;
        });
      });
      let buf: TileBuild['paths'] | undefined;
      let prev: [number, number] = [0, 0];
      const put = (q: number): [number, number] => {
        const [r, l] = edges[q];
        return [buf!.vertex(r[0], r[1], r[2], { uv: [0, look] }), buf!.vertex(l[0], l[1], l[2], { uv: [1, look] })];
      };
      for (let q = 1; q < keep.length; q++) {
        const [pe, pn] = pts[keep[q - 1]], [e, n] = pts[keep[q]];
        // Each segment goes into the tile of its midpoint; a new tile starts a new strip there.
        const t = tiles.at((pe + e) / 2, (pn + n) / 2).paths;
        if (t !== buf) { buf = t; prev = put(q - 1); }
        const cur = put(q);
        // Faces point up (same winding as the road strips).
        buf.tri(prev[0], cur[0], prev[1]);
        buf.tri(prev[1], cur[0], cur[1]);
        prev = cur;
        stats.drawn[kind] = (stats.drawn[kind] ?? 0) + Math.hypot(e - pe, n - pn);
      }
    }
  }
  return stats;
}

/** Marks the drawn path surfaces on a 1 m grid, so generated and measured trees keep off them. */
export class PathMask {
  private cells = new CellSet();
  constructor(ways: Way[], margin = 0.3) {
    for (const w of ways) {
      if (!isPath(w.tags)) continue;
      const r = pathWidth(w.tags) / 2 + margin;
      const k = Math.ceil(r);
      for (const [e, n] of densify(w.pts, 1)) {
        const ce = Math.round(e), cn = Math.round(n);
        for (let dx = -k; dx <= k; dx++)
          for (let dy = -k; dy <= k; dy++)
            if (Math.hypot(ce + dx - e, cn + dy - n) <= r) this.cells.add(ce + dx, cn + dy);
      }
    }
  }

  has(e: number, n: number) {
    return this.cells.has(Math.round(e), Math.round(n));
  }
}
