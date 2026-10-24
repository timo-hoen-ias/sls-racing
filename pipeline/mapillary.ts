// Downloads Mapillary map features (traffic signs, traffic lights, street lights, benches ...) for a region.
//   MAPILLARY_TOKEN=MLY|... node pipeline/mapillary.ts saarlouis
// Needs data/raw/<region>/osm.json (pipeline/fetch.ts). Output: data/raw/<region>/mapillary.json
// (see MapillaryFile in lib/mapillary.ts). Only features with a game category are kept.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MAPILLARY_ATTRIBUTION, categorize, type MapillaryFeature, type MapillaryFile } from './lib/mapillary.ts';
import { readOsm } from './lib/osm.ts';
import { loadWorld, paths, unproject } from './lib/region.ts';

const API = 'https://graph.mapillary.com/map_features';
/** The API returns at most 2000 features per request, so the region is queried in small cells. */
const CELL = 0.005;

async function cell(token: string, w: number, s: number, e: number, n: number): Promise<any[]> {
  const url = `${API}?bbox=${w},${s},${e},${n}&fields=id,object_value,geometry,aligned_direction,last_seen_at&limit=2000`;
  for (let attempt = 0, wait = 2; ; attempt++, wait *= 2) {
    const res = await fetch(url, { headers: { Authorization: `OAuth ${token}` } }).catch((e) => e as Error);
    if (!(res instanceof Error) && res.ok) {
      const data = ((await res.json()) as { data: any[] }).data;
      // A full page means the cell holds more; split it in four.
      if (data.length >= 2000 && e - w > 0.0005) {
        const mx = (w + e) / 2, my = (s + n) / 2;
        return (await Promise.all([cell(token, w, s, mx, my), cell(token, mx, s, e, my), cell(token, w, my, mx, n), cell(token, mx, my, e, n)])).flat();
      }
      return data;
    }
    const why = res instanceof Error ? res.message : `HTTP ${res.status}`;
    if (attempt >= 4 || (!(res instanceof Error) && (res.status === 401 || res.status === 403))) throw new Error(`Mapillary ${why}`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

async function main() {
  const id = process.argv[2];
  const token = process.env.MAPILLARY_TOKEN;
  if (!id || !token) throw new Error('usage: MAPILLARY_TOKEN=... node pipeline/mapillary.ts <region>');
  const { cfg, project } = loadWorld();
  const toLonLat = unproject(cfg.zone);
  const dir = paths.raw(id);
  const osmFile = `${dir}osm.json`;
  if (!existsSync(osmFile)) throw new Error(`${osmFile} missing. Run "node pipeline/fetch.ts ${id}" first.`);
  const osm = readOsm(JSON.parse(readFileSync(osmFile, 'utf8')), project);
  if (!osm.boundary) throw new Error('region has no boundary');

  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of osm.boundary)
    for (const [x, y] of ring) {
      const [lon, lat] = toLonLat(x, y);
      w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
    }

  const cells: [number, number][] = [];
  for (let x = Math.floor(w / CELL) * CELL; x < e; x += CELL) for (let y = Math.floor(s / CELL) * CELL; y < n; y += CELL) cells.push([x, y]);
  const seen = new Set<string>();
  const features: MapillaryFeature[] = [];
  let raw = 0;
  const work = async () => {
    for (let c = cells.shift(); c; c = cells.shift()) {
      for (const f of await cell(token, +c[0].toFixed(5), +c[1].toFixed(5), +(c[0] + CELL).toFixed(5), +(c[1] + CELL).toFixed(5))) {
        raw++;
        if (seen.has(f.id) || !categorize(f.object_value)) continue;
        seen.add(f.id);
        const [x, y] = project(f.geometry.coordinates[0], f.geometry.coordinates[1]);
        const dir = typeof f.aligned_direction === 'number' ? Math.round(f.aligned_direction) : -1;
        const year = f.last_seen_at ? new Date(f.last_seen_at).getUTCFullYear() : 0;
        features.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, f.object_value, dir, year]);
      }
    }
  };
  await Promise.all([work(), work(), work(), work()]);

  const out: MapillaryFile = { crs: 'EPSG:25832', attribution: MAPILLARY_ATTRIBUTION, features };
  writeFileSync(`${dir}mapillary.json`, JSON.stringify(out));
  const count = new Map<string, number>();
  for (const f of features) count.set(categorize(f[2])!, (count.get(categorize(f[2])!) ?? 0) + 1);
  console.log(`Mapillary: ${features.length} of ${raw} features kept (${[...count].map(([k, v]) => `${k} ${v}`).join(', ')}) → ${dir}mapillary.json`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
