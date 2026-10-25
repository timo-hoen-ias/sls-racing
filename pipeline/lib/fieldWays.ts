// Feldwege: forest tracks, farm tracks and small unpaved paths outside town. Unpaved footpaths, bridleways
// and cycle paths in the countryside are promoted to highway=track here, so they are built like the tracks:
// a carriageway at least FIELD_WAY.min wide (src/world/roadSpec.ts), carved flat into the terrain mesh
// (carve.ts) instead of floating on it, joined to the road network at its junctions, with the Feldweg look
// (two wheel ruts and a grass strip, src/render/pbr/roadCode.ts) and the Feldweg grip in the game
// (src/vehicle/roadSurface.ts). Paved paths and everything in town stay paths (paths.ts). Runs in readOsm,
// so the build, the drive test and the gap check all see the same network.
import { UNPAVED } from '../../src/render/pbr/roadCode.ts';
import { BuiltUp } from './kerbs.ts';
import { pointInPolygon, type Polygon, type Way } from './osm.ts';

const PROMOTE = new Set(['path', 'bridleway', 'footway', 'cycleway']);
/** Paths in parks, gardens and cemeteries stay paths, also outside built-up areas. */
const PARKS = new Set(['park', 'garden', 'cemetery', 'playground', 'golf_course']);

/** Unpaved path that becomes a Feldweg where it lies outside town (no surface tag: paths and bridleways only). */
export function fieldPathCandidate(tags: Record<string, string>): boolean {
  if (!PROMOTE.has(tags.highway)) return false;
  if (tags.area === 'yes' || (tags.tunnel && tags.tunnel !== 'no') || (tags.bridge && tags.bridge !== 'no') || tags.covered === 'yes' || tags.indoor === 'yes') return false;
  if (parseInt(tags.layer) < 0 || tags.level) return false;
  if (['sidewalk', 'crossing'].includes(tags.footway) || tags.cycleway === 'crossing' || tags.path === 'crossing') return false;
  const s = tags.surface;
  if (s) return UNPAVED.has(s);
  return tags.highway === 'path' || tags.highway === 'bridleway';
}

/** Promotes unpaved paths outside built-up areas to tracks (tag sls:path keeps the original class). */
export function promoteFieldPaths(ways: Way[], polygons: Polygon[]): number {
  const cands = ways.filter((w) => fieldPathCandidate(w.tags));
  if (!cands.length) return 0;
  const built = new BuiltUp(polygons);
  const parks = polygons.filter((p) => PARKS.has(p.tags.leisure) || PARKS.has(p.tags.landuse) || p.tags.amenity === 'grave_yard');
  const inPark = (w: Way) => {
    const mid = w.pts[w.pts.length >> 1];
    return parks.some((p) => pointInPolygon(mid[0], mid[1], p) && pointInPolygon(w.pts[0][0], w.pts[0][1], p));
  };
  let n = 0;
  for (const w of cands) {
    if (built.share(w) >= 0.5 || inPark(w)) continue;
    w.tags = { ...w.tags, 'sls:path': w.tags.highway, highway: 'track' };
    n++;
  }
  return n;
}

/** A promoted path is left a path where the terrain along it is steeper than this (rise per metre over GRADE_SPAN). */
const MAX_GRADE = 0.2;
const GRADE_SPAN = 8;
/** … or where the terrain falls away across it by more than this over the way's width plus 1 m each side (m). */
const MAX_CROSS = 1.4;
/** … or where it crosses a carriageway without a shared node (under a bridge, over a cutting). */
const CROSS_CELL = 50;

export interface DemoteReport { steep: number; slope: number; crossing: number }

/**
 * Turns promoted paths back into paths where a 4 m Feldweg cannot be built cleanly: steep trails, shelves
 * cut into a steep slope (switchback singletracks), and paths that pass under or over a road without
 * meeting it. Runs on the terrain heights before the road profiles (heights.ts roadHeights), in the build,
 * the drive test and the gap check alike.
 */
export function demoteRoughFieldPaths(ways: Way[], height: (e: number, n: number) => number, isRoad: (w: Way) => boolean): DemoteReport {
  const report: DemoteReport = { steep: 0, slope: 0, crossing: 0 };
  const promoted = ways.filter((w) => w.tags['sls:path']);
  if (!promoted.length) return report;
  // Carriageway segments (not promoted paths) on a grid, for the crossing test.
  const grid = new Map<string, [number, number, number, number, Way][]>();
  for (const w of ways) {
    if (w.tags['sls:path'] || !isRoad(w)) continue;
    for (let i = 1; i < w.pts.length; i++) {
      const [ax, ay] = w.pts[i - 1], [bx, by] = w.pts[i];
      for (let cx = Math.floor(Math.min(ax, bx) / CROSS_CELL); cx <= Math.floor(Math.max(ax, bx) / CROSS_CELL); cx++)
        for (let cy = Math.floor(Math.min(ay, by) / CROSS_CELL); cy <= Math.floor(Math.max(ay, by) / CROSS_CELL); cy++) {
          const k = `${cx}_${cy}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push([ax, ay, bx, by, w]);
        }
    }
  }
  const crosses = (w: Way) => {
    const own = new Set(w.ids);
    for (let i = 1; i < w.pts.length; i++) {
      const [ax, ay] = w.pts[i - 1], [bx, by] = w.pts[i];
      for (let cx = Math.floor(Math.min(ax, bx) / CROSS_CELL); cx <= Math.floor(Math.max(ax, bx) / CROSS_CELL); cx++)
        for (let cy = Math.floor(Math.min(ay, by) / CROSS_CELL); cy <= Math.floor(Math.max(ay, by) / CROSS_CELL); cy++)
          for (const [cx0, cy0, cx1, cy1, r] of grid.get(`${cx}_${cy}`) ?? []) {
            if (r.ids.some((id) => own.has(id))) continue;
            if (segmentsCross(ax, ay, bx, by, cx0, cy0, cx1, cy1)) return true;
          }
    }
    return false;
  };
  for (const w of promoted) {
    const half = 2 + 1;
    const samples: { e: number; n: number; h: number; d: number }[] = [];
    let steep = false, slope = false, dist = 0;
    for (let i = 1; i < w.pts.length && !slope; i++) {
      const [ax, ay] = w.pts[i - 1], [bx, by] = w.pts[i];
      const l = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / (l || 1), uy = (by - ay) / (l || 1);
      const k = Math.max(1, Math.ceil(l / 2));
      for (let j = i === 1 ? 0 : 1; j <= k; j++) {
        const e = ax + (bx - ax) * (j / k), n = ay + (by - ay) * (j / k);
        samples.push({ e, n, h: height(e, n), d: dist + (l * j) / k });
        if (Math.abs(height(e - uy * half, n + ux * half) - height(e + uy * half, n - ux * half)) > MAX_CROSS) { slope = true; break; }
      }
      dist += l;
    }
    if (!slope) {
      for (let a = 0, b = 0; b < samples.length; b++) {
        while (samples[b].d - samples[a].d > GRADE_SPAN) a++;
        if (samples[b].d - samples[a].d >= GRADE_SPAN * 0.75 && Math.abs(samples[b].h - samples[a].h) / (samples[b].d - samples[a].d) > MAX_GRADE) { steep = true; break; }
      }
    }
    const crossing = !steep && !slope && crosses(w);
    if (!steep && !slope && !crossing) continue;
    report[steep ? 'steep' : slope ? 'slope' : 'crossing']++;
    const { 'sls:path': was, ...rest } = w.tags;
    w.tags = { ...rest, highway: was };
  }
  return report;
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay), d2 = o(cx, cy, dx, dy, bx, by), d3 = o(ax, ay, bx, by, cx, cy), d4 = o(ax, ay, bx, by, dx, dy);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
