// Motorway junctions as they are built (RAA/RMS): ramps leave and join over an auxiliary lane instead of
// branching off the carriageway at an angle.
//
// OSM maps the deceleration and acceleration lanes of German motorways as an extra lane of the motorway way
// (lanes=3 with turn:lanes=…|slight_right or …|merge_to_left and placement=right_of:1) up to the node where
// the ramp leaves or joins. This module finds those runs of ways, marks them (tag sls:aux, see roadSpec.ts)
// so the cross-section adds the lane on the right of the through lanes, gives them a taper where the lane
// opens or closes without a ramp, and moves the first (exit) or last (entry) stretch of each ramp sideways so
// that it continues the auxiliary lane: its left edge line carries on the block marking, its right edge line
// the motorway's edge line. The road graph keeps the original nodes (Way.graph), so traffic and navigation
// are unchanged.
import { edgeLineWidth } from '../../src/render/pbr/roadCode.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import { isBridge, ROAD_CLASSES } from './roads.ts';
import { SYNTHETIC_NODE, type Way } from './osm.ts';
import { utmToLocal, type WorldInfo } from '../../src/world/format.ts';

/** Length of the taper where an auxiliary lane opens or closes (RAA: 60 m). */
export const TAPER = 60;
/** How far along a ramp it may run beside the motorway before it has left it. */
const REACH = 700;
/** Softness of the bend where a moved ramp hands over to its mapped course, metres. */
const SOFT = 4;
/** Densified spacing of a moved ramp. */
const STEP = 4;
/** Runs longer than this are real extra lanes, not junction lanes. */
const MAX_RUN = 2500;

export interface Ramp {
  kind: 'exit' | 'entry';
  /** Junction node (where the ramp leaves or joins). */
  e: number;
  n: number;
  /** Motorway ref, e.g. "A 8". */
  ref: string;
  destination: string;
  /** Whether the ramp runs on an auxiliary lane (otherwise it is left as mapped). */
  aux: boolean;
  /** Teleport spot for the debug console: on the motorway before an exit, on the ramp before an entry. */
  tp: { e: number; n: number; heading: number };
}

/** The wedge between a motorway and a ramp leaving it (or joining it): where the two carriageways part. */
export interface Gore {
  kind: 'exit' | 'entry';
  e: number;
  n: number;
  /** The moved ramp centreline, from the junction node outwards. */
  pts: [number, number][];
  /** Offset of the ramp's left edge line (its outer side, towards the motorway) right of its centreline. */
  leftLine: number;
  /** Motorway ways the ramp runs alongside (downstream of an exit, upstream of an entry). */
  ways: Set<Way>;
  /** The ramp's ways, from the junction outwards. */
  links: Way[];
  /** Distance from the junction along the ramp up to which it runs moved beside the motorway. */
  beside: number;
}

export interface RampPlan {
  ramps: Ramp[];
  gores: Gore[];
  /** Ways of auxiliary runs and moved ramps, for the log. */
  stats: { runs: number; moved: number; plain: number };
}

const lanesOf = (w: Way) => roadSection(w.tags)?.lanes ?? 2;
const auxTurn = (w: Way) => /slight_right|merge_to_left|merge_to_right/.test((w.tags['turn:lanes'] ?? '').split('|').pop() ?? '');
const len = (pts: [number, number][]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** Polyline in travel direction with projection. */
export class Line {
  cum: number[] = [0];
  readonly pts: [number, number][];
  constructor(pts: [number, number][]) {
    this.pts = pts;
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  get length() { return this.cum[this.cum.length - 1]; }
  /** Distance along the line, signed offset to the right, and the unit direction there. */
  project(e: number, n: number) {
    let best = { d: 0, lat: 0, dist: Infinity, dx: 0, dy: 1, end: false };
    for (let i = 1; i < this.pts.length; i++) {
      const [ae, an] = this.pts[i - 1], [be, bn] = this.pts[i];
      const sx = be - ae, sy = bn - an, l2 = sx * sx + sy * sy || 1;
      const t = Math.min(1, Math.max(0, ((e - ae) * sx + (n - an) * sy) / l2));
      const px = ae + sx * t, py = an + sy * t;
      const dist = Math.hypot(e - px, n - py);
      if (dist < best.dist) {
        const l = Math.sqrt(l2);
        const dx = sx / l, dy = sy / l;
        // Right of the direction (dx, dy) is (dy, -dx).
        best = { d: this.cum[i - 1] + t * l, lat: (e - px) * dy - (n - py) * dx, dist, dx, dy, end: (i === 1 && t === 0) || (i === this.pts.length - 1 && t === 1) };
      }
    }
    return best;
  }
  at(d: number) {
    let i = 1;
    while (i < this.pts.length - 1 && this.cum[i] < d) i++;
    const [ae, an] = this.pts[i - 1], [be, bn] = this.pts[i];
    const l = this.cum[i] - this.cum[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (d - this.cum[i - 1]) / l));
    return { e: ae + (be - ae) * t, n: an + (bn - an) * t, dx: (be - ae) / l, dy: (bn - an) / l };
  }
}

/** Smooth maximum of a and b: the plain maximum where they differ by more than k, rounded in between. */
const softMax = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
};

let synthetic = SYNTHETIC_NODE - 1;

/**
 * Finds the auxiliary lanes and moves the ramps onto them. Mutates the ways: tags (sls:aux), auxRun, and
 * pts/ids/graph of moved ramps. Run once after reading OSM, before heights and the road graph.
 */
export function planRamps(ways: Way[]): RampPlan {
  const plan: RampPlan = { ramps: [], gores: [], stats: { runs: 0, moved: 0, plain: 0 } };
  const motorways = ways.filter((w) => w.tags.highway === 'motorway' && w.pts.length >= 2);
  const links = ways.filter((w) => w.tags.highway === 'motorway_link' && w.pts.length >= 2);
  const index = (list: Way[], end: boolean) => {
    const m = new Map<number, Way[]>();
    for (const w of list) {
      const id = end ? w.ids[w.ids.length - 1] : w.ids[0];
      if (!m.has(id)) m.set(id, []);
      m.get(id)!.push(w);
    }
    return m;
  };
  const mStart = index(motorways, false), mEnd = index(motorways, true);
  const lStart = index(links, false), lEnd = index(links, true);
  const pick = (list: Way[] | undefined, self: Way) => {
    const c = (list ?? []).filter((w) => w !== self);
    return c.length === 1 ? c[0] : c.find((w) => w.tags.ref === self.tags.ref);
  };
  const next = (w: Way) => pick(mStart.get(w.ids[w.ids.length - 1]), w);
  const prev = (w: Way) => pick(mEnd.get(w.ids[0]), w);

  // Motorway polyline from a way onwards (or backwards up to its end), up to `reach` metres.
  const forward = (w: Way | undefined, reach: number) => {
    const pts: [number, number][] = [];
    const seen = new Set<Way>();
    while (w && !seen.has(w) && len(pts) < reach) {
      seen.add(w);
      pts.push(...(pts.length ? w.pts.slice(1) : w.pts));
      w = next(w);
    }
    return { pts, ways: seen };
  };
  const backward = (w: Way | undefined, reach: number) => {
    const pts: [number, number][] = [];
    const seen = new Set<Way>();
    while (w && !seen.has(w) && len(pts) < reach) {
      seen.add(w);
      pts.unshift(...(pts.length ? w.pts.slice(0, -1) : w.pts));
      w = prev(w);
    }
    return { pts, ways: seen };
  };

  // Runs of consecutive motorway ways with the same lane count.
  const done = new Set<Way>();
  const moved = new Set<Way>();
  for (const w0 of motorways) {
    if (done.has(w0)) continue;
    const n = lanesOf(w0);
    let first = w0;
    for (let p = prev(first); p && !done.has(p) && p !== w0 && lanesOf(p) === n; p = prev(first)) first = p;
    const run: Way[] = [];
    for (let w: Way | undefined = first; w && !done.has(w) && lanesOf(w) === n; w = next(w)) { run.push(w); done.add(w); }
    const last = run[run.length - 1];
    const before = prev(first), after = next(last);
    const startNode = first.ids[0], endNode = last.ids[last.ids.length - 1];
    const joins = lEnd.get(startNode) ?? [], leaves = lStart.get(endNode) ?? [];
    const added = !!before && lanesOf(before) === n - 1, dropped = !!after && lanesOf(after) === n - 1;
    const length = run.reduce((s, w) => s + len(w.pts), 0);
    const tagged = run.some(auxTurn);
    const aux = n >= 2 && length < MAX_RUN && (added || dropped) &&
      ((added && joins.length > 0) || (dropped && leaves.length > 0) || tagged) && !run.some((w) => w.tags.tunnel === 'yes');
    if (!aux) continue;
    plan.stats.runs++;
    const taperIn = added && !joins.length ? Math.min(TAPER, length / 3) : 0;
    const taperOut = dropped && !leaves.length ? Math.min(TAPER, length / 3) : 0;
    let from = 0;
    for (const w of run) {
      w.tags['sls:aux'] = 'yes';
      w.auxRun = { from, length, taperIn, taperOut };
      from += len(w.pts);
    }
    // Ramps on the auxiliary lane: exits at the end where the lane leaves, entries at the start.
    const block = roadSection(last.tags)!.block!;
    if (dropped) for (const link of leaves) moveRamp(link, 'exit', roadSection(first.tags)!.block ?? block, forward(after, REACH), backward(last, 500));
    if (added) for (const link of joins) moveRamp(link, 'entry', roadSection(first.tags)!.block ?? block, backward(before, REACH), backward(before, 400));
  }

  // Ramps without an auxiliary lane stay as mapped; list them for the debug console all the same.
  for (const [node, list] of lStart)
    for (const link of list) if (!moved.has(link) && (mEnd.has(node) || mStart.has(node))) addPlain(link, 'exit', node);
  for (const [node, list] of lEnd)
    for (const link of list) if (!moved.has(link) && (mEnd.has(node) || mStart.has(node))) addPlain(link, 'entry', node);
  return plan;

  function addPlain(link: Way, kind: 'exit' | 'entry', node: number) {
    const m = (mEnd.get(node) ?? mStart.get(node))![0];
    const i = m.ids.indexOf(node);
    const [e, n] = m.pts[i];
    const back = backward(mEnd.get(node)?.[0], 400);
    const line = new Line(back.pts.length >= 2 ? back.pts : m.pts);
    const at = kind === 'exit' ? line.at(Math.max(0, line.length - 350)) : new Line(link.pts).at(Math.max(0, len(link.pts) - 120));
    plan.ramps.push({ kind, e, n, ref: m.tags.ref ?? '', destination: link.tags.destination ?? link.tags['destination:ref'] ?? '', aux: false, tp: { e: at.e, n: at.n, heading: Math.atan2(at.dx, at.dy) } });
    plan.stats.plain++;
  }

  /**
   * Moves a ramp so it continues the auxiliary lane. `block` is the offset of the block marking (the line
   * between the through lanes and the auxiliary lane) right of the motorway line; `ref` the motorway beside
   * the ramp, in travel direction (downstream of an exit, upstream of an entry, ending at the junction).
   */
  function moveRamp(link: Way, kind: 'exit' | 'entry', block: number, ref: { pts: [number, number][]; ways: Set<Way> }, approach: { pts: [number, number][] }) {
    if (moved.has(link) || ref.pts.length < 2 || isBridge(link.tags)) return;
    const ls = roadSection(link.tags);
    if (!ls) return;
    const lw = edgeLineWidth(ls.outer);
    // The ramp's left edge line (its outer side) lies on the block marking: [block, block + lw].
    const leftLine = -ls.width / 2 + ls.inner - lw + ls.shift;
    const target = block - leftLine;
    // The ramp's ways from the junction outwards, as (way, index) in walking order.
    const chain: Way[] = [];
    for (let w: Way | undefined = link; w && !moved.has(w) && !chain.includes(w) && !isBridge(w.tags) && chain.reduce((s, c) => s + len(c.pts), 0) < REACH;) {
      chain.push(w);
      const nextList: Way[] | undefined = kind === 'exit' ? lStart.get(w.ids[w.ids.length - 1]) : lEnd.get(w.ids[0]);
      const joinOthers: Way[] | undefined = kind === 'exit' ? lEnd.get(w.ids[w.ids.length - 1]) : lStart.get(w.ids[0]);
      w = nextList?.length === 1 && (joinOthers?.length ?? 0) <= 1 ? nextList[0] : undefined;
    }
    const line = new Line(ref.pts);
    // Walk outwards from the junction, densified, with the lateral offset from the motorway line.
    interface P { e: number; n: number; d: number; lat: number; dx: number; dy: number; beyond: boolean }
    const walk: P[][] = [];
    let d = 0;
    let last: [number, number] | undefined;
    for (const w of chain) {
      const pts = kind === 'exit' ? w.pts : [...w.pts].reverse();
      const dense: P[] = [];
      for (let i = 0; i < pts.length; i++) {
        const seg = i ? densifySeg(pts[i - 1], pts[i]) : [pts[0]];
        for (const p of seg) {
          if (last) d += Math.hypot(p[0] - last[0], p[1] - last[1]);
          last = p;
          const pr = line.project(p[0], p[1]);
          dense.push({ e: p[0], n: p[1], d, lat: pr.lat, dx: pr.dx, dy: pr.dy, beyond: pr.end && pr.dist > 0.5 });
        }
      }
      walk.push(dense);
    }
    const flat = walk.flat();
    // A ramp that leaves on the left, or crosses over the motorway, is left alone.
    if (flat.some((p) => p.d < 120 && p.lat < -2)) return;
    // Offset added per point: up to the auxiliary lane, until the mapped course has left the motorway.
    const shiftAt = (p: P) => (p.beyond ? 0 : Math.max(0, softMax(p.lat, target, SOFT) - p.lat));
    const free = flat.findIndex((p) => p.d > 20 && shiftAt(p) < 0.02);
    const total = d;
    // If the mapped ramp never leaves the motorway within the chain, ease back to it over its last stretch.
    const fade = (p: P) => (free >= 0 ? (p.d < flat[free].d ? 1 : 0) : Math.min(1, Math.max(0, (total - p.d) / 80)));
    const out: [number, number][] = [];
    const commit: (() => void)[] = [];
    for (let k = 0; k < chain.length; k++) {
      const w = chain[k];
      const pts: [number, number][] = [];
      const ids: number[] = [];
      const at: number[] = [];
      const orig = kind === 'exit' ? w.pts : [...w.pts].reverse();
      const origIds = kind === 'exit' ? w.ids : [...w.ids].reverse();
      let oi = 0;
      for (const p of walk[k]) {
        const s = shiftAt(p) * fade(p);
        const isNode = oi < orig.length && Math.abs(p.e - orig[oi][0]) < 1e-6 && Math.abs(p.n - orig[oi][1]) < 1e-6;
        // Only the stretch that moves is densified; elsewhere keep the mapped nodes.
        if (!isNode && s < 0.01) continue;
        const q: [number, number] = [p.e + p.dy * s, p.n - p.dx * s];
        pts.push(q);
        if (isNode) { at.push(pts.length - 1); ids.push(origIds[oi++]); } else ids.push(synthetic--);
        if (out.length === 0 || q[0] !== out[out.length - 1][0] || q[1] !== out[out.length - 1][1]) out.push(q);
      }
      if (oi !== orig.length) return; // geometry did not line up (duplicate nodes): leave the ramp as mapped
      const g = { pts: w.pts, ids: w.ids, at: kind === 'exit' ? at : at.map((i) => pts.length - 1 - i).reverse() };
      if (kind === 'entry') { pts.reverse(); ids.reverse(); }
      commit.push(() => {
        w.graph = g;
        w.pts = pts;
        w.ids = ids;
        moved.add(w);
      });
    }
    for (const c of commit) c();
    plan.stats.moved++;
    const j = kind === 'exit' ? link.pts[0] : link.pts[link.pts.length - 1];
    const jNode = kind === 'exit' ? link.graph!.pts[0] : link.graph!.pts[link.graph!.pts.length - 1];
    plan.gores.push({ kind, e: jNode[0], n: jNode[1], pts: out, leftLine, ways: ref.ways, links: chain, beside: free >= 0 ? flat[free].d : total });
    // Teleport: 350 m before the junction on the motorway (exit), 120 m up the ramp (entry).
    const ap = new Line(approach.pts.length >= 2 ? approach.pts : ref.pts);
    const tp = kind === 'exit' ? ap.at(Math.max(0, ap.length - 350)) : new Line(link.pts).at(Math.max(0, len(link.pts) - 120));
    plan.ramps.push({
      kind, e: j[0], n: j[1], ref: [...ref.ways][0]?.tags.ref ?? '', destination: link.tags.destination ?? link.tags['destination:ref'] ?? '', aux: true,
      tp: { e: tp.e, n: tp.n, heading: Math.atan2(tp.dx, tp.dy) },
    });
  }
}

function densifySeg(a: [number, number], b: [number, number]): [number, number][] {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(d / STEP));
  const out: [number, number][] = [];
  for (let k = 1; k <= n; k++) out.push(k === n ? b : [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}

/** Junctions for the game's hw.* debug commands (public/tiles/ramps.json), in local coordinates. */
export function rampList(plan: RampPlan, world: WorldInfo) {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    v: 1,
    // [kind 0 exit / 1 entry, x, z, auxiliary lane 0/1, teleport x, z, heading (rad), motorway ref, destination]
    ramps: plan.ramps.map((r) => {
      const [x, z] = utmToLocal(world, r.e, r.n);
      const [tx, tz] = utmToLocal(world, r.tp.e, r.tp.n);
      return [r.kind === 'exit' ? 0 : 1, r1(x), r1(z), r.aux ? 1 : 0, r1(tx), r1(tz), Math.round(r.tp.heading * 1000) / 1000, r.ref, r.destination];
    }),
  };
}

/** Blend length after a ramp leaves the motorway, over which its own height profile takes over again. */
const HEIGHT_BLEND = 60;

/**
 * Where a moved ramp runs beside the motorway on the auxiliary lane, the two surfaces meet edge to edge, so
 * the ramp takes the motorway's height there (its own terrain profile would leave a step along the seam).
 * Run after roadHeights (needs the profiles).
 */
export function matchRampHeights(plan: RampPlan) {
  for (const g of plan.gores) {
    const mws = [...g.ways].filter((w) => w.profile && !isBridge(w.tags)).map((w) => ({ w, line: new Line(w.pts) }));
    if (!mws.length) continue;
    let base = 0;
    for (const w of g.links) {
      const wl = len(w.pts);
      const prof = w.profile;
      if (prof) {
        const line = new Line(w.pts);
        for (let k = 0; k < prof.y.length; k++) {
          const dJ = base + (g.kind === 'exit' ? prof.dist[k] : wl - prof.dist[k]);
          const t = dJ <= g.beside ? 1 : Math.max(0, 1 - (dJ - g.beside) / HEIGHT_BLEND);
          if (t <= 0) continue;
          const p = line.at(prof.dist[k]);
          let best: { y: number; dist: number } | undefined;
          for (const { w: m, line: ml } of mws) {
            const pr = ml.project(p.e, p.n);
            if ((pr.end && pr.dist > 1) || pr.dist > 30 || (best && pr.dist >= best.dist)) continue;
            // The motorway's surface (its profile plus any lift onto an overpass), less the ramp's draw-order lift.
            best = { y: profileAt(m.profile!, pr.d) + raiseAt(m, pr.d) + (ROAD_CLASSES.motorway.rank - ROAD_CLASSES.motorway_link.rank) * 0.008, dist: pr.dist };
          }
          if (!best) continue;
          // Smoothstep, so the grade eases into the ramp's own profile.
          const s = t * t * (3 - 2 * t);
          prof.y[k] += (best.y - prof.y[k]) * s;
        }
      }
      base += wl;
    }
  }
}

function raiseAt(w: Way, d: number) {
  if (!w.raise) return 0;
  let cum = 0;
  for (let i = 1; i < w.pts.length; i++) {
    const l = Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
    if (d <= cum + l || i === w.pts.length - 1) return w.raise[i - 1] + (w.raise[i] - w.raise[i - 1]) * Math.min(1, Math.max(0, (d - cum) / (l || 1)));
    cum += l;
  }
  return w.raise[0];
}

function profileAt(p: { dist: Float32Array; y: Float32Array }, d: number) {
  let k = 0;
  while (k < p.dist.length - 2 && p.dist[k + 1] < d) k++;
  const t = Math.min(1, Math.max(0, (d - p.dist[k]) / (p.dist[k + 1] - p.dist[k] || 1)));
  return p.y[k] + (p.y[k + 1] - p.y[k]) * t;
}
