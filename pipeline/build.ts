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
import { buildBuildings, buildLod2 } from './lib/buildings.ts';
import { landmarkArea, landmarkList, readLandmarks } from './lib/landmarks.ts';
import { Footprints, isTrafficStructure, lod2Buildings, lod2TileCount, LOD2_ATTRIBUTION, type Lod2Building } from './lib/lod2.ts';
import { bridgeDeckList } from './lib/bridges.ts';
import { RoadCarve } from './lib/carve.ts';
import { buildProps, mapillarySignType, signSize } from './lib/props.ts';
import { type ShopBuilding, buildShops } from './lib/shops.ts';
import { signalJunctions } from './lib/signals.ts';
import { RoadLines, RoadMask } from './lib/clearance.ts';
import { halfWidths } from './lib/overlap.ts';
import { GroundIndex, rand } from './lib/ground.ts';
import { applyMeasuredWidths, loadAlkisRoads } from './lib/alkis.ts';
import { missing, roadHeights, terrainHeight } from './lib/heights.ts';
import { readOsm, pointInRing, type OsmJson } from './lib/osm.ts';
import { loadRegion, loadWorld, paths, unproject, type RegionConfig } from './lib/region.ts';
import { buildGraph } from './lib/graph.ts';
import { buildRoads, type Railing } from './lib/roads.ts';
import { matchRampHeights, planRamps, rampList } from './lib/ramps.ts';
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
import { waterLevels, type TileGrid } from './lib/waterLevel.ts';

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
  const measured = regions.reduce((n, r) => n + applyMeasuredWidths(osm.ways, loadAlkisRoads(r.id)), 0);
  console.log(`ALKIS: measured carriageway width on ${measured} streets`);
  const ramps = planRamps(osm.ways);
  console.log(`Motorway junctions: ${ramps.stats.runs} auxiliary lanes, ${ramps.stats.moved} ramps moved onto them, ${ramps.stats.plain} ramps as mapped`);
  roadHeights(osm.ways, regions, height, console.log);
  matchRampHeights(ramps);
  const { graph, junctions } = buildGraph(osm.ways, info, height);
  const carve = new RoadCarve(TERRAIN_STEP);
  // Landmark models (real regions only): bridges they dress, and footprints whose generic buildings they replace.
  const real = regions.some((r) => r.boundary.type !== 'fixture');
  const landmarks = real ? readLandmarks(new URL('./landmarks.json', import.meta.url).pathname) : [];
  const railings: Railing[] = [];
  const dressed = new Set(landmarks.flatMap((l) => (l.bridge ? [l.bridge] : [])));
  const samples = buildRoads(osm.ways, info, height, tiles, junctions, carve, halfWidths(osm.ways, height, info), { dressed, railings }, ramps);
  // Main roads (tertiary and up) for shop fronts on the ground floor.
  const mainRoads = new RoadMask(osm.ways, 9, (t) => /^(primary|secondary|tertiary)$/.test(t.highway));
  // LoD2 models where the survey has them (the whole district), OSM outlines for everything else.
  const lod2Dir = regions.some((r) => r.lod2?.length) ? paths.lod2 : undefined;
  if (lod2Dir && !lod2TileCount(lod2Dir)) throw missing('LoD2', lod2Dir, regions);
  const landmarkFoot = landmarkArea(landmarks);
  const centre = (r: [number, number][]) => r.reduce(([a, b], [e, n]) => [a + e / r.length, b + n / r.length], [0, 0]);
  const footprints = new Footprints();
  if (lod2Dir) for (const b of lod2Buildings(lod2Dir)) if (!isTrafficStructure(b)) footprints.add(b.ground);
  // Only where the region has something already (roads, OSM buildings): the survey tiles reach past it.
  const T0 = info.tileSize;
  const used = new Set(tiles.tiles.keys());
  for (const p of osm.polygons) if (p.tags.building && p.outer.length) used.add(`${Math.floor(p.outer[0][0] / T0)}_${Math.floor(p.outer[0][1] / T0)}`);
  const outside = (b: Lod2Building) => {
    const r = b.ground[0] ?? [];
    return !r.length || !used.has(`${Math.floor(r[0][0] / T0)}_${Math.floor(r[0][1] / T0)}`);
  };
  // Buildings a road runs through (canopies, garages, passages the survey models solid) would block it.
  const lines = new RoadLines(osm.ways);
  let blocking = 0;
  const blocks = (rings: [number, number][][]) => {
    const hit = rings.some((r) => lines.through(r) !== undefined);
    if (hit) blocking++;
    return hit;
  };
  const shopBuildings: ShopBuilding[] = [];
  const onBuilding = (b: ShopBuilding) => shopBuildings.push(b);
  const lod2 = buildLod2(lod2Dir ? lod2Buildings(lod2Dir) : [], info, height, tiles, { mainRoad: (e, n) => mainRoads.has(e, n), onBuilding, skip: (b) => isTrafficStructure(b) || outside(b) || (!!b.ground[0] && landmarkFoot.contains(...centre(b.ground[0]))) || blocks(b.ground) });
  const nBuildings = buildBuildings(osm.polygons, info, height, tiles, { mainRoad: (e, n) => mainRoads.has(e, n), skip: (o) => footprints.covers(o) || landmarkFoot.contains(...centre(o)) || blocks([o]), onBuilding });
  console.log(`Roads: ${samples.length} samples, ${graph.edges.length} graph edges, ${graph.names.length} street names · Buildings: ${lod2.count} LoD2 + ${nBuildings} OSM, ${blocking} left out on roads`);

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
  // Tree trunks, fences and hedges keep clear of the carriageway edge too: narrow roads are mapped narrower
  // than the car drives them, and the car must not clip them.
  const nearLanes = new RoadMask(osm.ways, 0.5);
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
  const measuredTrees: MeasuredTree[] = [];
  for (const r of regions) {
    const l = r.boundary.type === 'fixture' ? undefined : loadLidar(r.id);
    if (l) { coverage.push(...l.coverage); for (const t of l.trees) measuredTrees.push(t); }
  }
  const lidar = placeLidarTrees(coverage, measuredTrees, {
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
  const props = buildProps(osm, { world: info, height, onLanes: (e, n) => onLanes.has(e, n), nearLanes: (e, n) => nearLanes.has(e, n), junctions, boundary: osm.boundary, detected, railings });
  console.log(`Mapillary: ${detected.length} features, ${props.detected} new as props, ${detectedLights.length} traffic lights`);
  const shops = buildShops(osm, { world: info, height, onRoad: (e, n) => onRoad.has(e, n), onLanes: (e, n) => onLanes.has(e, n), buildings: shopBuildings });
  console.log(`Shops: ${shops.placedMapped}/${shops.mapped} mapped placed · ${Object.entries(shops.counts).map(([k, c]) => `${k} ${c}`).join(', ') || '-'}`);
  console.log(`Props: ${Object.entries(props.counts).map(([k, c]) => `${PROP_NAMES[Number(k) as PropKind]} ${c}`).join(', ') || '-'}`);

  rmSync(`${paths.out}t`, { recursive: true, force: true });
  mkdirSync(`${paths.out}t`, { recursive: true });
  // Terrain and ground classes of all tiles first: water levels are smoothed across tile borders.
  const grids = new Map<string, TileGrid>();
  for (const k of want) {
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
        g[r * TERRAIN_N + c] = water.has(e, n) && !onRoad.has(e, n) ? Ground.water : ground.at(e, n, Ground.grass);
      }
    grids.set(k, { h, g });
  }
  const levels = waterLevels(grids, TERRAIN_N, Ground.water);
  console.log(`Water: smooth levels in ${levels.size} tiles`);

  let bytes = 0;
  const index: [number, number][] = [];
  for (const k of [...want].sort()) {
    const [ix, iy] = k.split('_').map(Number);
    const E0 = ix * T;
    const N0 = (iy + 1) * T;
    const { h, g } = grids.get(k)!;
    for (let r = 0; r < TERRAIN_N; r++)
      for (let c = 0; c < TERRAIN_N; c++) {
        const e = E0 + c * TERRAIN_STEP;
        const n = N0 - r * TERRAIN_STEP;
        const cls = g[r * TERRAIN_N + c];
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
    const bi = lod2.info.get(k);
    if (bi) tile.bldInfo = encode(new Float32Array(bi));
    const wl = levels.get(k);
    if (wl) tile.waterLevel = encode(wl);
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
    const tileShops = shops.tiles.get(k);
    if (tileShops) tile.shops = encode(new Float32Array(tileShops));
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
        ...(lod2.count ? [LOD2_ATTRIBUTION] : []),
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
  const placed = landmarkList(landmarks, info, height, (e, n) => want.has(`${Math.floor(e / T)}_${Math.floor(n / T)}`));
  writeFileSync(`${paths.out}landmarks.json`, JSON.stringify({ v: 1, landmarks: placed }));
  console.log(`Landmarks: ${placed.length} models placed`);
  writeFileSync(`${paths.out}bridges.json`, JSON.stringify({ v: 1, bridges: bridgeDeckList(osm.ways, height, info) }));
  writeFileSync(`${paths.out}ramps.json`, JSON.stringify(rampList(ramps, info)));
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
