// Builds streamable world tiles from raw region data.
//   node pipeline/build.ts            all regions listed in pipeline/world.json
//   node pipeline/build.ts saarlouis  only the named regions
//   node pipeline/build.ts fixture    synthetic test area (no download needed)
// Output: public/tiles/index.json and public/tiles/t/<ix>_<iy>.json
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  Ground, TERRAIN_N, TERRAIN_STEP, encode, tileKey, utmToLocal,
  type TileData, type WorldIndex,
} from '../src/world/format.ts';
import { buildBuildings } from './lib/buildings.ts';
import { GroundIndex, rand } from './lib/ground.ts';
import { readOsm, pointInRing, type OsmJson } from './lib/osm.ts';
import { loadRegion, loadWorld, paths, unproject, type RegionConfig } from './lib/region.ts';
import { buildGraph } from './lib/graph.ts';
import { buildRoads } from './lib/roads.ts';
import { flatSampler, terrariumSampler, type HeightSampler } from './lib/terrain.ts';
import { TileMap } from './lib/tilebuf.ts';
import { fixtureOsm } from './fixture.ts';

function main() {
  const { cfg, info, project } = loadWorld();
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const regions: RegionConfig[] = (ids.length ? ids : cfg.regions).map(loadRegion);
  const toLonLat = unproject(cfg.zone);
  const t0 = Date.now();

  // Merge raw data of all regions; shared border elements appear once.
  const seen = new Set<string>();
  const merged: OsmJson = { elements: [] };
  for (const r of regions) {
    let json: OsmJson;
    if (r.boundary.type === 'fixture') json = fixtureOsm(cfg.origin);
    else {
      const file = `${paths.raw(r.id)}osm.json`;
      if (!existsSync(file)) throw new Error(`${file} missing. Run "node pipeline/fetch.ts ${r.id}" first.`);
      json = JSON.parse(readFileSync(file, 'utf8'));
    }
    for (const el of json.elements) {
      const k = `${el.type}${el.id}`;
      if (!seen.has(k)) { seen.add(k); merged.elements.push(el); }
    }
  }

  const terrarium = regions.find((r) => r.terrain.source === 'terrarium')?.terrain as { zoom: number } | undefined;
  const sampler: HeightSampler = terrarium ? terrariumSampler(paths.terrain, terrarium.zoom) : flatSampler();
  const hCache = new Map<string, number>();
  const height = (e: number, n: number) => {
    const k = `${Math.round(e * 2)}_${Math.round(n * 2)}`;
    let h = hCache.get(k);
    if (h === undefined) { h = sampler.at(...toLonLat(e, n)); hCache.set(k, h); }
    return h;
  };

  const osm = readOsm(merged, project);
  const tiles = new TileMap(info.tileSize);
  const { graph, junctions } = buildGraph(osm.ways, info, height);
  const samples = buildRoads(osm.ways, info, height, tiles, junctions);
  const nBuildings = buildBuildings(osm.polygons, info, height, tiles);
  console.log(`Roads: ${samples.length} samples, ${graph.edges.length} graph edges, ${graph.names.length} street names · Buildings: ${nBuildings}`);

  // Tiles: everything with content, every tile inside a boundary, plus a ring of terrain around it.
  const T = info.tileSize;
  const want = new Set(tiles.tiles.keys());
  if (osm.boundary) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of osm.boundary) for (const [e, n] of ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    for (let ix = Math.floor(x0 / T); ix <= Math.floor(x1 / T); ix++)
      for (let iy = Math.floor(y0 / T); iy <= Math.floor(y1 / T); iy++)
        if (osm.boundary.some((r) => pointInRing((ix + 0.5) * T, (iy + 0.5) * T, r))) want.add(tileKey(ix, iy));
  }
  for (const k of [...want]) {
    const [ix, iy] = k.split('_').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) want.add(tileKey(ix + dx, iy + dy));
  }

  const ground = new GroundIndex(osm.polygons);
  const roadNear = new Set(samples.map((s) => `${Math.round(s.x / 6)}_${Math.round(s.z / 6)}`));
  const treesByTile = new Map<string, number[]>();
  const addTree = (e: number, n: number, s: number) => {
    const [x, z] = utmToLocal(info, e, n);
    const k = tileKey(Math.floor(e / T), Math.floor(n / T));
    if (!treesByTile.has(k)) treesByTile.set(k, []);
    treesByTile.get(k)!.push(x, height(e, n), z, s);
  };
  for (const [e, n] of osm.trees) addTree(e, n, 0.8 + rand(e, n) * 0.5);

  rmSync(`${paths.out}t`, { recursive: true, force: true });
  mkdirSync(`${paths.out}t`, { recursive: true });
  let bytes = 0;
  const index: [number, number][] = [];
  for (const k of [...want].sort()) {
    const [ix, iy] = k.split('_').map(Number);
    const E0 = ix * T;
    const N0 = (iy + 1) * T;
    const h = new Float32Array(TERRAIN_N * TERRAIN_N);
    const g = new Uint8Array(TERRAIN_N * TERRAIN_N);
    for (let r = 0; r < TERRAIN_N; r++)
      for (let c = 0; c < TERRAIN_N; c++) {
        const e = E0 + c * TERRAIN_STEP;
        const n = N0 - r * TERRAIN_STEP;
        h[r * TERRAIN_N + c] = Math.round(height(e, n) * 100) / 100;
        const cls = ground.at(e, n, Ground.grass);
        g[r * TERRAIN_N + c] = cls;
        // Scatter trees in forests and parks, away from roads.
        if (r < TERRAIN_N - 1 && c < TERRAIN_N - 1 && (cls === Ground.forest || (cls === Ground.grass && rand(e, n, 3) < 0.06))) {
          const count = cls === Ground.forest ? 2 : 1;
          for (let i = 0; i < count; i++) {
            const te = e + rand(e, n, i * 2 + 1) * TERRAIN_STEP;
            const tn = n - rand(e, n, i * 2 + 2) * TERRAIN_STEP;
            const [x, z] = utmToLocal(info, te, tn);
            if (!roadNear.has(`${Math.round(x / 6)}_${Math.round(z / 6)}`) && ground.at(te, tn, Ground.grass) === cls) addTree(te, tn, 0.7 + rand(te, tn) * 0.7);
          }
        }
      }
    const b = tiles.tiles.get(k);
    const tile: TileData = {
      v: 1, ix, iy, terrain: encode(h), ground: encode(g),
      roads: b?.roads.pack(), markings: b?.markings.pack(), buildings: b?.buildings.pack(), collide: b?.collide.pack(),
      sidewalks: b?.sidewalks.pack(),
    };
    if (b?.lamps.length) tile.lamps = encode(new Float32Array(b.lamps.map((v) => Math.round(v * 100) / 100)));
    const trees = treesByTile.get(k);
    if (trees) tile.trees = encode(new Float32Array(trees.map((v) => Math.round(v * 100) / 100)));
    const json = JSON.stringify(tile);
    bytes += json.length;
    writeFileSync(`${paths.out}t/${k}.json`, json);
    index.push([ix, iy]);
  }

  // Spawn on the road sample closest to the first region's spawn point, facing along the road.
  const [se, sn] = project(regions[0].spawn.lon, regions[0].spawn.lat);
  const [sx, sz] = utmToLocal(info, se, sn);
  let best = samples[0];
  let bd = Infinity;
  for (const s of samples) {
    const d = (s.x - sx) ** 2 + (s.z - sz) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  const idx: WorldIndex = {
    v: 1,
    world: info,
    regions: regions.map((r) => ({ id: r.id, name: r.name })),
    tiles: index,
    graph: 'graph.json',
    spawn: best ? { x: best.x, y: best.y + 1.5, z: best.z, heading: best.heading } : { x: 0, y: height(se, sn) + 2, z: 0, heading: 0 },
    attribution: regions.some((r) => r.boundary.type !== 'fixture')
      ? ['Kartendaten © OpenStreetMap-Mitwirkende (ODbL)', 'Gelände: Terrain Tiles (AWS Open Data, SRTM/EU-DEM)']
      : ['Synthetisches Testgelände'],
  };
  writeFileSync(`${paths.out}graph.json`, JSON.stringify(graph));
  writeFileSync(`${paths.out}index.json`, JSON.stringify(idx));
  console.log(`Tiles: ${index.length} (${(bytes / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${paths.out}`);
}

try {
  main();
} catch (e) {
  console.error((e as Error).message ?? e);
  process.exit(1);
}
