// Saarland laser-scan rasters in 1 km GeoTIFF tiles, 1 m grid, on ETRS89/UTM 32N (the game's own grid):
// DGM1 is the bare-earth terrain, DOM1 the surface with buildings, trees and bridge decks. The LVGL
// publishes one ZIP per district; fetch.ts pulls only the tiles a region needs out of it with range
// requests and stores them deflated in data/raw/<dgm1|dom1>/.
// Licence dl-de/by-2-0, "© GeoBasis DE/LVGL-SL (2025)".
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { RemoteZip, type ZipEntry } from './remotezip.ts';

const KM = 1000;
const NODATA = -9999;

/** "dgm1_32_335_5465_1_SL_2025.tif" (or dom1_…) → [335, 5465], the tile's south-west corner in km. */
function tileOf(name: string, match = LASER_NAME): [number, number] | undefined {
  const m = match.exec(name);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}
const LASER_NAME = /d[go]m1_32_(\d+)_(\d+)_1_/;

const file = (dir: string, ekm: number, nkm: number, ext = 'tif') => `${dir}${ekm}_${nkm}.${ext}.deflate`;

/** The km tiles ([east, north] of the south-west corner in km) that touch a UTM bbox. */
export function kmTiles([w, s, e, n]: [number, number, number, number]): [number, number][] {
  const out: [number, number][] = [];
  for (let x = Math.floor(w / KM); x <= Math.floor(e / KM); x++) for (let y = Math.floor(s / KM); y <= Math.floor(n / KM); y++) out.push([x, y]);
  return out;
}

/**
 * Downloads the given km tiles, each from the first archive that has it. Returns how many exist locally,
 * how many of them were new and how many no archive has.
 */
export async function fetchLaserTiles(
  dir: string, archives: string[], tiles: [number, number][], log = console.log,
  // Other km-tiled archives of the same share (LoD2 CityGML) name their tiles differently.
  { match = LASER_NAME, ext = 'tif' }: { match?: RegExp; ext?: string } = {},
) {
  mkdirSync(dir, { recursive: true });
  const want = tiles.filter(([e, n]) => !existsSync(file(dir, e, n, ext)));
  let have = tiles.length - want.length;
  let fetched = 0;
  for (const url of archives) {
    if (!want.length) break;
    const zip = await RemoteZip.open(url);
    const byTile = new Map<string, ZipEntry>();
    for (const e of zip.entries.values()) {
      const t = tileOf(e.name, match);
      if (t) byTile.set(`${t[0]}_${t[1]}`, e);
    }
    for (let i = want.length - 1; i >= 0; i--) {
      const [e, n] = want[i];
      const entry = byTile.get(`${e}_${n}`);
      if (!entry) continue;
      if (entry.method !== 8) throw new Error(`${entry.name}: ZIP method ${entry.method}, expected deflate`);
      writeFileSync(file(dir, e, n, ext), await zip.readRaw(entry));
      want.splice(i, 1);
      fetched++;
      have++;
      if (fetched % 10 === 0) log(`  ${fetched} tiles …`);
    }
  }
  return { have, fetched, missing: want.length };
}

/** Float32 heights of one uncompressed, strip-organised 1000×1000 GeoTIFF (as LAStools writes them). */
function readTiff(buf: Buffer): Float32Array {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = u32(4);
  const tags = new Map<number, number[]>();
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const o = ifd + 2 + i * 12;
    const type = u16(o + 2), count = u32(o + 4);
    if (type !== 3 && type !== 4) continue;
    const size = type === 3 ? 2 : 4;
    const at = count * size <= 4 ? o + 8 : u32(o + 8);
    tags.set(u16(o), Array.from({ length: count }, (_, k) => (type === 3 ? u16(at + k * 2) : u32(at + k * 4))));
  }
  const [w] = tags.get(256)!, [h] = tags.get(257)!;
  const bits = tags.get(258)?.[0], compression = tags.get(259)?.[0] ?? 1, format = tags.get(339)?.[0];
  if (w !== KM || h !== KM || bits !== 32 || compression !== 1 || format !== 3)
    throw new Error(`DGM1 GeoTIFF ${w}×${h}, ${bits} bit, compression ${compression}, format ${format} not supported`);
  const out = new Float32Array(w * h);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  for (const [s, off] of tags.get(273)!.entries()) {
    const len = tags.get(279)![s];
    for (let p = off; p < off + len && i < out.length; p += 4) out[i++] = view.getFloat32(p, le);
  }
  return out;
}

export interface LaserGrid {
  /** Height at a UTM position, or undefined outside the downloaded tiles or on a data gap. */
  at(e: number, n: number): number | undefined;
  /** Distance (m) from the position to the nearest point without DGM1 data, up to `max`. */
  coverage(e: number, n: number, max: number): number;
  tiles: number;
}

/** keep: how many tiles stay decoded (4 MB each, outside the JS heap), most recently used first. */
export function laserSampler(dir: string, keep = 640): LaserGrid {
  const cache = new Map<number, Float32Array | null>();
  // Roads and buildings jump across the whole world: the default keeps most of a Landkreis decoded (~2.5 GB),
  // so few tiles are inflated twice.
  const KEEP = keep;
  // Numeric keys and the last tile at hand: the terrain asks for millions of neighbouring points.
  let lastKey = NaN, last: Float32Array | null = null;
  const tile = (ekm: number, nkm: number) => {
    const key = ekm * 100_000 + nkm;
    if (key === lastKey) return last;
    let t = cache.get(key);
    if (t === undefined) {
      t = has(ekm, nkm) ? readTiff(inflateRawSync(readFileSync(file(dir, ekm, nkm)))) : null;
      if (cache.size >= KEEP) cache.delete(cache.keys().next().value!);
    } else cache.delete(key);
    cache.set(key, t);
    lastKey = key;
    last = t;
    return t;
  };
  // Pixel (c, r) covers [E0 + c, E0 + c + 1] × [N1 - r - 1, N1 - r]; its value belongs to the centre.
  const px = (ge: number, gn: number) => {
    const ekm = Math.floor(ge / KM), nkm = Math.floor(gn / KM);
    const t = tile(ekm, nkm);
    if (!t) return undefined;
    const v = t[(KM - 1 - (gn - nkm * KM)) * KM + (ge - ekm * KM)];
    return v === NODATA ? undefined : v;
  };
  const present = new Set(
    (existsSync(dir) ? readdirSync(dir) : []).flatMap((f) => {
      const m = /^(\d+)_(\d+)\.tif\.deflate$/.exec(f);
      return m ? [Number(m[1]) * 100_000 + Number(m[2])] : [];
    }),
  );
  const has = (ekm: number, nkm: number) => present.has(ekm * 100_000 + nkm);
  return {
    tiles: present.size,
    at(e, n) {
      const ge = e - 0.5, gn = n - 0.5;
      const x0 = Math.floor(ge), y0 = Math.floor(gn);
      const tx = ge - x0, ty = gn - y0;
      const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
      if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    },
    coverage(e, n, max) {
      // Tile granularity is enough: gaps inside a tile only occur along the state border.
      const r = Math.ceil(max / KM);
      const ekm = Math.floor(e / KM), nkm = Math.floor(n / KM);
      let best = max;
      for (let de = -r; de <= r; de++)
        for (let dn = -r; dn <= r; dn++) {
          if (has(ekm + de, nkm + dn)) continue;
          const x0 = (ekm + de) * KM, y0 = (nkm + dn) * KM;
          const dx = Math.max(x0 - e, 0, e - x0 - KM), dy = Math.max(y0 - n, 0, n - y0 - KM);
          best = Math.min(best, Math.hypot(dx, dy));
        }
      return best;
    },
  };
}

