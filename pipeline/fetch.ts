// Downloads raw map data for a region into data/raw/<region>/.
//   node pipeline/fetch.ts saarlouis
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { extractRegion } from './lib/pbf.ts';
import { farWanted } from './lib/far.ts';
import { fetchLaserTiles } from './lib/laser.ts';
import { loadRegion, loadWorld, paths, type RegionConfig } from './lib/region.ts';
import { fetchTerrarium, tilesForBbox } from './lib/terrain.ts';

const OVERPASS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// Overpass rejects generic clients; identify the project as its usage policy asks.
const HEADERS = { 'User-Agent': 'sls-racing-pipeline/0.1 (+https://github.com/timo-hoen-ias/sls-racing)', Accept: 'application/json' };

function overpassQuery(area: string, f: string): string {
  return `[out:json][timeout:300];
${area}
(
  way["highway"]${f};
  way["building"]${f};
  relation["building"]${f};
  relation["type"="multipolygon"]["building"]${f};
  way["landuse"]${f};
  relation["type"="multipolygon"]["landuse"]${f};
  way["natural"~"water|wood|scrub|grassland"]${f};
  relation["type"="multipolygon"]["natural"~"water|wood"]${f};
  way["waterway"="riverbank"]${f};
  way["waterway"~"^(river|stream|canal|ditch|drain)$"]${f};
  way["leisure"~"park|pitch|garden|playground"]${f};
  way["amenity"="parking"]${f};
  node["natural"="tree"]${f};
  node["highway"~"^(traffic_signals|stop|give_way|bus_stop|street_lamp|motorway_junction)$"]${f};
  node["place"~"^(city|town|village|suburb|quarter|hamlet)$"]${f};
  node["barrier"~"^(bollard|block)$"]${f};
  node["amenity"~"^(bench|waste_basket|post_box|bicycle_parking|telephone|vending_machine|recycling)$"]${f};
  node["emergency"="fire_hydrant"]${f};
  node["advertising"="column"]${f};
  node["traffic_sign"]${f};
  way["barrier"~"^(fence|wall|hedge|guard_rail)$"]${f};
);
(._;>;);
out body;`;
}

/** Runs a query, rotating through public Overpass servers with exponential backoff when they are busy. */
async function overpass(query: string) {
  let wait = 15;
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, { method: 'POST', headers: HEADERS, body: new URLSearchParams({ data: query }) });
      if (res.ok) return (await res.json()) as { elements: any[] };
      last = `${new URL(url).host}: HTTP ${res.status} ${(await res.text()).slice(0, 120).replace(/\s+/g, ' ')}`;
    } catch (e) {
      last = `${new URL(url).host}: ${(e as Error).message}`;
    }
    console.log(`  ${last} → retry in ${wait} s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    wait *= 2;
  }
  throw new Error(`Overpass failed: ${last}`);
}

/** Downloads the first reachable PBF extract (cached for a day) and returns its path. */
async function downloadExtract(urls: string[]): Promise<string> {
  const dir = paths.raw('extracts');
  mkdirSync(dir, { recursive: true });
  let last = '';
  for (const url of urls) {
    const file = dir + new URL(url).pathname.split('/').pop();
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 86_400_000) return file;
    console.log(`Extract: ${url} …`);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
      renameSync(`${file}.part`, file);
      console.log(`  ${(statSync(file).size / 1e6).toFixed(1)} MB → ${file}`);
      return file;
    } catch (e) {
      last = `${new URL(url).host}: ${(e as Error).message}`;
      console.log(`  ${last}`);
    }
  }
  throw new Error(`No extract reachable: ${last}`);
}

async function fetchOverpass(region: RegionConfig) {
  let area = '';
  let filter: string;
  let boundaryQuery = '';
  if (region.boundary.type === 'postal_code') {
    area = `area["boundary"="postal_code"]["postal_code"="${region.boundary.value}"]->.a;`;
    filter = '(area.a)';
    boundaryQuery = `[out:json];relation["boundary"="postal_code"]["postal_code"="${region.boundary.value}"];(._;>;);out body;`;
  } else if (region.boundary.type === 'bbox') {
    const b = region.boundary;
    filter = `(${b.south},${b.west},${b.north},${b.east})`;
  } else throw new Error('Overpass needs a postal_code or bbox boundary');
  console.log(`Overpass: ${region.name} …`);
  const json = await overpass(overpassQuery(area, filter));
  if (boundaryQuery) json.elements.push(...(await overpass(boundaryQuery)).elements);
  return json;
}

async function main() {
  const id = process.argv[2] ?? 'saarlouis';
  const region = loadRegion(id);
  const dir = paths.raw(id);
  mkdirSync(dir, { recursive: true });
  if (region.boundary.type === 'fixture') {
    console.log('Fixture region needs no download.');
    return;
  }

  const osmFile = `${dir}osm.json`;
  if (!existsSync(osmFile) || process.argv.includes('--force')) {
    // Prefer a PBF extract: one static download instead of a heavy query on shared Overpass servers.
    const useOverpass = process.argv.includes('--overpass') || !region.osm?.extracts.length;
    let json;
    if (useOverpass) json = await fetchOverpass(region);
    else {
      const pbf = await downloadExtract(region.osm!.extracts);
      console.log(`Cut ${region.name} from ${pbf} …`);
      const b = region.boundary;
      json = extractRegion(pbf, {
        postalCode: b.type === 'postal_code' ? b.value : undefined,
        bbox: b.type === 'bbox' ? b : undefined,
        marginMeters: region.marginMeters,
      });
    }
    writeFileSync(osmFile, JSON.stringify(json));
    console.log(`  ${json.elements.length} OSM elements → ${osmFile}`);
  }

  if (region.terrain.source === 'terrarium') {
    const osm = JSON.parse(readFileSync(osmFile, 'utf8'));
    let west = 180, south = 90, east = -180, north = -90;
    for (const el of osm.elements) {
      if (el.type !== 'node') continue;
      west = Math.min(west, el.lon); east = Math.max(east, el.lon);
      south = Math.min(south, el.lat); north = Math.max(north, el.lat);
    }
    const pad = 0.01;
    const tiles = tilesForBbox(west - pad, south - pad, east + pad, north + pad, region.terrain.zoom);
    const n = await fetchTerrarium(paths.terrain, tiles, region.terrain.zoom);
    console.log(`Terrain: ${tiles.length} tiles (${n} new) at z${region.terrain.zoom}`);
  }

  // Far view: buildings and land cover in a wide ring (no roads), coarse terrain beyond the region.
  if (region.far && region.osm?.extracts.length) {
    const farFile = `${dir}far-osm.json`;
    if (!existsSync(farFile) || process.argv.includes('--force')) {
      const pbf = await downloadExtract(region.osm.extracts);
      console.log(`Far view: cut ${region.far.marginMeters} m around ${region.name} …`);
      const b = region.boundary;
      const json = extractRegion(pbf, {
        postalCode: b.type === 'postal_code' ? b.value : undefined,
        bbox: b.type === 'bbox' ? b : undefined,
        marginMeters: region.far.marginMeters,
        keep: farWanted,
        trees: false,
      });
      writeFileSync(farFile, JSON.stringify(json));
      console.log(`  ${json.elements.length} OSM elements → ${farFile}`);
    }
    let west = 180, south = 90, east = -180, north = -90;
    for (const el of JSON.parse(readFileSync(farFile, 'utf8')).elements) {
      if (el.type !== 'node') continue;
      west = Math.min(west, el.lon); east = Math.max(east, el.lon);
      south = Math.min(south, el.lat); north = Math.max(north, el.lat);
    }
    const tiles = tilesForBbox(west, south, east, north, region.far.zoom);
    const n = await fetchTerrarium(paths.terrain, tiles, region.far.zoom);
    console.log(`Far terrain: ${tiles.length} tiles (${n} new) at z${region.far.zoom}`);
  }
  if (region.laser || region.lod2) await fetchLaser(region, JSON.parse(readFileSync(osmFile, 'utf8')));
}

/**
 * DGM1 for every km tile that holds part of a way (so every tile the build emits); DOM1 only where there are
 * bridges; LoD2 building models wherever there are buildings.
 */
async function fetchLaser({ laser, lod2 }: RegionConfig, osm: { elements: any[] }) {
  const { project } = loadWorld();
  const nodes = new Map<number, [number, number]>();
  for (const el of osm.elements) if (el.type === 'node') nodes.set(el.id, project(el.lon, el.lat));
  const km = (pred: (tags: Record<string, string>) => boolean) => {
    const set = new Set<string>();
    for (const el of osm.elements)
      if (el.type === 'way' && pred(el.tags ?? {}))
        for (const id of el.nodes) {
          const p = nodes.get(id);
          if (p) set.add(`${Math.floor(p[0] / 1000)}_${Math.floor(p[1] / 1000)}`);
        }
    return [...set].map((k) => k.split('_').map(Number) as [number, number]);
  };
  if (lod2?.length) {
    const b = await fetchLaserTiles(paths.lod2, lod2, km((t) => !!t.building && t.building !== 'no'), console.log, { match: /LoD2_32_(\d+)_(\d+)_1_.*\.gml$/, ext: 'gml' });
    console.log(`LoD2: ${b.have} km tiles (${b.fetched} new, ${b.missing} outside the data)`);
  }
  if (!laser) return;
  const dgm = await fetchLaserTiles(paths.dgm1, laser.dgm1, km(() => true));
  console.log(`DGM1: ${dgm.have} km tiles (${dgm.fetched} new, ${dgm.missing} outside the data)`);
  if (!laser.dom1?.length) return;
  const dom = await fetchLaserTiles(paths.dom1, laser.dom1, km((t) => !!t.highway && !!t.bridge && t.bridge !== 'no'));
  console.log(`DOM1 (bridges): ${dom.have} km tiles (${dom.fetched} new)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
