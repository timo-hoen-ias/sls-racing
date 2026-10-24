import { type WorldInfo, tileKey, utmToLocal } from '../../src/world/format.ts';
import { SHOP_KINDS, SHOP_STRIDE, ShopFlag, type ShopKind } from '../../src/world/shopKinds.ts';
import { rand } from './ground.ts';
import { type OsmData, pointInRing } from './osm.ts';

// Shop fronts on the ground floor of buildings: awning, fascia board and sign, café tables, pavement sign. Mapped
// shops (shop=*, cafés, restaurants, pharmacies, banks …) sit on the street side of the building they are in or
// next to; buildings the façade code gave shop windows (facades.ts) get generic fronts along their street sides.

const AMENITY: Record<string, ShopKind> = {
  cafe: 'cafe', restaurant: 'restaurant', fast_food: 'restaurant', bar: 'restaurant', pub: 'restaurant', biergarten: 'restaurant',
  ice_cream: 'eis', pharmacy: 'apotheke', bank: 'bank',
};
const SHOP: Record<string, ShopKind> = {
  bakery: 'baeckerei', pastry: 'baeckerei', butcher: 'metzgerei', deli: 'metzgerei', hairdresser: 'friseur', beauty: 'friseur',
  clothes: 'mode', shoes: 'mode', boutique: 'mode', fashion_accessories: 'mode', books: 'buch', stationery: 'buch',
  florist: 'blumen', garden_centre: 'blumen', ice_cream: 'eis', kiosk: 'kiosk', newsagent: 'kiosk', tobacco: 'kiosk',
  coffee: 'cafe', confectionery: 'baeckerei',
};
/** Generic fronts for shop-window façades without a mapped shop. */
const GENERIC: ShopKind[] = ['laden', 'laden', 'laden', 'mode', 'mode', 'cafe', 'baeckerei', 'friseur', 'kiosk', 'buch', 'blumen', 'eis', 'restaurant'];

/** Kind of a mapped shop, or undefined if the tags are no shop front. */
export function shopKindOf(tags: Record<string, string>): ShopKind | undefined {
  if (tags.amenity && AMENITY[tags.amenity]) return AMENITY[tags.amenity];
  if (!tags.shop || tags.shop === 'no' || tags.shop === 'vacant') return undefined;
  return SHOP[tags.shop] ?? 'laden';
}

export interface ShopBuilding {
  id: number;
  /** Open outer ring (UTM). */
  outer: [number, number][];
  /** The façade has shop windows (facades.ts). */
  shopWindows: boolean;
  /** Distance from the old town centre (m). */
  centre: number;
}

export interface ShopOptions {
  world: WorldInfo;
  height: (e: number, n: number) => number;
  /** True on a road or its pavement. */
  onRoad: (e: number, n: number) => boolean;
  /** True on a road's driving lanes. */
  onLanes: (e: number, n: number) => boolean;
  buildings: ShopBuilding[];
}

interface Wall { b: ShopBuilding; ae: number; an: number; de: number; dn: number; len: number; ne: number; nn: number; used: [number, number][] }

const FRONT = 5.5;
/** Old town radius (m) where most shop-window façades get a front. */
const GENERIC_RADIUS = 650;

export function buildShops(osm: OsmData, o: ShopOptions) {
  const T = o.world.tileSize;
  const out = new Map<string, number[]>();
  const counts: Partial<Record<ShopKind, number>> = {};
  // Street-facing walls of every building, in a grid for the lookup.
  const CELL = 40;
  const grid = new Map<string, Wall[]>();
  const wallsOf = new Map<number, Wall[]>();
  for (const b of o.buildings) {
    const ring = b.outer;
    const list: Wall[] = [];
    for (let i = 0; i < ring.length; i++) {
      const [ae, an] = ring[i], [be, bn] = ring[(i + 1) % ring.length];
      const len = Math.hypot(be - ae, bn - an);
      if (len < 3) continue;
      const de = (be - ae) / len, dn = (bn - an) / len;
      // Outward normal: the side where a point just off the wall is outside the footprint.
      let ne = dn, nn = -de;
      const me = (ae + be) / 2, mn = (an + bn) / 2;
      if (pointInRing(me + ne * 0.5, mn + nn * 0.5, ring)) { ne = -ne; nn = -nn; }
      // Facing a street: a road or pavement within 12 m in front of it.
      let street = false;
      for (let d = 2; d <= 12 && !street; d += 2) street = o.onRoad(me + ne * d, mn + nn * d);
      if (!street) continue;
      const w: Wall = { b, ae, an, de, dn, len, ne, nn, used: [] };
      list.push(w);
      const k = `${Math.floor(me / CELL)}_${Math.floor(mn / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(w);
    }
    if (list.length) wallsOf.set(b.id, list);
  }

  /** Puts a front of `width` around position t along the wall; false when it does not fit. */
  const place = (w: Wall, t: number, width: number, kind: ShopKind, seed: number) => {
    width = Math.min(width, w.len - 0.6);
    if (width < 2.5) return false;
    t = Math.max(width / 2 + 0.3, Math.min(w.len - width / 2 - 0.3, t));
    if (w.used.some(([a, b]) => t + width / 2 > a && t - width / 2 < b)) return false;
    w.used.push([t - width / 2, t + width / 2]);
    const e = w.ae + w.de * t, n = w.an + w.dn * t;
    const r = (s: number) => rand(e, n, seed + s);
    let flags = 0;
    const awning = r(1);
    if (awning < 0.55) flags |= ShopFlag.awning;
    else if (awning < 0.75) flags |= ShopFlag.awningBox;
    if (r(2) < 0.5 || kind === 'apotheke') flags |= ShopFlag.projecting;
    // Café tables and pavement signs only where there is pavement in front, not driving lanes.
    const free = (d: number) => !o.onLanes(e + w.ne * d, n + w.nn * d) && !o.onLanes(e + w.ne * (d + 1), n + w.nn * (d + 1));
    if ((kind === 'cafe' || kind === 'eis' || kind === 'restaurant') && width >= 4 && free(2.6)) flags |= ShopFlag.tables;
    if (r(3) < 0.35 && free(1.2)) flags |= ShopFlag.aufsteller;
    const [x, z] = utmToLocal(o.world, e, n);
    const k = tileKey(Math.floor(e / T), Math.floor(n / T));
    if (!out.has(k)) out.set(k, []);
    const heading = Math.atan2(w.ne, -w.nn);
    out.get(k)!.push(SHOP_KINDS.indexOf(kind), r2(x), r2(o.height(e, n)), r2(z), Math.round(heading * 1000) / 1000, r2(width), flags, Math.floor(r(4) * 7));
    counts[kind] = (counts[kind] ?? 0) + 1;
    return true;
  };

  // Mapped shops: points and shop-tagged buildings, onto the nearest street-facing wall within 15 m.
  const mapped: { e: number; n: number; kind: ShopKind; id: number }[] = [];
  for (const p of osm.points) {
    const kind = shopKindOf(p.tags);
    if (kind) mapped.push({ e: p.e, n: p.n, kind, id: p.id });
  }
  for (const p of osm.polygons) {
    const kind = shopKindOf(p.tags);
    if (!kind || !p.tags.building) continue;
    const ring = p.outer.slice(0, -1);
    let e = 0, n = 0;
    for (const [a, b] of ring) { e += a / ring.length; n += b / ring.length; }
    mapped.push({ e, n, kind, id: p.id });
  }
  let placedMapped = 0;
  for (const s of mapped) {
    let best: Wall | undefined, bd = 15, bt = 0;
    const ce = Math.floor(s.e / CELL), cn = Math.floor(s.n / CELL);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const w of grid.get(`${ce + a}_${cn + b}`) ?? []) {
          const t = Math.max(0, Math.min(w.len, (s.e - w.ae) * w.de + (s.n - w.an) * w.dn));
          const d = Math.hypot(w.ae + w.de * t - s.e, w.an + w.dn * t - s.n);
          if (d < bd) { bd = d; best = w; bt = t; }
        }
    if (best && place(best, bt, FRONT, s.kind, s.id % 1000)) placedMapped++;
  }

  // Shop-window façades without a mapped shop: in the old town most get one generic front on their longest street
  // side (two on long ones), further out only a few.
  for (const b of o.buildings) {
    if (!b.shopWindows || wallsOf.get(b.id)?.some((w) => w.used.length)) continue;
    const w = (wallsOf.get(b.id) ?? []).reduce<Wall | undefined>((a, x) => (!a || x.len > a.len ? x : a), undefined);
    if (!w || rand(w.ae, w.an, 49) > (b.centre < GENERIC_RADIUS ? 0.7 : 0.15)) continue;
    const n = w.len > 16 ? 2 : 1;
    for (let i = 0; i < n; i++) place(w, (i + 0.5) * (w.len / n), 4.5, GENERIC[mix(b.id * 31 + i) % GENERIC.length], 60 + i * 7);
  }
  return { tiles: out, counts, mapped: mapped.length, placedMapped };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Integer hash (the coordinate-based rand correlates for neighbouring salts). */
function mix(n: number) {
  let h = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

export { SHOP_STRIDE };
