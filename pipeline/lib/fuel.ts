import { type WorldInfo, tileKey, utmToLocal } from '../../src/world/format.ts';
import { FUEL_COLORS, NO_PYLON, fuelIslands, fuelLayout, type FuelBox } from '../../src/world/fuelKinds.ts';
import { rand } from './ground.ts';
import { type OsmData, pointInRing, type Way } from './osm.ts';
import { ROAD_CLASSES, isBridge, isDrivable } from './roads.ts';

// Petrol stations from OSM amenity=fuel (areas, points, fuel-tagged buildings): a canopy with pump islands,
// pumps and columns, a shop where the survey has no building, and a price pylon at the road. Where the LoD2 survey
// or OSM model the canopy (ALKIS 51009_1610 "Überdachung", building=roof) its outline sets the canopy and the solid
// block is left out of the buildings. Solid parts keep clear of every carriageway (service roads through the
// forecourt included); islands that would stand on one are dropped.

export interface FuelBuilding {
  ring: [number, number][];
  /** canopy: roof over the pumps (left out where a station uses it), shop: a station building, other. */
  kind: 'canopy' | 'shop' | 'other';
}

export interface FuelOptions {
  world: WorldInfo;
  height: (e: number, n: number) => number;
  /** Carriageways with a margin: no solid part may stand there. */
  nearLanes: (e: number, n: number) => boolean;
  /** Road or pavement: the pylon stands beside it. */
  onRoad: (e: number, n: number) => boolean;
  buildings: FuelBuilding[];
}

export interface FuelStation {
  name: string;
  osm: string;
  e: number;
  n: number;
  /** Canopy axis (unit, along the road) and front normal (towards the road), UTM. */
  ax: [number, number];
  nz: [number, number];
  length: number;
  width: number;
  mask: number;
  islands: number;
  /** The canopy outline came from the survey or OSM. */
  mapped: boolean;
  shop?: { e: number; n: number; w: number; d: number };
  realShop: boolean;
  pylon?: { e: number; n: number; ax: [number, number] };
}

/** Station zone around a point (m). */
const POINT_ZONE = 32;
const SHOP = { w: 12, d: 8 };
/** Service roads and tracks (driveways through the forecourt): solid parts keep this far from the centreline. */
const SERVICE_CLEAR = 1.9;

export function isFuelCanopyFn(fn: string) {
  return fn.startsWith('51009_161');
}
export function isFuelShopFn(fn: string) {
  return fn === '31001_2130';
}

const centroid = (r: [number, number][]): [number, number] => {
  let e = 0, n = 0;
  for (const [a, b] of r) { e += a / r.length; n += b / r.length; }
  return [e, n];
};
const area = (r: [number, number][]) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a / 2);
};
const open = (r: [number, number][]) => (r.length > 1 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1] ? r.slice(0, -1) : r);
const key = (r: [number, number][]) => { const [e, n] = centroid(open(r)); return `${Math.round(e * 10)}_${Math.round(n * 10)}`; };

/** Smallest rectangle around the points: centre, unit long axis, length and width. */
export function minRect(pts: [number, number][]) {
  let best = { c: [0, 0] as [number, number], ax: [1, 0] as [number, number], l: 0, w: 0, a: Infinity };
  const angles = new Set<number>();
  for (let i = 0; i < pts.length; i++) {
    const [ae, an] = pts[i], [be, bn] = pts[(i + 1) % pts.length];
    if (Math.hypot(be - ae, bn - an) > 0.5) angles.add(Math.round(((Math.atan2(bn - an, be - ae) % Math.PI) + Math.PI) % Math.PI * 1000) / 1000);
  }
  if (!angles.size) angles.add(0);
  for (const t of angles) {
    const ux = Math.cos(t), uy = Math.sin(t);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [e, n] of pts) {
      const a = e * ux + n * uy, b = -e * uy + n * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const ar = (a1 - a0) * (b1 - b0);
    if (ar < best.a) {
      const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
      const c: [number, number] = [ca * ux - cb * uy, ca * uy + cb * ux];
      best = a1 - a0 >= b1 - b0 ? { c, ax: [ux, uy], l: a1 - a0, w: b1 - b0, a: ar } : { c, ax: [-uy, ux], l: b1 - b0, w: a1 - a0, a: ar };
    }
  }
  return best;
}

/** Road segments on a grid, for the nearest road and its direction. */
class Segments {
  private cells = new Map<string, [number, number, number, number, number][]>();
  private static C = 32;
  constructor(ways: Way[]) {
    for (const w of ways) {
      if (!isDrivable(w.tags) || isBridge(w.tags)) continue;
      const rank = ROAD_CLASSES[w.tags.highway].rank;
      for (let i = 1; i < w.pts.length; i++) {
        const [ae, an] = w.pts[i - 1], [be, bn] = w.pts[i];
        for (let x = Math.floor(Math.min(ae, be) / Segments.C); x <= Math.floor(Math.max(ae, be) / Segments.C); x++)
          for (let y = Math.floor(Math.min(an, bn) / Segments.C); y <= Math.floor(Math.max(an, bn) / Segments.C); y++) {
            const k = `${x}_${y}`;
            if (!this.cells.has(k)) this.cells.set(k, []);
            this.cells.get(k)!.push([ae, an, be, bn, rank]);
          }
      }
    }
  }
  /** A road of at most maxRank has its centreline within d metres. */
  within(e: number, n: number, d: number, maxRank: number) {
    const cx = Math.floor(e / Segments.C), cy = Math.floor(n / Segments.C);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (const [ae, an, be, bn, rank] of this.cells.get(`${x}_${y}`) ?? []) {
          if (rank > maxRank) continue;
          const de = be - ae, dn = bn - an, l2 = de * de + dn * dn || 1;
          const t = Math.max(0, Math.min(1, ((e - ae) * de + (n - an) * dn) / l2));
          if (Math.hypot(ae + de * t - e, an + dn * t - n) < d) return true;
        }
    return false;
  }
  /** Nearest point on a road of at least minRank within max metres, with the road direction. */
  nearest(e: number, n: number, max: number, minRank: number) {
    let best: { e: number; n: number; d: number; dir: [number, number] } | undefined;
    const r = Math.ceil(max / Segments.C);
    const cx = Math.floor(e / Segments.C), cy = Math.floor(n / Segments.C);
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (const [ae, an, be, bn, rank] of this.cells.get(`${x}_${y}`) ?? []) {
          if (rank < minRank) continue;
          const de = be - ae, dn = bn - an, l2 = de * de + dn * dn || 1;
          const t = Math.max(0, Math.min(1, ((e - ae) * de + (n - an) * dn) / l2));
          const pe = ae + de * t, pn = an + dn * t, d = Math.hypot(pe - e, pn - n);
          if (d < max && (!best || d < best.d)) { const l = Math.sqrt(l2); best = { e: pe, n: pn, d, dir: [de / l, dn / l] }; }
        }
    return best;
  }
}

/** Buildings on a grid for footprint tests. */
class Blocks {
  private cells = new Map<string, { ring: [number, number][]; box: number[] }[]>();
  private static C = 32;
  add(ring: [number, number][]) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    const item = { ring, box: [x0, y0, x1, y1] };
    for (let x = Math.floor(x0 / Blocks.C); x <= Math.floor(x1 / Blocks.C); x++)
      for (let y = Math.floor(y0 / Blocks.C); y <= Math.floor(y1 / Blocks.C); y++) {
        const k = `${x}_${y}`;
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k)!.push(item);
      }
  }
  has(e: number, n: number) {
    for (const it of this.cells.get(`${Math.floor(e / Blocks.C)}_${Math.floor(n / Blocks.C)}`) ?? [])
      if (e >= it.box[0] && e <= it.box[2] && n >= it.box[1] && n <= it.box[3] && pointInRing(e, n, it.ring)) return true;
    return false;
  }
}

export function planFuel(osm: OsmData, o: FuelOptions) {
  const segs = new Segments(osm.ways);
  // Zones: mapped areas first, then fuel buildings and points that are not inside one already.
  type Zone = { name: string; osm: string; ring?: [number, number][]; e: number; n: number; shopRing?: [number, number][]; size: number };
  const zones: Zone[] = [];
  const inZone = (e: number, n: number) => zones.some((z) => (z.ring ? pointInRing(e, n, z.ring) : false) || Math.hypot(z.e - e, z.n - n) < 60);
  const label = (t: Record<string, string>) => t.name ?? t.brand ?? t.operator ?? 'Tankstelle';
  for (const p of osm.polygons) {
    if (p.tags.amenity !== 'fuel') continue;
    const ring = open(p.outer);
    if (ring.length < 3) continue;
    const [e, n] = centroid(ring);
    if (zones.some((z) => z.ring && pointInRing(e, n, z.ring) || Math.hypot(z.e - e, z.n - n) < 25)) continue;
    const building = p.tags.building && !/^(roof|canopy)$/.test(p.tags.building);
    zones.push({ name: label(p.tags), osm: `way ${p.id}`, ring: building ? undefined : ring, e, n, shopRing: building ? ring : undefined, size: area(ring) });
  }
  for (const p of osm.points) {
    if (p.tags.amenity !== 'fuel' || inZone(p.e, p.n)) continue;
    zones.push({ name: label(p.tags), osm: `node ${p.id}`, e: p.e, n: p.n, size: 0 });
  }
  const zoneHas = (z: Zone, e: number, n: number) => (z.ring && z.size > 250 ? pointInRing(e, n, z.ring) : Math.hypot(z.e - e, z.n - n) < POINT_ZONE);

  // Buildings: canopies inside a zone go (the station draws its own), the rest are obstacles.
  const skip = new Set<string>();
  const blocks = new Blocks();
  const canopies = new Map<Zone, [number, number][][]>();
  const shops = new Set<Zone>();
  for (const b of o.buildings) {
    const ring = open(b.ring);
    if (ring.length < 3) continue;
    const [e, n] = centroid(ring);
    if (!zones.some((z) => Math.abs(z.e - e) < 150 && Math.abs(z.n - n) < 150)) continue;
    const z = zones.find((z) => zoneHas(z, e, n));
    if (z && b.kind === 'canopy') {
      if (!canopies.has(z)) canopies.set(z, []);
      if (area(ring) >= 20) canopies.get(z)!.push(ring);
      skip.add(key(ring));
      continue;
    }
    if (z && area(ring) >= 25) shops.add(z);
    blocks.add(ring);
  }
  for (const p of osm.polygons)
    if (p.tags.amenity === 'fuel' && /^(roof|canopy)$/.test(p.tags.building ?? '')) skip.add(key(p.outer));

  const stations: FuelStation[] = [];
  const failed: string[] = [];
  const toUtm = (s: { e: number; n: number; ax: [number, number]; nz: [number, number] }, x: number, z: number): [number, number] =>
    [s.e + s.ax[0] * x + s.nz[0] * z, s.n + s.ax[1] * x + s.nz[1] * z];
  /** Footprint of a box (with margin) clear of lanes and buildings. */
  const boxClear = (s: Parameters<typeof toUtm>[0], b: { x: number; z: number; w: number; d: number }, m: number, lanes = true) => {
    for (let x = -b.w / 2 - m; x <= b.w / 2 + m + 1e-6; x += Math.min(0.5, b.w / 2 + m))
      for (let z = -b.d / 2 - m; z <= b.d / 2 + m + 1e-6; z += Math.min(0.5, b.d / 2 + m)) {
        const [e, n] = toUtm(s, b.x + x, b.z + z);
        if ((lanes && (o.nearLanes(e, n) || segs.within(e, n, SERVICE_CLEAR, 1))) || blocks.has(e, n)) return false;
      }
    return true;
  };

  for (const z of zones) {
    // Canopy outlines to try: all mapped canopies together, the largest alone, else a default size at the zone centre.
    const mapped = canopies.get(z) ?? [];
    const rects: { c: [number, number]; ax: [number, number]; l: number; w: number; mapped: boolean }[] = [];
    if (mapped.length) {
      rects.push({ ...minRect(mapped.flat()), mapped: true });
      if (mapped.length > 1) rects.push({ ...minRect(mapped.reduce((x, y) => (area(y) > area(x) ? y : x))), mapped: true });
    }
    const road0 = segs.nearest(z.e, z.n, 80, 2) ?? segs.nearest(z.e, z.n, 80, 0);
    rects.push({ c: [z.e, z.n], ax: road0 ? road0.dir : [1, 0], l: z.size > 1500 ? 24 : 20, w: z.size > 1500 ? 13 : 11, mapped: false });
    let best: { s: FuelStation; n: number } | undefined;
    let road: ReturnType<Segments['nearest']>;
    const why: string[] = [];
    for (const r of rects) {
      const length = Math.max(12, Math.min(34, r.l)), width = Math.max(8, Math.min(16, r.w));
      const c = r.c;
      // Front towards the nearest street (not the service road through the forecourt).
      const rd = segs.nearest(c[0], c[1], 120, 2) ?? segs.nearest(c[0], c[1], 120, 0);
      let nz: [number, number] = [-r.ax[1], r.ax[0]];
      if (rd && (rd.e - c[0]) * nz[0] + (rd.n - c[1]) * nz[1] < 0) nz = [-nz[0], -nz[1]];
      // Local x of the game's frame for this heading.
      const ax: [number, number] = [-nz[1], nz[0]];
      const islands = fuelIslands(length, width);
      const all = (1 << islands.length) - 1;
      const solids = (mask: number) => fuelLayout(length, width, mask).filter((b) => b.part !== 'roof');
      // Search offsets: mapped canopies stay close to the survey, generic ones may move back from the road.
      const offs: [number, number][] = [];
      const range = r.mapped ? [-3, 3] : [-14, 4];
      for (let dz = range[0]; dz <= range[1]; dz += 1) for (let dx = -6; dx <= 6; dx += 1.5) offs.push([dx, dz]);
      offs.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
      let roofHit = 0;
      for (const [dx, dz] of offs) {
        const s = { e: c[0] + ax[0] * dx + nz[0] * dz, n: c[1] + ax[1] * dx + nz[1] * dz, ax, nz };
        // The roof (1 m in from its edge) may not reach into a building; it may span a service road.
        if (!boxClear(s, { x: 0, z: 0, w: length - 2, d: width - 2 }, 0, false)) { roofHit++; continue; }
        let mask = 0;
        islands.forEach((_, i) => { if (solids(1 << i).every((b) => boxClear(s, b, 0.3))) mask |= 1 << i; });
        const n = popcount(mask);
        if (!n || (best && n <= best.n)) continue;
        best = { s: { name: z.name, osm: z.osm, ...s, length, width, mask, islands: islands.length, mapped: r.mapped, realShop: shops.has(z) || !!z.shopRing }, n };
        road = rd;
        if (mask === all) break;
      }
      if (best) break;
      why.push(`${roofHit === offs.length ? 'Gebäude' : 'Fahrbahn'} ${r.mapped ? 'vermessen' : 'generisch'} ${length.toFixed(0)}×${width.toFixed(0)}`);
    }
    if (!best) { failed.push(`${z.name} (${why.join(', ')})`); continue; }
    const { ax, nz, length, width } = best.s;
    const s = best.s;
    if (!s.realShop) {
      // Shop behind the canopy, else beside it.
      const tries: [number, number][] = [[0, -(width / 2 + 5 + SHOP.d / 2)], [-(length / 2 + 5 + SHOP.w / 2), 0], [length / 2 + 5 + SHOP.w / 2, 0], [0, -(width / 2 + 9 + SHOP.d / 2)]];
      for (const [x, zz] of tries)
        if (boxClear(s, { x, z: zz, w: SHOP.w, d: SHOP.d }, 0.8)) { const [e, n] = toUtm(s, x, zz); s.shop = { e, n, ...SHOP }; break; }
    }
    // Price pylon beside the street, off the pavement, to one side of the canopy.
    if (road) {
      for (const side of [1, -1, 0]) {
        const along = side * (length / 2 + 3);
        const base: [number, number] = [road.e + road.dir[0] * along, road.n + road.dir[1] * along];
        const u = [-nz[0], -nz[1]];
        for (let d = 2; d <= 25; d += 0.5) {
          const pe = base[0] + u[0] * d, pn = base[1] + u[1] * d;
          if (o.onRoad(pe, pn) || o.nearLanes(pe, pn)) continue;
          const ok = [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]].every(([a, b]) => !o.onRoad(pe + a, pn + b) && !o.nearLanes(pe + a, pn + b) && !blocks.has(pe + a, pn + b));
          // Not under the canopy.
          const lx = (pe - s.e) * ax[0] + (pn - s.n) * ax[1], lz = (pe - s.e) * nz[0] + (pn - s.n) * nz[1];
          const underRoof = Math.abs(lx) < length / 2 + 1.5 && Math.abs(lz) < width / 2 + 1.5;
          const inShop = s.shop && Math.hypot(pe - s.shop.e, pn - s.shop.n) < 9;
          if (ok && !underRoof && !inShop) { s.pylon = { e: pe, n: pn, ax: road.dir }; break; }
        }
        if (s.pylon) break;
      }
    }
    stations.push(s);
  }

  // Tile records.
  const T = o.world.tileSize;
  const tiles = new Map<string, number[]>();
  const heading = (v: [number, number]) => Math.round(Math.atan2(v[0], -v[1]) * 1000) / 1000;
  stations.forEach((s, i) => {
    // Ground: mean of the island centres, a little low so nothing floats on a sloping forecourt.
    const hs = fuelIslands(s.length, s.width).filter((_, j) => s.mask & (1 << j)).map((is) => o.height(...toUtm(s, is.x, is.z)));
    const y = hs.reduce((a, b) => a + b, 0) / hs.length - 0.03;
    const [x, zz] = utmToLocal(o.world, s.e, s.n);
    const rec = [x, y, zz, heading(s.nz), s.length, s.width, s.mask, Math.floor(rand(s.e, s.n, 3) * FUEL_COLORS.length)];
    if (s.shop) {
      const [sx, sz] = utmToLocal(o.world, s.shop.e, s.shop.n);
      rec.push(sx, o.height(s.shop.e, s.shop.n) - 0.05, sz, heading(s.nz), s.shop.w, s.shop.d);
    } else rec.push(0, 0, 0, 0, 0, 0);
    if (s.pylon) {
      const [px, pz] = utmToLocal(o.world, s.pylon.e, s.pylon.n);
      rec.push(px, o.height(s.pylon.e, s.pylon.n) - 0.05, pz, heading(s.pylon.ax));
    } else rec.push(0, NO_PYLON, 0, 0);
    rec.push(i + 1);
    const k = tileKey(Math.floor(s.e / T), Math.floor(s.n / T));
    if (!tiles.has(k)) tiles.set(k, []);
    tiles.get(k)!.push(...rec.map((v) => Math.round(v * 1000) / 1000));
  });
  /** Station list for the game's fuel.list / fuel.tp (all stations, also on tiles not loaded). */
  const list = stations.map((s) => {
    const [x, z] = utmToLocal(o.world, s.e, s.n);
    return { name: s.name, osm: s.osm, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, heading: heading(s.nz), length: Math.round(s.length * 10) / 10, width: Math.round(s.width * 10) / 10, pumps: popcount(s.mask) * 2, mapped: s.mapped, shop: s.realShop ? 'gebaeude' : s.shop ? 'modell' : 'keiner', pylon: !!s.pylon };
  });
  return {
    tiles, list, zones: zones.length, failed,
    /** Buildings (outer ring) the stations replace with their own canopy. */
    skip: (ring: [number, number][]) => skip.has(key(ring)),
  };
}

function popcount(m: number) {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
}

export type { FuelBox };
