// Height profiles of roads. Draping a road straight onto 1 m terrain copies every flaw of the data into the
// driving surface: OSM lines that run a metre off the road onto an embankment slope, kerbs, ditches, the
// slope at a bridge end. Real roads are smooth, so each road gets a profile sampled from the terrain,
// filtered, and pinned to one height per node so that roads meeting at a node (and bridges) meet exactly.
import type { Way } from './osm.ts';
import { densify, isBridge, isDrivable, roadWidth } from './roads.ts';

/** Spacing of profile samples (m). */
export const PROFILE_STEP = 2;
/** Half window of the median filter, and of the smoothing after it (samples). */
const MEDIAN = 3, SMOOTH = 3;
/** Node heights come from the terrain this far along each road from the node (m). */
const NODE_REACH = 6;
/** Steepest ramp used to bring a profile to its node height (rise per metre). */
const RAMP_GRADE = 0.05;
/** Past the junction plateau the road blends back into its own profile over this length (m). */
const JUNCTION_BLEND = 10;

const median = (vs: number[]) => {
  const s = vs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export interface ProfileReport { roads: number; nodes: number; maxCorrection: number }

/**
 * Sets `way.profile` (terrain height every PROFILE_STEP metres along the way, filtered and pinned to node
 * heights) on every drivable road that is not a bridge. Bridge nodes are pinned to their decks (`anchors`).
 */
export function roadProfiles(ways: Way[], height: (e: number, n: number) => number, anchors: Map<number, number>): ProfileReport {
  const roads = ways.filter((w) => isDrivable(w.tags) && !isBridge(w.tags));
  // Raw terrain samples per road, with the distance of each original node along it.
  const raw = new Map<Way, { ys: number[]; nodeAt: number[] }>();
  for (const w of roads) {
    const ys: number[] = [];
    const nodeAt: number[] = [0];
    let dist = 0;
    for (let i = 1; i < w.pts.length; i++) {
      const seg = densify([w.pts[i - 1], w.pts[i]], PROFILE_STEP);
      dist += Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
      nodeAt.push(dist);
      if (i === 1) ys.push(height(...w.pts[0]));
      for (const p of seg.slice(1)) ys.push(height(...p));
    }
    raw.set(w, { ys, nodeAt });
  }
  // Even spacing per segment differs slightly from PROFILE_STEP; keep the distance of every sample.
  const dists = new Map<Way, number[]>();
  for (const w of roads) {
    const d: number[] = [0];
    for (let i = 1; i < w.pts.length; i++) {
      const len = Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
      const n = Math.max(1, Math.ceil(len / PROFILE_STEP));
      const base = raw.get(w)!.nodeAt[i - 1];
      for (let k = 1; k <= n; k++) d.push(base + (len * k) / n);
    }
    dists.set(w, d);
  }

  // One height per node: the median of the terrain near it along every road through it, or the deck.
  const near = new Map<number, number[]>();
  for (const w of roads) {
    const { ys, nodeAt } = raw.get(w)!;
    const d = dists.get(w)!;
    w.ids.forEach((id, i) => {
      if (anchors.has(id)) return;
      if (!near.has(id)) near.set(id, []);
      const list = near.get(id)!;
      for (let k = 0; k < ys.length; k++) if (Math.abs(d[k] - nodeAt[i]) <= NODE_REACH) list.push(ys[k]);
    });
  }
  const nodeH = new Map(anchors);
  for (const [id, vs] of near) nodeH.set(id, median(vs));

  // Junctions: nodes where roads meet or cross (three or more road ends). Each road through one is flat at
  // the node height across the widest road there, so the crossing surfaces coincide instead of forming a
  // ridge where their slopes differ.
  const degree = new Map<number, number>();
  const widest = new Map<number, number>();
  for (const w of roads) {
    const hw = roadWidth(w.tags)! / 2;
    w.ids.forEach((id, i) => {
      degree.set(id, (degree.get(id) ?? 0) + (i === 0 || i === w.ids.length - 1 ? 1 : 2));
      widest.set(id, Math.max(widest.get(id) ?? 0, hw));
    });
  }
  const isJunction = (id: number) => (degree.get(id) ?? 0) >= 3 && !anchors.has(id);

  let maxCorrection = 0;
  for (const w of roads) {
    const { ys, nodeAt } = raw.get(w)!;
    const d = dists.get(w)!;
    // Median, then a moving average: removes kerbs and ditch edges, keeps hills.
    const med = ys.map((_, k) => median(ys.slice(Math.max(0, k - MEDIAN), k + MEDIAN + 1)));
    const smooth = med.map((_, k) => {
      const s = med.slice(Math.max(0, k - SMOOTH), k + SMOOTH + 1);
      return s.reduce((a, b) => a + b, 0) / s.length;
    });
    // Ramp the profile onto each node height: full correction at the node, fading out along the road.
    const prof = smooth.slice();
    for (let i = 0; i < w.ids.length; i++) {
      const target = nodeH.get(w.ids[i])!;
      const k0 = d.findIndex((v) => v >= nodeAt[i] - 1e-6);
      const delta = target - smooth[k0];
      maxCorrection = Math.max(maxCorrection, Math.abs(delta));
      const before = i > 0 ? nodeAt[i] - nodeAt[i - 1] : 0;
      const after = i < w.ids.length - 1 ? nodeAt[i + 1] - nodeAt[i] : 0;
      const reach = Math.max(8, Math.abs(delta) / RAMP_GRADE);
      for (let k = 0; k < prof.length; k++) {
        const off = d[k] - nodeAt[i];
        const span = off < 0 ? Math.min(reach, before) : Math.min(reach, after);
        if (!span && off !== 0) continue;
        const t = off === 0 ? 1 : 1 - Math.abs(off) / span;
        if (t > 0) prof[k] += delta * t;
      }
    }
    const flats = w.ids.flatMap((id, i) => (isJunction(id) ? [{ at: nodeAt[i], y: nodeH.get(id)!, r: widest.get(id)! + 0.5 }] : []));
    if (flats.length)
      for (let k = 0; k < prof.length; k++) {
        let wt = 0, y = 0;
        for (const f of flats) {
          const off = Math.abs(d[k] - f.at);
          const t = off <= f.r ? 1 : Math.max(0, 1 - (off - f.r) / JUNCTION_BLEND);
          if (t > wt) { wt = t; y = f.y; }
        }
        // Smoothstep so the grade changes gently into and out of the plateau.
        if (wt > 0) prof[k] += (y - prof[k]) * wt * wt * (3 - 2 * wt);
      }
    w.profile = { dist: Float32Array.from(d), y: Float32Array.from(prof) };
  }
  return { roads: roads.length, nodes: nodeH.size, maxCorrection };
}
