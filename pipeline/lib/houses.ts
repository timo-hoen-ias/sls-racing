import { type WorldInfo, tileKey, utmToLocal } from '../../src/world/format.ts';
import {
  GARDEN_LINEAR, GARDENS, HOUSE_MODELS, type GardenPart, type HouseKind, type HouseModel, type HouseStyle, TINTS, gardenIndex,
} from '../../src/world/houseKinds.ts';
import { rand } from './ground.ts';
import { pointInRing } from './osm.ts';

// Freely designed houses (fun-racer look, src/world/houseCatalog.json) in place of the surveyed buildings: small
// detached houses become one of 30 models in six styles, large detached homes villas, administrative buildings
// one of three Amtsgebäude. A building qualifies when its footprint is roughly a rectangle that one of the models
// fits with little stretching, nothing else stands right next to it (terraces and semi-detached houses keep their
// real shape) and the model with its steps stays off every road, pavement and footpath. The model faces the
// nearest street; the strip between it and the street becomes a front garden in the model's garden style.

export interface HouseCandidate {
  /** Unique key ('L' + LoD2 id or 'O' + OSM id). */
  key: string;
  outer: [number, number][];
  /** OSM-style tags (LoD2 buildings: from their ALKIS function). */
  tags: Record<string, string>;
  /** ALKIS function code, e.g. "31001_1000". */
  fn?: string;
}

export interface HouseOptions {
  world: WorldInfo;
  height: (e: number, n: number) => number;
  /** Road surface with pavements and a margin: houses, steps and garden parts stay off it. */
  onRoad: (e: number, n: number) => boolean;
  /** Footpaths and cycle paths. */
  onPath: (e: number, n: number) => boolean;
  /** Distance from the old town centre (m). */
  centre: (e: number, n: number) => number;
  /** Footprints of every building (candidates too) with their keys, to keep terraces and neighbours intact. */
  footprints: { key: string; ring: [number, number][] }[];
}

/** A placed house, also the input for its front garden. */
export interface HousePlan {
  key: string;
  model: number;
  /** Centre (UTM), front normal (unit, UTM) and right vector (model +x). */
  e: number; n: number; fe: number; fn: number; re: number; rn: number;
  /** Scaled half width (along the front) and half depth (m). */
  hw: number; hd: number;
  sx: number; sz: number;
  /** Free depth in front of the house up to the street (m). */
  front: number;
  y: number;
  heading: number;
}

/** Scale limits per kind: houses stretch little, big buildings a bit more. */
const SCALE: Record<HouseKind, [number, number]> = { haus: [0.8, 1.28], villa: [0.78, 1.3], gross: [0.7, 1.45] };
/** Least footprint area / bounding rectangle area. */
const FILL: Record<HouseKind, number> = { haus: 0.72, villa: 0.72, gross: 0.8 };
/** Gap (m) to the next building for a house to count as detached. */
const DETACHED = 0.6;
/** Outbuildings (garages, sheds) up to this area (m²) don't make a house semi-detached: they go with the plot. */
const OUTBUILDING = 45;
/** Old town radius (m): historic styles there, modern ones further out. */
const OLD_TOWN = 900;
/** Least clearance (m) around a house rectangle for the neighbour test. */
const REACH = 0.6;

/** Building kind from tags and ALKIS function, or undefined for buildings that keep their real shape. */
export function houseKindOf(c: HouseCandidate, area: number): HouseKind | undefined {
  const t = c.tags;
  const code = c.fn?.startsWith('31001_') ? Number(c.fn.slice(6)) : undefined;
  const admin = code !== undefined
    ? (code >= 3010 && code < 3020) || code === 2020 || code === 2030 || code === 2040
    : ['public', 'civic', 'government', 'townhall', 'office'].includes(t.building) || ['townhall', 'courthouse'].includes(t.amenity) || t.office === 'government';
  if (admin) return area >= 250 && area <= 2200 ? 'gross' : undefined;
  const home = code !== undefined
    ? code >= 1000 && code < 1200
    : ['house', 'detached', 'villa', 'residential', 'yes', 'bungalow', 'semidetached_house'].includes(t.building) && !t.shop && !t.amenity;
  if (!home) return undefined;
  if (area >= 55 && area <= 175) return 'haus';
  if (area > 175 && area <= 420) return 'villa';
  return undefined;
}

/** Style weights by distance from the old town. */
function styleWeight(style: HouseStyle, centre: number) {
  const old = centre < OLD_TOWN;
  const w: Record<HouseStyle, [number, number]> = {
    antik: [3, 0.8], stadtvilla: [2, 1.2], klassisch: [1, 1.6], landhaus: [0.6, 1.4], modern: [0.8, 1.5], architekt: [0.5, 1.1], villa: [1, 1], verwaltung: [1, 1],
  };
  return w[style][old ? 0 : 1];
}

/** Rectangle of least area around a ring (rotating calipers over the hull edges). */
export function boundingRect(ring: [number, number][]) {
  const hull = convexHull(ring);
  let best: { e: number; n: number; ae: number; an: number; a: number; b: number; area: number } | undefined;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i], [x1, y1] = hull[(i + 1) % hull.length];
    const l = Math.hypot(x1 - x0, y1 - y0);
    if (l < 1e-6) continue;
    const ae = (x1 - x0) / l, an = (y1 - y0) / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ae + y * an, v = -x * an + y * ae;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      best = { e: uc * ae - vc * an, n: uc * an + vc * ae, ae, an, a: (u1 - u0) / 2, b: (v1 - v0) / 2, area };
    }
  }
  return best;
}

function convexHull(pts: [number, number][]) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export const ringArea = (r: [number, number][]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
};

const hashKey = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Grid of footprint rings for the neighbour test. */
export class FootGrid {
  private cells = new Map<string, number[]>();
  private rings: [number, number][][];
  constructor(rings: [number, number][][]) {
    this.rings = rings;
    rings.forEach((r, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [e, n] of r) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
      for (let x = Math.floor(x0 / 32); x <= Math.floor(x1 / 32); x++)
        for (let y = Math.floor(y0 / 32); y <= Math.floor(y1 / 32); y++) {
          const k = `${x}_${y}`;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k)!.push(i);
        }
    });
  }
  /** Rings near a box (UTM bounds). */
  near(x0: number, y0: number, x1: number, y1: number) {
    const out = new Set<number>();
    for (let x = Math.floor(x0 / 32); x <= Math.floor(x1 / 32); x++)
      for (let y = Math.floor(y0 / 32); y <= Math.floor(y1 / 32); y++) for (const i of this.cells.get(`${x}_${y}`) ?? []) out.add(i);
    return [...out].map((i) => this.rings[i]);
  }
  /** Whether (e, n) lies inside any ring. */
  inside(e: number, n: number, skip?: Set<[number, number][]>) {
    return this.near(e, n, e, n).some((r) => !skip?.has(r) && pointInRing(e, n, r));
  }
}

/** Picks houses for the candidates; returns the plans and the keys of the buildings they replace. */
export function planHouses(cands: HouseCandidate[], o: HouseOptions) {
  const grid = new FootGrid(o.footprints.map((f) => f.ring));
  const keyOf = new Map(o.footprints.map((f) => [f.ring, f.key]));
  const plans: HousePlan[] = [];
  const replaced = new Set<string>();
  const rejected: Record<string, number> = {};
  const no = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
  /** Areas already claimed by placed houses (their rectangles grown by the reach), against overlaps. */
  const claimed: [number, number][][] = [];
  const claimGrid = new Map<string, number[]>();
  const claimedAt = (e: number, n: number) => (claimGrid.get(`${Math.floor(e / 32)}_${Math.floor(n / 32)}`) ?? []).some((i) => pointInRing(e, n, claimed[i]));

  for (const c of cands) {
    const area = ringArea(c.outer);
    const kind = houseKindOf(c, area);
    if (!kind) continue;
    const rect = boundingRect(c.outer);
    if (!rect || area / rect.area < FILL[kind]) { no('form'); continue; }
    // Detached: no other footprint within DETACHED of the rectangle.
    const corners = (a: number, b: number) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [rect.e + rect.ae * a * s - rect.an * b * t, rect.n + rect.an * a * s + rect.ae * b * t] as [number, number]);
    const grown = corners(rect.a + DETACHED, rect.b + DETACHED);
    const xs = grown.map((p) => p[0]), ys = grown.map((p) => p[1]);
    const neighbours = grid.near(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)).filter((r) => r !== c.outer && !sameRing(r, c.outer));
    const touches = (r: [number, number][], box: [number, number][]) => r.some(([e, n]) => pointInRing(e, n, box)) || box.some(([e, n]) => pointInRing(e, n, r));
    const close = neighbours.filter((r) => touches(r, grown));
    if (close.some((r) => ringArea(r) > OUTBUILDING)) { no('nachbar'); continue; }
    // Garages and sheds the house (with its eaves) would cut into are cleared with it; the others stay.
    const tight = corners(rect.a + REACH + 0.3, rect.b + REACH + 0.3);
    const absorb = close.filter((r) => touches(r, tight));
    const own = new Set([...absorb, ...neighbours.filter((r) => sameRing(r, c.outer))]);
    for (const r of grid.near(rect.e, rect.n, rect.e, rect.n)) if (r === c.outer || sameRing(r, c.outer)) own.add(r);
    // Which side faces the street: the one with the road closest in front of it.
    const sides = [
      { fe: -rect.an, fn: rect.ae, half: rect.b, width: rect.a },
      { fe: rect.an, fn: -rect.ae, half: rect.b, width: rect.a },
      { fe: rect.ae, fn: rect.an, half: rect.a, width: rect.b },
      { fe: -rect.ae, fn: -rect.an, half: rect.a, width: rect.b },
    ].map((s) => {
      let d = 0;
      for (d = 0.5; d <= 30; d += 0.5) {
        const me = rect.e + s.fe * (s.half + d), mn = rect.n + s.fn * (s.half + d);
        // Probe the middle and both quarters of the side, so a corner of the street counts too.
        const re = -s.fn, rn = s.fe;
        if ([0, -0.5, 0.5].some((t) => o.onRoad(me + re * s.width * t, mn + rn * s.width * t))) break;
      }
      return { ...s, dist: d };
    });
    const side = sides.reduce((a, b) => (b.dist < a.dist ? b : a));
    if (side.dist > 30) { no('keine Straße'); continue; }
    const W = side.width * 2, D = side.half * 2;
    const cen = o.centre(rect.e, rect.n);
    const h = hashKey(c.key);
    // Models of this kind that fit with little stretching, weighted by style and fit.
    const [lo, hi] = SCALE[kind];
    const options = HOUSE_MODELS.map((m, i) => ({ m, i, sx: W / m.w, sz: D / m.d }))
      .filter((x) => x.m.kind === kind && x.sx >= lo && x.sx <= hi && x.sz >= lo && x.sz <= hi);
    if (!options.length) { no('maß'); continue; }
    const weights = options.map((x) => styleWeight(x.m.style, cen) * Math.exp(-2.5 * (Math.abs(Math.log(x.sx)) + Math.abs(Math.log(x.sz)))));
    let r = rand(h & 0xffff, h >>> 16, 3) * weights.reduce((a, b) => a + b, 0);
    let pick = options[0];
    for (let i = 0; i < options.length; i++) { r -= weights[i]; if (r <= 0) { pick = options[i]; break; } }
    const hw = W / 2, hd = D / 2;
    // How far the model reaches out of its rectangle: eaves, towers, steps and porches (houseCatalog.json).
    const side_ = pick.m.reach, ahead = pick.m.front;
    const fe = side.fe, fn = side.fn, re = -fn, rn = fe;
    // The model, its eaves and the steps in front stay off roads, pavements and paths and clear of other houses.
    const at = (u: number, v: number): [number, number] => [rect.e + re * u + fe * v, rect.n + rn * u + fn * v];
    let blocked = false;
    for (let u = -hw - side_; u <= hw + side_ + 0.79 && !blocked; u += 0.8)
      for (let v = -hd - side_; v <= hd + ahead + 0.79 && !blocked; v += 0.8) {
        const [e, n] = at(Math.min(u, hw + side_), Math.min(v, hd + ahead));
        if (o.onRoad(e, n) || o.onPath(e, n) || claimedAt(e, n) || grid.inside(e, n, own)) blocked = true;
      }
    if (blocked) { no('straße'); continue; }
    const ground = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, 0]].map(([u, v]) => o.height(...at(u, v)));
    const plan: HousePlan = {
      key: c.key, model: pick.i, e: rect.e, n: rect.n, fe, fn, re, rn, hw, hd, sx: pick.sx, sz: pick.sz,
      front: side.dist, y: Math.min(...ground) - 0.05, heading: Math.atan2(fe, -fn),
    };
    plans.push(plan);
    replaced.add(c.key);
    for (const r of absorb) { const k = keyOf.get(r); if (k) replaced.add(k); }
    const claim = [at(-hw - side_, -hd - side_), at(hw + side_, -hd - side_), at(hw + side_, hd + ahead), at(-hw - side_, hd + ahead)];
    claimed.push(claim);
    const cx = claim.map((p) => p[0]), cy = claim.map((p) => p[1]);
    for (let x = Math.floor(Math.min(...cx) / 32); x <= Math.floor(Math.max(...cx) / 32); x++)
      for (let y = Math.floor(Math.min(...cy) / 32); y <= Math.floor(Math.max(...cy) / 32); y++) {
        const k = `${x}_${y}`;
        if (!claimGrid.has(k)) claimGrid.set(k, []);
        claimGrid.get(k)!.push(claimed.length - 1);
      }
  }
  return { plans, replaced, rejected };
}

function sameRing(a: [number, number][], b: [number, number][]) {
  return a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
}

/** Tile records ("houses" field) of the plans. */
export function houseRecords(plans: HousePlan[], world: WorldInfo) {
  const T = world.tileSize;
  const out = new Map<string, number[]>();
  const counts: Record<string, number> = {};
  for (const p of plans) {
    const m = HOUSE_MODELS[p.model];
    const k = tileKey(Math.floor(p.e / T), Math.floor(p.n / T));
    if (!out.has(k)) out.set(k, []);
    const [x, z] = utmToLocal(world, p.e, p.n);
    const h = hashKey(p.key);
    out.get(k)!.push(p.model, r2(x), r2(p.y), r2(z), r3(p.heading), r3(p.sx), r3(p.sz), h % TINTS[m.style].length, r3(((h >>> 8) % 1000) / 1000));
    counts[m.id] = (counts[m.id] ?? 0) + 1;
  }
  return { tiles: out, counts };
}

export interface GardenOptions {
  world: WorldInfo;
  height: (e: number, n: number) => number;
  onRoad: (e: number, n: number) => boolean;
  onPath: (e: number, n: number) => boolean;
  /** Inside a building that stays. */
  inBuilding: (e: number, n: number) => boolean;
  /** A fence, wall or hedge (props) already runs here. */
  barrier?: (e: number, n: number) => boolean;
}

/** Front gardens: property line with fence, gate and pillars, path to the door, beds and garden things. */
export function buildGardens(plans: HousePlan[], o: GardenOptions) {
  const T = o.world.tileSize;
  const out = new Map<string, number[]>();
  const counts: Partial<Record<GardenPart, number>> = {};
  /** 1 m cells taken by any garden part, so neighbouring gardens do not stack fences. */
  const taken = new Set<string>();
  const cell = (e: number, n: number) => `${Math.round(e)}_${Math.round(n)}`;
  // Every other house footprint is off limits for a garden.
  const houseGrid = new Map<string, HousePlan[]>();
  for (const p of plans) {
    const k = `${Math.floor(p.e / 40)}_${Math.floor(p.n / 40)}`;
    if (!houseGrid.has(k)) houseGrid.set(k, []);
    houseGrid.get(k)!.push(p);
  }
  const otherHouse = (e: number, n: number, self: HousePlan) => {
    const cx = Math.floor(e / 40), cy = Math.floor(n / 40);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const p of houseGrid.get(`${cx + a}_${cy + b}`) ?? [])
          if (p !== self && Math.abs((e - p.e) * p.re + (n - p.n) * p.rn) < p.hw + 0.4 && Math.abs((e - p.e) * p.fe + (n - p.n) * p.fn) < p.hd + 0.4) return true;
    return false;
  };
  const free = (e: number, n: number, self: HousePlan) => !o.onRoad(e, n) && !o.onPath(e, n) && !o.inBuilding(e, n) && !otherHouse(e, n, self);
  let gardens = 0;

  for (const p of plans) {
    const m: HouseModel = HOUSE_MODELS[p.model];
    const spec = GARDENS[m.garden];
    const depth = Math.min(p.front - 0.6, m.kind === 'haus' ? 7 : 12);
    if (depth < Math.max(1.8, m.front + 0.6)) continue;
    gardens++;
    const at = (u: number, v: number): [number, number] => [p.e + p.re * u + p.fe * v, p.n + p.rn * u + p.fn * v];
    const front = p.hd + depth; // the property line, v from the house centre
    const local: number[] = [];
    const tileOf = (e: number, n: number) => tileKey(Math.floor(e / T), Math.floor(n / T));
    const put = (part: GardenPart, u: number, v: number, along: 'u' | 'v' | 'face', len = 1) => {
      const [e, n] = at(u, v);
      if (!free(e, n, p)) return false;
      if (GARDEN_LINEAR.has(part)) {
        const du = along === 'u' ? len / 2 : 0, dv = along === 'v' ? len / 2 : 0;
        const a = at(u - du, v - dv), b = at(u + du, v + dv);
        if (!free(a[0], a[1], p) || !free(b[0], b[1], p)) return false;
      }
      const heading = along === 'u' ? p.heading + Math.PI / 2 : p.heading;
      const [x, z] = utmToLocal(o.world, e, n);
      const k = tileOf(e, n);
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(gardenIndex(part), r2(x), r2(o.height(e, n)), r2(z), r3(heading), r2(len));
      counts[part] = (counts[part] ?? 0) + 1;
      local.push(u, v);
      return true;
    };
    const door = m.door * p.sx;
    const garage = m.garage === null ? undefined : m.garage * p.sx;
    const span = p.hw + 0.8;
    // Openings in the property line: the gate in front of the door, the drive in front of the garage.
    const gateW = m.kind === 'haus' ? 1.2 : 2.4;
    const gaps: [number, number][] = [[door - gateW / 2, door + gateW / 2]];
    if (garage !== undefined) gaps.push([garage - 1.6, garage + 1.6]);
    // Fence pieces of at most 2 m along the property line, following the ground.
    const fenceOk = (u: number) => {
      const [e, n] = at(u, front);
      if (taken.has(cell(e, n)) || o.barrier?.(e, n)) return false;
      return true;
    };
    for (let u = -span; u < span - 0.05;) {
      const gap = gaps.find(([a, b]) => u >= a - 0.01 && u < b);
      if (gap) { u = gap[1]; continue; }
      const next = Math.min(span, u + 2, ...gaps.map(([a]) => a).filter((a) => a > u + 0.05));
      const len = next - u;
      if (len > 0.3 && fenceOk(u + len / 2)) put(spec.fence, u + len / 2, front, 'u', len);
      u = next;
    }
    if (spec.gate && m.kind !== 'gross') put(spec.gate, door, front, 'u', gateW);
    if (spec.pillar) for (const s of [-1, 1]) put(spec.pillar, door + s * (gateW / 2 + 0.25), front, 'face');
    // Side fences back to the house front, where nothing else stands.
    for (const s of [-1, 1]) {
      for (let v = p.hd + 0.3; v < front - 0.3;) {
        const len = Math.min(2, front - 0.3 - v);
        const [e, n] = at(s * span, v + len / 2);
        if (len > 0.3 && !taken.has(cell(e, n)) && !o.barrier?.(e, n)) put(spec.fence, s * span, v + len / 2, 'v', len);
        v += len;
      }
    }
    // Path from the steps to the gate, the drive to the garage.
    const v0 = p.hd + m.front;
    if (front - v0 > 0.4) {
      put(spec.path, door, (v0 + front) / 2, 'v', front - v0);
      if (garage !== undefined) put('auffahrt', garage, (p.hd + front) / 2, 'v', front - p.hd);
    }
    // Beds parallel to the house front on either side of the path, garden things on the free ground.
    const rnd = (s: number) => rand(Math.round(p.e * 10), Math.round(p.n * 10), s);
    // Free ground starts in front of porches and verandas.
    const vmin = p.hd + Math.max(0.8, m.front - 0.5);
    if (front - vmin >= 2.2) {
      const vb = vmin + 0.4 + rnd(1) * Math.max(0, front - vmin - 1.8);
      const left = [-span + 0.8, door - gateW / 2 - 0.6], right = [door + gateW / 2 + 0.6, (garage !== undefined ? garage - 2 : span - 0.8)];
      spec.beds.forEach((bed, i) => {
        const [a, b] = i % 2 === 0 ? left : right;
        const len = Math.min(3, b - a);
        if (len > 1) put(bed, (a + b) / 2, vb, 'u', len);
      });
    }
    let placed = 0;
    for (let tries = 0; tries < 30 && placed < Math.min(spec.points.length, 2 + Math.floor(depth / 2)); tries++) {
      const part = spec.points[placed];
      let u: number, v: number;
      if (part === 'briefkasten') { u = door + gateW / 2 + 0.5; v = front - 0.5; }
      else if (part === 'tonnen') { u = (rnd(5) < 0.5 ? -1 : 1) * (p.hw - 1.0); v = vmin; }
      else if (part === 'brunnen') { if (depth < 7) { placed++; continue; } u = door + (door > 0 ? -4 : 4); v = p.hd + depth / 2; }
      else if (part === 'fahnenmast') { u = door + (placed - 1) * 2.5 + (door > 0 ? -5 : 5); v = front - 1.5; }
      else { u = -span + 0.8 + rnd(10 + tries) * (2 * span - 1.6); v = vmin + rnd(20 + tries) * Math.max(0, front - vmin - 0.6); }
      // Keep the path, the drive and the other things clear.
      const clear = Math.abs(u - door) > 1.2 && (garage === undefined || Math.abs(u - garage) > 2) || part === 'briefkasten';
      let near = false;
      for (let i = 0; i < local.length; i += 2) if (Math.hypot(local[i] - u, local[i + 1] - v) < (part === 'brunnen' ? 2.2 : 0.9)) near = true;
      if ((!clear || near) && part !== 'briefkasten') continue;
      if (put(part, u, v, 'face')) placed++;
      else if (part === 'briefkasten' || part === 'tonnen' || part === 'brunnen' || part === 'fahnenmast') placed++;
    }
    for (let i = 0; i < local.length; i += 2) { const [e, n] = at(local[i], local[i + 1]); taken.add(cell(e, n)); }
  }
  return { tiles: out, counts, gardens };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Lookup of the placed houses' rectangles, e.g. to clear trees out of them. */
export class HouseIndex {
  private grid = new Map<string, HousePlan[]>();
  constructor(plans: HousePlan[]) {
    for (const p of plans) {
      const k = `${Math.floor(p.e / 40)}_${Math.floor(p.n / 40)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k)!.push(p);
    }
  }
  covers(e: number, n: number, margin = 0) {
    const cx = Math.floor(e / 40), cy = Math.floor(n / 40);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const p of this.grid.get(`${cx + a}_${cy + b}`) ?? [])
          if (Math.abs((e - p.e) * p.re + (n - p.n) * p.rn) < p.hw + margin && Math.abs((e - p.e) * p.fe + (n - p.n) * p.fn) < p.hd + margin) return true;
    return false;
  }
}
