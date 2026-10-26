// Builds streamable world tiles from raw region data.
//   node pipeline/build.ts            all regions listed in pipeline/world.json
//   node pipeline/build.ts saarlouis  only the named regions
//   node pipeline/build.ts fixture    synthetic test area (no download needed)
// Output: public/tiles/index.json and public/tiles/t/<ix>_<iy>.bin (gzipped binary container, see encodeTile in format.ts)
import { districtList } from './lib/districts.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  FAR_N, FAR_TILE_SIZE, Ground, TERRAIN_N, TERRAIN_STEP, encode, encodeTile, localToUtm, tileKey, utmToLocal,
  type TileData, type WorldIndex,
} from '../src/world/format.ts';
import { buildBuildings, buildLod2 } from './lib/buildings.ts';
import { landmarkArea, landmarkList, readLandmarks } from './lib/landmarks.ts';
import { Footprints, isTrafficStructure, lod2Buildings, lod2Tags, lod2TileCount, LOD2_ATTRIBUTION, type Lod2Building } from './lib/lod2.ts';
import { bridgeDeckList } from './lib/bridges.ts';
import { RoadCarve } from './lib/carve.ts';
import { buildProps, mapillarySignType, signSize } from './lib/props.ts';
import { buildGuideSigns, type Place } from './lib/guideSigns.ts';
import { type ShopBuilding, buildShops } from './lib/shops.ts';
import { type FuelBuilding, isFuelCanopyFn, isFuelShopFn, planFuel } from './lib/fuel.ts';
import { signalJunctions } from './lib/signals.ts';
import { RoadLines, RoadMask } from './lib/clearance.ts';
import { halfWidths } from './lib/overlap.ts';
import { GroundIndex, rand } from './lib/ground.ts';
import { applyMeasuredWidths, loadAlkisRoads } from './lib/alkis.ts';
import { missing, roadHeights, terrainHeight } from './lib/heights.ts';
import { readOsm, pointInRing, type OsmJson } from './lib/osm.ts';
import { applyOsmFixes } from './lib/osmFixes.ts';
import { loadRegion, loadWorld, paths, unproject, useRoadProfile, type RegionConfig } from './lib/region.ts';
import { buildGraph } from './lib/graph.ts';
import { drawFillets, planFillets } from './lib/fillets.ts';
import { drawCalming, drawRoundaboutIslands, planTurningCircles } from './lib/roadDetails.ts';
import { Details, along } from './lib/details.ts';
import { buildIndustry } from './lib/industry.ts';
import { buildLeisure } from './lib/leisure.ts';
import { buildPower } from './lib/power.ts';
import { TRACK, buildRail, isTrack } from './lib/rail.ts';
import { fillSlots } from './lib/slots.ts';
import { smoothBends, splineCurves } from './lib/smooth.ts';
import { CarriagewayIndex, buildRoads, isBridge, isDrivable, roadProfile, roadWidth, sidewalkSides, sidewalkWidth, type Railing } from './lib/roads.ts';
import { PathMask, buildPaths, meshHeight } from './lib/paths.ts';
import { activeRoadProfile, KERB, noCars } from '../src/world/roadSpec.ts';
import { separateCarriageways } from './lib/carriageways.ts';
import { matchLevels } from './lib/levels.ts';
import { matchRampHeights, planRamps, rampList } from './lib/ramps.ts';
import { planKerbs } from './lib/kerbs.ts';
import { buildRoadside } from './lib/roadside.ts';
import { terrariumSampler } from './lib/terrain.ts';
import { MeshBuf, TileMap } from './lib/tilebuf.ts';
import { WaterLines } from './lib/waterways.ts';
import { fixtureOsm } from './fixture.ts';
import { buildFar } from './lib/far.ts';
import { PROP_NAMES, PROP_STRIDE, Prop, type PropKind } from '../src/world/propKinds.ts';
import { FootGrid, HouseIndex, buildGardens, houseRecords, planHouses, ringArea, type HouseCandidate } from './lib/houses.ts';
import { BUSH_STRIDE, Bush, type TreeKind } from '../src/world/vegKinds.ts';
import { areaDensity, areaTreeKind, areaTreeScale, isPark, treeKindOf } from './lib/vegetation.ts';
import { loadLidar } from './lib/lidar.ts';
import { categorize, loadMapillary } from './lib/mapillary.ts';
import { placeLidarTrees, type MeasuredTree } from './lib/lidarTrees.ts';
import { LANDCOVER_ATTRIBUTION, loadLandcover, roofColour, tileCover } from './lib/landcover.ts';
import { waterLevels, type TileGrid } from './lib/waterLevel.ts';

function main() {
  const { cfg, info, project } = loadWorld();
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const regions: RegionConfig[] = (ids.length ? ids : cfg.regions).map(loadRegion);
  console.log(`Road profile: ${useRoadProfile({ regions })}`);
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

  for (const line of applyOsmFixes(merged)) console.log(`OSM fix: ${line}`);
  const osm = readOsm(merged, project);
  const height = terrainHeight(regions, toLonLat, console.log, osm.polygons);
  // Game road profile: kinks in the mapped lines become short arcs, before anything reads the geometry.
  const smoothed = smoothBends(osm.ways, new Set(osm.points.map((p) => p.id)));
  if (smoothed) console.log(`Bends: ${smoothed} kinks rounded`);
  const curves = splineCurves(osm.ways);
  if (curves.ways) console.log(`Curves: ${curves.ways} ways as splines, ${curves.points} points added`);
  const tiles = new TileMap(info.tileSize);
  const measured = regions.reduce((n, r) => n + applyMeasuredWidths(osm.ways, loadAlkisRoads(r.id)), 0);
  console.log(`ALKIS: measured carriageway width on ${measured} streets`);
  const medians = separateCarriageways(osm.ways);
  console.log(`Motorway medians: ${medians.ways} carriageways moved apart over ${medians.km} km (up to ${medians.maxMove} m each)`);
  const ramps = planRamps(osm.ways);
  console.log(`Motorway junctions: ${ramps.stats.runs} auxiliary lanes, ${ramps.stats.moved} ramps moved onto them, ${ramps.stats.plain} ramps as mapped`);
  roadHeights(osm.ways, regions, height, console.log);
  matchRampHeights(ramps);
  const matched = matchLevels(osm.ways, height);
  console.log(`Levels: ${matched.ways} roads matched to the road they overlap (${matched.overlaps} samples), max. shift ${matched.maxShift.toFixed(2)} m`);
  // Kerbs and pavements only in built-up areas, on the mapped sides; the graph stores them for the game.
  const kerbs = planKerbs(osm.ways, osm.polygons, osm.points);
  console.log(`Kerbs: ${kerbs.urban} streets in town, ${kerbs.rural} rural without kerbs, ${kerbs.tagged} with mapped sidewalks, ${kerbs.crossings} lowered crossings`);
  const { graph, junctions, banned } = buildGraph(osm.ways, info, height, osm);
  console.log(`Turn restrictions: ${osm.restrictions?.length ?? 0} mapped → ${banned} banned turns · bus lines: ${graph.b?.length ?? 0} (${osm.busRoutes?.length ?? 0} routes)`);
  // Rounded junction corners (game road profile): kerbs, lamps and props keep clear of them like of a junction.
  const fillets = planFillets(osm.ways, height);
  const corners = fillets.length;
  // Turning circles at dead ends (roadDetails.ts) are fillets too.
  const turning = planTurningCircles(osm, height);
  fillets.push(...turning.fillets);
  for (const f of fillets) {
    const [x, z] = utmToLocal(info, f.node[0], f.node[1]);
    junctions.push({ x, z, width: 2 * Math.max(0, f.reach - 2.8) });
  }
  console.log(`Junction corners: ${corners} rounded · turning circles: ${turning.fillets.length} (${turning.skipped} left out: buildings or slope)`);
  const carve = new RoadCarve(TERRAIN_STEP);
  // Landmark models (real regions only): bridges they dress, and footprints whose generic buildings they replace.
  const real = regions.some((r) => r.boundary.type !== 'fixture');
  const landmarks = real ? readLandmarks(new URL('./landmarks.json', import.meta.url).pathname) : [];
  const railings: Railing[] = [];
  const dressed = new Set(landmarks.flatMap((l) => (l.bridge ? [l.bridge] : [])));
  const samples = buildRoads(osm.ways, info, height, tiles, junctions, carve, halfWidths(osm.ways, height, info), { dressed, railings }, ramps);
  drawFillets(fillets, info, tiles, carve);
  const calming = drawCalming(osm, info, tiles, height);
  console.log(`Traffic calming: ${calming.bumps} bumps, ${calming.tables} tables, ${calming.rings} mini roundabouts`);
  // Visual OSM details (details.ts): roundabout islands, rail, power and leisure grounds.
  const details = new Details(info, tiles);
  const islands = drawRoundaboutIslands(osm.ways, info, tiles, details, height);
  console.log(`Roundabout islands: ${islands.islands} raised, ${islands.spots.length - islands.islands} left open`);
  const rail = buildRail(osm, info, details, height);
  console.log(`Rail: ${rail.km.toFixed(1)} km track (${rail.electrifiedKm.toFixed(1)} km electrified, ${rail.masts} masts), ${rail.bridges} bridges, ${rail.crossings} level crossings`);
  const power = buildPower(osm, details, height);
  console.log(`Power: ${power.pylons} pylons, ${power.poles} poles, ${power.spans} spans, ${power.kiosks} transformer kiosks, ${power.substations} substations, ${power.solarRows} solar rows`);
  const leisure = buildLeisure(osm, details, height);
  console.log(`Leisure: ${leisure.pitches} pitches (${leisure.goals} goals, ${leisure.nets} nets, ${leisure.floodlights} floodlights), ${leisure.playgrounds} playgrounds (${leisure.equipment} items), ${leisure.pools} pools, ${leisure.fountains} fountain basins, ${leisure.tracks} running tracks`);
  // Narrow slots left between carriageways get patched, so no wheel drops between two roads.
  const slots = fillSlots(tiles, info);
  console.log(`Road slots: ${slots} cells of 0.5 m patched between carriageways`);
  // Footpaths, cycle paths and steps on the terrain mesh as carved for the roads, stopping at carriageways and sidewalks.
  const pathStats = (() => {
    // Scoped so the index is freed before the tiles are written.
    const lanes = new CarriagewayIndex();
    for (const w of osm.ways) {
      if (!isDrivable(w.tags) || isBridge(w.tags)) continue;
      const sides = sidewalkSides(w);
      lanes.add(w, roadProfile(w, height, info), roadWidth(w.tags)! / 2 + (sides.left || sides.right ? sidewalkWidth(w) : 0));
    }
    return buildPaths(osm.ways, info, meshHeight((e, n) => carve.apply(e, n, height.raw(e, n))), tiles, (x, z) => lanes.onOther(undefined, x, z, 0.2));
  })();
  graph.w = pathStats.lines;
  const km = (m: number) => (m / 1000).toFixed(1);
  console.log(`Paths: ${pathStats.lines.length} ways, ${Object.entries(pathStats.drawn).map(([k, m]) => `${k} ${km(m)} km`).join(', ')}; ${km(pathStats.clipped)} km on roads left out · closed to cars: ${graph.edges.filter((e) => e.x).length} graph edges`);
  const onPaths = new PathMask(osm.ways);
  // Main roads (tertiary and up) for shop fronts on the ground floor.
  const mainRoads = new RoadMask(osm.ways, 9, (t) => /^(primary|secondary|tertiary)$/.test(t.highway));
  // LoD2 models where the survey has them (the whole district), OSM outlines for everything else.
  const lod2Dir = regions.some((r) => r.lod2?.length) ? paths.lod2 : undefined;
  if (lod2Dir && !lod2TileCount(lod2Dir)) throw missing('LoD2', lod2Dir, regions);
  const landmarkFoot = landmarkArea(landmarks);
  const centre = (r: [number, number][]) => r.reduce(([a, b], [e, n]) => [a + e / r.length, b + n / r.length], [0, 0]);
  const footprints = new Footprints();
  // LoD2 buildings that may become freely designed houses (houses.ts): one ground ring each.
  const lod2Rings: { id: string; ring: [number, number][]; fn: string; parts: number }[] = [];
  const fuelBuildings: FuelBuilding[] = [];
  if (lod2Dir) for (const b of lod2Buildings(lod2Dir)) if (!isTrafficStructure(b)) {
    footprints.add(b.ground);
    if (b.ground.length) lod2Rings.push({ id: b.id, ring: b.ground.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a)), fn: b.fn, parts: b.ground.length });
    for (const ring of b.ground) fuelBuildings.push({ ring, kind: isFuelCanopyFn(b.fn) ? 'canopy' : isFuelShopFn(b.fn) ? 'shop' : 'other' });
  }
  for (const p of osm.polygons)
    if (p.tags.building && !footprints.covers(p.outer)) fuelBuildings.push({ ring: p.outer, kind: /^(roof|canopy)$/.test(p.tags.building) ? 'canopy' : 'other' });
  const onRoad = new RoadMask(osm.ways);
  // Tree trunks, fences and hedges keep clear of the carriageway edge too: narrow roads are mapped narrower
  // than the car drives them, and the car must not clip them.
  const nearLanes = new RoadMask(osm.ways, 0.5);
  // Petrol stations: canopies, pumps, shops and price pylons; the survey's canopy blocks make way for them.
  // Service roads through the forecourt are checked against their centreline in fuel.ts.
  const fuelLanes = new RoadMask(osm.ways, 0.5, (t) => !/^(service|track)$/.test(t.highway));
  const fuel = planFuel(osm, { world: info, height, nearLanes: (e, n) => fuelLanes.has(e, n), onRoad: (e, n) => onRoad.has(e, n), buildings: fuelBuildings });
  fuelBuildings.length = 0;
  console.log(`Petrol stations: ${fuel.list.length} of ${fuel.zones} placed (${fuel.list.filter((f) => f.mapped).length} on the surveyed canopy, ${fuel.list.reduce((a, f) => a + f.pumps, 0)} pumps)${fuel.failed.length ? `, no room: ${fuel.failed.join(', ')}` : ''}`);
  // Only where the region has something already (roads, OSM buildings): the survey tiles reach past it.
  const T0 = info.tileSize;
  const used = new Set(tiles.tiles.keys());
  for (const p of osm.polygons) if (p.tags.building && p.outer.length) used.add(`${Math.floor(p.outer[0][0] / T0)}_${Math.floor(p.outer[0][1] / T0)}`);
  const outside = (b: Lod2Building) => {
    const r = b.ground[0] ?? [];
    return !r.length || !used.has(`${Math.floor(r[0][0] / T0)}_${Math.floor(r[0][1] / T0)}`);
  };
  // Land cover from the aerial survey (pipeline/landcover.ts), where a region has it; also the measured roof colours.
  const landcover = regions.map((r) => (r.boundary.type === 'fixture' ? undefined : loadLandcover(r.id))).find((l) => l);
  if (landcover) console.log(`Land cover: ${landcover.tiles} survey tiles of 2 km`);
  // Roof colours per tile for roof.at: local x, z and sRGB.
  const roofInfo = new Map<string, number[]>();
  const roofColourAt = (e: number, n: number) => {
    const m = landcover?.roofAt(e, n);
    if (!m) return undefined;
    const c = roofColour(m);
    const k = tileKey(Math.floor(e / info.tileSize), Math.floor(n / info.tileSize));
    if (!roofInfo.has(k)) roofInfo.set(k, []);
    roofInfo.get(k)!.push(...utmToLocal(info, e, n).map((v) => Math.round(v * 10) / 10), ...c);
    return c;
  };
  // Buildings a road runs through (canopies, garages, passages the survey models solid) would block it.
  const lines = new RoadLines(osm.ways);
  let blocking = 0;
  const blocks = (rings: [number, number][][]) => {
    const hit = rings.some((r) => lines.through(r) !== undefined);
    if (hit) blocking++;
    return hit;
  };
  // Freely designed houses, villas and administrative buildings in place of fitting surveyed ones (houses.ts).
  const houseRoad = new RoadMask(osm.ways, 2.0);
  houseRoad.addFillets(fillets);
  const osmKept = osm.polygons.filter((p) => p.tags.building && p.tags.building !== 'no' && p.outer.length > 3 && !footprints.covers(p.outer.slice(0, -1)) && !landmarkFoot.contains(...centre(p.outer.slice(0, -1))));
  const lod2Kept = lod2Rings.filter((b) => {
    const r = b.ring;
    return r.length >= 3 && used.has(`${Math.floor(r[0][0] / T0)}_${Math.floor(r[0][1] / T0)}`) && !landmarkFoot.contains(...centre(r)) && lines.through(r) === undefined;
  });
  const houseCands: HouseCandidate[] = [
    ...lod2Kept.filter((b) => b.parts === 1).map((b) => ({ key: `L${b.id}`, outer: b.ring, tags: lod2Tags(b.fn), fn: b.fn })),
    ...osmKept.filter((p) => !p.holes.length && lines.through(p.outer.slice(0, -1)) === undefined).map((p) => ({ key: `O${p.id}`, outer: p.outer.slice(0, -1), tags: p.tags })),
  ];
  const allFoot = [...lod2Rings.map((b) => ({ key: `L${b.id}`, ring: b.ring })), ...osmKept.map((p) => ({ key: `O${p.id}`, ring: p.outer.slice(0, -1) }))];
  const houses = planHouses(houseCands, {
    world: info, height, onRoad: (e, n) => houseRoad.has(e, n), onPath: (e, n) => onPaths.has(e, n),
    centre: (e, n) => Math.hypot(e - info.originE, n - info.originN), footprints: allFoot,
  });
  const houseRecs = houseRecords(houses.plans, info);
  console.log(`Houses: ${houses.plans.length} freely designed (${Object.entries(houseRecs.counts).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(', ')}) · kept real: ${Object.entries(houses.rejected).map(([k, c]) => `${k} ${c}`).join(', ') || '-'}`);
  const keptFoot = new FootGrid([...lod2Rings.filter((b) => !houses.replaced.has(`L${b.id}`)).map((b) => b.ring), ...osmKept.filter((p) => !houses.replaced.has(`O${p.id}`)).map((p) => p.outer.slice(0, -1))]);
  const houseIndex = new HouseIndex(houses.plans);
  const shopBuildings: ShopBuilding[] = [];
  const onBuilding = (b: ShopBuilding) => shopBuildings.push(b);
  const lod2 = buildLod2(lod2Dir ? lod2Buildings(lod2Dir) : [], info, height, tiles, { mainRoad: (e, n) => mainRoads.has(e, n), onBuilding, roofColour: roofColourAt, skip: (b) => isTrafficStructure(b) || houses.replaced.has(`L${b.id}`) || outside(b) || b.ground.some(fuel.skip) || (!!b.ground[0] && landmarkFoot.contains(...centre(b.ground[0]))) || blocks(b.ground) });
  const nBuildings = buildBuildings(osm.polygons.filter((p) => !houses.replaced.has(`O${p.id}`)), info, height, tiles, { mainRoad: (e, n) => mainRoads.has(e, n), skip: (o) => footprints.covers(o) || fuel.skip(o) || landmarkFoot.contains(...centre(o)) || blocks([o]), onBuilding, roofColour: roofColourAt });
  if (landcover) console.log(`Roofs: ${[...roofInfo.values()].reduce((a, v) => a + v.length / 5, 0)} buildings with their surveyed colour`);
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

  // Heath areas are extra features (osmTags.ts); they count as grass ground.
  const ground = new GroundIndex([...osm.polygons, ...(osm.extra?.areas ?? []).filter((a) => a.tags.natural === 'heath')]);
  let coverTiles = 0;
  const water = new WaterLines(osm.ways);
  const waterways = water.polylines(info, height);
  // Lamps stand beside their own road; drop the ones that end up on another road's lanes.
  const onLanes = new RoadMask(osm.ways, -0.5);
  const onMotorLanes = new RoadMask(osm.ways, -0.5, (t) => !noCars(t));
  // Trees a little further: their trunk collider is up to TREE_COLLIDER_MAX wide and the mask is a 2 m grid.
  const treeLanes = new RoadMask(osm.ways, 1.0);
  // No trees or bushes on the railway beds (rail.ts).
  const railBed = new RoadMask([], 0.5);
  railBed.addLines((osm.extra?.ways ?? []).filter((w) => isTrack(w.tags)).map((w) => ({ pts: w.pts, half: TRACK.bedBottom / 2 })));
  treeLanes.addLines((osm.extra?.ways ?? []).filter((w) => isTrack(w.tags)).map((w) => ({ pts: w.pts, half: TRACK.bedBottom / 2 })));
  for (const m of [onRoad, onLanes, onMotorLanes, nearLanes, treeLanes]) m.addFillets(fillets);
  const industry = buildIndustry(osm, details, height, (e, n) => onRoad.has(e, n), (e, n) => keptFoot.inside(e, n));
  console.log(`Industry: ${industry.chimneys} chimneys, ${industry.masts} masts, ${industry.tanks} tanks, ${industry.waterTowers} water towers, ${industry.pipesKm.toFixed(1)} km pipelines, ${industry.conveyorsKm.toFixed(1)} km conveyors, ${industry.piers} piers, ${industry.weirs} weirs/dams/lock gates`);
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
    skip: (e, n) => treeLanes.has(e, n) || onPaths.has(e, n) || ground.at(e, n, Ground.grass) === Ground.forest,
    tagsAt: (e, n) => ground.tagsAt(e, n), mapped, rand,
  });
  for (const t of lidar.trees) addTree(t.e, t.n, t.scale, t.kind, t.crown);
  // Grid of the measured trees, so park trees are only added in the gaps between them.
  const MEASURED_CELL = 16;
  const measuredGrid = new Map<string, [number, number, number][]>();
  for (const t of lidar.trees) {
    const k = `${Math.floor(t.e / MEASURED_CELL)}_${Math.floor(t.n / MEASURED_CELL)}`;
    if (!measuredGrid.has(k)) measuredGrid.set(k, []);
    measuredGrid.get(k)!.push([t.e, t.n, t.crown / 10]);
  }
  const nearMeasured = (e: number, n: number, gap: number) => {
    const ce = Math.floor(e / MEASURED_CELL), cn = Math.floor(n / MEASURED_CELL);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const [te, tn, cr] of measuredGrid.get(`${ce + a}_${cn + b}`) ?? []) if (Math.hypot(te - e, tn - n) < cr + gap) return true;
    return false;
  };
  // Low crowns along a measured hedge are the hedge itself (props): no bush on top of it.
  const hedgeCells = new Set<string>();
  for (const h of landcover?.hedges ?? [])
    for (let i = 1; i < h.length; i++) {
      const l = Math.hypot(h[i][0] - h[i - 1][0], h[i][1] - h[i - 1][1]);
      for (let d = 0; d <= l; d += 1) hedgeCells.add(`${Math.round(h[i - 1][0] + ((h[i][0] - h[i - 1][0]) * d) / (l || 1))}_${Math.round(h[i - 1][1] + ((h[i][1] - h[i - 1][1]) * d) / (l || 1))}`);
    }
  const onHedge = (e: number, n: number) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (hedgeCells.has(`${Math.round(e) + a}_${Math.round(n) + b}`)) return true;
    return false;
  };
  let hedgeBushes = 0;
  for (const [e, n, s] of lidar.bushes) {
    if (onHedge(e, n)) { hedgeBushes++; continue; }
    addBush(e, n, s, Bush.round);
  }
  mapped.forEach((t, i) => { if (!lidar.merged.has(i) && !treeLanes.has(t.e, t.n)) addTree(t.e, t.n, 0.8 + rand(t.e, t.n) * 0.5, t.kind); });
  // Mapped tree rows (natural=tree_row) outside the LiDAR survey: a tree every 9 m where none is mapped near.
  let rowTrees = 0;
  const lidarCovered = (e: number, n: number) => coverage.some(([e0, n0, e1, n1]) => e >= e0 && e < e1 && n >= n0 && n < n1);
  for (const w of osm.extra?.ways ?? []) {
    if (w.tags.natural !== 'tree_row') continue;
    for (const p of along(w.pts, 9)) {
      if (lidarCovered(p.e, p.n) || treeLanes.has(p.e, p.n) || onPaths.has(p.e, p.n) || nearMeasured(p.e, p.n, 2)) continue;
      if (mapped.some((t) => Math.abs(t.e - p.e) < 4 && Math.abs(t.n - p.n) < 4)) continue;
      addTree(p.e, p.n, 0.85 + rand(p.e, p.n) * 0.4, treeKindOf(w.tags, rand(p.e, p.n, 31)));
      rowTrees++;
    }
  }
  console.log(`Tree rows: ${rowTrees} trees added outside the LiDAR survey`);
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
  // Text signs (place names, street names, direction and motorway signs); places beyond the region from the far view extract.
  const farPlaces: Place[] = [];
  for (const r of regions) {
    const f = `${paths.raw(r.id)}far-osm.json`;
    if (!existsSync(f)) continue;
    for (const el of (JSON.parse(readFileSync(f, 'utf8')) as OsmJson).elements)
      if (el.type === 'node' && el.tags?.place && el.tags.name) farPlaces.push({ name: el.tags.name, place: el.tags.place, ...((([e, n]) => ({ e, n }))(project(el.lon, el.lat))) });
  }
  const guide = buildGuideSigns(osm, { world: info, height, farPlaces });
  console.log(`Guide signs: ${Object.entries(guide.counts).map(([k, c]) => `${k} ${c}`).join(', ')} (${farPlaces.length} places beyond the region) · skipped: ${Object.entries(guide.skipped).map(([k, c]) => `${k} ${c}`).join(', ')}`);
  // Mapped place-name signs replace the generic ones where roads cross the postal boundary.
  const cityLimits = guide.counts.ort === 0;
  // Survey hedges and ALKIS walls reach beyond the OSM extract (the ALKIS walls cover the whole district):
  // only the ones on tiles with OSM content, where the terrain is fetched.
  const inData = (l: [number, number][]) => l.every(([e, n]) => used.has(`${Math.floor(e / T0)}_${Math.floor(n / T0)}`));
  const props = buildProps(osm, { world: info, height, onLanes: (e, n) => onLanes.has(e, n), onMotorLanes: (e, n) => onMotorLanes.has(e, n), nearLanes: (e, n) => nearLanes.has(e, n), junctions, boundary: osm.boundary, detected, cityLimits, railings, hedges: landcover?.hedges.filter(inData), walls: landcover?.walls.filter(inData) });
  console.log(`Bollards at ${props.entries} entrances to pedestrian zones and roads closed to cars`);
  console.log(`Mapillary: ${detected.length} features, ${props.detected} new as props, ${detectedLights.length} traffic lights`);
  // Stall lines: 12 cm wide, 4.8 m long, in two pieces that follow the ground, 4 cm above it.
  const stallBufs = new Map<string, MeshBuf>();
  for (let i = 0; i < props.stallLines.length; i += 4) {
    const [e, n, de, dn] = props.stallLines.slice(i, i + 4);
    const k = tileKey(Math.floor(e / info.tileSize), Math.floor(n / info.tileSize));
    if (!stallBufs.has(k)) stallBufs.set(k, new MeshBuf());
    const buf = stallBufs.get(k)!;
    const pt = (t: number, s: number) => {
      const pe = e + de * t + dn * s, pn = n + dn * t - de * s;
      const [x, z] = utmToLocal(info, pe, pn);
      return buf.vertex(x, height(pe, pn) + 0.04, z);
    };
    const row = [-2.4, 0, 2.4].map((t) => [pt(t, -0.06), pt(t, 0.06)]);
    for (let j = 1; j < row.length; j++) {
      const [a, b] = row[j - 1], [c, d] = row[j];
      // a → b runs right across the line, a → c along it: counter-clockwise seen from above.
      buf.tri(a, b, c);
      buf.tri(b, d, c);
    }
  }
  console.log(`Car parks: ${props.stallLines.length / 4} painted stall lines`);
  if (landcover) console.log(`Hedges: ${landcover.hedges.length} measured from the laser heights, ${props.measuredHedges} pieces placed, ${hedgeBushes} bushes on them dropped; ${props.alkisWalls} wall pieces from ALKIS`);
  const shops = buildShops(osm, { world: info, height, onRoad: (e, n) => onRoad.has(e, n), onLanes: (e, n) => onLanes.has(e, n), buildings: shopBuildings });
  // Front gardens of the designed houses, where no surveyed fence, wall or hedge runs already.
  const barrierCells = new Set<string>();
  for (const list of props.tiles.values())
    for (let i = 0; i + PROP_STRIDE <= list.length; i += PROP_STRIDE) {
      if (list[i] !== Prop.fence && list[i] !== Prop.wall && list[i] !== Prop.hedge) continue;
      const [e, n] = localToUtm(info, list[i + 1], list[i + 3]);
      const len = Math.abs(list[i + 5]), h = list[i + 4];
      // Linear props run along their heading: local (sin h, cos h) is UTM (sin h, -cos h).
      for (let d = -len / 2; d <= len / 2; d += 1) barrierCells.add(`${Math.round(e + Math.sin(h) * d)}_${Math.round(n - Math.cos(h) * d)}`);
    }
  const gardens = buildGardens(houses.plans, {
    world: info, height, onRoad: (e, n) => houseRoad.has(e, n), onPath: (e, n) => onPaths.has(e, n), inBuilding: (e, n) => keptFoot.inside(e, n),
    barrier: (e, n) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (barrierCells.has(`${Math.round(e) + a}_${Math.round(n) + b}`)) return true; return false; },
  });
  console.log(`Gardens: ${gardens.gardens} front gardens · ${Object.entries(gardens.counts).map(([k, c]) => `${k} ${c}`).join(', ') || '-'}`);
  console.log(`Shops: ${shops.placedMapped}/${shops.mapped} mapped placed · ${Object.entries(shops.counts).map(([k, c]) => `${k} ${c}`).join(', ') || '-'}`);
  // Guard rails, delineators and chevron boards outside town (roadside.ts).
  const roadside = buildRoadside(osm.ways, { world: info, height, onLanes: (e, n) => onLanes.has(e, n), dressed });
  for (const [k, list] of rail.props) {
    if (!props.tiles.has(k)) props.tiles.set(k, []);
    props.tiles.get(k)!.push(...list);
  }
  for (const [k, list] of roadside.props) {
    if (!props.tiles.has(k)) props.tiles.set(k, []);
    props.tiles.get(k)!.push(...list);
  }
  const railTiles = roadside.rails.tiles();
  const rc = roadside.counts;
  console.log(`Roadside: ${rc.railKm} km guard rail (${rc.motorway} motorway, ${rc.medianKm} km double median, ${rc.bridges} bridge, ${rc.mapped} mapped runs, ${rc.embankments} embankment roads), ${rc.posts} delineators, ${rc.chevrons} chevron boards`);
  console.log(`Props: ${Object.entries(props.counts).map(([k, c]) => `${PROP_NAMES[Number(k) as PropKind]} ${c}`).join(', ') || '-'}`);

  // Trees and bushes the designed houses (a little larger than the real footprints) would swallow.
  let clearedTrees = 0;
  for (const [k, list] of treesByTile) {
    const kinds = treeKindsByTile.get(k)!, crowns = treeCrownsByTile.get(k)!;
    const keep: number[] = [], keepK: number[] = [], keepC: number[] = [];
    for (let i = 0, j = 0; i < list.length; i += 4, j++) {
      if (houseIndex.covers(...localToUtm(info, list[i], list[i + 2]), 0.8)) { clearedTrees++; continue; }
      keep.push(...list.slice(i, i + 4)); keepK.push(kinds[j]); keepC.push(crowns[j]);
    }
    treesByTile.set(k, keep); treeKindsByTile.set(k, keepK); treeCrownsByTile.set(k, keepC);
  }
  for (const [k, list] of bushesByTile) {
    const keep: number[] = [];
    for (let i = 0; i < list.length; i += 5) if (!houseIndex.covers(...localToUtm(info, list[i], list[i + 2]), 0.5)) keep.push(...list.slice(i, i + 5));
    bushesByTile.set(k, keep);
  }
  console.log(`Houses: ${clearedTrees} trees inside the designed houses removed`);

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

  const osmLamps = new Map<string, typeof props.lamps>();
  for (const l of props.lamps) {
    const k = tileKey(Math.floor(l.e / T), Math.floor(l.n / T));
    if (!osmLamps.has(k)) osmLamps.set(k, []);
    osmLamps.get(k)!.push(l);
  }
  let mappedLamps = 0;
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
            if (onRoad.has(te, tn) || railBed.has(te, tn) || onPaths.has(te, tn) || ground.at(te, tn, Ground.grass) !== cls) continue;
            if (i < nt) {
              // Trunks keep clear of the carriageway like the measured trees.
              if (treeLanes.has(te, tn)) continue;
              // Inside the LiDAR survey the measured trees stand already: parks get more only in the gaps between
              // them, other green stays as measured.
              if (cls !== Ground.forest && lidar.covered(te, tn) && (!isPark(tags) || nearMeasured(te, tn, 4))) continue;
              addTree(te, tn, areaTreeScale(tags, cls === Ground.forest, rand(te, tn)), areaTreeKind(tags, rand(te, tn, 7)));
            }
            else addBush(te, tn, 0.6 + rand(te, tn, 8) * 0.8, tags?.natural === 'scrub' || cls === Ground.forest ? Bush.scrub : Bush.round);
          }
        }
      }
    const b = tiles.tiles.get(k);
    const tile: TileData = {
      v: 1, ix, iy, terrain: encode(h), ground: encode(g),
      roads: b?.roads.pack(), markings: b?.markings.pack(), buildings: b?.buildings.pack(), collide: b?.collide.pack(),
      sidewalks: b?.sidewalks.pack(), stalls: stallBufs.get(k)?.pack(), paths: b?.paths.pack(), details: b?.details.pack(),
    };
    const cover = landcover && tileCover(landcover, E0, N0, g);
    if (cover) {
      tile.splat = encode(cover.splat);
      tile.rows = encode(cover.rows);
      tile.tint = encode(cover.tint);
      coverTiles++;
    }
    const lamps = offLanes(b?.lamps ?? []);
    // Mapped lamps where the generated ones have none within 12 m.
    for (const l of osmLamps.get(k) ?? []) {
      let near = false;
      for (let i = 0; i < lamps.length && !near; i += 4) near = Math.hypot(lamps[i] - l.x, lamps[i + 2] - l.z) < 12;
      if (!near) { lamps.push(l.x, l.y, l.z, l.heading); mappedLamps++; }
    }
    if (lamps.length) tile.lamps = encode(new Float32Array(lamps.map((v) => Math.round(v * 100) / 100)));
    const ri = roofInfo.get(k);
    if (ri) tile.roofInfo = encode(new Float32Array(ri));
    const bi = lod2.info.get(k);
    if (bi) tile.bldInfo = encode(new Float32Array(bi));
    const wl = levels.get(k);
    if (wl) tile.waterLevel = encode(wl);
    const ww = waterways.get(k);
    if (ww) tile.waterways = encode(new Float32Array(ww));
    const trees = treesByTile.get(k);
    if (trees?.length) tile.trees = encode(new Float32Array(trees.map((v) => Math.round(v * 100) / 100)));
    const treeKinds = treeKindsByTile.get(k);
    if (treeKinds?.length) tile.treeKinds = encode(new Uint8Array(treeKinds));
    const crowns = treeCrownsByTile.get(k);
    if (crowns?.some((c) => c > 0)) tile.treeCrowns = encode(new Uint8Array(crowns));
    const bushes = bushesByTile.get(k);
    if (bushes?.length) tile.bushes = encode(new Float32Array(bushes.map((v) => Math.round(v * 100) / 100)));
    const rails = railTiles.get(k);
    if (rails) tile.rails = encode(new Float32Array(rails));
    const tileFuel = fuel.tiles.get(k);
    if (tileFuel) tile.fuel = encode(new Float32Array(tileFuel));
    const tileHouses = houseRecs.tiles.get(k);
    if (tileHouses) tile.houses = encode(new Float32Array(tileHouses));
    const tileGardens = gardens.tiles.get(k);
    if (tileGardens) tile.gardens = encode(new Float32Array(tileGardens));
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
    roadProfile: activeRoadProfile(),
    ...(corners || smoothed || curves.ways || slots ? { roadShape: { corners, slots, bends: smoothed, curves: curves.ways, curvePoints: curves.points } } : {}),
    spawn: best ? { x: best.x, y: best.y + 1.5, z: best.z, heading: best.heading } : { x: 0, y: height(se, sn) + 2, z: 0, heading: 0 },
    attribution: regions.some((r) => r.boundary.type !== 'fixture')
      ? ['Kartendaten © OpenStreetMap-Mitwirkende (ODbL)',
        ...(regions.some((r) => r.laser) ? ['Gelände und Brücken: © GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0'] : []),
        ...(lod2.count ? [LOD2_ATTRIBUTION] : []),
        ...(coverTiles ? [LANDCOVER_ATTRIBUTION] : []),
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
    idx.far = { size: FAR_TILE_SIZE, n: FAR_N, tiles: buildFar({ info, polygons: farOsm.polygons, box: { e0, n0, e1, n1 }, height: farHeight, colour: landcover && ((e, n) => landcover.colourAt(e, n)), out: paths.out }) };
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
  writeFileSync(`${paths.out}fuel.json`, JSON.stringify({ v: 1, stations: fuel.list }));
  const districts = districtList(osm, (e, n) => utmToLocal(info, e, n));
  writeFileSync(`${paths.out}districts.json`, JSON.stringify({ v: 1, districts }));
  console.log(`Districts: ${districts.map((d) => d.name).join(', ') || '–'}`);
  writeFileSync(`${paths.out}signs.json`, JSON.stringify({ v: 1, signs: guide.signs }));
  writeFileSync(`${paths.out}bridges.json`, JSON.stringify({ v: 1, bridges: bridgeDeckList(osm.ways, height, info) }));
  writeFileSync(`${paths.out}ramps.json`, JSON.stringify(rampList(ramps, info, medians.points)));
  // Flattened plazas (plazas.ts) for the plaza command: [name, x, z, plane height, area m², RMS cm, tilt %].
  writeFileSync(`${paths.out}plazas.json`, JSON.stringify({ v: 1, plazas: height.plazas.map((p) => {
    const [x, z] = utmToLocal(info, p.e0, p.n0);
    return [p.name, Math.round(x * 10) / 10, Math.round(z * 10) / 10, Math.round(p.y0 * 100) / 100, Math.round(p.area), Math.round(p.rms * 100), Math.round(Math.hypot(p.ge, p.gn) * 1000) / 10];
  }) }));
  // OSM details placed by the pipeline, for the osm.details command: [kind, x, z, note].
  writeFileSync(`${paths.out}details.json`, JSON.stringify({ v: 1, spots: [...turning.spots, ...calming.spots, ...islands.spots, ...rail.spots, ...power.spots, ...leisure.spots, ...industry.spots].map((s) => {
    const [x, z] = utmToLocal(info, s.e, s.n);
    return [s.kind, Math.round(x * 10) / 10, Math.round(z * 10) / 10, s.note];
  }) }));
  writeFileSync(`${paths.out}index.json`, JSON.stringify(idx));
  const nTrees = [...treeKindsByTile.values()].reduce((a, v) => a + v.length, 0);
  const nBushes = [...bushesByTile.values()].reduce((a, v) => a + v.length / BUSH_STRIDE, 0);
  console.log(`Vegetation: ${nTrees} trees (${lidar.trees.length} from LiDAR, ${lidar.merged.size} of them mapped in OSM), ${nBushes} bushes`);
  if (landcover) console.log(`Land cover: ${coverTiles} tiles with survey colours and textures`);
  console.log(`Street lamps: ${mappedLamps} of ${props.lamps.length} mapped ones added where the generated rows have none`);
  console.log(`Tiles: ${index.length} (${(bytes / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${paths.out}`);
}

try {
  main();
} catch (e) {
  console.error((e as Error).message ?? e);
  process.exit(1);
}
