// Street furniture and parked cars from OSM: signs, bus stops, bollards, benches, bins, post boxes, hydrants,
// advertising columns, fences, walls, hedges, the Saarlouis city limit signs, and
// parked cars on car parks and along residential streets. Everything stays off the driving lanes.
// Output: per tile Float32 records (see src/world/propKinds.ts).

import { type WorldInfo, tileKey, utmToLocal } from '../../src/world/format.ts';
import { DETECTED, PROP_STRIDE, Prop, type PropKind, SIGN_TYPES, type SignType } from '../../src/world/propKinds.ts';
import type { Junction } from './graph.ts';
import { rand } from './ground.ts';
import { type OsmData, type Polygon, pointInPolygon, pointInRing } from './osm.ts';
import { KERB, bollardedEntry } from '../../src/world/roadSpec.ts';
import { ROAD_LIFT, densify, isBridge, isDrivable, isMotorRoad, roadSurfaceHeights, roadWidth, type Railing } from './roads.ts';

interface Seg {
  ae: number; an: number; be: number; bn: number;
  ya: number; yb: number;
  width: number;
  highway: string;
}

const CELL = 25;

/** Nearest drivable road to a point: distance, direction and side. */
class RoadIndex {
  private grid = new Map<string, Seg[]>();
  constructor(ways: OsmData['ways'], height: (e: number, n: number) => number) {
    for (const w of ways) {
      if (!isDrivable(w.tags)) continue;
      const width = roadWidth(w.tags)!;
      const ys = roadSurfaceHeights(w, height);
      for (let i = 1; i < w.pts.length; i++) {
        const s: Seg = { ae: w.pts[i - 1][0], an: w.pts[i - 1][1], be: w.pts[i][0], bn: w.pts[i][1], ya: ys[i - 1], yb: ys[i], width, highway: w.tags.highway };
        const e0 = Math.floor(Math.min(s.ae, s.be) / CELL), e1 = Math.floor(Math.max(s.ae, s.be) / CELL);
        const n0 = Math.floor(Math.min(s.an, s.bn) / CELL), n1 = Math.floor(Math.max(s.an, s.bn) / CELL);
        for (let ce = e0; ce <= e1; ce++)
          for (let cn = n0; cn <= n1; cn++) {
            const k = `${ce}_${cn}`;
            if (!this.grid.has(k)) this.grid.set(k, []);
            this.grid.get(k)!.push(s);
          }
      }
    }
  }

  nearest(e: number, n: number, max = 30) {
    let best: { d: number; pe: number; pn: number; de: number; dn: number; side: number; seg: Seg; y: number } | undefined;
    const r = Math.ceil(max / CELL);
    const ce = Math.floor(e / CELL), cn = Math.floor(n / CELL);
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++)
        for (const s of this.grid.get(`${ce + i}_${cn + j}`) ?? []) {
          const dx = s.be - s.ae, dy = s.bn - s.an;
          const l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((e - s.ae) * dx + (n - s.an) * dy) / l2));
          const pe = s.ae + dx * t, pn = s.an + dy * t;
          const d = Math.hypot(e - pe, n - pn);
          if (d < max && (!best || d < best.d)) {
            const l = Math.sqrt(l2);
            // side > 0: the point is right of the segment direction (UTM: east right, north up).
            const side = Math.sign((e - s.ae) * dy - (n - s.an) * dx) || 1;
            best = { d, pe, pn, de: dx / l, dn: dy / l, side, seg: s, y: s.ya + (s.yb - s.ya) * t };
          }
        }
    return best;
  }
}

export interface PropOptions {
  world: WorldInfo;
  height: (e: number, n: number) => number;
  /** True where a point lies on any road's driving lanes. */
  onLanes: (e: number, n: number) => boolean;
  /** True on the lanes of a road open to cars (default onLanes); bollards there would close it. */
  onMotorLanes?: (e: number, n: number) => boolean;
  /** True within a car's clearance of the lanes; fences, walls and hedges stay out of it (default onLanes). */
  nearLanes?: (e: number, n: number) => boolean;
  junctions: Junction[];
  boundary?: [number, number][][];
  /** False when the place-name signs come from guideSigns.ts: no props for city limits then (default true). */
  cityLimits?: boolean;
  /** Pedestrian railings along bridge caps, from buildRoads. */
  railings?: Railing[];
  /** Hedge centre lines measured from the laser heights (lib/hedges.ts); dropped where OSM maps a hedge nearby. */
  hedges?: [number, number][][];
  /** Wall centre lines from ALKIS; dropped where OSM maps any barrier nearby. */
  walls?: [number, number][][];
  /** Extra point features from street-level imagery (Mapillary); dropped where OSM already has one nearby. */
  detected?: { kind: PropKind; e: number; n: number; size?: number }[];
}

/** Detected and mapped features of one kind closer than this (m) are the same object. */
const DEDUPE = 8;

export function buildProps(osm: OsmData, o: PropOptions) {
  const T = o.world.tileSize;
  const out = new Map<string, number[]>();
  const counts: Partial<Record<PropKind, number>> = {};
  const roads = new RoadIndex(osm.ways, o.height);
  const junctionNear = junctionLookup(o.junctions, o.world);
  /** Local heading facing along a UTM direction. */
  const headingOf = (de: number, dn: number) => Math.atan2(de, -dn);
  const add = (kind: PropKind, e: number, n: number, heading: number, size = 0, y?: number) => {
    const k = tileKey(Math.floor(e / T), Math.floor(n / T));
    if (!out.has(k)) out.set(k, []);
    const [x, z] = utmToLocal(o.world, e, n);
    const near = roads.nearest(e, n, 12);
    const h = y ?? (near && near.d < near.seg.width / 2 + 3 ? Math.max(o.height(e, n), near.y - ROAD_LIFT) + ROAD_LIFT + KERB.height : o.height(e, n));
    out.get(k)!.push(kind, r2(x), r2(h), r2(z), r3(heading), r2(size));
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  // Point features. Anything mapped on the carriageway moves to the kerb.
  const placed = new Map<string, [PropKind, number, number][]>();
  const cellOf = (e: number, n: number) => `${Math.floor(e / DEDUPE)}_${Math.floor(n / DEDUPE)}`;
  const placePoint = (kind: PropKind, e: number, n: number, size: number) => {
    const road = roads.nearest(e, n, 25);
    let heading = rand(e, n, 5) * Math.PI * 2;
    if (road) {
      const onRoad = o.onLanes(e, n);
      if (kind === Prop.bollard || kind === Prop.block) {
        // Bollards and blocks on a road open to cars would close it: drop them. In pedestrian zones and on
        // roads closed to cars they stay where they are mapped, on the carriageway.
        if (onRoad && (o.onMotorLanes ?? o.onLanes)(e, n)) return;
        if (onRoad) {
          add(kind, e, n, headingOf(road.de, road.dn), size, road.y);
          remember(kind, e, n);
          return;
        }
      }
      const side = onRoad ? (kind === Prop.stopSign || kind === Prop.giveWay || kind === Prop.busStop || rand(e, n, 2) < 0.5 ? 1 : -1) : road.side;
      if (onRoad) {
        // Right of the way's direction: normal (dn, -de).
        const off = road.seg.width / 2 + (kind === Prop.busStop ? 1.4 : 0.7);
        e = road.pe + road.dn * off * side;
        n = road.pn - road.de * off * side;
        if (o.onLanes(e, n)) return;
      }
      // Face the road; signs face the traffic coming towards them on their side.
      if (kind === Prop.sign || kind === Prop.stopSign || kind === Prop.giveWay) heading = side > 0 ? headingOf(-road.de, -road.dn) : headingOf(road.de, road.dn);
      else heading = headingOf(-road.dn * side, road.de * side);
    }
    add(kind, e, n, heading, size);
    remember(kind, e, n);
  };
  function remember(kind: PropKind, e: number, n: number) {
    const c = cellOf(e, n);
    if (!placed.has(c)) placed.set(c, []);
    placed.get(c)!.push([kind, e, n]);
  }
  const placedNear = (e: number, n: number, r: number, kinds: PropKind[]) => {
    const k = Math.ceil(r / DEDUPE), ce = Math.floor(e / DEDUPE), cn = Math.floor(n / DEDUPE);
    for (let a = -k; a <= k; a++)
      for (let b = -k; b <= k; b++)
        for (const [kind, pe, pn] of placed.get(`${ce + a}_${cn + b}`) ?? []) if (kinds.includes(kind) && Math.hypot(pe - e, pn - n) < r) return true;
    return false;
  };
  for (const p of osm.points) {
    const t = p.tags;
    let kind: PropKind | undefined;
    let size = 0;
    if (t.highway === 'bus_stop') { kind = Prop.busStop; size = t.shelter === 'yes' ? 1 : 0; }
    else if (t.highway === 'stop') kind = Prop.stopSign;
    else if (t.highway === 'give_way') kind = Prop.giveWay;
    else if (t.traffic_sign) {
      kind = Prop.sign;
      size = signSize(osmSignType(t.traffic_sign));
      if (o.cityLimits === false && size === signSize('ortsschild')) continue;
    }
    else if (t.barrier === 'bollard') kind = Prop.bollard;
    else if (t.barrier === 'block') kind = Prop.block;
    else if (t.amenity === 'bench') kind = Prop.bench;
    else if (t.amenity === 'waste_basket') kind = Prop.bin;
    else if (t.amenity === 'post_box') kind = Prop.postBox;
    else if (t.amenity === 'recycling') kind = Prop.recycling;
    else if (t.emergency === 'fire_hydrant') kind = Prop.hydrant;
    else if (t.amenity === 'bicycle_parking') kind = Prop.bikeStand;
    else if (t.advertising === 'column') kind = Prop.column;
    if (kind) placePoint(kind, p.e, p.n, size);
  }
  // A row of bollards where a pedestrian zone or a road closed to motor vehicles leaves a road open to cars,
  // unless OSM maps a barrier there already. They are breakable (src/world/props.ts), so the player can still get in.
  const motorWidth = new Map<number, number>();
  for (const w of osm.ways) if (isMotorRoad(w.tags)) for (const id of w.ids) motorWidth.set(id, Math.max(motorWidth.get(id) ?? 0, roadWidth(w.tags)!));
  let entries = 0;
  for (const w of osm.ways) {
    if (!isDrivable(w.tags) || isMotorRoad(w.tags) || !bollardedEntry(w.tags) || isBridge(w.tags)) continue;
    const width = roadWidth(w.tags)!;
    w.ids.forEach((id, i) => {
      const mw = motorWidth.get(id);
      if (mw === undefined || (i > 0 && i < w.ids.length - 1)) return;
      // Into the closed way from the junction: past the road's edge and a little more.
      const pts = i === 0 ? w.pts : [...w.pts].reverse();
      const at = alongPolyline(pts, mw / 2 + 2);
      if (!at) return;
      const [e, n, de, dn] = at;
      if (placedNear(e, n, 12, [Prop.bollard, Prop.block]) || (o.onMotorLanes ?? o.onLanes)(e, n)) return;
      const road = roads.nearest(e, n, 5);
      const y = road?.y ?? o.height(e, n) + ROAD_LIFT;
      // 1.5 m apart: too narrow for a car, wide enough for bikes and prams.
      const count = Math.max(2, Math.round((width - 0.8) / 1.5) + 1);
      for (let k = 0; k < count; k++) {
        const off = (k / (count - 1) - 0.5) * (width - 0.8);
        const be = e + dn * off, bn = n - de * off;
        if ((o.onMotorLanes ?? o.onLanes)(be, bn)) continue;
        add(Prop.bollard, be, bn, headingOf(de, dn), 0, y);
        remember(Prop.bollard, be, bn);
      }
      entries++;
    });
  }

  // Detected features count only where OSM has none of the same kind (signs: any sign) nearby.
  const SIGNS: PropKind[] = [Prop.sign, Prop.stopSign, Prop.giveWay];
  const same = (a: PropKind, b: PropKind) => a === b || (SIGNS.includes(a) && SIGNS.includes(b));
  let detected = 0;
  for (const d of o.detected ?? []) {
    if (o.cityLimits === false && d.kind === Prop.sign && d.size === signSize('ortsschild')) continue;
    let dup = false;
    const ce = Math.floor(d.e / DEDUPE), cn = Math.floor(d.n / DEDUPE);
    for (let a = -1; a <= 1 && !dup; a++)
      for (let b = -1; b <= 1 && !dup; b++)
        for (const [k, e, n] of placed.get(`${ce + a}_${cn + b}`) ?? []) if (same(k, d.kind) && Math.hypot(e - d.e, n - d.n) < DEDUPE) { dup = true; break; }
    if (dup) continue;
    // Negative size marks the record as detected and keeps the sign type (see DETECTED in propKinds.ts).
    placePoint(d.kind, d.e, d.n, DETECTED - (d.size ?? 0));
    detected++;
  }

  // Fences, walls and hedges, in pieces of up to 4 m (mapped guard rails: roadside.ts).
  // Keep a car's clearance from the lanes: the whole piece stays off them, not only its centre (a barrier way
  // crossing a street).
  const clear = o.nearLanes ?? o.onLanes;
  const offLanes = (e: number, n: number, de: number, dn: number, len: number) => [-0.5, -0.25, 0, 0.25, 0.5].every((f) => !clear(e + de * len * f, n + dn * len * f));
  const mappedHedges = new Set<string>(), mappedBarriers = new Set<string>();
  const HEDGE_CELL = 3;
  for (const w of osm.ways) {
    const b = w.tags.barrier;
    const kind = b === 'fence' ? Prop.fence : b === 'wall' ? Prop.wall : b === 'hedge' ? Prop.hedge : undefined;
    if (!kind) continue;
    pieces(w.pts, 4, (e, n, de, dn, len) => {
      const cell = `${Math.floor(e / HEDGE_CELL)}_${Math.floor(n / HEDGE_CELL)}`;
      if (kind !== Prop.fence) mappedHedges.add(cell);
      mappedBarriers.add(cell);
      if (offLanes(e, n, de, dn, len)) add(kind, e, n, headingOf(de, dn), len);
    });
  }
  // Measured hedges have a negative length (see isMeasured in propKinds.ts); none beside a mapped hedge or wall.
  let measuredHedges = 0;
  const mappedNear = (set: Set<string>, e: number, n: number) => {
    const ce = Math.floor(e / HEDGE_CELL), cn = Math.floor(n / HEDGE_CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (set.has(`${ce + a}_${cn + b}`)) return true;
    return false;
  };
  for (const h of o.hedges ?? [])
    pieces(h, 4, (e, n, de, dn, len) => {
      if (mappedNear(mappedHedges, e, n) || !offLanes(e, n, de, dn, len)) return;
      add(Prop.hedge, e, n, headingOf(de, dn), -len);
      measuredHedges++;
    });
  // Walls from the ALKIS building layer where OSM has no barrier.
  let alkisWalls = 0;
  for (const w of o.walls ?? [])
    pieces(w, 4, (e, n, de, dn, len) => {
      if (mappedNear(mappedBarriers, e, n) || !offLanes(e, n, de, dn, len)) return;
      add(Prop.wall, e, n, headingOf(de, dn), len);
      alkisWalls++;
    });

  // Guard rails (motorways, embankments, bridges, mapped ones) are their own tile field now: roadside.ts.

  // Bridge railings, at the cap height buildRoads gave them.
  for (const r of o.railings ?? []) add(Prop.railing, r.e, r.n, headingOf(r.de, r.dn), r.len, r.y);

  // City limit signs where roads cross the boundary.
  for (const ring of o.cityLimits === false ? [] : o.boundary ?? []) {
    for (const w of osm.ways) {
      if (!isDrivable(w.tags) || !/^(primary|secondary|tertiary|unclassified|trunk)$/.test(w.tags.highway)) continue;
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1], b = w.pts[i];
        if (pointInRing(a[0], a[1], ring) === pointInRing(b[0], b[1], ring)) continue;
        const de = b[0] - a[0], dn = b[1] - a[1];
        const l = Math.hypot(de, dn) || 1;
        const me = (a[0] + b[0]) / 2, mn = (a[1] + b[1]) / 2;
        const off = roadWidth(w.tags)! / 2 + 1.2;
        // One sign for each direction, on the right-hand side, facing the oncoming traffic.
        add(Prop.cityLimit, me + (dn / l) * off, mn - (de / l) * off, headingOf(-de / l, -dn / l));
        add(Prop.cityLimit, me - (dn / l) * off, mn + (de / l) * off, headingOf(de / l, dn / l));
      }
    }
  }

  // Parked cars: car parks. Paved ones get white lines between the stalls (centre e, n and direction de, dn).
  const stallLines: number[] = [];
  const painted = new Set<string>();
  for (const p of osm.polygons) {
    if (p.tags.amenity !== 'parking' || /^(underground|multi-storey|rooftop)$/.test(p.tags.parking ?? '')) continue;
    const paint = !/^(street_side|lane|on_kerb|half_on_kerb)$/.test(p.tags.parking ?? '') && (p.tags.surface === undefined || /^(asphalt|concrete|paved)$/.test(p.tags.surface));
    parkingLot(p, (e, n, heading, variant, ux, uy) => {
      if (o.onLanes(e, n)) return;
      if (paint)
        for (const s of [-1, 1]) {
          const le = e + ux * STALL.width / 2 * s, ln = n + uy * STALL.width / 2 * s;
          const k = `${Math.round(le * 4)}_${Math.round(ln * 4)}`;
          if (painted.has(k) || o.onLanes(le - uy * 2.4, ln + ux * 2.4) || o.onLanes(le + uy * 2.4, ln - ux * 2.4)) continue;
          painted.add(k);
          stallLines.push(r2(le), r2(ln), r3(-uy), r3(ux));
        }
      if (rand(e, n, 9) > 0.62) return;
      add(Prop.parkedCar, e, n, heading, variant);
    });
  }

  // Parked cars along residential streets inside the town, half on the kerb as is common here.
  for (const w of osm.ways) {
    if (!isDrivable(w.tags) || !/^(residential|living_street|unclassified)$/.test(w.tags.highway)) continue;
    if (o.boundary && !o.boundary.some((r) => pointInRing(w.pts[0][0], w.pts[0][1], r))) continue;
    const width = roadWidth(w.tags)!;
    const off = width / 2 + 0.35;
    // Each kerb parker takes 0.55 m of the carriageway: none on narrow lanes, one side only on tight streets.
    if (width < 4.5) continue;
    for (const s of width < 5.5 ? [1] : [1, -1]) {
      const tag = w.tags[`parking:${s > 0 ? 'right' : 'left'}`] ?? w.tags['parking:both'] ?? w.tags[`parking:lane:${s > 0 ? 'right' : 'left'}`] ?? w.tags['parking:lane:both'];
      if (tag === 'no' || tag === 'separate') continue;
      // Without tags, about half of the street sides have parked cars.
      if (!tag && rand(w.pts[0][0], w.pts[0][1], s > 0 ? 11 : 12) > 0.55) continue;
      pieces(w.pts, 6, (e, n, de, dn) => {
        if (rand(e, n, 13) > 0.5) return;
        const pe = e + dn * off * s, pn = n - de * off * s;
        if (o.onLanes(pe, pn) || junctionNear(e, n, 12)) return;
        // Parked in the direction of traffic on that side.
        const variant = carVariant(pe, pn);
        add(Prop.parkedCar, pe, pn, s > 0 ? headingOf(de, dn) : headingOf(-de, -dn), variant);
      }, 3);
    }
  }
  return { tiles: out, counts, detected, entries, measuredHedges, alkisWalls, stallLines };
}

/** Variant number for a parked car: colour index × 2 + 1 for a van. */
function carVariant(e: number, n: number) {
  return Math.floor(rand(e, n, 21) * 14) * 2 + (rand(e, n, 22) < 0.12 ? 1 : 0);
}

/** Calls fn for pieces of at most `step` metres along a polyline: centre, unit direction, length, distance along. */
function pieces(pts: [number, number][], step: number, fn: (e: number, n: number, de: number, dn: number, len: number, along: number) => void, skipEnds = 0) {
  let along = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ae, an] = pts[i - 1], [be, bn] = pts[i];
    const l = Math.hypot(be - ae, bn - an);
    if (l < 0.3) continue;
    const k = Math.max(1, Math.round(l / step));
    for (let j = 0; j < k; j++) {
      const t = (j + 0.5) / k;
      const d = along + l * t;
      if (skipEnds && (i === 1 && d < skipEnds)) continue;
      fn(ae + (be - ae) * t, an + (bn - an) * t, (be - ae) / l, (bn - an) / l, l / k, d);
    }
    along += l;
  }
}

/** Stall size on a car park (m). */
export const STALL = { width: 2.6, depth: 5 };

/** Stall grid aligned with the car park's longest edge: rows of 2.6 m wide stalls, 5 m deep, with 6 m aisles.
 * Calls back with the stall centre, the parked car's heading and variant, and the edge direction ux, uy. */
function parkingLot(p: Polygon, fn: (e: number, n: number, heading: number, variant: number, ux: number, uy: number) => void) {
  const ring = p.outer;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  area = Math.abs(area / 2);
  if (area < 120 || area > 30000) return;
  let best = 0, ux = 1, uy = 0;
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i][0] - ring[i - 1][0], dy = ring[i][1] - ring[i - 1][1];
    const l = Math.hypot(dx, dy);
    if (l > best) { best = l; ux = dx / l; uy = dy / l; }
  }
  const vx = -uy, vy = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [e, n] of ring) {
    const u = e * ux + n * uy, v = e * vx + n * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const period = 16; // stall row 5 m + aisle 6 m + stall row 5 m
  for (let v = v0 + 2.5; v < v1 - 2; v += 1) {
    const phase = (v - v0) % period;
    const row = phase < 1 ? 0 : phase >= 15 && phase < 16 ? 1 : -1;
    if (row < 0) continue;
    for (let u = u0 + 1.5; u < u1 - 1.3; u += 2.6) {
      const e = u * ux + v * vx, n = u * uy + v * vy;
      if (!pointInPolygon(e, n, p)) continue;
      // Ensure the whole stall is inside.
      if (!pointInPolygon(e + vx * 2.4, n + vy * 2.4, p) || !pointInPolygon(e - vx * 2.4, n - vy * 2.4, p)) continue;
      const face = row === 0 ? 1 : -1;
      fn(e, n, Math.atan2(vx * face, -vy * face), carVariant(e, n), ux, uy);
    }
  }
}

function junctionLookup(junctions: Junction[], world: WorldInfo) {
  const grid = new Map<string, Junction[]>();
  for (const j of junctions) {
    const k = `${Math.floor(j.x / 30)}_${Math.floor(j.z / 30)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(j);
  }
  return (e: number, n: number, extra: number) => {
    const [x, z] = utmToLocal(world, e, n);
    const cx = Math.floor(x / 30), cz = Math.floor(z / 30);
    for (let i = -1; i <= 1; i++)
      for (let k = -1; k <= 1; k++)
        for (const j of grid.get(`${cx + i}_${cz + k}`) ?? []) if (Math.hypot(j.x - x, j.z - z) < j.width / 2 + extra) return true;
    return false;
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export { PROP_STRIDE };

/** Size field of a sign record: index into SIGN_TYPES + 1, 0 when unknown. */
export const signSize = (type: SignType | undefined) => (type ? SIGN_TYPES.indexOf(type) + 1 : 0);

/** Sign type from an OSM traffic_sign value such as "DE:306", "DE:274[50]" or "DE:205,1020-30" (first known one). */
export function osmSignType(value: string): SignType | undefined {
  if (value === 'city_limit') return 'ortsschild';
  for (const part of value.split(/[;,]/)) {
    const m = /^(?:DE:)?(\d{3})(\.\d+)?(?:[-[](\d+))?/.exec(part.trim());
    if (!m) continue;
    const [, code, sub, arg] = m;
    if (code === '306') return 'vorfahrtstrasse';
    if (code === '301') return 'vorfahrt';
    if (code === '205') return 'vorfahrt-achten';
    if (code === '206') return 'stop';
    if (code === '267') return 'einfahrt-verboten';
    if (code === '274') {
      // 274.1 is the 30 zone; plain 274 carries the limit as argument.
      const v = sub === '.1' ? 30 : Number(arg);
      if (!v) continue;
      return v <= 30 ? 'tempo-30' : v <= 50 ? 'tempo-50' : v <= 70 ? 'tempo-70' : 'tempo-100';
    }
    if (code === '350') return 'fussgaenger';
    if (code === '310') return 'ortsschild';
  }
  return undefined;
}

/** Sign type from a Mapillary traffic sign value such as "regulatory--maximum-speed-limit-30--g1". */
export function mapillarySignType(value: string): SignType | undefined {
  const v = value.replace(/--g\d+$/, '');
  const speed = /^regulatory--maximum-speed-limit-(\d+)$/.exec(v);
  if (speed) {
    const n = Number(speed[1]);
    return n <= 30 ? 'tempo-30' : n <= 50 ? 'tempo-50' : n <= 70 ? 'tempo-70' : n <= 100 ? 'tempo-100' : undefined;
  }
  const map: Record<string, SignType> = {
    'regulatory--priority-road': 'vorfahrtstrasse', 'regulatory--yield': 'vorfahrt-achten', 'regulatory--stop': 'stop',
    'regulatory--no-entry': 'einfahrt-verboten', 'regulatory--speed-limit-zone': 'tempo-30', 'information--pedestrians-crossing': 'fussgaenger',
  };
  return map[v];
}

/** Point and direction (unit de, dn) at a distance along a polyline, or undefined when it is shorter. */
function alongPolyline(pts: [number, number][], dist: number): [number, number, number, number] | undefined {
  let left = dist;
  for (let i = 1; i < pts.length; i++) {
    const [ae, an] = pts[i - 1], [be, bn] = pts[i];
    const l = Math.hypot(be - ae, bn - an);
    if (l >= left && l > 0) {
      const t = left / l;
      return [ae + (be - ae) * t, an + (bn - an) * t, (be - ae) / l, (bn - an) / l];
    }
    left -= l;
  }
  return undefined;
}
