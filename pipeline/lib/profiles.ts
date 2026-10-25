// Height profiles of roads. Draping a road straight onto 1 m terrain copies every flaw of the data into the
// driving surface: OSM lines that run a metre off the road onto an embankment slope, kerbs, ditches, the
// slope at a bridge end. Real roads are smooth, so each road gets a profile sampled from the terrain,
// filtered, and pinned to one height per shared node so that roads meeting at a node (and bridges) meet exactly.
// The laser terrain also has small measuring errors (a few centimetres to decimetres over 10–30 m) that a
// short filter keeps as bumps; real roads are built with long vertical curves, so the profile is smoothed
// over a length that grows with the road class.
import { SYNTHETIC_NODE, type Way } from './osm.ts';
import { ROAD_CLASSES, densify, isBridge, isDrivable, roadWidth } from './roads.ts';

/** Spacing of profile samples (m). */
export const PROFILE_STEP = 2;
/** Half window of the median filter (samples). */
const MEDIAN = 3;
/** Gaussian smoothing after the median (sigma, m): long on fast roads with big vertical curves, shorter in town. */
export function profileSigma(highway: string) {
  const rank = ROAD_CLASSES[highway]?.rank ?? 0;
  return rank >= 8 ? 28 : rank >= 5 ? 16 : rank >= 2 ? 11 : 8;
}
/** Shortest reach (m) over which a node correction fades out along the road. */
const PIN_REACH = 24;
/** Dips narrower than about twice this (samples) are filled: culverts and stream beds the road crosses on fill. */
const CLOSE = 4;
/** Node heights come from the terrain this far along each road from the node (m). */
const NODE_REACH = 6;
/** Steepest ramp used to bring a profile to its node height (rise per metre). */
const RAMP_GRADE = 0.04;
/** Past the junction plateau the road blends back into its own profile over this length (m). */
const JUNCTION_BLEND = 10;
/** A junction plateau tilts with the grade of its main road, up to this much (rise per metre). */
const PLATEAU_GRADE = 0.12;
/** Grade of a road end is measured over this length, and matched to the road it continues into over this reach (m). */
const GRADE_SPAN = 4, GRADE_REACH = 16;
/** Grade of each road at a junction, for the plateau's tilt, is measured over this much either side (m). */
const TILT_SPAN = 8;
/** Direction of a junction arm is taken over this length (m); a plateau reaches at most this far along an arm. */
const ARM_SPAN = 10, MAX_ARM_REACH = 30;

const median = (vs: number[]) => {
  const s = vs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const win = (vs: number[], k: number, r: number) => vs.slice(Math.max(0, k - r), k + r + 1);

export interface ProfileReport { roads: number; nodes: number; maxCorrection: number; roughness: Roughness }

/** How bumpy profiles are: the largest and the mean deviation from a 40 m running mean, in metres. */
export interface Roughness { max: number; mean: number }

/**
 * Gaussian smoothing of samples at distances `d` (sigma in m) as a locally weighted straight-line fit, so a
 * steady grade passes unchanged, also at the ends where the window is one-sided.
 */
export function gaussSmooth(ys: ArrayLike<number>, d: ArrayLike<number>, sigma: number): number[] {
  const n = ys.length, out = new Array<number>(n);
  const r = 3 * sigma;
  let lo = 0;
  for (let k = 0; k < n; k++) {
    while (d[lo] < d[k] - r) lo++;
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = lo; j < n && d[j] <= d[k] + r; j++) {
      const x = d[j] - d[k], w = Math.exp(-0.5 * (x / sigma) ** 2);
      sw += w; sx += w * x; sy += w * ys[j]; sxx += w * x * x; sxy += w * x * ys[j];
    }
    const det = sw * sxx - sx * sx;
    // Value of the fitted line at x = 0; a plain weighted mean where the window is too short for a line.
    out[k] = det > 1e-9 * sw * sw ? (sy * sxx - sx * sxy) / det : sy / sw;
  }
  return out;
}

/** Bumps along road profiles: deviation of each sample from the 40 m running mean around it. */
export function profileRoughness(ways: Way[]): Roughness {
  let max = 0, sum = 0, cnt = 0;
  for (const w of ways) {
    const p = w.profile;
    if (!p || p.y.length < 12) continue;
    const { dist: d, y } = p;
    const len = d[d.length - 1];
    let lo = 0, hi = 0, acc = 0;
    for (let k = 0; k < y.length; k++) {
      // Only samples with the full window, away from the ends where junctions shape the profile.
      if (d[k] < 20 || d[k] > len - 20) continue;
      while (hi < y.length && d[hi] <= d[k] + 20) acc += y[hi++];
      while (d[lo] < d[k] - 20) acc -= y[lo++];
      const dev = Math.abs(y[k] - acc / (hi - lo));
      max = Math.max(max, dev); sum += dev; cnt++;
    }
  }
  return { max, mean: cnt ? sum / cnt : 0 };
}

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

  // Median (removes kerbs and ditch edges), then a Gaussian over a length by road class (removes the
  // measuring noise, keeps hills).
  const smoothed = new Map<Way, number[]>();
  for (const w of roads) {
    const { ys } = raw.get(w)!;
    const med = ys.map((_, k) => median(win(ys, k, MEDIAN)));
    smoothed.set(w, gaussSmooth(med, dists.get(w)!, profileSigma(w.tags.highway)));
  }

  // One height per node shared by several roads (or by one road twice): the median of the smoothed profiles
  // near it along every road through it, or the deck. Nodes on one road only need no pin: the profile runs
  // smoothly through them.
  const uses = new Map<number, number>();
  for (const w of roads) for (const id of w.ids) uses.set(id, (uses.get(id) ?? 0) + 1);
  const near = new Map<number, number[]>();
  for (const w of roads) {
    const { nodeAt } = raw.get(w)!;
    const ys = smoothed.get(w)!;
    const d = dists.get(w)!;
    w.ids.forEach((id, i) => {
      // Points the pipeline added only shape the line.
      if (anchors.has(id) || id < SYNTHETIC_NODE || (uses.get(id) ?? 0) < 2) return;
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
    const smooth = smoothed.get(w)!;
    // Ramp the profile onto each pinned node height: full correction at the node, fading out smoothly along
    // the road (never past the next pinned node, so each pin holds exactly).
    const pins = w.ids.flatMap((id, i) => (nodeH.has(id) ? [i] : []));
    const prof = smooth.slice();
    pins.forEach((i, pi) => {
      const target = nodeH.get(w.ids[i])!;
      const k0 = d.findIndex((v) => v >= nodeAt[i] - 1e-6);
      const delta = target - smooth[k0];
      maxCorrection = Math.max(maxCorrection, Math.abs(delta));
      // Before the first pin and after the last the correction fades out towards the road's free end.
      const before = nodeAt[i] - (pi > 0 ? nodeAt[pins[pi - 1]] : 0);
      const after = (pi < pins.length - 1 ? nodeAt[pins[pi + 1]] : nodeAt[w.ids.length - 1]) - nodeAt[i];
      // Smoothstep fade: its steepest grade is 1.5 × delta / reach.
      const reach = Math.max(PIN_REACH, (1.5 * Math.abs(delta)) / RAMP_GRADE);
      for (let k = 0; k < prof.length; k++) {
        const off = d[k] - nodeAt[i];
        if (Math.abs(off) < 1e-6) { prof[k] += delta; continue; }
        const span = off < 0 ? Math.min(reach, before) : Math.min(reach, after);
        if (!span) continue;
        const t = 1 - Math.abs(off) / span;
        if (t > 0) prof[k] += delta * t * t * (3 - 2 * t);
      }
    });
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
  // Junction plateaus are planes through the node height, tilted with the roads that meet there: a flat
  // plateau on a steep street makes the street climb twice as steeply into it and leaves a crest to jump
  // from. The plane's gradient is fitted to the grade of every road at the node (weighted by class and
  // width), so on a hillside both the street and the side road keep their grade through the junction; where
  // all roads run one way it takes the main road's grade. All surfaces still meet at the node.
  const fits = new Map<number, { see: number; snn: number; sen: number; ses: number; sns: number; best: number; g: [number, number] }>();
  for (const w of roads) {
    const { nodeAt } = raw.get(w)!;
    const len = dists.get(w)!.at(-1)!;
    const wt = (ROAD_CLASSES[w.tags.highway].rank + 1) * roadWidth(w.tags)!;
    w.ids.forEach((id, i) => {
      if (!isJunction(id)) return;
      const x0 = Math.max(0, nodeAt[i] - TILT_SPAN), x1 = Math.min(len, nodeAt[i] + TILT_SPAN);
      if (x1 - x0 < 1) return;
      const s = (at(w, x1) - at(w, x0)) / (x1 - x0);
      const [ue, un] = heading(w, i);
      if (!fits.has(id)) fits.set(id, { see: 0, snn: 0, sen: 0, ses: 0, sns: 0, best: 0, g: [0, 0] });
      const f = fits.get(id)!;
      f.see += wt * ue * ue; f.snn += wt * un * un; f.sen += wt * ue * un; f.ses += wt * ue * s; f.sns += wt * un * s;
      if (wt > f.best) { f.best = wt; f.g = [s * ue, s * un]; }
    });
  }
  const tilt = new Map<number, [number, number]>();
  for (const [id, f] of fits) {
    const det = f.see * f.snn - f.sen * f.sen;
    // Roads crossing at less than about 15° do not fix a plane: keep the main road's grade.
    let g: [number, number] = det > 0.07 * (f.see + f.snn) ** 2 ? [(f.ses * f.snn - f.sns * f.sen) / det, (f.sns * f.see - f.ses * f.sen) / det] : f.g;
    const m = Math.hypot(g[0], g[1]);
    if (m > PLATEAU_GRADE) g = [(g[0] * PLATEAU_GRADE) / m, (g[1] * PLATEAU_GRADE) / m];
    tilt.set(id, g);
  }

  // Arms of each junction: the direction each road leaves it in (over its first ARM_SPAN metres), and its
  // half width. Where two arms leave at an acute angle their surfaces overlap for a long way, so the plateau
  // reaches along each arm as far as another arm's surface still overlaps it.
  const armDir = (w: Way, i: number, step: 1 | -1): [number, number] | undefined => {
    const [e0, n0] = w.pts[i];
    let j = i + step;
    if (j < 0 || j >= w.pts.length) return undefined;
    while (j + step >= 0 && j + step < w.pts.length && Math.hypot(w.pts[j][0] - e0, w.pts[j][1] - n0) < ARM_SPAN) j += step;
    const l = Math.hypot(w.pts[j][0] - e0, w.pts[j][1] - n0) || 1;
    return [(w.pts[j][0] - e0) / l, (w.pts[j][1] - n0) / l];
  };
  const arms = new Map<number, { w: Way; u: [number, number]; hw: number }[]>();
  for (const w of roads) {
    const hw = roadWidth(w.tags)! / 2;
    w.ids.forEach((id, i) => {
      if (!isJunction(id)) return;
      if (!arms.has(id)) arms.set(id, []);
      for (const step of [-1, 1] as const) {
        const u = armDir(w, i, step);
        if (u) arms.get(id)!.push({ w, u, hw });
      }
    });
  }
  /** How far along the arm of `w` leaving in direction `u` another arm's surface still overlaps it. */
  const overlapReach = (id: number, w: Way, u: [number, number], hw: number) => {
    let r = 0;
    for (const a of arms.get(id) ?? []) {
      if (a.w === w) continue;
      const cos = u[0] * a.u[0] + u[1] * a.u[1];
      if (cos <= 0) continue;
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      r = Math.max(r, Math.min(MAX_ARM_REACH, (hw + a.hw) / Math.max(sin, 1e-3)));
    }
    return r;
  };

  for (const w of roads) {
    const { nodeAt } = raw.get(w)!;
    const d = dists.get(w)!;
    const prof = pinned.get(w)!;
    const hw = roadWidth(w.tags)! / 2;
    const flats = w.ids.flatMap((id, i) => {
      if (!isJunction(id)) return [];
      const [ge, gn] = tilt.get(id) ?? [0, 0];
      const [ue, un] = heading(w, i);
      const base = widest.get(id)! + 0.5;
      const back = armDir(w, i, -1), fwd = armDir(w, i, 1);
      return [{
        at: nodeAt[i], y: nodeH.get(id)!, slope: ge * ue + gn * un,
        rBack: Math.max(base, back ? overlapReach(id, w, back, hw) : 0),
        rFwd: Math.max(base, fwd ? overlapReach(id, w, fwd, hw) : 0),
      }];
    });
    if (flats.length)
      for (let k = 0; k < prof.length; k++) {
        // Plateaus close together share the stretch between them: weighted by closeness, so the profile
        // passes continuously from one to the next instead of stepping where the nearer one changes.
        let wt = 0, sw = 0, sy = 0;
        for (const f of flats) {
          const off = Math.abs(d[k] - f.at), r = d[k] < f.at ? f.rBack : f.rFwd;
          const t = off <= r ? 1 : Math.max(0, 1 - (off - r) / JUNCTION_BLEND);
          if (!t) continue;
          const tw = off <= r ? 1e6 : t;
          wt = Math.max(wt, t); sw += tw; sy += tw * (f.y + f.slope * (d[k] - f.at));
        }
        const y = sw ? sy / sw : 0;
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
  return { roads: roads.length, nodes: nodeH.size, maxCorrection, roughness: profileRoughness(roads) };
}
