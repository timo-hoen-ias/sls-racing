// Street space widths from ALKIS "Tatsächliche Nutzung" (LVGL Saarland, dl-de/by-2-0).
// ALKIS Straßenverkehr areas cover the public street parcel from property line to property line: carriageway,
// sidewalks, parking strips and verges together. The open shapefile does not split off the carriageway, so
// the measured value is the street space; measuredWidth() derives a carriageway estimate from it for town
// streets only. The pipeline thread decides where roads.ts uses it.
import { existsSync, readFileSync } from 'node:fs';
import { readDerived } from './derived.ts';
import type { Way } from './osm.ts';
import { builtTunnel, isDrivable, ROAD_CLASSES } from './roads.ts';
import { roadSection } from '../../src/world/roadSpec.ts';

export const ALKIS_ATTRIBUTION = '© GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0';

export interface AlkisRoads {
  crs: 'EPSG:25832';
  attribution: string;
  /** Measured street space per OSM way id: median width in metres and the share of samples that hit ALKIS. */
  ways: Record<string, { street: number; hit: number }>;
}

export function readAlkisRoads(file: string): AlkisRoads | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AlkisRoads) : undefined;
}

/** ALKIS street widths of a region: fresh from data/raw, else the committed copy in data/derived. */
export const loadAlkisRoads = (region: string) => readDerived<AlkisRoads>(region, 'alkis-roads');

/** Street space (property line to property line) of a way in metres, if ALKIS measured it reliably. */
export function streetSpace(way: Way, data: AlkisRoads | undefined): number | undefined {
  const m = data?.ways[way.id];
  return m && m.hit >= 0.6 ? m.street : undefined;
}

/**
 * Carriageway width estimate in metres for town streets (classes with sidewalks), else undefined:
 * street space minus two sidewalks of 20 % each (1.5 to 3.5 m), kept within 75 to 150 % of the OSM width,
 * so a wrong match can never produce a road narrower than a car or a square-wide road.
 */
export function measuredWidth(way: Way, data: AlkisRoads | undefined): number | undefined {
  const cls = ROAD_CLASSES[way.tags.highway];
  // Against the mapped (1:1) width: the game profile widens the result afterwards.
  const osm = roadSection(way.tags, 'real')?.width;
  const street = streetSpace(way, data);
  if (!cls?.street || !osm || !street || way.tags.bridge || way.tags.tunnel) return undefined;
  const sidewalk = Math.min(3.5, Math.max(1.5, street * 0.2));
  const w = street - 2 * sidewalk;
  return Math.round(Math.min(osm * 1.5, Math.max(osm * 0.75, w)) * 10) / 10;
}

/** Street space polygons as rings in UTM, with a coarse grid for point-in-polygon tests. */
export class StreetArea {
  private grid = new Map<string, number[]>();
  private polys: { rings: [number, number][][]; bbox: [number, number, number, number] }[];
  private cell: number;
  constructor(polys: { rings: [number, number][][]; bbox: [number, number, number, number] }[], cell = 50) {
    this.polys = polys;
    this.cell = cell;
    polys.forEach((p, i) => {
      for (let x = Math.floor(p.bbox[0] / cell); x <= Math.floor(p.bbox[2] / cell); x++)
        for (let y = Math.floor(p.bbox[1] / cell); y <= Math.floor(p.bbox[3] / cell); y++) {
          const k = `${x}_${y}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k)!.push(i);
        }
    });
  }

  has(e: number, n: number) {
    for (const i of this.grid.get(`${Math.floor(e / this.cell)}_${Math.floor(n / this.cell)}`) ?? []) {
      const p = this.polys[i];
      if (e < p.bbox[0] || e > p.bbox[2] || n < p.bbox[1] || n > p.bbox[3]) continue;
      // Even-odd over all rings handles holes.
      let inside = false;
      for (const r of p.rings)
        for (let a = 0, b = r.length - 1; a < r.length; b = a++)
          if (r[a][1] > n !== r[b][1] > n && e < ((r[b][0] - r[a][0]) * (n - r[a][1])) / (r[b][1] - r[a][1]) + r[a][0]) inside = !inside;
      if (inside) return true;
    }
    return false;
  }
}

/**
 * Measures the street space across every drivable way: every 8 m, away from the way's ends (junctions),
 * walk left and right in 0.25 m steps until leaving the street area. Samples wider than 40 m are squares or
 * junction mouths and are skipped.
 */
export function measureStreets(ways: Way[], area: StreetArea): AlkisRoads['ways'] {
  const out: AlkisRoads['ways'] = {};
  const reach = (e: number, n: number, de: number, dn: number) => {
    for (let d = 0.25; d <= 25; d += 0.25) if (!area.has(e + de * d, n + dn * d)) return d - 0.125;
    return Infinity;
  };
  for (const w of ways) {
    if (!isDrivable(w.tags)) continue;
    const widths: number[] = [];
    let samples = 0;
    let along = 0;
    let total = 0;
    for (let i = 1; i < w.pts.length; i++) total += Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
    for (let i = 1; i < w.pts.length; i++) {
      const [ae, an] = w.pts[i - 1], [be, bn] = w.pts[i];
      const len = Math.hypot(be - ae, bn - an);
      if (!len) continue;
      const te = (be - ae) / len, tn = (bn - an) / len;
      for (let s = (8 - (along % 8)) % 8; s < len; s += 8) {
        const pos = along + s;
        if (pos < 12 || pos > total - 12) continue;
        samples++;
        const e = ae + te * s, n = an + tn * s;
        if (!area.has(e, n)) continue;
        const width = reach(e, n, tn, -te) + reach(e, n, -tn, te);
        if (width <= 40) widths.push(width);
      }
      along += len;
    }
    if (widths.length < 2) continue;
    widths.sort((a, b) => a - b);
    out[w.id] = { street: Math.round(widths[widths.length >> 1] * 10) / 10, hit: Math.round((widths.length / samples) * 100) / 100 };
  }
  return out;
}

/**
 * Uses the measured carriageway width for every town street without a `width` tag, by setting the tag, so
 * every later step (road sections, overlap, graph, game) sees the same width. Returns how many changed.
 */
export function applyMeasuredWidths(ways: Way[], data: AlkisRoads | undefined): number {
  const measured = ways.flatMap((w) => {
    if (!isDrivable(w.tags) || w.tags.width) return [];
    const m = measuredWidth(w, data);
    return m ? [[w, m] as const] : [];
  });
  for (const [w, m] of measured) w.tags.width = String(m);
  // ALKIS has no carriageway in a tunnel: the tube takes the widest measured approach, so the road outside never
  // reaches into its walls. Twice, so the inner ways of a chain get it too.
  const ends = new Map<number, Way[]>();
  for (const w of ways) if (isDrivable(w.tags)) for (const id of [w.ids[0], w.ids[w.ids.length - 1]]) ends.set(id, [...(ends.get(id) ?? []), w]);
  const unmeasured = ways.filter((w) => builtTunnel(w.tags) && !w.tags.width);
  for (let pass = 0; pass < 2; pass++)
    for (const w of unmeasured) {
      const own = roadSection(w.tags)?.width ?? 0;
      const near = [w.ids[0], w.ids[w.ids.length - 1]].flatMap((id) => ends.get(id) ?? []).filter((o) => o !== w && o.tags.width && o.tags.highway === w.tags.highway);
      const widest = Math.max(0, ...near.map((o) => parseFloat(o.tags.width)));
      if (widest > own) w.tags.width = String(widest);
    }
  // Street space between the houses, for the game road profile (wider carriageways, narrower sidewalks).
  for (const w of ways) {
    if (!isDrivable(w.tags) || w.tags.bridge || w.tags.tunnel || !ROAD_CLASSES[w.tags.highway]?.street) continue;
    const street = streetSpace(w, data);
    if (street) w.tags['sls:street'] = String(Math.round(street * 10) / 10);
  }
  return measured.length;
}
