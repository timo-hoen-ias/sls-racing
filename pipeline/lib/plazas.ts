// Flat plazas. The laser terrain (DGM1) has centimetre-to-decimetre noise and small measuring errors: on a
// paved square such as the Großer Markt it shows as dips and humps the car rocks over. Real squares and car
// parks are paved as one even plane, so each one (touching ones together) gets a plane fitted robustly to the
// terrain inside it, and the terrain there takes the plane's height. Around the edge the plane blends back
// into the measured terrain. Applied to the terrain height itself, so roads, buildings and paths on and
// around a square all see the same flat surface.
import { pointInPolygon, type Polygon } from './osm.ts';

/** Width (m) beyond the plaza outline over which the plane blends back into the measured terrain. */
export const PLAZA_BLEND = 8;
/** Plane fit samples every this many metres inside the outline. */
const FIT_STEP = 2;
/** A plaza may tilt at most this much (rise per metre); steeper fits are terraces or slopes, left as they are. */
const MAX_TILT = 0.06;
/** After the fit, the terrain may stray this far (m, RMS of the kept samples) or the area is not one plane. */
const MAX_RMS = 0.35;
/** Plazas smaller than this (m²) are not worth a plane; larger than this are fields, not squares. */
const MIN_AREA = 150, MAX_AREA = 60_000;
/** Outlines more elongated than this (4πA/P², 1 for a circle) are streets drawn as areas, which the road profiles smooth. */
const MIN_COMPACT = 0.18;
const CELL = 64;

/** Squares, pedestrian areas and surface car parks: paved as one plane. */
export function isPlaza(tags: Record<string, string>): boolean {
  if (tags.place === 'square' || tags.amenity === 'marketplace') return true;
  if (tags.highway === 'pedestrian' && tags.area === 'yes') return true;
  if (tags['area:highway'] === 'pedestrian') return true;
  if (tags.amenity === 'parking') return !tags.parking || tags.parking === 'surface';
  return false;
}

export interface Plaza {
  /** Plane: height at (e0, n0) plus grade per metre east and north. */
  e0: number; n0: number; y0: number; ge: number; gn: number;
  polys: Polygon[];
  /** Bounding box of the outlines (UTM). */
  x0: number; y0b: number; x1: number; y1: number;
  rms: number;
  area: number;
  name: string;
}

const ringArea = (r: [number, number][]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a) / 2;
};
const ringLength = (r: [number, number][]) => {
  let l = 0;
  for (let i = 1; i < r.length; i++) l += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
  return l;
};
const bbox = (r: [number, number][]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [e, n] of r) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
  return { x0, y0, x1, y1 };
};
/** Distance from a point to the outline of a ring. */
function ringDist(e: number, n: number, r: [number, number][]) {
  let best = Infinity;
  for (let i = 1; i < r.length; i++) {
    const [ax, ay] = r[i - 1], [bx, by] = r[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(e - ax - dx * t, n - ay - dy * t));
  }
  return best;
}

/** Least squares plane y = a + b (e - e0) + c (n - n0) through samples, with weights 0/1. */
function fitPlane(s: { e: number; n: number; y: number }[], keep: boolean[], e0: number, n0: number) {
  let S = 0, Se = 0, Sn = 0, Sy = 0, See = 0, Snn = 0, Sen = 0, Sey = 0, Sny = 0;
  s.forEach((p, i) => {
    if (!keep[i]) return;
    const e = p.e - e0, n = p.n - n0;
    S++; Se += e; Sn += n; Sy += p.y; See += e * e; Snn += n * n; Sen += e * n; Sey += e * p.y; Sny += n * p.y;
  });
  // Solve the 3 × 3 normal equations (Cramer's rule).
  const m = [[S, Se, Sn], [Se, See, Sen], [Sn, Sen, Snn]], v = [Sy, Sey, Sny];
  const det3 = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const D = det3(m);
  if (!S || Math.abs(D) < 1e-9) return { a: S ? Sy / S : 0, b: 0, c: 0 };
  const col = (k: number) => m.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)));
  return { a: det3(col(0)) / D, b: det3(col(1)) / D, c: det3(col(2)) / D };
}

export interface PlazaReport { plazas: number; polygons: number; skipped: number; maxRms: number }

/**
 * Finds the plazas among the polygons, fits a plane to each group of touching ones and returns them, with a
 * lookup for the flattened height. `raw` is the measured terrain.
 */
export function planPlazas(polygons: Polygon[], raw: (e: number, n: number) => number) {
  const cands = polygons.filter((p) => {
    if (!isPlaza(p.tags) || p.outer.length < 4) return false;
    const a = ringArea(p.outer) - p.holes.reduce((s, h) => s + ringArea(h), 0);
    if (a < MIN_AREA || a > MAX_AREA) return false;
    return (4 * Math.PI * a) / ringLength(p.outer) ** 2 >= MIN_COMPACT;
  });
  // Group outlines that touch or overlap (within 1.5 m): one paved surface, one plane.
  const boxes = cands.map((p) => bbox(p.outer));
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (i: number, j: number) => {
    const a = boxes[i], b = boxes[j];
    if (a.x0 > b.x1 + 1.5 || b.x0 > a.x1 + 1.5 || a.y0 > b.y1 + 1.5 || b.y0 > a.y1 + 1.5) return false;
    const near = (p: Polygon, q: Polygon) => p.outer.some(([e, n]) => pointInPolygon(e, n, q) || ringDist(e, n, q.outer) < 1.5);
    return near(cands[i], cands[j]) || near(cands[j], cands[i]);
  };
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) if (touch(i, j)) parent[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  cands.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(i); });

  const plazas: Plaza[] = [];
  let skipped = 0, maxRms = 0;
  for (const members of groups.values()) {
    const polys = members.map((i) => cands[i]);
    const x0 = Math.min(...members.map((i) => boxes[i].x0)), x1 = Math.max(...members.map((i) => boxes[i].x1));
    const y0 = Math.min(...members.map((i) => boxes[i].y0)), y1 = Math.max(...members.map((i) => boxes[i].y1));
    const s: { e: number; n: number; y: number }[] = [];
    for (let e = x0 + FIT_STEP / 2; e < x1; e += FIT_STEP)
      for (let n = y0 + FIT_STEP / 2; n < y1; n += FIT_STEP)
        if (polys.some((p) => pointInPolygon(e, n, p))) s.push({ e, n, y: raw(e, n) });
    if (s.length < 12) { skipped++; continue; }
    const e0 = (x0 + x1) / 2, n0 = (y0 + y1) / 2;
    // Robust fit: drop samples far off the plane (kiosks, steps, measuring errors) and fit again.
    const keep = s.map(() => true);
    let f = fitPlane(s, keep, e0, n0), rms = 0;
    for (let it = 0; it < 3; it++) {
      const r = s.map((p) => p.y - (f.a + f.b * (p.e - e0) + f.c * (p.n - n0)));
      const abs = r.map(Math.abs).sort((a, b) => a - b);
      const lim = Math.max(0.1, 3 * 1.4826 * abs[abs.length >> 1]);
      r.forEach((v, i) => (keep[i] = Math.abs(v) <= lim));
      f = fitPlane(s, keep, e0, n0);
      const kept = r.filter((_, i) => keep[i]);
      rms = Math.sqrt(kept.reduce((a, v) => a + v * v, 0) / Math.max(1, kept.length));
    }
    if (Math.hypot(f.b, f.c) > MAX_TILT || rms > MAX_RMS) { skipped++; continue; }
    maxRms = Math.max(maxRms, rms);
    const area = polys.reduce((a, p) => a + ringArea(p.outer), 0);
    const name = polys.map((p) => p.tags.name).find((n) => n) ?? (polys.some((p) => p.tags.amenity === 'parking') ? 'Parkplatz' : 'Platz');
    plazas.push({ e0, n0, y0: f.a, ge: f.b, gn: f.c, polys, x0, y0b: y0, x1, y1, rms, area, name });
  }

  const cells = new Map<string, Plaza[]>();
  for (const p of plazas)
    for (let cx = Math.floor((p.x0 - PLAZA_BLEND) / CELL); cx <= Math.floor((p.x1 + PLAZA_BLEND) / CELL); cx++)
      for (let cy = Math.floor((p.y0b - PLAZA_BLEND) / CELL); cy <= Math.floor((p.y1 + PLAZA_BLEND) / CELL); cy++) {
        const k = `${cx}_${cy}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k)!.push(p);
      }

  /** Flattened terrain height: the plane inside a plaza, blended into `h` (the measured height) around it. */
  const apply = (e: number, n: number, h: number) => {
    const list = cells.get(`${Math.floor(e / CELL)}_${Math.floor(n / CELL)}`);
    if (!list) return h;
    let best = 0, y = h;
    for (const p of list) {
      if (e < p.x0 - PLAZA_BLEND || e > p.x1 + PLAZA_BLEND || n < p.y0b - PLAZA_BLEND || n > p.y1 + PLAZA_BLEND) continue;
      let w: number;
      if (p.polys.some((q) => pointInPolygon(e, n, q))) w = 1;
      else {
        const d = Math.min(...p.polys.map((q) => ringDist(e, n, q.outer)));
        if (d >= PLAZA_BLEND) continue;
        const t = 1 - d / PLAZA_BLEND;
        w = t * t * (3 - 2 * t);
      }
      if (w > best) { best = w; y = p.y0 + p.ge * (e - p.e0) + p.gn * (n - p.n0); }
    }
    return best ? h + (y - h) * best : h;
  };
  const report: PlazaReport = { plazas: plazas.length, polygons: plazas.reduce((a, p) => a + p.polys.length, 0), skipped, maxRms };
  return { plazas, apply, report };
}
