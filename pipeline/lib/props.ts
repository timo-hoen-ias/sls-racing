// Street furniture and parked cars from OSM: signs, bus stops, bollards, benches, bins, post boxes, hydrants,
// advertising columns, fences, walls, hedges, guard rails along motorways, the Saarlouis city limit signs, and
// parked cars on car parks and along residential streets. Everything stays off the driving lanes.
// Output: per tile Float32 records (see src/world/propKinds.ts).

import { type WorldInfo, tileKey, utmToLocal } from '../../src/world/format.ts';
import { DETECTED, PROP_STRIDE, Prop, type PropKind, SIGN_TYPES, type SignType } from '../../src/world/propKinds.ts';
import type { Junction } from './graph.ts';
import { rand } from './ground.ts';
import { type OsmData, type Polygon, pointInPolygon, pointInRing } from './osm.ts';
import { ROAD_LIFT, densify, isDrivable, roadSurfaceHeights, roadWidth } from './roads.ts';

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
  junctions: Junction[];
  boundary?: [number, number][][];
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
    const h = y ?? (near && near.d < near.seg.width / 2 + 3 ? Math.max(o.height(e, n), near.y - ROAD_LIFT) + ROAD_LIFT + 0.14 : o.height(e, n));
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
      // Bollards and blocks on a road would close it: drop them.
      if (onRoad && (kind === Prop.bollard || kind === Prop.block)) return;
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
    const c = cellOf(e, n);
    if (!placed.has(c)) placed.set(c, []);
    placed.get(c)!.push([kind, e, n]);
  };
  for (const p of osm.points) {
    const t = p.tags;
    let kind: PropKind | undefined;
    let size = 0;
    if (t.highway === 'bus_stop') { kind = Prop.busStop; size = t.shelter === 'yes' ? 1 : 0; }
    else if (t.highway === 'stop') kind = Prop.stopSign;
    else if (t.highway === 'give_way') kind = Prop.giveWay;
    else if (t.traffic_sign) { kind = Prop.sign; size = signSize(osmSignType(t.traffic_sign)); }
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
  // Detected features count only where OSM has none of the same kind (signs: any sign) nearby.
  const SIGNS: PropKind[] = [Prop.sign, Prop.stopSign, Prop.giveWay];
  const same = (a: PropKind, b: PropKind) => a === b || (SIGNS.includes(a) && SIGNS.includes(b));
  let detected = 0;
  for (const d of o.detected ?? []) {
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

  // Fences, walls, hedges and mapped guard rails, in pieces of up to 4 m.
  for (const w of osm.ways) {
    const b = w.tags.barrier;
    const kind = b === 'fence' ? Prop.fence : b === 'wall' ? Prop.wall : b === 'hedge' ? Prop.hedge : b === 'guard_rail' ? Prop.guardRail : undefined;
    if (!kind) continue;
    pieces(w.pts, 4, (e, n, de, dn, len) => {
      if (o.onLanes(e, n)) return;
      add(kind, e, n, headingOf(de, dn), len);
    });
  }

  // Guard rails along motorways and trunk roads, both sides, except where other roads join.
  for (const w of osm.ways) {
    if (!/^(motorway|trunk)$/.test(w.tags.highway) || !isDrivable(w.tags)) continue;
    const off = roadWidth(w.tags)! / 2 + 0.8;
    const ys = roadSurfaceHeights(w, o.height);
    const cum = [0];
    for (let i = 1; i < w.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]));
    let seg = 0;
    pieces(w.pts, 4, (e, n, de, dn, len, along) => {
      while (seg < cum.length - 2 && along > cum[seg + 1]) seg++;
      const t = Math.min(1, Math.max(0, (along - cum[seg]) / (cum[seg + 1] - cum[seg] || 1)));
      const y = ys[seg] + (ys[seg + 1] - ys[seg]) * t - ROAD_LIFT;
      for (const s of [1, -1]) {
        const pe = e + dn * off * s, pn = n - de * off * s;
        if (o.onLanes(pe, pn) || junctionNear(pe, pn, 6)) continue;
        add(Prop.guardRail, pe, pn, headingOf(de, dn), len, y);
      }
    });
  }

  // City limit signs where roads cross the boundary.
  for (const ring of o.boundary ?? []) {
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

  // Parked cars: car parks.
  for (const p of osm.polygons) {
    if (p.tags.amenity !== 'parking' || /^(underground|multi-storey|rooftop)$/.test(p.tags.parking ?? '')) continue;
    parkingLot(p, (e, n, heading, variant) => {
      if (o.onLanes(e, n) || rand(e, n, 9) > 0.62) return;
      add(Prop.parkedCar, e, n, heading, variant);
    });
  }

  // Parked cars along residential streets inside the town, half on the kerb as is common here.
  for (const w of osm.ways) {
    if (!isDrivable(w.tags) || !/^(residential|living_street|unclassified)$/.test(w.tags.highway)) continue;
    if (o.boundary && !o.boundary.some((r) => pointInRing(w.pts[0][0], w.pts[0][1], r))) continue;
    const off = roadWidth(w.tags)! / 2 + 0.35;
    for (const s of [1, -1]) {
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
  return { tiles: out, counts, detected };
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

/** Stall grid aligned with the car park's longest edge: rows of 2.6 m wide stalls, 5 m deep, with 6 m aisles. */
function parkingLot(p: Polygon, fn: (e: number, n: number, heading: number, variant: number) => void) {
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
      fn(e, n, Math.atan2(vx * face, -vy * face), carVariant(e, n));
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
