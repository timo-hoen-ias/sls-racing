// Motorway medians at their real width. OSM often draws the two carriageways of a motorway closer together than
// they are built (A 8 and A 620 around Saarlouis: in places the inner lanes would touch), which leaves no room
// for the median and its rail. This moves each carriageway outwards (to its right) where the lanes of the two
// directions lie closer than MEDIAN.lanes, by half the shortfall each, eased in and out along the road. Moved
// nodes keep their ids, so everything sharing them (bridges, the next way, ramps and slip roads) moves along;
// ramps and other roads leaving a moved node follow over MEDIAN.fade metres. Long segments get extra
// (synthetic) nodes so the offset can follow the median between mapped nodes.
//
// Run once after reading OSM and the measured widths, before planRamps (which lines the ramps up with the moved
// carriageway), heights and the road graph: build.ts, gapcheck.ts and drivetest.ts.
import { roadSection } from '../../src/world/roadSpec.ts';
import { SYNTHETIC_NODE, type Way } from './osm.ts';

export const MEDIAN = {
  /**
   * Distance between the inner lane edges of the two directions (RAA, RQ 31: 4 m median including both inner
   * edge strips; narrower sections with a concrete barrier have less).
   */
  lanes: 3.5,
  /** Largest move of one carriageway, metres. */
  max: 2,
  /** Change of the move per metre along the road (1:40). */
  slope: 1 / 40,
  /** Roads leaving a moved node ease back to their mapped course over this length. */
  fade: 120,
  /** Spacing of the extra nodes on long moved segments. */
  step: 20,
};

export interface SeparationStats {
  ways: number;
  km: number;
  maxMove: number;
  /** Moved stretches every 50 m, [e, n, move] in UTM, for the hw.median debug command. */
  points: [number, number, number][];
}

let synthetic = SYNTHETIC_NODE - 500_000_000;

const carriageway = (w: Way) => w.tags.highway === 'motorway' && !!roadSection(w.tags)?.oneway && w.pts.length >= 2;

interface Sample { e: number; n: number; dx: number; dy: number; d: number; laneLeft: number; w: Way }

/** Moves motorway carriageways apart where their median is too narrow. Mutates pts (and ids) of the ways. */
export function separateCarriageways(ways: Way[]): SeparationStats {
  const stats: SeparationStats = { ways: 0, km: 0, maxMove: 0, points: [] };
  const cws = ways.filter(carriageway);
  // Samples every 4 m with the distance from the line to the inner lane edge.
  const G = 32;
  const grid = new Map<string, Sample[]>();
  const samples = new Map<Way, Sample[]>();
  for (const w of cws) {
    const s = roadSection(w.tags)!;
    const laneLeft = s.width / 2 - s.shift - s.inner;
    const list: Sample[] = [];
    let d = 0;
    for (let i = 1; i < w.pts.length; i++) {
      const [ae, an] = w.pts[i - 1], [be, bn] = w.pts[i];
      const l = Math.hypot(be - ae, bn - an);
      if (l < 1e-6) continue;
      const k = Math.max(1, Math.ceil(l / 4));
      for (let j = i === 1 ? 0 : 1; j <= k; j++)
        list.push({ e: ae + ((be - ae) * j) / k, n: an + ((bn - an) * j) / k, dx: (be - ae) / l, dy: (bn - an) / l, d: d + (l * j) / k, laneLeft, w });
      d += l;
    }
    samples.set(w, list);
    for (const p of list) {
      const key = `${Math.floor(p.e / G)}_${Math.floor(p.n / G)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(p);
    }
  }
  // Move needed per sample: half the shortfall to the other direction's lanes on the left.
  const need = (p: Sample) => {
    let gap = Infinity;
    const ce = Math.floor(p.e / G), cn = Math.floor(p.n / G);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const q of grid.get(`${ce + a}_${cn + b}`) ?? []) {
          if (q.w === p.w || p.dx * q.dx + p.dy * q.dy > -0.9) continue;
          const de = q.e - p.e, dn = q.n - p.n;
          if (Math.abs(de * p.dx + dn * p.dy) > 3) continue;
          // Left of the direction: (-dy, dx).
          const lat = -de * p.dy + dn * p.dx;
          if (lat <= 0 || lat > 30) continue;
          gap = Math.min(gap, lat - p.laneLeft - q.laneLeft);
        }
    return Number.isFinite(gap) ? Math.min(MEDIAN.max, Math.max(0, (MEDIAN.lanes - gap) / 2)) : 0;
  };
  // Eased along the road: never changes faster than the slope.
  const moves = new Map<Way, number[]>();
  for (const w of cws) {
    const list = samples.get(w)!;
    const m = list.map(need);
    for (let i = 1; i < m.length; i++) m[i] = Math.max(m[i], m[i - 1] - (list[i].d - list[i - 1].d) * MEDIAN.slope);
    for (let i = m.length - 2; i >= 0; i--) m[i] = Math.max(m[i], m[i + 1] - (list[i + 1].d - list[i].d) * MEDIAN.slope);
    moves.set(w, m);
  }
  // Displacement per node id (to the right of its carriageway); shared nodes take the larger one.
  const shift = new Map<number, [number, number]>();
  const put = (id: number, v: [number, number]) => {
    const old = shift.get(id);
    if (!old || Math.hypot(...v) > Math.hypot(...old)) shift.set(id, v);
  };
  const moveAt = (w: Way, d: number) => {
    const list = samples.get(w)!, m = moves.get(w)!;
    let lo = 0, hi = list.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (list[mid].d <= d) lo = mid; else hi = mid; }
    const t = list[hi].d > list[lo].d ? Math.min(1, Math.max(0, (d - list[lo].d) / (list[hi].d - list[lo].d))) : 0;
    return m[lo] + (m[hi] - m[lo]) * t;
  };
  for (const w of cws) {
    const m = moves.get(w)!;
    if (!m.some((v) => v > 0.01)) continue;
    stats.ways++;
    // Extra nodes on long segments that move.
    const pts: [number, number][] = [w.pts[0]];
    const ids: number[] = [w.ids[0]];
    const dist: number[] = [0];
    let d = 0;
    for (let i = 1; i < w.pts.length; i++) {
      const [ae, an] = w.pts[i - 1], [be, bn] = w.pts[i];
      const l = Math.hypot(be - ae, bn - an);
      const k = Math.max(moveAt(w, d), moveAt(w, d + l)) > 0.01 || moveAt(w, d + l / 2) > 0.01 ? Math.max(1, Math.ceil(l / MEDIAN.step)) : 1;
      for (let j = 1; j < k; j++) {
        pts.push([ae + ((be - ae) * j) / k, an + ((bn - an) * j) / k]);
        ids.push(synthetic--);
        dist.push(d + (l * j) / k);
      }
      d += l;
      pts.push(w.pts[i]);
      ids.push(w.ids[i]);
      dist.push(d);
    }
    w.pts = pts;
    w.ids = ids;
    for (let i = 0; i < pts.length; i++) {
      const s = moveAt(w, dist[i]);
      if (s < 0.01) continue;
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const dx = (b[0] - a[0]) / l, dy = (b[1] - a[1]) / l;
      // Right of the direction: (dy, -dx).
      put(ids[i], [dy * s, -dx * s]);
      stats.maxMove = Math.max(stats.maxMove, s);
    }
    stats.km += d * (m.filter((v) => v > 0.01).length / m.length) / 1000;
    const list = samples.get(w)!;
    for (let i = 0; i < list.length; i += 12) if (m[i] > 0.01) stats.points.push([list[i].e, list[i].n, Math.round(m[i] * 100) / 100]);
  }
  if (!shift.size) return stats;
  // Other roads at a moved node follow it and ease back to their mapped course.
  const isCw = new Set(cws);
  const follow = new Map<number, [number, number]>();
  for (const w of ways) {
    if (isCw.has(w) || w.pts.length < 2) continue;
    for (let i = 0; i < w.ids.length; i++) {
      const v = shift.get(w.ids[i]);
      if (!v) continue;
      for (const dir of [1, -1]) {
        let d = 0;
        for (let k = i + dir; k >= 0 && k < w.ids.length; k += dir) {
          d += Math.hypot(w.pts[k][0] - w.pts[k - dir][0], w.pts[k][1] - w.pts[k - dir][1]);
          if (d >= MEDIAN.fade || shift.has(w.ids[k])) break;
          const f = 1 - d / MEDIAN.fade;
          const old = follow.get(w.ids[k]);
          if (!old || Math.hypot(...old) < Math.hypot(v[0] * f, v[1] * f)) follow.set(w.ids[k], [v[0] * f, v[1] * f]);
        }
      }
    }
  }
  for (const [id, v] of follow) if (!shift.has(id)) shift.set(id, v);
  for (const w of ways) {
    if (!w.ids.some((id) => shift.has(id))) continue;
    w.pts = w.pts.map((p, i) => {
      const v = shift.get(w.ids[i]);
      return v ? [p[0] + v[0], p[1] + v[1]] : p;
    });
  }
  stats.km = Math.round(stats.km * 10) / 10;
  stats.maxMove = Math.round(stats.maxMove * 100) / 100;
  return stats;
}
