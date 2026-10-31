// Power lines from OSM (2026-10-25): lattice pylons with cross arms, insulators and sagging conductors on
// power=line, concrete or wooden poles with a cross bar on power=minor_line, compact substations for lone
// transformers, transformer bays with gantries in substations, and panel rows on solar farms. All drawn into the
// tiles' "details" layer (details.ts); pylon legs and transformers also go into the collision layer.
import { type Details, hexRgb } from './details.ts';
import type { OsmData, Polygon } from './osm.ts';
import type { DetailSpot } from './roadDetails.ts';

type Height = (e: number, n: number) => number;
type P3 = [number, number, number];

/** Pylon height (m) by the line's highest voltage, when the tower has no height tag. */
export function pylonHeight(voltage: string | undefined): number {
  const v = Math.max(0, ...(voltage ?? '').split(';').map(Number).filter((x) => Number.isFinite(x)));
  return v >= 380000 ? 56 : v >= 220000 ? 46 : v >= 110000 ? 34 : v >= 30000 ? 24 : 20;
}

/** Conductor attachment points across the line (x = metres right of the centre, y = fraction of the height),
 * Donaumast style: two conductors a side on the lower arm, one a side above, more arms for 9 and 12 cables. */
export function pylonSlots(cables: number, h: number): [number, number][] {
  const w = h * 0.2;
  const lower: [number, number][] = [[-w, 0.7], [-w * 0.55, 0.7], [w * 0.55, 0.7], [w, 0.7]];
  const upper: [number, number][] = [[-w * 0.6, 0.85], [w * 0.6, 0.85]];
  const third: [number, number][] = [[-w * 0.9, 0.56], [-w * 0.5, 0.56], [w * 0.5, 0.56], [w * 0.9, 0.56]];
  if (cables <= 3) return [[-w * 0.8, 0.78], [w * 0.8, 0.78], [w * 0.5, 0.9]];
  if (cables <= 6) return [...lower, ...upper];
  const upper4: [number, number][] = [[-w * 0.75, 0.85], [-w * 0.35, 0.85], [w * 0.35, 0.85], [w * 0.75, 0.85]];
  return [...lower, ...third, ...upper4].slice(0, Math.min(12, cables));
}

const STEEL = hexRgb(0x8d948f), STEEL_DARK = hexRgb(0x6c726e), CONDUCTOR = hexRgb(0x56595a), INSULATOR = hexRgb(0xb9b1a3);
const CONCRETE = hexRgb(0x9c9a94), WOOD = hexRgb(0x6b5440), KIOSK = hexRgb(0xc8bfa8), KIOSK_ROOF = hexRgb(0x56524c);
const TRAFO = hexRgb(0x5e6a62), PANEL = hexRgb(0x1f2b45), PANEL_FRAME = hexRgb(0x9aa0a6), PANEL_BACK = hexRgb(0x4a4f55);

export interface PowerStats { pylons: number; poles: number; spans: number; kiosks: number; substations: number; solarRows: number; moved: number; spots: DetailSpot[] }

interface Support { e: number; n: number; y: number; ae: number; an: number; h: number; pole: boolean }

/** Unit vector across the line at vertex i (bisector of the neighbouring segments), pointing right of travel. */
function acrossAt(pts: [number, number][], i: number): [number, number] {
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const de = b[0] - a[0], dn = b[1] - a[1], l = Math.hypot(de, dn) || 1;
  return [dn / l, -de / l];
}

/** Point in a polygon ring (UTM). */
function inside(ring: [number, number][], e: number, n: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Where the footing of a support stands: its legs (pylon) or its foot (pole), x across and z along the line. */
export function footings(h: number, pole: boolean): [number, number][] {
  if (pole) return [[0, 0]];
  const b = h * 0.09;
  return [[-b, -b], [b, -b], [b, b], [-b, b]];
}

/** Steps (m) a support is moved along its line to get its footings off a carriageway: OSM places some a few metres
 * off, and a pylon leg or pole on the road is a wall to drive into. */
const SHIFTS = [2, -2, 4, -4, 6, -6, 8, -8, 10, -10, 12, -12];

/**
 * The support position with no footing on a road (`onRoad`), moved along the line by the smallest step that
 * clears it; unchanged when it stands clear already or no step does.
 */
export function clearOfRoads(e: number, n: number, ae: number, an: number, feet: [number, number][], onRoad: (e: number, n: number) => boolean): [number, number] {
  const le = -an, ln = ae;
  const hits = (ce: number, cn: number) => feet.some(([x, z]) => onRoad(ce + ae * x + le * z, cn + an * x + ln * z));
  if (!hits(e, n)) return [e, n];
  for (const d of SHIFTS) if (!hits(e + le * d, n + ln * d)) return [e + le * d, n + ln * d];
  return [e, n];
}

export function buildPower(osm: Pick<OsmData, 'points' | 'extra'>, details: Details, measured: Height, onRoad: (e: number, n: number) => boolean = () => false): PowerStats {
  // Lines run on beyond the fetched terrain; their supports out there are left out (NaN).
  const height: Height = (e, n) => { try { return measured(e, n); } catch { return NaN; } };
  const stats: PowerStats = { pylons: 0, poles: 0, spans: 0, kiosks: 0, substations: 0, solarRows: 0, moved: 0, spots: [] };
  const lines = (osm.extra?.ways ?? []).filter((w) => w.tags.power === 'line' || w.tags.power === 'minor_line');
  const nodeTags = new Map(osm.points.map((p) => [p.id, p.tags]));
  const done = new Set<number>();
  // Lattice tower: four tapering legs, braced faces, cross arms with hanging insulators.
  const pylon = (s: Support, slots: [number, number][]) => {
    const { e, n, y, ae, an, h } = s;
    const le = -an, ln = ae; // along the line
    const P = (x: number, z: number, yy: number): P3 => [e + ae * x + le * z, n + an * x + ln * z, yy];
    const base = h * 0.09, waist = h * 0.025;
    const half = (f: number) => base + (waist - base) * Math.min(1, f / 0.68);
    const levels = [0, 0.12, 0.26, 0.4, 0.54, 0.68, 0.85, 1];
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let k = 1; k < levels.length; k++) {
      const f0 = levels[k - 1], f1 = levels[k], w0 = half(f0), w1 = half(f1), y0 = y + f0 * h, y1 = y + f1 * h;
      for (let c = 0; c < 4; c++) {
        const [x, z] = corners[c], [x2, z2] = corners[(c + 1) % 4];
        details.tube(P(x * w0, z * w0, y0), P(x * w1, z * w1, y1), 0.09, STEEL, 4);
        // One diagonal per face and level, alternating, and the horizontal ring.
        if (k % 2) details.tube(P(x * w0, z * w0, y0), P(x2 * w1, z2 * w1, y1), 0.04, STEEL_DARK, 3);
        else details.tube(P(x2 * w0, z2 * w0, y0), P(x * w1, z * w1, y1), 0.04, STEEL_DARK, 3);
        details.tube(P(x * w1, z * w1, y1), P(x2 * w1, z2 * w1, y1), 0.04, STEEL_DARK, 3);
      }
    }
    // Earth wire peak.
    details.tube(P(0, 0, y + h), P(0, 0, y + h + 2.5), 0.07, STEEL, 3);
    for (const fy of [...new Set(slots.map(([, f]) => f))]) {
      const reach = Math.max(...slots.filter(([, f]) => f === fy).map(([x]) => Math.abs(x)));
      const w = half(fy), yy = y + fy * h;
      for (const side of [-1, 1]) {
        if (!slots.some(([x, f]) => f === fy && Math.sign(x) === side)) continue;
        for (const z of [-1, 1]) {
          details.tube(P(side * w, z * w, yy), P(side * reach, 0, yy), 0.06, STEEL, 3);
          details.tube(P(side * w, z * w, yy + h * 0.06), P(side * reach, 0, yy), 0.04, STEEL_DARK, 3);
        }
      }
    }
    for (const [x, f] of slots) details.tube(P(x, 0, y + f * h), P(x, 0, y + f * h - 2.6), 0.13, INSULATOR, 5);
    // Leg footings in the collision layer.
    for (const [x, z] of corners) details.solid(P(x * base, z * base, y - 0.5), 0.8, 0.8, 2.5, ae, an);
    stats.pylons++;
  };
  const pole = (s: Support, conc: boolean) => {
    const { e, n, y, ae, an, h } = s;
    details.cylinder(e, n, y, conc ? 0.16 : 0.13, h, conc ? CONCRETE : WOOD, 6, conc ? 0.09 : 0.11);
    details.tube([e - ae * 0.9, n - an * 0.9, y + h - 0.6], [e + ae * 0.9, n + an * 0.9, y + h - 0.6], 0.05, STEEL_DARK, 3);
    for (const x of [-0.8, 0.8]) details.tube([e + ae * x, n + an * x, y + h - 0.55], [e + ae * x, n + an * x, y + h - 0.2], 0.05, INSULATOR, 4);
    details.solid([e, n, y - 0.3], 0.35, 0.35, 2.3, ae, an);
    stats.poles++;
  };

  for (const w of lines) {
    const minor = w.tags.power === 'minor_line';
    const cables = Number(w.tags.cables) || (minor ? 3 : 6);
    const sup: Support[] = w.pts.map((p, i) => {
      const t = nodeTags.get(w.ids[i]);
      const isPole = minor || t?.power === 'pole';
      const tagged = Number(t?.height);
      const h = Number.isFinite(tagged) && tagged > 4 ? tagged : isPole ? (minor ? 9 : 14) : pylonHeight(w.tags.voltage);
      const [ae, an] = acrossAt(w.pts, i);
      const [e, n] = clearOfRoads(p[0], p[1], ae, an, footings(h, isPole), onRoad);
      if (e !== p[0] || n !== p[1]) {
        stats.moved++;
        stats.spots.push({ kind: 'mast-verschoben', e, n, note: `${Math.hypot(e - p[0], n - p[1]).toFixed(0)} m von der Fahrbahn weg (OSM ${w.ids[i]})` });
      }
      return { e, n, y: height(e, n), ae, an, h, pole: isPole };
    });
    const slotsOf = (s: Support): [number, number][] =>
      s.pole ? (minor ? [[-0.8, 1], [0.8, 1], [0, 1.02]] : [[-1.6, 0.92], [1.6, 0.92], [-1, 0.8], [1, 0.8]]) : pylonSlots(cables, s.h);
    sup.forEach((s, i) => {
      if (!Number.isFinite(s.y)) return;
      // A support shared by two lines is drawn once; portals at a substation get the line's pylon too.
      if (done.has(w.ids[i])) return;
      done.add(w.ids[i]);
      if (s.pole) pole(s, (nodeTags.get(w.ids[i])?.material ?? 'concrete') !== 'wood' && !minor);
      else pylon(s, slotsOf(s));
      if (!s.pole && stats.pylons % 25 === 1) stats.spots.push({ kind: 'strommast', e: s.e, n: s.n, note: `${s.h.toFixed(0)} m, ${w.tags.voltage ?? '?'} V` });
    });
    // Conductors between neighbouring supports, sagging (parabola), earth wire on pylon peaks.
    for (let i = 1; i < sup.length; i++) {
      const a = sup[i - 1], b = sup[i];
      const span = Math.hypot(b.e - a.e, b.n - a.n);
      if (span < 2 || span > 700 || !Number.isFinite(a.y + b.y)) continue;
      const sa = slotsOf(a), sb = slotsOf(b);
      const pairs: [P3, P3][] = [];
      for (let k = 0; k < Math.min(sa.length, sb.length); k++) {
        const hangA = a.pole ? 0.05 : 2.6, hangB = b.pole ? 0.05 : 2.6;
        pairs.push([
          [a.e + a.ae * sa[k][0], a.n + a.an * sa[k][0], a.y + sa[k][1] * a.h - hangA],
          [b.e + b.ae * sb[k][0], b.n + b.an * sb[k][0], b.y + sb[k][1] * b.h - hangB],
        ]);
      }
      if (!a.pole && !b.pole) pairs.push([[a.e, a.n, a.y + a.h + 2.5], [b.e, b.n, b.y + b.h + 2.5]]);
      const segs = Math.max(2, Math.ceil(span / (minor ? 10 : 15)));
      const mid = height((a.e + b.e) / 2, (a.n + b.n) / 2) || Math.min(a.y, b.y);
      for (const [p, q] of pairs) {
        // Sag about 3 % of the span, less where the ground under the middle comes close.
        const sag = Math.max(0.2, Math.min(span * (minor ? 0.015 : 0.03), (p[2] + q[2]) / 2 - mid - (minor ? 5 : 9)));
        let prev = p;
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const cur: P3 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t - 4 * sag * t * (1 - t)];
          details.tube(prev, cur, minor ? 0.025 : 0.045, CONDUCTOR, 3);
          prev = cur;
        }
      }
      stats.spans++;
    }
  }

  // Lone transformers (not on a line pole or in a substation): a compact substation kiosk.
  const subs = (osm.extra?.areas ?? []).filter((a) => a.tags.power === 'substation' && a.tags.location !== 'indoor');
  const inSub = (e: number, n: number) => subs.some((s) => inside(s.outer, e, n));
  const poleAt = new Set(lines.flatMap((w) => w.ids));
  for (const p of osm.points) {
    if (p.tags.power !== 'transformer' || poleAt.has(p.id) || inSub(p.e, p.n)) continue;
    const y = height(p.e, p.n);
    if (!Number.isFinite(y)) continue;
    details.box(p.e, p.n, y - 0.2, 1, 0, 2.6, 2, 2.5, KIOSK, KIOSK_ROOF);
    details.solid([p.e, p.n, y - 0.2], 2.6, 2, 2.5, 0, -1);
    stats.kiosks++;
  }

  // Substations: transformer bays with a gantry each, on a grid inside the outline.
  for (const s of subs) {
    const box = bounds(s);
    const area = Math.abs(ringArea(s.outer));
    if (area < 60 || s.tags.substation === 'minor_distribution') continue;
    stats.substations++;
    stats.spots.push({ kind: 'umspannwerk', e: (box[0] + box[2]) / 2, n: (box[1] + box[3]) / 2, note: `${Math.round(area)} m²${s.tags.name ? `, ${s.tags.name}` : ''}` });
    const step = area > 2000 ? 16 : 8;
    for (let e = box[0] + step / 2; e < box[2]; e += step)
      for (let n = box[1] + step / 2; n < box[3]; n += step) {
        if (![[-3, -3], [3, -3], [3, 3], [-3, 3]].every(([x, z]) => inside(s.outer, e + x, n + z))) continue;
        const y = height(e, n);
        if (!Number.isFinite(y)) continue;
        details.box(e, n, y, 1, 0, 3.2, 2.4, 2.8, TRAFO);
        details.solid([e, n, y], 3.2, 2.4, 2.8, 0, -1);
        if (step > 8 && Math.round((e - box[0]) / step + (n - box[1]) / step) % 2 === 0) {
          // Gantry over every other bay: two posts and a beam, with bushings on the transformer.
          for (const x of [-3.5, 3.5]) details.tube([e + x, n, y], [e + x, n, y + 9], 0.12, STEEL_DARK, 4);
          details.tube([e - 3.5, n, y + 9], [e + 3.5, n, y + 9], 0.1, STEEL_DARK, 4);
          for (const x of [-1, 0, 1]) details.tube([e + x, n, y + 2.8], [e + x, n, y + 4.2], 0.12, INSULATOR, 5);
        }
      }
  }

  // Ground-mounted solar: south-facing tables in east-west rows, 2.4 m deep, tilted 25°.
  const solar = (osm.extra?.areas ?? []).filter((a) => (a.tags.power === 'generator' && a.tags['generator:source'] === 'solar') || (a.tags.power === 'plant' && a.tags['plant:source'] === 'solar'));
  const solarDone: Polygon[] = [];
  for (const s of solar) {
    const box = bounds(s);
    if (solarDone.some((o) => inside(o.outer, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2))) continue;
    solarDone.push(s);
    const area = Math.abs(ringArea(s.outer));
    if (area < 150) continue;
    stats.spots.push({ kind: 'solarpark', e: (box[0] + box[2]) / 2, n: (box[1] + box[3]) / 2, note: `${(area / 10000).toFixed(1)} ha` });
    const depth = 2.4, tilt = (25 * Math.PI) / 180, rise = depth * Math.sin(tilt), run = depth * Math.cos(tilt);
    for (let n = box[1] + 3; n < box[3] - 2; n += 6.5) {
      // Row spans: where the row line lies inside the outline.
      for (const [e0, e1] of spans(s.outer, n)) {
        stats.solarRows++;
        for (let e = e0 + 1; e < e1 - 1; e += 4) {
          const e2 = Math.min(e + 4, e1 - 1);
          const ya = height(e, n), yb = height(e2, n);
          if (!Number.isFinite(ya + yb)) continue;
          const lo = 0.8, hi = lo + rise;
          // Low edge to the south (n - run/2), high edge to the north.
          const pa: P3 = [e, n - run / 2, ya + lo], pb: P3 = [e2, n - run / 2, yb + lo], pc: P3 = [e2, n + run / 2, yb + hi], pd: P3 = [e, n + run / 2, ya + hi];
          details.quadUp(pa, pb, pc, pd, PANEL);
          details.quadDown(pa, pb, pc, pd, PANEL_BACK);
          details.tube([e + 0.2, n + run / 2 - 0.1, ya], [e + 0.2, n + run / 2 - 0.1, ya + hi], 0.04, PANEL_FRAME, 3);
          details.tube([e + 0.2, n - run / 2 + 0.1, ya], [e + 0.2, n - run / 2 + 0.1, ya + lo], 0.04, PANEL_FRAME, 3);
        }
      }
    }
  }
  return stats;
}

function bounds(p: Polygon): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [e, n] of p.outer) { a = Math.min(a, e); b = Math.min(b, n); c = Math.max(c, e); d = Math.max(d, n); }
  return [a, b, c, d];
}

function ringArea(r: [number, number][]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return s / 2;
}

/** Inside spans of a ring along the east-west line at n (sorted [e0, e1] pairs). */
function spans(r: [number, number][], n: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > n !== yj > n) xs.push(xi + ((n - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

