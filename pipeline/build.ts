// Builds streamable world tiles from raw region data.
//   node pipeline/build.ts            all regions listed in pipeline/world.json
//   node pipeline/build.ts saarlouis  only the named regions
//   node pipeline/build.ts fixture    synthetic test area (no download needed)
// Output: public/tiles/index.json and public/tiles/t/<ix>_<iy>.bin (gzipped binary container, see encodeTile in format.ts)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  FAR_N, FAR_TILE_SIZE, Ground, TERRAIN_N, TERRAIN_STEP, encode, encodeTile, localToUtm, tileKey, utmToLocal,
  type TileData, type WorldIndex,
} from '../src/world/format.ts';
import { buildBuildings } from './lib/buildings.ts';
import { bridgeDeckList } from './lib/bridges.ts';
import { RoadCarve } from './lib/carve.ts';
import { buildProps, mapillarySignType, signSize } from './lib/props.ts';
import { signalJunctions } from './lib/signals.ts';
import { RoadMask } from './lib/clearance.ts';
import { halfWidths } from './lib/overlap.ts';
import { GroundIndex, rand } from './lib/ground.ts';
import { roadHeights, terrainHeight } from './lib/heights.ts';
import { readOsm, pointInRing, type OsmJson } from './lib/osm.ts';
import { loadRegion, loadWorld, paths, unproject, type RegionConfig } from './lib/region.ts';
import { buildGraph } from './lib/graph.ts';
import { buildRoads } from './lib/roads.ts';
import { terrariumSampler } from './lib/terrain.ts';
import { TileMap } from './lib/tilebuf.ts';
import { WaterLines } from './lib/waterways.ts';
import { fixtureOsm } from './fixture.ts';
import { buildFar } from './lib/far.ts';
import { PROP_NAMES, Prop, type PropKind } from '../src/world/propKinds.ts';
import { BUSH_STRIDE, Bush, type TreeKind } from '../src/world/vegKinds.ts';
import { areaDensity, areaTreeKind, treeKindOf } from './lib/vegetation.ts';
import { loadLidar } from './lib/lidar.ts';
import { categorize, loadMapillary } from './lib/mapillary.ts';
import { placeLidarTrees, type MeasuredTree } from './lib/lidarTrees.ts';

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

  const height = terrainHeight(regions, toLonLat, console.log);

  const osm = readOsm(merged, project);
  const tiles = new TileMap(info.tileSize);
  roadHeights(osm.ways, regions, height, console.log);
  const { graph, junctions } = buildGraph(osm.ways, info, height);
  const carve = new RoadCarve(TERRAIN_STEP);
  const samples = buildRoads(osm.ways, info, height, tiles, junctions, carve, halfWidths(osm.ways, height, info));
  // Main roads (tertiary and up) for shop fronts on the ground floor.
  const mainRoads = new RoadMask(osm.ways, 9, (t) => /^(primary|secondary|tertiary)$/.test(t.highway));
  const nBuildings = buildBuildings(osm.polygons, info, height, tiles, { mainRoad: (e, n) => mainRoads.has(e, n) });
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
  const water = new WaterLines(osm.ways);
  const waterways = water.polylines(info, height);
  const onRoad = new RoadMask(osm.ways);
  // Lamps stand beside their own road; drop the ones that end up on another road's lanes.
  const onLanes = new RoadMask(osm.ways, -0.5);
  const offLanes = (lamps: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < lamps.length; i += 4) if (!onLanes.has(...localToUtm(info, lamps[i], lamps[i + 2]))) out.push(...lamps.slice(i, i + 4));
    return out;
  };
  const TREE_CELL = 8;
  const TREE_EVERY = Math.max(1, Math.round(TREE_CELL / TERRAIN_STEP));
  const treesByTile = new Map<string, number[]>();
  const treeKindsByTile = new Map<string, number[]>();
  const treeCrownsByTile = new Map<string, number[]>();
  const bushesByTile = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, e: number, n: number, ...v: number[]) => {
    const k = tileKey(Math.floor(e / T), Math.floor(n / T));
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(...v);
  };
  const addTree = (e: number, n: number, s: number, kind: TreeKind, crown = 0) => {
    const [x, z] = utmToLocal(info, e, n);
    push(treesByTile, e, n, x, height(e, n), z, s);
    push(treeKindsByTile, e, n, kind);
    push(treeCrownsByTile, e, n, crown);
  };
  const addBush = (e: number, n: number, s: number, kind: number) => {
    const [x, z] = utmToLocal(info, e, n);
    push(bushesByTile, e, n, x, height(e, n), z, s, kind);
  };
  // Measured trees from the LiDAR survey where there is one; mapped OSM trees they stand on keep their species.
  const mapped = osm.trees.filter(([e, n]) => !onRoad.has(e, n)).map(([e, n, tags]) => ({ e, n, kind: treeKindOf(tags, rand(e, n, 31)) }));
  const coverage: [number, number, number, number][] = [];
  const measured: MeasuredTree[] = [];
  for (const r of regions) {
    const l = r.boundary.type === 'fixture' ? undefined : loadLidar(r.id);
    if (l) { coverage.push(...l.coverage); for (const t of l.trees) measured.push(t); }
  }
  // Trunks keep clear of the carriageway edge too (tracks are narrow and the car must not clip them).
  const nearLanes = new RoadMask(osm.ways, 0.5);
  const lidar = placeLidarTrees(coverage, measured, {
    skip: (e, n) => nearLanes.has(e, n) || ground.at(e, n, Ground.grass) === Ground.forest,
    tagsAt: (e, n) => ground.tagsAt(e, n), mapped, rand,
  });
  for (const t of lidar.trees) addTree(t.e, t.n, t.scale, t.kind, t.crown);
  for (const [e, n, s] of lidar.bushes) addBush(e, n, s, Bush.round);
  mapped.forEach((t, i) => { if (!lidar.merged.has(i)) addTree(t.e, t.n, 0.8 + rand(t.e, t.n) * 0.5, t.kind); });
  // Street furniture and traffic lights seen on Mapillary's street-level photos, on top of OSM.
  const DETECTED: Partial<Record<string, PropKind>> = { sign: Prop.sign, stopSign: Prop.stopSign, giveWay: Prop.giveWay, bench: Prop.bench, hydrant: Prop.hydrant };
  // Bins are left out: the photos mostly show household bins put out on collection day.
  const detected: { kind: PropKind; e: number; n: number; size: number }[] = [];
  const detectedLights: [number, number][] = [];
  for (const r of regions) {
    const m = r.boundary.type === 'fixture' ? undefined : loadMapillary(r.id);
    for (const [e, n, value] of m?.features ?? []) {
      const cat = categorize(value);
      if (cat === 'trafficLight') detectedLights.push([e, n]);
      const kind = cat && DETECTED[cat];
      if (kind) detected.push({ kind, e, n, size: kind === Prop.sign ? signSize(mapillarySignType(value)) : 0 });
    }
  }
  const props = buildProps(osm, { world: info, height, onLanes: (e, n) => onLanes.has(e, n), junctions, boundary: osm.boundary, detected });
  console.log(`Mapillary: ${detected.length} features, ${props.detected} new as props, ${detectedLights.length} traffic lights`);
  console.log(`Props: ${Object.entries(props.counts).map(([k, c]) => `${PROP_NAMES[Number(k) as PropKind]} ${c}`).join(', ') || '-'}`);

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
        h[r * TERRAIN_N + c] = Math.round(carve.apply(e, n, height.raw(e, n)) * 100) / 100;
        // Brooks become water cells, except under roads (culverts), where the mesh must stay level.
        const cls = water.has(e, n) && !onRoad.has(e, n) ? Ground.water : ground.at(e, n, Ground.grass);
        g[r * TERRAIN_N + c] = cls;
        // Scatter trees and bushes in woods, scrub and parks, away from roads. Densities are per 8 m cell and area type, whatever the mesh step.
        if (r % TREE_EVERY === 0 && c % TREE_EVERY === 0 && r < TERRAIN_N - 1 && c < TERRAIN_N - 1 && (cls === Ground.forest || cls === Ground.grass)) {
          const tags = ground.tagsAt(e + TREE_CELL / 2, n - TREE_CELL / 2);
          const d = areaDensity(tags, cls === Ground.forest);
          const count = (v: number, s: number) => Math.floor(v) + (rand(e, n, s) < v % 1 ? 1 : 0);
          const nt = count(d.trees, 3), nb = count(d.bushes, 4);
          for (let i = 0; i < nt + nb; i++) {
            const te = e + rand(e, n, i * 2 + 5) * TREE_CELL;
            const tn = n - rand(e, n, i * 2 + 6) * TREE_CELL;
            if (onRoad.has(te, tn) || ground.at(te, tn, Ground.grass) !== cls) continue;
            if (i < nt) {
              // Parks and gardens inside the LiDAR survey have their measured trees already.
              if (cls !== Ground.forest && lidar.covered(te, tn)) continue;
              addTree(te, tn, 0.7 + rand(te, tn) * 0.7, areaTreeKind(tags, rand(te, tn, 7)));
            }
            else addBush(te, tn, 0.6 + rand(te, tn, 8) * 0.8, tags?.natural === 'scrub' || cls === Ground.forest ? Bush.scrub : Bush.round);
          }
        }
      }
    const b = tiles.tiles.get(k);
    const tile: TileData = {
      v: 1, ix, iy, terrain: encode(h), ground: encode(g),
      roads: b?.roads.pack(), markings: b?.markings.pack(), buildings: b?.buildings.pack(), collide: b?.collide.pack(),
      sidewalks: b?.sidewalks.pack(),
    };
    const lamps = offLanes(b?.lamps ?? []);
    if (lamps.length) tile.lamps = encode(new Float32Array(lamps.map((v) => Math.round(v * 100) / 100)));
    const ww = waterways.get(k);
    if (ww) tile.waterways = encode(new Float32Array(ww));
    const trees = treesByTile.get(k);
    if (trees) tile.trees = encode(new Float32Array(trees.map((v) => Math.round(v * 100) / 100)));
    const treeKinds = treeKindsByTile.get(k);
    if (treeKinds) tile.treeKinds = encode(new Uint8Array(treeKinds));
    const crowns = treeCrownsByTile.get(k);
    if (crowns?.some((c) => c > 0)) tile.treeCrowns = encode(new Uint8Array(crowns));
    const bushes = bushesByTile.get(k);
    if (bushes) tile.bushes = encode(new Float32Array(bushes.map((v) => Math.round(v * 100) / 100)));
    const tileProps = props.tiles.get(k);
    if (tileProps) tile.props = encode(new Float32Array(tileProps));
    // Gzipped here because static hosting does not compress application/octet-stream; the client inflates it.
    const bin = gzipSync(encodeTile(tile), { level: 9 });
    bytes += bin.byteLength;
    writeFileSync(`${paths.out}t/${k}.bin`, bin);
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
    format: 'bin',
    world: info,
    regions: regions.map((r) => ({ id: r.id, name: r.name })),
    tiles: index,
    graph: 'graph.json',
    spawn: best ? { x: best.x, y: best.y + 1.5, z: best.z, heading: best.heading } : { x: 0, y: height(se, sn) + 2, z: 0, heading: 0 },
    attribution: regions.some((r) => r.boundary.type !== 'fixture')
      ? ['Kartendaten © OpenStreetMap-Mitwirkende (ODbL)',
        ...(regions.some((r) => r.laser) ? ['Gelände und Brücken: © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0'] : []),
        'Gelände außerhalb: Terrain Tiles (AWS Open Data, SRTM/EU-DEM)']
      : ['Synthetisches Testgelände'],
  };
  // Far view (P3): coarse terrain and building blocks around regions that ask for it.
  const farRegion = regions.find((r) => r.far && existsSync(`${paths.raw(r.id)}far-osm.json`));
  if (farRegion?.far && farRegion.terrain.source === 'terrarium') {
    const farJson: OsmJson = JSON.parse(readFileSync(`${paths.raw(farRegion.id)}far-osm.json`, 'utf8'));
    const farOsm = readOsm(farJson, project);
    // The detailed tiles plus the far margin (the extract itself reaches further along long relations).
    const m = farRegion.far.marginMeters;
    const e0 = Math.min(...index.map(([ix]) => ix)) * T - m, e1 = (Math.max(...index.map(([ix]) => ix)) + 1) * T + m;
    const n0 = Math.min(...index.map(([, iy]) => iy)) * T - m, n1 = (Math.max(...index.map(([, iy]) => iy)) + 1) * T + m;
    // Detailed terrain where the near tiles have it, so both meet; the coarse zoom beyond.
    const coarse = terrariumSampler(paths.terrain, farRegion.far.zoom);
    const farHeight = (e: number, n: number) => {
      try { return height.raw(e, n); } catch { return coarse.at(...toLonLat(e, n)); }
    };
    idx.far = { size: FAR_TILE_SIZE, n: FAR_N, tiles: buildFar({ info, polygons: farOsm.polygons, box: { e0, n0, e1, n1 }, height: farHeight, out: paths.out }) };
  }
  const signalPts = osm.points.filter((p) => p.tags.highway === 'traffic_signals' && p.tags.crossing !== 'traffic_signals').map((p) => utmToLocal(info, p.e, p.n));
  // Traffic lights seen on photos stand at the kerb, a little further from the junction node than OSM's.
  const photoSignals = detectedLights.map(([e, n]) => utmToLocal(info, e, n));
  graph.s = signalJunctions(graph, signalPts, photoSignals);
  console.log(`Traffic lights: ${signalPts.length} signal nodes + ${photoSignals.length} from photos → ${graph.s.length} junctions in ${new Set(graph.s.map((s) => s[1])).size} groups`);
  writeFileSync(`${paths.out}graph.json`, JSON.stringify(graph));
  writeFileSync(`${paths.out}bridges.json`, JSON.stringify({ v: 1, bridges: bridgeDeckList(osm.ways, height, info) }));
  writeFileSync(`${paths.out}index.json`, JSON.stringify(idx));
  const nTrees = [...treeKindsByTile.values()].reduce((a, v) => a + v.length, 0);
  const nBushes = [...bushesByTile.values()].reduce((a, v) => a + v.length / BUSH_STRIDE, 0);
  console.log(`Vegetation: ${nTrees} trees (${lidar.trees.length} from LiDAR, ${lidar.merged.size} of them mapped in OSM), ${nBushes} bushes`);
  console.log(`Tiles: ${index.length} (${(bytes / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${paths.out}`);
}

try {
  main();
} catch (e) {
  console.error((e as Error).message ?? e);
  process.exit(1);
}
