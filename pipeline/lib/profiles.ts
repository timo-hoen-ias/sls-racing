// Height profiles of roads. Draping a road straight onto 1 m terrain copies every flaw of the data into the
// driving surface: OSM lines that run a metre off the road onto an embankment slope, kerbs, ditches, the
// slope at a bridge end. Real roads are smooth, so each road gets a profile sampled from the terrain,
// filtered, and pinned to one height per node so that roads meeting at a node (and bridges) meet exactly.
import { SYNTHETIC_NODE, type Way } from './osm.ts';
import { ROAD_CLASSES, densify, isBridge, isDrivable, roadWidth } from './roads.ts';

/** Spacing of profile samples (m). */
export const PROFILE_STEP = 2;
/** Half window of the median filter, and of the smoothing after it (samples). */
const MEDIAN = 3, SMOOTH = 3;
/** Dips narrower than about twice this (samples) are filled: culverts and stream beds the road crosses on fill. */
const CLOSE = 4;
/** Node heights come from the terrain this far along each road from the node (m). */
const NODE_REACH = 6;
/** Steepest ramp used to bring a profile to its node height (rise per metre). */
const RAMP_GRADE = 0.05;
/** Past the junction plateau the road blends back into its own profile over this length (m). */
const JUNCTION_BLEND = 10;
/** A junction plateau tilts with the grade of its main road, up to this much (rise per metre). */
const PLATEAU_GRADE = 0.12;
/** Grade of a road end is measured over this length, and matched to the road it continues into over this reach (m). */
const GRADE_SPAN = 4, GRADE_REACH = 16;

const median = (vs: number[]) => {
  const s = vs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const win = (vs: number[], k: number, r: number) => vs.slice(Math.max(0, k - r), k + r + 1);

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
    // Closing (max, then min over a window) fills narrow dips: in the bare-earth model a road crossing a
    // culvert or stream on a fill has a trench where the fill was cut out. Hills and long underpasses stay.
    const dilated = ys.map((_, k) => Math.max(...win(ys, k, CLOSE)));
    raw.set(w, { ys: dilated.map((_, k) => Math.min(...win(dilated, k, CLOSE))), nodeAt });
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
      // Points the pipeline added only shape the line; the profile runs smoothly through them.
      if (anchors.has(id) || id < SYNTHETIC_NODE) return;
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
  const pinned = new Map<Way, number[]>();
  for (const w of roads) {
    const { ys, nodeAt } = raw.get(w)!;
    const d = dists.get(w)!;
    // Median, then a moving average: removes kerbs and ditch edges, keeps hills.
    const med = ys.map((_, k) => median(win(ys, k, MEDIAN)));
    const smooth = med.map((_, k) => {
      const s = med.slice(Math.max(0, k - SMOOTH), k + SMOOTH + 1);
      return s.reduce((a, b) => a + b, 0) / s.length;
    });
    // Ramp the profile onto each node height: full correction at the node, fading out along the road.
    const prof = smooth.slice();
    for (let i = 0; i < w.ids.length; i++) {
      if (!nodeH.has(w.ids[i])) continue;
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
    pinned.set(w, prof);
  }

  // Direction (unit, UTM) and grade of a road at one of its nodes, from its pinned profile.
  const at = (w: Way, x: number) => {
    const d = dists.get(w)!, y = pinned.get(w)!;
    let k = 0;
    while (k < d.length - 2 && d[k + 1] < x) k++;
    return y[k] + (y[k + 1] - y[k]) * Math.min(1, Math.max(0, (x - d[k]) / (d[k + 1] - d[k] || 1)));
  };
  const heading = (w: Way, i: number): [number, number] => {
    const a = w.pts[Math.max(0, i - 1)], b = w.pts[Math.min(w.pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  // Junction plateaus are planes through the node height, tilted with the main road (highest class, then
  // widest): a flat plateau on a steep street makes the main road climb twice as steeply into it and leaves
  // a crest to jump from. The other roads follow the plane, so all surfaces still meet at the node.
  const tilt = new Map<number, { rank: number; hw: number; g: [number, number] }>();
  for (const w of roads) {
    const { nodeAt } = raw.get(w)!;
    const len = dists.get(w)!.at(-1)!;
    const rank = ROAD_CLASSES[w.tags.highway].rank, hw = roadWidth(w.tags)! / 2;
    w.ids.forEach((id, i) => {
      if (!isJunction(id)) return;
      const best = tilt.get(id);
      if (best && (best.rank > rank || (best.rank === rank && best.hw >= hw))) return;
      const x0 = Math.max(0, nodeAt[i] - GRADE_SPAN), x1 = Math.min(len, nodeAt[i] + GRADE_SPAN);
      if (x1 - x0 < 1) return;
      const s = Math.max(-PLATEAU_GRADE, Math.min(PLATEAU_GRADE, (at(w, x1) - at(w, x0)) / (x1 - x0)));
      const [ue, un] = heading(w, i);
      tilt.set(id, { rank, hw, g: [s * ue, s * un] });
    });
  }

  for (const w of roads) {
    const { nodeAt } = raw.get(w)!;
    const d = dists.get(w)!;
    const prof = pinned.get(w)!;
    const flats = w.ids.flatMap((id, i) => {
      if (!isJunction(id)) return [];
      const [ge, gn] = tilt.get(id)?.g ?? [0, 0];
      const [ue, un] = heading(w, i);
      return [{ at: nodeAt[i], y: nodeH.get(id)!, r: widest.get(id)! + 0.5, slope: ge * ue + gn * un }];
    });
    if (flats.length)
      for (let k = 0; k < prof.length; k++) {
        let wt = 0, y = 0;
        for (const f of flats) {
          const off = Math.abs(d[k] - f.at);
          const t = off <= f.r ? 1 : Math.max(0, 1 - (off - f.r) / JUNCTION_BLEND);
          if (t > wt) { wt = t; y = f.y + f.slope * (d[k] - f.at); }
        }
        // Smoothstep so the grade changes gently into and out of the plateau.
        if (wt > 0) prof[k] += (y - prof[k]) * wt * wt * (3 - 2 * wt);
      }
    w.profile = { dist: Float32Array.from(d), y: Float32Array.from(prof) };
  }

  // Where one road simply continues as another (two road ends at a node, nothing else), give both the same
  // grade at the node: filtered apart, they would meet at a kink, and the collision overlap at the joint
  // (roads.ts end caps) would stick up out of the steeper one.
  const ends = new Map<number, { w: Way; atEnd: boolean }[]>();
  for (const w of roads) {
    if (!w.profile || w.profile.y.length < 3) continue;
    for (const atEnd of [false, true]) {
      const id = w.ids[atEnd ? w.ids.length - 1 : 0];
      if (degree.get(id) !== 2 || anchors.has(id)) continue;
      if (!ends.has(id)) ends.set(id, []);
      ends.get(id)!.push({ w, atEnd });
    }
  }
  // Outward grade of a road at one of its ends, over GRADE_SPAN metres.
  const outward = ({ w, atEnd }: { w: Way; atEnd: boolean }) => {
    const { dist, y } = w.profile!;
    const n = y.length, len = dist[n - 1];
    const at = (x: number) => {
      let k = 0;
      while (k < n - 2 && dist[k + 1] < x) k++;
      return y[k] + (y[k + 1] - y[k]) * Math.min(1, Math.max(0, (x - dist[k]) / (dist[k + 1] - dist[k] || 1)));
    };
    const span = Math.min(GRADE_SPAN, len);
    return atEnd ? (y[n - 1] - at(len - span)) / span : (y[0] - at(span)) / span;
  };
  for (const pair of ends.values()) {
    if (pair.length !== 2 || pair[0].w === pair[1].w) continue;
    const [g0, g1] = pair.map(outward);
    // Travelling from the first road into the second, the grade is g0 before the node and -g1 after.
    const s = (g0 - g1) / 2;
    pair.forEach((e, i) => {
      const fix = (i ? -s : s) - (i ? g1 : g0);
      const { dist, y } = e.w.profile!;
      const len = dist[dist.length - 1];
      const reach = Math.min(GRADE_REACH, len / 2);
      for (let k = 0; k < y.length; k++) {
        const x = e.atEnd ? len - dist[k] : dist[k];
        if (x < reach) y[k] += fix * -x * (1 - x / reach) ** 2;
      }
    });
  }
  return { roads: roads.length, nodes: nodeH.size, maxCorrection };
}
