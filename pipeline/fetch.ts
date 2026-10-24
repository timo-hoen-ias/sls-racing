// Downloads raw map data for a region into data/raw/<region>/.
//   node pipeline/fetch.ts saarlouis
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { loadRegion, paths } from './lib/region.ts';
import { fetchTerrarium, tilesForBbox } from './lib/terrain.ts';

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';

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
  way["leisure"~"park|pitch|garden|playground"]${f};
  way["amenity"="parking"]${f};
  node["natural"="tree"]${f};
);
(._;>;);
out body;`;
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
    let area = '';
    let filter: string;
    let boundaryQuery = '';
    if (region.boundary.type === 'postal_code') {
      area = `area["boundary"="postal_code"]["postal_code"="${region.boundary.value}"]->.a;`;
      filter = '(area.a)';
      boundaryQuery = `[out:json];relation["boundary"="postal_code"]["postal_code"="${region.boundary.value}"];(._;>;);out body;`;
    } else {
      const b = region.boundary;
      filter = `(${b.south},${b.west},${b.north},${b.east})`;
    }
    console.log(`Overpass: ${region.name} …`);
    const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(area, filter) }) });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    if (boundaryQuery) {
      const b = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: boundaryQuery }) });
      if (!b.ok) throw new Error(`Overpass boundary HTTP ${b.status}`);
      json.elements.push(...(await b.json()).elements);
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
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
