// Land cover of the ground from the LVGL TrueDOP20 aerial survey (colour + near infrared, 20 cm), ALKIS
// "Tatsächliche Nutzung" (what the parcel is used for), ALKIS building outlines and the laser surface
// height above ground (DOM1 − DGM1). pipeline/landcover.ts classifies every 2 m cell once and stores the
// result per 2 km survey tile in data/derived/<region>/landcover/ (committed); world:build reads it here.
//
// The rules, from looking at the survey over Saarlouis, the Lisdorfer Au and the Saaraue:
// - Vegetation shows as a high NDVI (near infrared − red); bare soil, asphalt and roofs stay low.
// - Something more than 2.5 m above the terrain with vegetation is a tree crown; the ground under it is
//   forest floor in woods, grass with leaf litter in gardens and parks (the photo only shows the crown).
// - What a low-NDVI cell is depends on the parcel: in fields it is ploughed soil, in yards asphalt or
//   concrete, on the railway ballast, on sports grounds red clay, in parks and cemeteries gravel paths.
// - Fields are green crops, ripe or stubble (yellowish, mid NDVI) or bare soil; Gartenbauland is the
//   vegetable growing of the Lisdorfer Au with its rows.
// Licence of the inputs: dl-de/by-2-0, © GeoBasis DE/LVGL-SL (2025).
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { derivedDir } from './derived.ts';
import { COVER_LOOK, Cover, GROUND_LOOK, SPLAT, SPLAT_AERIAL_REF, type CoverClass, lookWeights } from '../../src/world/coverKinds.ts';
import { TERRAIN_N, TERRAIN_STEP } from '../../src/world/format.ts';

export { Cover, COVER_NAMES, type CoverClass } from '../../src/world/coverKinds.ts';

export const LANDCOVER_ATTRIBUTION = 'Bodenbedeckung: TrueDOP20, ALKIS, DOM1/DGM1 © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0';

/** ALKIS use of a parcel, condensed (raster value 0 = no ALKIS data). */
export const Use = {
  none: 0, residential: 1, mixed: 2, industry: 3, public: 4, leisure: 5, park: 6, sports: 7, cemetery: 8,
  arable: 9, grassland: 10, market: 11, orchard: 12, forestBroad: 13, forestNeedle: 14, forest: 15, copse: 16,
  heath: 17, swamp: 18, bare: 19, water: 20, street: 21, verge: 22, path: 23, square: 24, rail: 25, airfield: 26,
  quarry: 27, parking: 28,
} as const;
export type UseClass = (typeof Use)[keyof typeof Use];

/** ALKIS NUTZART/BEZ → Use. */
export function alkisUse(nutzart: string, bez: string): UseClass {
  switch (nutzart) {
    case 'Wohnbaufläche': return Use.residential;
    case 'Fläche gemischter Nutzung': return Use.mixed;
    case 'Industrie- und Gewerbefläche': return bez === 'Parken' ? Use.parking : Use.industry;
    case 'Fläche besonderer funktionaler Prägung': return bez === 'Parken' ? Use.parking : bez === 'Historische Anlage' ? Use.park : Use.public;
    case 'Sport-, Freizeit- und Erholungsfläche':
      if (bez === 'Sportanlage' || bez === 'Schwimmen') return Use.sports;
      if (bez === 'Grünanlage' || bez === 'Erholungsfläche') return Use.park;
      return bez === 'Parken' ? Use.parking : Use.leisure;
    case 'Friedhof': return Use.cemetery;
    case 'Landwirtschaft':
      if (bez === 'Ackerland' || bez === 'Spargel' || bez === 'Brachland') return Use.arable;
      if (bez === 'Gartenbauland') return Use.market;
      if (bez === 'Obst- und Nussplantage' || bez === 'Streuobstwiese' || bez === 'Baumschule' || bez === 'Rebfläche') return Use.orchard;
      if (bez === 'Nadelholz') return Use.forestNeedle;
      return Use.grassland;
    case 'Wald': return bez === 'Laubholz' ? Use.forestBroad : bez === 'Nadelholz' ? Use.forestNeedle : Use.forest;
    case 'Gehölz': return Use.copse;
    case 'Heide': return Use.heath;
    case 'Sumpf': return Use.swamp;
    case 'Unland/Vegetationslose Fläche': return Use.bare;
    case 'Fliessgewässer': case 'Stehendes Gewässer': case 'Hafenbecken': return Use.water;
    case 'Strassenverkehr': return bez === 'Begleitfläche Straßenverkehr' ? Use.verge : Use.street;
    case 'Weg': return Use.path;
    case 'Platz': return bez === 'Parkplatz' ? Use.parking : Use.square;
    case 'Bahnverkehr': return Use.rail;
    case 'Flugverkehr': return Use.airfield;
    case 'Halde': case 'Tagebau, Grube, Steinbruch': return Use.quarry;
    default: return Use.none;
  }
}

const BUILT = new Set<number>([Use.residential, Use.mixed, Use.industry, Use.public, Use.leisure, Use.parking, Use.square, Use.street, Use.path, Use.airfield]);
const FOREST = new Set<number>([Use.forestBroad, Use.forestNeedle, Use.forest]);

export interface CellInput {
  use: UseClass;
  /** Inside an ALKIS building outline. */
  building: boolean;
  /** Mean of the 2 m cell, 0..255. */
  r: number; g: number; b: number; nir: number;
  /** Surface above the terrain in metres (DOM1 − DGM1), NaN where unknown. */
  ndsm: number;
}

/** Normalised difference vegetation index of a cell. */
export const ndviOf = (r: number, nir: number) => (nir - r) / (nir + r + 1);

/** The land cover rule set (see the header). */
export function classify(c: CellInput): CoverClass {
  const v = ndviOf(c.r, c.nir);
  const lum = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  const sat = max > 0 ? (max - min) / max : 0;
  const high = c.ndsm > 2.5;
  // The survey's NDVI tops out near 0.5 (lawn 0.3–0.5, dry grass and stubble 0.15–0.3, soil and asphalt < 0.1).
  const veg = v > 0.27, sparse = v > 0.12;
  const u = c.use;
  if (c.building && (Number.isNaN(c.ndsm) || c.ndsm > 1.5)) return Cover.roof;
  if (u === Use.water) return v > 0.3 && !high ? Cover.wetland : Cover.water;
  // Tree crowns: the ground below.
  if (high && v > 0.2) {
    if (FOREST.has(u) || u === Use.copse) return Cover.forestFloor;
    if (u === Use.orchard) return Cover.orchard;
    return Cover.underTree;
  }
  // Brownish versus grey bare ground.
  const brown = c.r > c.b + 14 && sat > 0.12;
  const red = c.r > c.g * 1.25 && c.r > c.b * 1.4 && c.r > 90;
  const bareBuilt = (): CoverClass => (red && (u === Use.sports || u === Use.leisure) ? Cover.clay : brown ? Cover.gravel : Cover.paved);
  switch (u) {
    case Use.arable:
      if (v > 0.32) return Cover.cropGreen;
      if (sparse) return c.r >= c.g * 0.92 && lum > 95 ? Cover.cropRipe : Cover.cropGreen;
      return Cover.soil;
    case Use.market: return sparse ? Cover.vegRows : Cover.soil;
    case Use.grassland: return veg ? Cover.meadow : v > 0.08 ? Cover.dryGrass : Cover.soil;
    case Use.orchard: return veg ? Cover.orchard : sparse ? Cover.dryGrass : Cover.soil;
    case Use.forestBroad: case Use.forestNeedle: case Use.forest:
      return sparse ? Cover.forestFloor : brown ? Cover.soil : Cover.gravel;
    case Use.copse: return veg ? Cover.scrub : sparse ? Cover.meadow : Cover.soil;
    case Use.heath: return veg ? Cover.scrub : Cover.dryGrass;
    case Use.swamp: return Cover.wetland;
    case Use.bare: case Use.quarry: return veg ? Cover.meadow : sparse ? Cover.dryGrass : brown ? Cover.soil : Cover.gravel;
    case Use.rail: return veg ? Cover.meadow : sparse ? Cover.dryGrass : Cover.ballast;
    case Use.verge: return veg ? Cover.meadow : sparse ? Cover.dryGrass : Cover.gravel;
    case Use.park: case Use.cemetery:
      return veg ? Cover.lawn : sparse ? Cover.dryGrass : brown || lum > 120 ? Cover.gravel : Cover.paved;
    case Use.sports:
      // Artificial turf is green without the infrared of living grass.
      if (veg || (c.g > c.r * 1.1 && c.g > c.b * 1.1 && sat > 0.2)) return Cover.lawn;
      return sparse ? Cover.dryGrass : bareBuilt();
    default:
      if (BUILT.has(u)) return veg ? Cover.lawn : sparse ? Cover.dryGrass : bareBuilt();
      // No ALKIS: decide on colour alone.
      return veg ? Cover.meadow : sparse ? Cover.dryGrass : brown ? Cover.soil : Cover.paved;
  }
}

/** Cells whose colour shows shade or something on top, not the ground itself: filled from their neighbours. */
export function hidesGround(cls: CoverClass, lum: number): boolean {
  return cls === Cover.roof || cls === Cover.underTree || cls === Cover.forestFloor || cls === Cover.orchard || lum < 38;
}

/** Fills a polygon (even-odd over all rings) into a row-major grid; cell (c, r) centre at (e0 + (c + .5) s, n1 − (r + .5) s). */
export function rasterize(
  rings: [number, number][][], grid: Uint8Array, cols: number, rows: number, e0: number, n1: number, s: number, value: number,
) {
  let y0 = Infinity, y1 = -Infinity;
  for (const ring of rings) for (const [, n] of ring) { y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
  const r0 = Math.max(0, Math.floor((n1 - y1) / s - 0.5)), r1 = Math.min(rows - 1, Math.ceil((n1 - y0) / s - 0.5));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const y = n1 - (r + 0.5) * s;
    xs.length = 0;
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[j];
        if ((ay > y) !== (by > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - e0) / s - 0.5)), c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - e0) / s - 0.5));
      for (let c = c0; c <= c1; c++) grid[r * cols + c] = value;
    }
  }
}

/** Survey tile size (m) and the raster steps of the stored class and colour grids. */
export const LC_TILE = 2000;
export const LC_CLASS_STEP = 2;
export const LC_COLOUR_STEP = 4;

export const landcoverDir = (region: string) => `${derivedDir(region)}landcover/`;

/** Roof colour of one ALKIS building: centroid (UTM, m) and mean sRGB colour of its roof in the survey. */
export type RoofColour = [e: number, n: number, r: number, g: number, b: number];

export interface LandcoverFile {
  attribution: string;
  /** South-west corners (UTM, m) of the 2 km tiles that have rasters. */
  tiles: [number, number][];
  roofs: RoofColour[];
}

export interface Landcover {
  /** Cover class at a UTM position, Cover.none outside the survey. */
  classAt(e: number, n: number): CoverClass;
  /** Crop-row direction code at a UTM position: 1..255 for 0..180° from east towards north, 0 = none. */
  rowsAt(e: number, n: number): number;
  /** Ground colour (sRGB 0..255, shade and crowns filled in) at a UTM position, bilinear; undefined outside. */
  colourAt(e: number, n: number): [number, number, number] | undefined;
  /** Mean roof colour of the surveyed building whose centroid lies nearest to (e, n), within `max` metres. */
  roofAt(e: number, n: number, max?: number): [number, number, number] | undefined;
  tiles: number;
}

/** Reads the committed land cover rasters of a region; undefined when the region has none. */
export function loadLandcover(region: string): Landcover | undefined {
  const dir = landcoverDir(region);
  if (!existsSync(`${dir}index.json.gz`)) return undefined;
  const file: LandcoverFile = JSON.parse(gunzipSync(readFileSync(`${dir}index.json.gz`)).toString('utf8'));
  const known = new Set(file.tiles.map(([e, n]) => `${e / 1000}_${n / 1000}`));
  type Raster = { cls: Uint8Array; col: Uint8Array; rows?: Uint8Array } | null;
  const cache = new Map<number, Raster>();
  // The terrain asks for neighbouring points over and over: remember the last tile.
  let lastKey = NaN, last: Raster = null;
  const tile = (e0: number, n0: number) => {
    const nk = e0 * 1e4 + n0 / LC_TILE;
    if (nk === lastKey) return last;
    // Files are named by the south-west corner in km.
    const k = `${e0 / 1000}_${n0 / 1000}`;
    let t = cache.get(nk);
    if (t === undefined) {
      if (!known.has(k)) t = null;
      else {
        const cls = PNG.sync.read(readFileSync(`${dir}${k}.class.png`));
        const col = PNG.sync.read(readFileSync(`${dir}${k}.colour.png`));
        const c = new Uint8Array(cls.width * cls.height);
        for (let i = 0; i < c.length; i++) c[i] = cls.data[i * 4];
        let rows: Uint8Array | undefined;
        if (existsSync(`${dir}${k}.rows.png`)) {
          const rp = PNG.sync.read(readFileSync(`${dir}${k}.rows.png`));
          rows = new Uint8Array(c.length);
          for (let i = 0; i < c.length; i++) rows[i] = rp.data[i * 4];
        }
        t = { cls: c, col: col.data, rows };
      }
      cache.set(nk, t);
    }
    lastKey = nk;
    last = t;
    return t;
  };
  const N_CLS = LC_TILE / LC_CLASS_STEP, N_COL = LC_TILE / LC_COLOUR_STEP;
  const colPx = (ge: number, gn: number, ch: number) => {
    const e0 = Math.floor(ge / N_COL) * LC_TILE, n0 = Math.floor(gn / N_COL) * LC_TILE;
    const t = tile(e0, n0);
    if (!t) return undefined;
    const c = ge - (e0 / LC_TILE) * N_COL, r = N_COL - 1 - (gn - (n0 / LC_TILE) * N_COL);
    return t.col[(r * N_COL + c) * 4 + ch];
  };
  // Roofs in a 50 m grid.
  const roofGrid = new Map<string, RoofColour[]>();
  for (const rc of file.roofs) {
    const k = `${Math.floor(rc[0] / 50)}_${Math.floor(rc[1] / 50)}`;
    if (!roofGrid.has(k)) roofGrid.set(k, []);
    roofGrid.get(k)!.push(rc);
  }
  return {
    tiles: file.tiles.length,
    classAt(e, n) {
      const e0 = Math.floor(e / LC_TILE) * LC_TILE, n0 = Math.floor(n / LC_TILE) * LC_TILE;
      const t = tile(e0, n0);
      if (!t) return Cover.none;
      const c = Math.min(N_CLS - 1, Math.floor((e - e0) / LC_CLASS_STEP)), r = Math.min(N_CLS - 1, Math.floor((n0 + LC_TILE - n) / LC_CLASS_STEP));
      return t.cls[r * N_CLS + c] as CoverClass;
    },
    rowsAt(e, n) {
      const e0 = Math.floor(e / LC_TILE) * LC_TILE, n0 = Math.floor(n / LC_TILE) * LC_TILE;
      const t = tile(e0, n0);
      if (!t?.rows) return 0;
      const c = Math.min(N_CLS - 1, Math.floor((e - e0) / LC_CLASS_STEP)), r = Math.min(N_CLS - 1, Math.floor((n0 + LC_TILE - n) / LC_CLASS_STEP));
      return t.rows[r * N_CLS + c];
    },
    colourAt(e, n) {
      // Colour pixel centres sit at (k + 0.5) steps; grid coordinates count northwards.
      const ge = e / LC_COLOUR_STEP - 0.5, gn = n / LC_COLOUR_STEP - 0.5;
      const x0 = Math.floor(ge), y0 = Math.floor(gn), tx = ge - x0, ty = gn - y0;
      const out: [number, number, number] = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const a = colPx(x0, y0, ch), b = colPx(x0 + 1, y0, ch), c = colPx(x0, y0 + 1, ch), d = colPx(x0 + 1, y0 + 1, ch);
        if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
        out[ch] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      }
      return out;
    },
    roofAt(e, n, max = 12) {
      let best: RoofColour | undefined, bd = max * max;
      const gx = Math.floor(e / 50), gy = Math.floor(n / 50);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const rc of roofGrid.get(`${gx + dx}_${gy + dy}`) ?? []) {
            const d = (rc[0] - e) ** 2 + (rc[1] - n) ** 2;
            if (d < bd) { bd = d; best = rc; }
          }
      return best && [best[2], best[3], best[4]];
    },
  };
}

/**
 * Texture weights, crop-row strength and survey colour of a terrain vertex at (e, n): the cover classes of the
 * 2 m cells within 2 m around it, tent-weighted. Undefined outside the survey.
 */
export function vertexCover(lc: Landcover, e: number, n: number): { w: number[]; rows: number; dir: number; colour: [number, number, number] } | undefined {
  const w = new Array<number>(8).fill(0);
  let rows = 0, total = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cls = lc.classAt(e + dx * 2 + 0.01, n + dy * 2 + 0.01);
      if (cls === Cover.none) continue;
      const k = (2 - Math.abs(dx)) * (2 - Math.abs(dy));
      const l = lookWeights(COVER_LOOK[cls]);
      for (let i = 0; i < 8; i++) w[i] += l.w[i] * k;
      rows += l.rows * k;
      total += k;
    }
  const colour = lc.colourAt(e, n);
  if (!total || !colour) return undefined;
  // Rows without a mapped field direction (soil outside fields) run east–west.
  const dir = lc.rowsAt(e, n);
  return { w: w.map((v) => v / total), rows: dir ? rows / total : 0, dir, colour };
}

/**
 * The tile fields "splat" (8 bytes per vertex), "rows" (strength, direction code) and "tint" (sRGB survey colour, 3 bytes) of a terrain
 * tile whose north-west vertex sits at (E0, N0); `ground` is the coarse class per vertex for the vertices
 * outside the survey. Undefined when the survey misses the tile entirely.
 */
export function tileCover(lc: Landcover | undefined, E0: number, N0: number, ground: Uint8Array) {
  const n = TERRAIN_N * TERRAIN_N;
  const splat = new Uint8Array(n * 8), rows = new Uint8Array(n * 2), tint = new Uint8Array(n * 3);
  let hits = 0;
  for (let r = 0; r < TERRAIN_N; r++)
    for (let c = 0; c < TERRAIN_N; c++) {
      const i = r * TERRAIN_N + c;
      const v = lc && vertexCover(lc, E0 + c * TERRAIN_STEP, N0 - r * TERRAIN_STEP);
      const look = v ?? { ...lookWeights(GROUND_LOOK[ground[i]] ?? GROUND_LOOK[1]), dir: 0, colour: undefined };
      // Without a survey colour the tint is the reference itself, so the shader shows the plain class colour.
      const colour = v?.colour ?? [0, 1, 2].map((ch) => SPLAT.reduce((a, name, k) => a + look.w[k] * SPLAT_AERIAL_REF[name][ch], 0));
      if (v) hits++;
      for (let k = 0; k < 8; k++) splat[i * 8 + k] = Math.round(look.w[k] * 255);
      rows[i * 2] = Math.round(look.rows * 255);
      rows[i * 2 + 1] = look.dir;
      for (let ch = 0; ch < 3; ch++) tint[i * 3 + ch] = Math.round(colour[ch]);
    }
  return hits ? { splat, rows, tint } : undefined;
}

const toLin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)));

/**
 * Roof colour for the building mesh from the survey's mean roof colour: the aerial photo is hazy and
 * bright (an anthracite roof shows as mid grey), so the haze is taken off in linear light, the result
 * darkened a little and its saturation raised. Measured against roofs on the Großer Markt and in Roden.
 */
export function roofColour([r, g, b]: [number, number, number]): [number, number, number] {
  const haze = [0.07, 0.07, 0.07];
  const lin = [r, g, b].map((c, i) => Math.max(0, toLin(c) - haze[i]) * 0.85);
  const l = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return lin.map((v) => toSrgb(Math.max(0, l + (v - l) * 1.3))) as [number, number, number];
}
