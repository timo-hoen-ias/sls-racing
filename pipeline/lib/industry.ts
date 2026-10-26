// Industry and water structures from OSM (2026-10-25): chimneys with red and white bands and a warning light,
// radio and lighting masts, storage tanks and water towers that LoD2 has no building for, overhead pipelines and
// goods conveyors on supports, wooden piers, weirs, dams and lock gates. Drawn into the tiles' "details" layer
// (details.ts); bases and supports are solid, never on a road. Structures inside a building footprint are left to it.
import { type Details, type Rgb, hexRgb } from './details.ts';
import type { OsmData, Polygon } from './osm.ts';
import type { DetailSpot } from './roadDetails.ts';

type Height = (e: number, n: number) => number;
type P3 = [number, number, number];
type Pt = [number, number];

const BRICK = hexRgb(0x8c5a46), CONCRETE = hexRgb(0xa29f97), RED = hexRgb(0xb3372b), WHITE = hexRgb(0xe8e6e0), LIGHT = hexRgb(0xff3020);
const STEEL = hexRgb(0x8d948f), TANK = hexRgb(0xc9cbc6), PIPE = hexRgb(0x7c8a8f), CONVEYOR = hexRgb(0x6f736d), WOOD = hexRgb(0x7a5c40);
const WEIR = hexRgb(0x9b988f), GATE = hexRgb(0x4e5a5e);

export interface IndustryStats { chimneys: number; masts: number; tanks: number; waterTowers: number; pipesKm: number; conveyorsKm: number; piers: number; weirs: number; spots: DetailSpot[] }

/** Height tag in metres (accepts "45", "45 m"), or undefined. */
export function tagHeight(t: Record<string, string>): number | undefined {
  const v = Number.parseFloat(t.height ?? '');
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function centroid(r: Pt[]): Pt {
  const ring = r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;
  return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
}

function area(r: Pt[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s / 2);
}

/** Points every `step` metres along a polyline, with the unit direction there. */
function along(pts: Pt[], step: number): { e: number; n: number; de: number; dn: number }[] {
  const out: { e: number; n: number; de: number; dn: number }[] = [];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const de = (b[0] - a[0]) / l, dn = (b[1] - a[1]) / l;
    for (let d = carry; d <= l; d += step) out.push({ e: a[0] + de * d, n: a[1] + dn * d, de, dn });
    carry = (step - ((l - carry) % step)) % step;
  }
  return out;
}

const lengthOf = (pts: Pt[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

export function buildIndustry(osm: Pick<OsmData, 'points' | 'polygons' | 'extra'>, details: Details, measured: Height, blocked: (e: number, n: number) => boolean, onBuilding: (e: number, n: number) => boolean = () => false): IndustryStats {
  const height: Height = (e, n) => { try { return measured(e, n); } catch { return NaN; } };
  const ok = (e: number, n: number) => Number.isFinite(height(e, n));
  const stats: IndustryStats = { chimneys: 0, masts: 0, tanks: 0, waterTowers: 0, pipesKm: 0, conveyorsKm: 0, piers: 0, weirs: 0, spots: [] };

  const chimney = (e: number, n: number, h: number, r: number, name?: string) => {
    const y = height(e, n);
    const brick = h < 40;
    details.cylinder(e, n, y - 0.5, r, h * 0.84 + 0.5, brick ? BRICK : CONCRETE, 12, r * 0.72, false);
    // Two red bands with a white one between at the top (aviation marking), a warning light on the rim.
    const r1 = r * 0.72, top = y + h;
    details.cylinder(e, n, y + h * 0.84, r1, h * 0.06, RED, 12, r1 * 0.98, false);
    details.cylinder(e, n, y + h * 0.9, r1 * 0.98, h * 0.05, WHITE, 12, r1 * 0.97, false);
    details.cylinder(e, n, y + h * 0.95, r1 * 0.97, h * 0.05, RED, 12, r1 * 0.96, false);
    details.disc(e, n, top, r1 * 0.96, hexRgb(0x262626), 12);
    details.box(e + r1 * 0.8, n, top, 1, 0, 0.4, 0.4, 0.4, LIGHT);
    details.solid([e, n, y - 0.5], r * 1.6, r * 1.6, Math.min(h, 12), 1, 0);
    stats.chimneys++;
    stats.spots.push({ kind: 'schornstein', e, n, note: `${h.toFixed(0)} m${name ? `, ${name}` : ''}` });
  };
  const mast = (e: number, n: number, h: number, lighting: boolean) => {
    const y = height(e, n);
    if (lighting) {
      details.cylinder(e, n, y, 0.3, h, STEEL, 8, 0.15);
      details.box(e, n, y + h, 1, 0, 2.4, 1.2, 0.6, WHITE);
    } else {
      // Radio mast: tapered tube with antenna platforms.
      details.cylinder(e, n, y, 0.9, h, CONCRETE, 10, 0.35);
      for (const f of [0.6, 0.8]) details.cylinder(e, n, y + h * f, 1.8, 0.4, STEEL, 10);
      details.cylinder(e, n, y + h, 0.12, h * 0.15, RED, 6, 0.06);
    }
    details.solid([e, n, y], 1.4, 1.4, 6, 1, 0);
    stats.masts++;
    stats.spots.push({ kind: 'funkmast', e, n, note: `${h.toFixed(0)} m` });
  };
  for (const p of osm.points) {
    const t = p.tags;
    // LoD2 and OSM buildings already model the structures that stand in them.
    if (!ok(p.e, p.n) || onBuilding(p.e, p.n)) continue;
    if (t.man_made === 'chimney') chimney(p.e, p.n, tagHeight(t) ?? 50, Math.max(1.2, (tagHeight(t) ?? 50) / 22), t.name);
    else if (t.man_made === 'mast' && t['tower:type'] !== 'bell_tower') mast(p.e, p.n, tagHeight(t) ?? (t['tower:type'] === 'lighting' ? 22 : 38), t['tower:type'] === 'lighting');
    else if (t.man_made === 'storage_tank') {
      const h = tagHeight(t) ?? 8, y = height(p.e, p.n);
      details.cylinder(p.e, p.n, y - 0.3, 4, h + 0.3, TANK, 16);
      details.solid([p.e, p.n, y - 0.3], 7, 7, h, 1, 0);
      stats.tanks++;
    }
  }

  // Areas without a building tag (LoD2 builds the ones that have one).
  const areas: Polygon[] = [...osm.polygons, ...(osm.extra?.areas ?? [])];
  const seen = new Set<number>();
  for (const a of areas) {
    const t = a.tags;
    if (t.building || seen.has(a.id)) continue;
    if (!/^(chimney|storage_tank|water_tower|silo)$/.test(t.man_made ?? '')) continue;
    seen.add(a.id);
    const [e, n] = centroid(a.outer);
    if (!ok(e, n) || onBuilding(e, n)) continue;
    const r = Math.max(1, Math.sqrt(area(a.outer) / Math.PI));
    if (t.man_made === 'chimney') chimney(e, n, tagHeight(t) ?? 60, r, t.name);
    else if (t.man_made === 'water_tower') {
      const h = tagHeight(t) ?? 30, y = height(e, n);
      details.cylinder(e, n, y, Math.min(r, 3), h * 0.7, CONCRETE, 12);
      details.cylinder(e, n, y + h * 0.7, Math.min(r, 3), h * 0.12, CONCRETE, 16, Math.max(r, 6));
      details.cylinder(e, n, y + h * 0.82, Math.max(r, 6), h * 0.18, CONCRETE, 16, Math.max(r, 6) * 0.6);
      details.solid([e, n, y], Math.min(r, 3) * 1.6, Math.min(r, 3) * 1.6, h * 0.7, 1, 0);
      stats.waterTowers++;
      stats.spots.push({ kind: 'wasserturm', e, n, note: t.name ?? '' });
    } else {
      const h = tagHeight(t) ?? Math.min(18, 4 + r * 0.9), y = Math.min(...a.outer.map(([x, z]) => height(x, z)).filter(Number.isFinite));
      details.cylinder(e, n, y - 0.3, r, h + 0.3, TANK, Math.min(32, Math.max(12, Math.round(r * 3))), r, false);
      // Shallow cone roof.
      details.cylinder(e, n, y + h, r, Math.max(0.4, r * 0.15), hexRgb(0xb6b8b3), Math.min(32, Math.max(12, Math.round(r * 3))), 0.3);
      details.solid([e, n, y - 0.3], r * 1.6, r * 1.6, h, 1, 0);
      stats.tanks++;
      if (stats.tanks % 5 === 1) stats.spots.push({ kind: 'tank', e, n, note: `${(r * 2).toFixed(0)} m Ø` });
    }
  }

  // Lines: overhead pipelines, goods conveyors, piers, weirs, dams, lock gates.
  for (const w of osm.extra?.ways ?? []) {
    const t = w.tags;
    if (!w.pts.every(([e, n]) => ok(e, n))) continue;
    if (t.man_made === 'pipeline' && /^(overhead|surface)$/.test(t.location ?? '')) {
      const over = t.location === 'overhead', lift = over ? 5.2 : 0.7, r = Number.parseFloat(t.diameter ?? '') / 1000 / 2 || 0.35;
      const pts = along(w.pts, 6);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        details.tube([a.e, a.n, height(a.e, a.n) + lift], [b.e, b.n, height(b.e, b.n) + lift], r, PIPE, 6);
      }
      for (const s of along(w.pts, 12)) {
        if (blocked(s.e, s.n)) continue;
        const y = height(s.e, s.n);
        if (over) for (const side of [-1, 1]) details.tube([s.e + s.dn * side * 0.8, s.n - s.de * side * 0.8, y], [s.e + s.dn * side * 0.4, s.n - s.de * side * 0.4, y + lift], 0.1, STEEL, 4);
        else details.box(s.e, s.n, y, s.de, s.dn, 0.4, 0.8, lift - r, CONCRETE);
        details.solid([s.e, s.n, y], 1.8, 0.4, lift, s.dn, -s.de);
      }
      stats.pipesKm += lengthOf(w.pts) / 1000;
      stats.spots.push({ kind: 'rohrleitung', e: w.pts[0][0], n: w.pts[0][1], note: t.name ?? t.substance ?? '' });
    } else if (t.man_made === 'goods_conveyor') {
      // A closed gallery on trestles, at least 6 m up (roads pass beneath).
      const lift = Math.max(6, tagHeight(t) ?? 0);
      const pts = along(w.pts, 6);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const ya = height(a.e, a.n) + lift, yb = height(b.e, b.n) + lift;
        const ce = a.dn * 1.3, cn = -a.de * 1.3;
        for (const s of [-1, 1]) details.face([a.e + ce * s, a.n + cn * s, ya], [b.e + ce * s, b.n + cn * s, yb], ya + 2.2, yb + 2.2, ce * s, cn * s, CONVEYOR);
        details.quadUp([a.e - ce, a.n - cn, ya + 2.2], [a.e + ce, a.n + cn, ya + 2.2], [b.e + ce, b.n + cn, yb + 2.2], [b.e - ce, b.n - cn, yb + 2.2], CONVEYOR);
        details.quadDown([a.e - ce, a.n - cn, ya], [a.e + ce, a.n + cn, ya], [b.e + ce, b.n + cn, yb], [b.e - ce, b.n - cn, yb], CONVEYOR);
      }
      for (const s of along(w.pts, 24)) {
        if (blocked(s.e, s.n)) continue;
        const y = height(s.e, s.n);
        for (const side of [-1, 1]) details.tube([s.e + s.dn * side * 1.6, s.n - s.de * side * 1.6, y], [s.e + s.dn * side * 1.1, s.n - s.de * side * 1.1, y + lift], 0.15, STEEL, 4);
        details.solid([s.e, s.n, y], 3.4, 0.5, lift, s.dn, -s.de);
      }
      stats.conveyorsKm += lengthOf(w.pts) / 1000;
      stats.spots.push({ kind: 'foerderband', e: w.pts[0][0], n: w.pts[0][1], note: `${lengthOf(w.pts).toFixed(0)} m` });
    } else if (t.man_made === 'pier' && !w.closed) {
      // Flat wooden deck at the shore end's height, on posts.
      const y = Math.max(height(w.pts[0][0], w.pts[0][1]), height(w.pts[w.pts.length - 1][0], w.pts[w.pts.length - 1][1])) + 0.3;
      const width = Number.parseFloat(t.width ?? '') || 2.2;
      const deck: P3[] = along(w.pts, 3).map((s) => [s.e, s.n, y]);
      const last = w.pts[w.pts.length - 1];
      deck.push([last[0], last[1], y]);
      details.ribbon(deck, width, WOOD);
      for (const s of along(w.pts, 3)) for (const side of [-1, 1]) {
        const pe = s.e + s.dn * side * (width / 2 - 0.15), pn = s.n - s.de * side * (width / 2 - 0.15);
        details.cylinder(pe, pn, Math.min(height(pe, pn), y) - 1, 0.12, y - Math.min(height(pe, pn), y) + 1, WOOD, 5, 0.12, false);
      }
      stats.piers++;
      stats.spots.push({ kind: 'steg', e: w.pts[0][0], n: w.pts[0][1], note: t.name ?? '' });
    } else if (/^(weir|dam|lock_gate)$/.test(t.waterway ?? '')) {
      // Concrete crest (weir, dam) or a steel gate across the water, level along its length.
      const hs = w.pts.map(([e, n]) => height(e, n));
      // The ends sit on the banks at about the water level; the crest just above it.
      const top = Math.min(hs[0], hs[hs.length - 1]) + (t.waterway === 'lock_gate' ? 1 : 0.3), bottom = Math.min(...hs) - 1.5;
      const width = t.waterway === 'dam' ? 4 : t.waterway === 'weir' ? 1.6 : 0.6;
      const col: Rgb = t.waterway === 'lock_gate' ? GATE : WEIR;
      for (let i = 1; i < w.pts.length; i++) {
        const [a, b] = [w.pts[i - 1], w.pts[i]], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ce = ((b[1] - a[1]) / l) * width / 2, cn = (-(b[0] - a[0]) / l) * width / 2;
        details.quadUp([a[0] - ce, a[1] - cn, top], [a[0] + ce, a[1] + cn, top], [b[0] + ce, b[1] + cn, top], [b[0] - ce, b[1] - cn, top], col);
        for (const s of [-1, 1]) details.face([a[0] + ce * s, a[1] + cn * s, bottom], [b[0] + ce * s, b[1] + cn * s, bottom], top, top, ce * s, cn * s, col);
      }
      stats.weirs++;
      stats.spots.push({ kind: 'wehr', e: w.pts[0][0], n: w.pts[0][1], note: `${t.waterway}${t.name ? `, ${t.name}` : ''}` });
    }
  }
  return stats;
}
