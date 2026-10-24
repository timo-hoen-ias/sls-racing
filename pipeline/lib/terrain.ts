// Elevation from Terrarium PNG tiles (AWS Open Data "Terrain Tiles", mostly SRTM/EU-DEM in Germany).
// Later: replace with Saarland DGM1 (1 m) behind the same sampler interface.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export interface HeightSampler {
  /** Height in metres above sea level at a WGS84 position. */
  at(lon: number, lat: number): number;
}

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

export function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

export function tilesForBbox(west: number, south: number, east: number, north: number, z: number): [number, number][] {
  const [x0, y0] = lonLatToTile(west, north, z);
  const [x1, y1] = lonLatToTile(east, south, z);
  const out: [number, number][] = [];
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) out.push([x, y]);
  return out;
}

/** Downloads with a few retries: a single dropped connection to S3 should not fail a whole world build. */
async function download(url: string, what: string, tries = 4): Promise<Buffer> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw new Error(`${what}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

export async function fetchTerrarium(dir: string, tiles: [number, number][], z: number) {
  mkdirSync(dir, { recursive: true });
  let fetched = 0;
  for (const [x, y] of tiles) {
    const file = `${dir}/${z}_${x}_${y}.png`;
    if (existsSync(file)) continue;
    writeFileSync(file, await download(`${TERRARIUM}/${z}/${x}/${y}.png`, `Terrarium ${z}/${x}/${y}`));
    fetched++;
  }
  return fetched;
}

export function terrariumSampler(dir: string, z: number): HeightSampler {
  const cache = new Map<string, Float32Array | null>();
  const tile = (x: number, y: number) => {
    const key = `${x}_${y}`;
    if (!cache.has(key)) {
      const file = `${dir}/${z}_${key}.png`;
      if (!existsSync(file)) cache.set(key, null);
      else {
        const png = PNG.sync.read(readFileSync(file));
        const h = new Float32Array(256 * 256);
        for (let i = 0; i < h.length; i++) {
          const d = png.data;
          h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        }
        cache.set(key, h);
      }
    }
    return cache.get(key);
  };
  const px = (gx: number, gy: number) => {
    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    const h = tile(tx, ty);
    if (!h) throw new Error(`Terrain tile ${z}/${tx}/${ty} missing. Run "npm run world:fetch" first.`);
    return h[(gy - ty * 256) * 256 + (gx - tx * 256)];
  };
  return {
    at(lon, lat) {
      const [fx, fy] = lonLatToTile(lon, lat, z);
      // Pixel centres sit at +0.5.
      const gx = fx * 256 - 0.5;
      const gy = fy * 256 - 0.5;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = gx - x0;
      const ty = gy - y0;
      const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    },
  };
}

export const flatSampler = (h = 180): HeightSampler => ({ at: () => h });
