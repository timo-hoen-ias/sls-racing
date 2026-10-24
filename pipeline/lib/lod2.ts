// LoD2 building models of the LVGL Saarland (CityGML 1.0, one file per km tile, UTM 32N, heights NHN like
// DGM1): every building with its real footprint, wall and roof surfaces, from laser scan and cadastre.
// fetch.ts stores the tiles deflated in data/raw/lod2/. Licence dl-de/by-2-0, "© GeoBasis DE/LVGL-SL (2025)".
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export const LOD2_ATTRIBUTION = 'Gebäude: LoD2 © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0';

/** A planar surface: outer ring and holes, each a flat [e, n, h, e, n, h, …] list without the closing point. */
export interface Surface { outer: number[]; holes: number[][] }

export interface Lod2Building {
  id: string;
  /** ALKIS building function, e.g. "31001_1000" (Wohnhaus). */
  fn: string;
  /** ALKIS roof type code (1000 flat, 3100 gable, 3200 hip, …). */
  roofType: number;
  walls: Surface[];
  roofs: Surface[];
  /** Footprint (UTM) from the ground surfaces, for matching OSM buildings. */
  ground: [number, number][][];
  /** Lowest point, the ground level of the building (m NHN). */
  base: number;
  top: number;
}

const ring = (posList: string) => {
  const v = posList.trim().split(/\s+/).map(Number);
  // Rings are closed: drop the repeated first point.
  if (v.length >= 6 && v[0] === v[v.length - 3] && v[1] === v[v.length - 2] && v[2] === v[v.length - 1]) v.length -= 3;
  return v;
};

function surfaces(xml: string, tag: string): Surface[] {
  const out: Surface[] = [];
  const re = new RegExp(`<bldg:${tag}[ >][\\s\\S]*?</bldg:${tag}>`, 'g');
  for (const m of xml.matchAll(re)) {
    for (const poly of m[0].matchAll(/<gml:Polygon[\s\S]*?<\/gml:Polygon>/g)) {
      const rings = [...poly[0].matchAll(/<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([^<]*)<\/gml:posList>/g)];
      const outer = rings.find((r) => r[1] === 'exterior');
      if (!outer) continue;
      const o = ring(outer[2]);
      if (o.length >= 9) out.push({ outer: o, holes: rings.filter((r) => r[1] === 'interior').map((r) => ring(r[2])).filter((h) => h.length >= 9) });
    }
  }
  return out;
}

/** All buildings of one CityGML tile (BuildingParts merged into their building). */
export function parseLod2(xml: string): Lod2Building[] {
  const out: Lod2Building[] = [];
  const starts = [...xml.matchAll(/<bldg:Building gml:id="([^"]+)"/g)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index! : xml.length;
    const body = xml.slice(m.index!, end);
    const walls = surfaces(body, 'WallSurface');
    const roofs = surfaces(body, 'RoofSurface');
    const grounds = surfaces(body, 'GroundSurface');
    if (!walls.length || !roofs.length) return;
    let base = Infinity, top = -Infinity;
    for (const s of [...walls, ...roofs]) for (let k = 2; k < s.outer.length; k += 3) { base = Math.min(base, s.outer[k]); top = Math.max(top, s.outer[k]); }
    out.push({
      id: m[1],
      fn: /<bldg:function>([^<]+)</.exec(body)?.[1] ?? '',
      roofType: Number(/<bldg:roofType>([^<]+)</.exec(body)?.[1] ?? 0),
      walls, roofs,
      ground: grounds.map((g) => {
        const r: [number, number][] = [];
        for (let k = 0; k < g.outer.length; k += 3) r.push([g.outer[k], g.outer[k + 1]]);
        return r;
      }),
      base, top,
    });
  });
  return out;
}

export const lod2TileCount = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.gml.deflate')).length : 0);

/** Every LoD2 building stored for a region (data/raw/lod2/), tile by tile. */
export function* lod2Buildings(dir: string): Generator<Lod2Building> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.gml.deflate')).sort())
    yield* parseLod2(inflateRawSync(readFileSync(`${dir}${f}`)).toString('utf8'));
}

/**
 * OSM-style building tags for an ALKIS building function, so façades and heights pick the same kinds as
 * for OSM buildings. Codes: 31001_1xxx housing, 31001_2xxx trade and industry, 31001_3xxx public.
 */
export function lod2Tags(fn: string): Record<string, string> {
  const [group, code] = fn.split('_');
  const c = Number(code);
  if (group !== '31001') return { building: 'roof' };
  if (c >= 2460 && c < 2470) return { building: 'garage' };
  if (c >= 1000 && c < 2000) return { building: c === 1000 || c === 1010 ? 'house' : 'residential' };
  if (c >= 2000 && c < 3000) return { building: c >= 2100 && c < 2200 ? 'office' : c >= 2050 && c < 2100 ? 'retail' : c >= 2500 ? 'industrial' : 'commercial' };
  if (c >= 3000 && c < 4000) return { building: c >= 3040 && c < 3050 ? 'church' : c >= 3020 && c < 3030 ? 'school' : 'public' };
  return { building: 'yes' };
}

/** Kinds of LoD2 objects the game builds itself: bridges and other traffic structures (roads.ts decks). */
export const isTrafficStructure = (b: Lod2Building) => b.fn.startsWith('53');

/** LoD2 footprints with a grid, to find the OSM buildings they replace. */
export class Footprints {
  private cells = new Map<string, number[]>();
  private rings: [number, number][][] = [];
  private centres: [number, number][] = [];
  add(rings: [number, number][][]) {
    let ce = 0, cn = 0, k = 0;
    for (const r of rings) {
      const i = this.rings.length;
      this.rings.push(r);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [e, n] of r) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); ce += e; cn += n; k++; }
      for (let x = Math.floor(x0 / 32); x <= Math.floor(x1 / 32); x++)
        for (let y = Math.floor(y0 / 32); y <= Math.floor(y1 / 32); y++) {
          const key = `${x}_${y}`;
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key)!.push(i);
        }
    }
    if (k) this.centres.push([ce / k, cn / k]);
  }
  get size() { return this.centres.length; }
  /** Whether (e, n) lies inside any footprint. */
  contains(e: number, n: number) {
    return (this.cells.get(`${Math.floor(e / 32)}_${Math.floor(n / 32)}`) ?? []).some((i) => inRing(this.rings[i], e, n));
  }
  /** Whether an OSM outline stands for a building LoD2 already has: its centre in a footprint, or a footprint's centre in it. */
  covers(outer: [number, number][]) {
    let ce = 0, cn = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of outer) { ce += e / outer.length; cn += n / outer.length; x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    if (this.contains(ce, cn)) return true;
    for (let x = Math.floor(x0 / 32); x <= Math.floor(x1 / 32); x++)
      for (let y = Math.floor(y0 / 32); y <= Math.floor(y1 / 32); y++)
        for (const i of this.cells.get(`${x}_${y}`) ?? []) {
          const r = this.rings[i];
          // A vertex of the footprint well inside the outline means they overlap substantially.
          let fe = 0, fn = 0;
          for (const [e, n] of r) { fe += e / r.length; fn += n / r.length; }
          if (inRing(outer, fe, fn)) return true;
        }
    return false;
  }
}

function inRing(r: [number, number][], e: number, n: number) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > n) !== (r[j][1] > n) && e < ((r[j][0] - r[i][0]) * (n - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  return inside;
}
