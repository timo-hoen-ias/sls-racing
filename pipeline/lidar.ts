// Measures single trees from the LVGL Saarland LiDAR point cloud for a region.
//   node pipeline/lidar.ts saarlouis            all 1 km tiles around the region boundary
//   node pipeline/lidar.ts saarlouis --tiles=336_5464,337_5464   only these tiles (km grid, UTM 32N)
// Needs data/raw/<region>/osm.json (pipeline/fetch.ts) for the boundary.
// Output: data/raw/<region>/lidar.json (see LidarFile in lib/lidar.ts); per-tile results are cached in
// data/raw/<region>/lidar/, so a rerun only processes new tiles. The LAZ files themselves are not kept.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readLaz } from './lib/laz.ts';
import { writeDerived } from './lib/derived.ts';
import { CLS_BUILDING, CLS_GROUND, CLS_VEG, LIDAR_ATTRIBUTION, dedupeBorders, extractTrees, reclassifyPoplars, type LidarFile, type LidarTree } from './lib/lidar.ts';
import { pointInRing, readOsm } from './lib/osm.ts';
import { loadRegion, loadWorld, paths } from './lib/region.ts';
import { RemoteZip, type ZipEntry } from './lib/remotezip.ts';

// Open data share of the LVGL (freie Geobasisdaten), one archive per Landkreis.
const SHARE = 'https://www.shop.lvgl.saarland.de/cloud/public.php/dav/files/NK8ndP55qAqGEZD/OD_LIDAR_Punktwolke_2025_laz_LK/';
const ARCHIVES = ['SLS', 'SB', 'MZG', 'NK', 'WND', 'HOM', 'IGB'].map((lk) => `${SHARE}LIDAR_laz_${lk}_EPSG-25832_Entstehung-2025.zip`);

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error('usage: node pipeline/lidar.ts <region> [--tiles=e_n,...]');
  const region = loadRegion(id);
  const { project } = loadWorld();
  const dir = paths.raw(id);
  const tileArg = process.argv.find((a) => a.startsWith('--tiles='))?.slice(8);

  let wanted: string[];
  if (tileArg) wanted = tileArg.split(',');
  else {
    const osmFile = `${dir}osm.json`;
    if (!existsSync(osmFile)) throw new Error(`${osmFile} missing. Run "node pipeline/fetch.ts ${id}" first.`);
    const osm = readOsm(JSON.parse(readFileSync(osmFile, 'utf8')), project);
    if (!osm.boundary) throw new Error('region has no boundary');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of osm.boundary) for (const [e, n] of ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    const m = region.marginMeters;
    wanted = [];
    // Tiles that touch the boundary plus margin, tested on a 50 m grid.
    const inside = (e: number, n: number) => osm.boundary!.some((r) => pointInRing(e, n, r));
    for (let e = Math.floor((x0 - m) / 1000); e <= Math.floor((x1 + m) / 1000); e++)
      for (let n = Math.floor((y0 - m) / 1000); n <= Math.floor((y1 + m) / 1000); n++) {
        let hit = false;
        for (let a = e * 1000 - m; a <= e * 1000 + 1000 + m && !hit; a += 50)
          for (let b = n * 1000 - m; b <= n * 1000 + 1000 + m && !hit; b += 50) hit = inside(a, b);
        if (hit) wanted.push(`${e}_${n}`);
      }
  }

  // Find each wanted tile in one of the Landkreis archives (a region can span several).
  const where = new Map<string, { zip: RemoteZip; entry: ZipEntry }>();
  for (const url of ARCHIVES) {
    if (wanted.every((k) => where.has(k))) break;
    let zip: RemoteZip;
    try { zip = await RemoteZip.open(url); } catch (e) { console.log(`  ${url.split('/').pop()}: ${(e as Error).message}`); continue; }
    for (const entry of zip.entries.values()) {
      const m = /3dm_32_(\d+)_(\d+)_1_SL_\d+_\d+\.laz$/.exec(entry.name);
      if (m && wanted.includes(`${m[1]}_${m[2]}`) && !where.has(`${m[1]}_${m[2]}`)) where.set(`${m[1]}_${m[2]}`, { zip, entry });
    }
  }
  const missing = wanted.filter((k) => !where.has(k));
  if (missing.length) console.log(`  no LiDAR for ${missing.length} tiles (outside Saarland): ${missing.join(' ')}`);

  const cache = `${dir}lidar/`;
  mkdirSync(cache, { recursive: true });
  const todo = [...where.keys()];
  let done = 0;
  const work = async () => {
    for (let k = todo.shift(); k; k = todo.shift()) {
      const file = `${cache}${k}.json`;
      if (existsSync(file)) { done++; continue; }
      const t0 = Date.now();
      const { zip, entry } = where.get(k)!;
      const laz = await zip.read(entry);
      const pts = await readLaz(laz, (c) => c === CLS_GROUND || c === CLS_BUILDING || c === CLS_VEG);
      const [e, n] = k.split('_').map(Number);
      const trees = extractTrees(pts, e * 1000, n * 1000);
      writeFileSync(file, JSON.stringify(trees));
      console.log(`  ${k}: ${trees.length} trees from ${(pts.count / 1e6).toFixed(1)} M points in ${((Date.now() - t0) / 1000).toFixed(1)} s (${++done}/${where.size})`);
    }
  };
  await Promise.all([work(), work(), work()]);

  const coverage: LidarFile['coverage'] = [];
  let trees: LidarTree[] = [];
  for (const k of where.keys()) {
    const [e, n] = k.split('_').map(Number);
    coverage.push([e * 1000, n * 1000, e * 1000 + 1000, n * 1000 + 1000]);
    trees.push(...(JSON.parse(readFileSync(`${cache}${k}.json`, 'utf8')) as LidarTree[]));
  }
  const before = trees.length;
  trees = reclassifyPoplars(dedupeBorders(trees));
  const out: LidarFile = { crs: 'EPSG:25832', attribution: LIDAR_ATTRIBUTION, coverage, trees };
  writeDerived(id, 'lidar', out);
  const kinds = [0, 1, 2].map((l) => trees.filter((t) => t[4] === l).length);
  console.log(`LiDAR: ${trees.length} trees (${before - trees.length} border duplicates removed; broadleaf ${kinds[0]}, conifer ${kinds[1]}, poplar ${kinds[2]}) on ${coverage.length} km² → ${dir}lidar.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
