// Roadside furniture outside built-up areas: guard rails (Schutzplanken) along motorways and trunk roads, on
// high embankments, on bridges and their approaches and where OSM maps them; delineators (Leitpfosten) every 50 m,
// closer in bends; chevron boards (Richtungstafeln, Z 625) on the outside of sharp bends. Town streets have kerbs
// instead (kerbs.ts). Rails go into the tile field "rails" (guardRails.ts), posts and boards into the props.
//
// Rules (RPS 2009, RMS/HLB): rails 0.5 m beyond the paved edge; delineators 0.5–1 m beyond it, both sides, at the
// same stations, 50 m apart on straights and down to 10 m in tight bends; Z 625 where the radius is under 120 m.

import { GUARD_RAIL } from '../../src/world/guardRail.ts';
import { type WorldInfo, tileKey, utmToLocal } from '../../src/world/format.ts';
import { Prop, type PropKind } from '../../src/world/propKinds.ts';
import { roadSection } from '../../src/world/roadSpec.ts';
import { GuardRails, type ProfileSample, railAlongRoad } from './guardRails.ts';
import { isExpressway } from './kerbs.ts';
import type { Way } from './osm.ts';
import { ROAD_CLASSES, ROAD_LIFT, isBridge, isDrivable, roadProfile } from './roads.ts';

export const ROADSIDE = {
  /** Delineator spacing on straights (m). */
  posts: 50,
  /** Tightest delineator spacing in bends (m). */
  postsMin: 10,
  /** Delineator distance from the paved edge (m). */
  postOffset: 0.75,
  /** Chevron boards below this bend radius (m). */
  chevronRadius: 120,
  /** Embankment: rail where the ground drops this much within 3 m of the edge, or `drop` within 7 m. */
  steep: 1.8,
  drop: 3,
  /** Rails continue this far onto the road beyond a bridge (m). */
  approach: 20,
};

/**
 * The lane mask (2 m cells) of a road reaches up to about 1.5 m past its own edge, so "another road's lanes here"
 * is probed this far beyond the rail or post.
 */
const PROBE = 1.5;

export interface RoadsideOptions {
  world: WorldInfo;
  height: (e: number, n: number) => number;
  /** True where a point lies on any road's driving lanes. */
  onLanes: (e: number, n: number) => boolean;
  /** Bridges that bring their own railings (landmark models): no guard rails on them. */
  dressed?: Set<number>;
}

export interface RoadsideCounts { posts: number; chevrons: number; railKm: number; mapped: number; bridges: number; embankments: number; motorway: number }

/** Junction nodes (three or more road ends meet), from the drivable ways. */
function junctionNodes(roads: Way[]) {
  const degree = new Map<number, number>();
  for (const w of roads)
    w.ids.forEach((id, i) => {
      const end = !w.closed && (i === 0 || i === w.ids.length - 1);
      if (w.closed && i === w.ids.length - 1) return;
      degree.set(id, (degree.get(id) ?? 0) + (end ? 1 : 2));
    });
  return degree;
}

export function buildRoadside(ways: Way[], o: RoadsideOptions) {
  const T = o.world.tileSize;
  const props = new Map<string, number[]>();
  const rails = new GuardRails(o.world);
  const counts: RoadsideCounts = { posts: 0, chevrons: 0, railKm: 0, mapped: 0, bridges: 0, embankments: 0, motorway: 0 };
  const roads = ways.filter((w) => isDrivable(w.tags));
  const profiles = new Map(roads.map((w) => [w, roadProfile(w, o.height, o.world) as ProfileSample[]]));
  // Road samples with their height: bridge rails must not stand on a road alongside at deck level (the 2D lane
  // mask cannot tell that road from the one passing underneath).
  const sgrid = new Map<string, { e: number; n: number; y: number; hw: number; w: Way }[]>();
  for (const [w, ring] of profiles) {
    const hw = (roadSection(w.tags)?.width ?? 6) / 2;
    for (const p of ring) {
      const k = `${Math.floor(p.e / 16)}_${Math.floor(p.n / 16)}`;
      if (!sgrid.has(k)) sgrid.set(k, []);
      sgrid.get(k)!.push({ e: p.e, n: p.n, y: p.y, hw, w });
    }
  }
  /**
   * Another road's carriageway near (e, n) at about this height. Samples on this road's own centreline (the road
   * continuing beyond the bridge end) do not count.
   */
  const roadAtLevel = (self: Way, e: number, n: number, y: number) => {
    const near = (ce: number, cn: number) => {
      const out = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) out.push(...(sgrid.get(`${ce + a}_${cn + b}`) ?? []));
      return out;
    };
    const list = near(Math.floor(e / 16), Math.floor(n / 16));
    const P = self.pts, m = P.length - 1;
    const ends = [self.ids[0], self.ids[m]];
    // Continues end to end from this road and straight on (not a cross street through an end node, nor a road
    // bending in): the sample lies on the extension of this road's centreline.
    const selfHw = (roadSection(self.tags)?.width ?? 6) / 2;
    const straightOn = (q: { e: number; n: number; w: Way; hw: number }) => {
      // A wider road beyond the bridge end would run into the rail.
      if (q.hw > selfHw + 0.25) return false;
      if (!ends.includes(q.w.ids[0]) && !ends.includes(q.w.ids[q.w.ids.length - 1])) return false;
      for (const [a, b] of [[P[0], P[1]], [P[m], P[m - 1]]]) {
        const de = a[0] - b[0], dn = a[1] - b[1], l = Math.hypot(de, dn) || 1;
        const qe = q.e - a[0], qn = q.n - a[1];
        if (qe * de + qn * dn >= -1 && Math.abs(qe * dn - qn * de) / l < 1) return true;
      }
      return false;
    };
    for (const q of list)
      if (q.w !== self && Math.abs(q.y - y) < 2.5 && Math.hypot(q.e - e, q.n - n) < q.hw + 2.5 && !straightOn(q)) return true;
    return false;
  };
  const degree = junctionNodes(roads);
  // Junction positions with the widest road there, to keep rails and posts out of the mouths of side roads.
  const widest = new Map<number, number>();
  for (const w of roads) {
    const width = roadSection(w.tags)?.width ?? 6;
    for (const id of w.ids) widest.set(id, Math.max(widest.get(id) ?? 0, width));
  }
  const jgrid = new Map<string, [number, number, number][]>();
  for (const w of roads)
    w.ids.forEach((id, i) => {
      if ((degree.get(id) ?? 0) < 3) return;
      const [e, n] = w.pts[i];
      const k = `${Math.floor(e / 30)}_${Math.floor(n / 30)}`;
      if (!jgrid.has(k)) jgrid.set(k, []);
      jgrid.get(k)!.push([e, n, widest.get(id)!]);
    });
  const nearJunction = (e: number, n: number, extra: number) => {
    const ce = Math.floor(e / 30), cn = Math.floor(n / 30);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const [je, jn, w] of jgrid.get(`${ce + a}_${cn + b}`) ?? []) if (Math.hypot(je - e, jn - n) < w / 2 + extra) return true;
    return false;
  };
  const add = (kind: PropKind, e: number, n: number, y: number, heading: number, size = 0) => {
    const k = tileKey(Math.floor(e / T), Math.floor(n / T));
    if (!props.has(k)) props.set(k, []);
    const [x, z] = utmToLocal(o.world, e, n);
    props.get(k)!.push(kind, r2(x), r2(y), r2(z), Math.round(heading * 1000) / 1000, size);
  };
  /** Local heading facing along a UTM direction. */
  const headingOf = (de: number, dn: number) => Math.atan2(de, -dn);

  // Bridge ends that carry rails: the roads beyond continue them for a while.
  const bridgeEnds = new Set<number>();
  for (const w of roads) if (isBridge(w.tags) && !o.dressed?.has(w.id) && railed(w)) { bridgeEnds.add(w.ids[0]); bridgeEnds.add(w.ids[w.ids.length - 1]); }

  for (const way of roads) {
    const hw = way.tags.highway;
    const cls = ROAD_CLASSES[hw];
    if (!cls || cls.rank < 3 || hw === 'living_street') continue;
    const urban = way.urban ?? cls.street;
    const section = roadSection(way.tags)!;
    const half = section.width / 2;
    const ring = profiles.get(way)!;
    if (ring.length < 2) continue;
    const bridge = isBridge(way.tags);
    const link = /_link$/.test(hw);
    // Schnellstraßen: rails along both sides wherever nothing joins.
    const motorway = isExpressway(way.tags) && !link;
    const len = ring[ring.length - 1].dist;
    const atStart = bridgeEnds.has(way.ids[0]) && !bridge;
    const atEnd = bridgeEnds.has(way.ids[way.ids.length - 1]) && !bridge;

    // --- Guard rails ---
    const railOffset = half + (bridge ? 0.3 : GUARD_RAIL.clearance);
    const railSides = new Map<number, boolean[]>();
    let embankment = false;
    for (const side of [1, -1] as const) {
      const want = new Array<boolean>(ring.length).fill(false);
      if (bridge) { if (!o.dressed?.has(way.id) && railed(way)) want.fill(true); }
      else if (motorway) want.fill(true);
      else if (!urban && !link) {
        // Embankments: the ground falls away steeply beside the road.
        const hazard = ring.map((p) => {
          const g = (d: number) => o.height(p.e + p.dy * d * side, p.n - p.dx * d * side);
          const road = p.y - ROAD_LIFT;
          return road - g(half + 3) >= ROADSIDE.steep || road - g(half + 7) >= ROADSIDE.drop;
        });
        // A real hazard is at least 12 m long; then cover it with 12 m to spare each way and close short gaps.
        const raw = hazard.map((h, i) => h && (hazard[i - 1] || hazard[i + 1]) && (hazard[i - 2] || hazard[i + 1] && hazard[i + 2] || hazard[i - 1] && hazard[i + 1]));
        for (let i = 0; i < ring.length; i++) if (raw[i]) for (let k = Math.max(0, i - 3); k <= Math.min(ring.length - 1, i + 3); k++) want[k] = true;
        closeGaps(want, 6);
        if (want.some(Boolean)) embankment = true;
      }
      if (!urban || motorway) {
        if (atStart) ring.forEach((p, i) => { if (p.dist <= ROADSIDE.approach) want[i] = true; });
        if (atEnd) ring.forEach((p, i) => { if (len - p.dist <= ROADSIDE.approach) want[i] = true; });
      }
      // Never across a junction mouth or another road's lanes (bridges only stop at junctions: the road below
      // is in the lane mask too).
      const ok = ring.map((p) => {
        const e = p.e + p.dy * railOffset * side, n = p.n - p.dx * railOffset * side;
        const pe = p.e + p.dy * (railOffset + PROBE) * side, pn = p.n - p.dx * (railOffset + PROBE) * side;
        return !nearJunction(e, n, 8) && (bridge ? !roadAtLevel(way, e, n, p.y) : !o.onLanes(pe, pn));
      });
      // On bridges keep one more sample (4 m) clear of a road joining at deck level: cars cut that corner.
      const final = want.map((w, i) => w && ok[i] && (!bridge || ((ok[i - 1] ?? true) && (ok[i + 1] ?? true))));
      railSides.set(side, final);
      const byIndex = new Map(ring.map((p, i) => [p, i]));
      for (const run of railAlongRoad(ring, side, () => railOffset, (p) => final[byIndex.get(p)!])) {
        // Runs that meet a bridge rail (or are one) join without a terminal there.
        const first = side > 0 ? run[0] : run[run.length - 1];
        const last = side > 0 ? run[run.length - 1] : run[0];
        const s0 = ring.find((p) => Math.abs(p.e + p.dy * railOffset * side - first.e) < 0.01 && Math.abs(p.n - p.dx * railOffset * side - first.n) < 0.01);
        const s1 = ring.find((p) => Math.abs(p.e + p.dy * railOffset * side - last.e) < 0.01 && Math.abs(p.n - p.dx * railOffset * side - last.n) < 0.01);
        const joinsStart = (bridge || atStart) && s0 === ring[0];
        const joinsEnd = (bridge || atEnd) && s1 === ring[ring.length - 1];
        // Point order: road on the left, so for side -1 the run is reversed.
        const terminals: [boolean, boolean] = side > 0 ? [!joinsStart, !joinsEnd] : [!joinsEnd, !joinsStart];
        if (!rails.add(run, { terminals })) continue;
        if (bridge) counts.bridges++;
        else if (motorway) counts.motorway++;
      }
    }

    if (embankment) counts.embankments++;

    // --- Delineators and chevron boards: rural roads, motorways and ramps, not on bridges ---
    if (urban || bridge) continue;
    if (section.width < 4.5) continue;
    const radius = ring.map((_, i) => bendRadius(ring, i));
    const postOffset = half + ROADSIDE.postOffset;
    let next = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (p.dist < next) continue;
      const spacing = Math.max(ROADSIDE.postsMin, Math.min(ROADSIDE.posts, radius[i] / 8));
      next = p.dist + spacing;
      for (const side of [1, -1] as const) {
        // Where there is a rail, its posts carry the reflectors.
        if (railSides.get(side)![i]) continue;
        // One-way carriageways (motorways): the left side is the median, which has its rail.
        if (section.oneway && motorway && side < 0) continue;
        const e = p.e + p.dy * postOffset * side, n = p.n - p.dx * postOffset * side;
        if (nearJunction(e, n, 6) || o.onLanes(p.e + p.dy * (postOffset + PROBE) * side, p.n - p.dx * (postOffset + PROBE) * side)) continue;
        // Faces the traffic on its own side: right posts look back along the road, left ones forward.
        add(Prop.delineator, e, n, p.y - 0.05, side > 0 ? headingOf(-p.dx, -p.dy) : headingOf(p.dx, p.dy));
        counts.posts++;
      }
    }
    if (motorway || link || parseInt(way.tags.maxspeed) <= 30) continue;
    // Chevron boards on the outside of sharp bends, a few per bend and direction, facing the approaching traffic.
    let bendFrom = -1;
    for (let i = 0; i <= ring.length; i++) {
      const sharp = i < ring.length && radius[i] < ROADSIDE.chevronRadius;
      if (sharp && bendFrom < 0) bendFrom = i;
      if (sharp || bendFrom < 0) continue;
      const from = bendFrom, to = i - 1;
      bendFrom = -1;
      if (ring[to].dist - ring[from].dist < 12) continue;
      // Turning direction along the way: + left (anticlockwise in UTM).
      const a = ring[from], b = ring[to];
      const turn = Math.sign(a.dx * b.dy - a.dy * b.dx);
      if (!turn) continue;
      // Outside of the bend: right of the way for a left bend.
      const outside = turn > 0 ? 1 : -1;
      const n = Math.min(4, Math.max(2, Math.round((b.dist - a.dist) / 20) + 1));
      for (let k = 0; k < n; k++) {
        const p = ring[Math.round(from + ((to - from) * (k + 0.5)) / n)];
        const off = half + 1.6;
        const e = p.e + p.dy * off * outside, nn = p.n - p.dx * off * outside;
        if (nearJunction(e, nn, 6) || o.onLanes(p.e + p.dy * (off + 1) * outside, p.n - p.dx * (off + 1) * outside)) continue;
        // Traffic along the way sees arrows into the bend; on two-way roads the other side of the board too.
        add(turn > 0 ? Prop.chevronLeft : Prop.chevronRight, e, nn, p.y - 0.05, headingOf(-p.dx, -p.dy));
        counts.chevrons++;
        if (!section.oneway) {
          // Back to back, 4 cm behind.
          const be = e + p.dy * 0.04 * outside, bn = nn - p.dx * 0.04 * outside;
          add(turn > 0 ? Prop.chevronRight : Prop.chevronLeft, be, bn, p.y - 0.05, headingOf(p.dx, p.dy));
          counts.chevrons++;
        }
      }
    }
  }

  // Rails mapped in OSM (barrier=guard_rail), wherever they are: on the ground beside the nearest road.
  for (const w of ways) {
    if (w.tags.barrier !== 'guard_rail' || w.pts.length < 2) continue;
    const pts = w.pts.map(([e, n]) => ({ e, n, y: o.height(e, n) }));
    // Cut where a road's lanes cross the mapped line.
    let cur: typeof pts = [];
    const flush = () => { if (cur.length >= 2) { rails.add(orientToRoad(cur, o.onLanes)); counts.mapped++; } cur = []; };
    for (const p of densePts(pts)) {
      if (o.onLanes(p.e, p.n)) flush();
      else cur.push(p);
    }
    flush();
  }
  counts.railKm = Math.round(rails.length / 100) / 10;
  return { props, rails, counts };
}

/**
 * Bridges that get guard rails: fast roads (motorways to secondary roads, as roads.ts FAST), where the raised
 * walkway with the pedestrian railing starts behind the rail. Other bridges have only the railing.
 */
function railed(w: Way) {
  return /^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$/.test(w.tags.highway);
}

/** Closes runs of false shorter than `max` between two true entries. */
function closeGaps(a: boolean[], max: number) {
  let last = -1;
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    if (last >= 0 && i - last > 1 && i - last - 1 <= max) for (let k = last + 1; k < i; k++) a[k] = true;
    last = i;
  }
}

/** Bend radius at sample i from the heading change over about ±12 m (Infinity on straights). */
export function bendRadius(ring: { dx: number; dy: number; dist: number }[], i: number) {
  const a = ring[Math.max(0, i - 3)], b = ring[Math.min(ring.length - 1, i + 3)];
  const ang = Math.acos(Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy)));
  const arc = b.dist - a.dist;
  return ang > 1e-3 && arc > 0 ? arc / ang : Infinity;
}

/** Points about every 4 m along a polyline. */
function densePts(pts: { e: number; n: number; y: number }[]) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const k = Math.max(1, Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / 4));
    for (let j = 1; j <= k; j++) out.push({ e: a.e + ((b.e - a.e) * j) / k, n: a.n + ((b.n - a.n) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  return out;
}

/** Orders a mapped rail so the nearer road is on its left (the beam faces the traffic). */
function orientToRoad(pts: { e: number; n: number; y: number }[], onLanes: (e: number, n: number) => boolean) {
  const m = pts[Math.floor(pts.length / 2)], q = pts[Math.min(pts.length - 1, Math.floor(pts.length / 2) + 1)], p = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
  const de = q.e - p.e, dn = q.n - p.n, l = Math.hypot(de, dn) || 1;
  // Left of the direction: (-dn, de). Probe for lanes up to 6 m out on either side.
  for (let d = 1; d <= 6; d++) {
    if (onLanes(m.e - (dn / l) * d, m.n + (de / l) * d)) return pts;
    if (onLanes(m.e + (dn / l) * d, m.n - (de / l) * d)) return [...pts].reverse();
  }
  return pts;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
