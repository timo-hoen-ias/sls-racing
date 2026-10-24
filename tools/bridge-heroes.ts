// Writes pipeline/bridge-heroes.json: for the landmark bridges of Saarlouis, the deck centreline from
// public/tiles/bridges.json plus the terrain height (DGM1, bridges filtered out) and whether the point lies over
// water, every 4 m. tools/blender/make_bridges.py uses it to set piers, abutments and spans on the real ground.
// Run after "npm run world:fetch && npm run world:build": node tools/bridge-heroes.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { terrainHeight } from '../pipeline/lib/heights.ts';
import { pointInRing, readOsm, type OsmJson } from '../pipeline/lib/osm.ts';
import { loadRegion, loadWorld, paths, unproject } from '../pipeline/lib/region.ts';

/** Way id -> bridge type (see make_bridges.py HEROES). Pairs are the two carriageways of one structure. */
export const HEROES: Record<number, string> = {
  26388860: 'peter-neis',
  54047593: 'heinemann', 1204767018: 'heinemann',
  39487835: 'a8', 39487837: 'a8',
  39828527: 'a620', 39828525: 'a620', 39828523: 'a620', 39828520: 'a620', 34030718: 'a620', 34030717: 'a620',
  176710576: 'brueckenstrasse',
  26336797: 'adenauer',
};

const { cfg, project } = loadWorld();
const regions = cfg.regions.map(loadRegion);
const toLonLat = unproject(cfg.zone);
const height = terrainHeight(regions, toLonLat);

const merged: OsmJson = { elements: [] };
const seen = new Set<string>();
for (const r of regions) {
  const file = `${paths.raw(r.id)}osm.json`;
  if (!existsSync(file)) throw new Error(`${file} fehlt: erst "npm run world:fetch"`);
  for (const el of (JSON.parse(readFileSync(file, 'utf8')) as OsmJson).elements) {
    const k = `${el.type}${el.id}`;
    if (!seen.has(k)) { seen.add(k); merged.elements.push(el); }
  }
}
const water = readOsm(merged, project).polygons.filter((p) => p.tags.natural === 'water' || p.tags.waterway === 'riverbank' || p.tags.water === 'river');
const overWater = (e: number, n: number) => water.some((p) => pointInRing(e, n, p.outer) && !p.holes.some((h) => pointInRing(e, n, h)));

const bridges = (JSON.parse(readFileSync(new URL('../public/tiles/bridges.json', import.meta.url), 'utf8')) as {
  bridges: { id: number; name?: string; halfWidth: number; pts: number[] }[];
}).bridges;
const out = [];
for (const b of bridges) {
  const type = HEROES[b.id];
  if (!type) continue;
  const pts = [];
  for (let i = 0; i < b.pts.length; i += 3) {
    const [e, n, y] = [b.pts[i], b.pts[i + 1], b.pts[i + 2]];
    pts.push([e, n, y, +height.raw(e, n).toFixed(2), overWater(e, n) ? 1 : 0]);
  }
  out.push({ id: b.id, type, ...(b.name ? { name: b.name } : {}), halfWidth: b.halfWidth, pts });
}
const missing = Object.keys(HEROES).filter((id) => !out.some((b) => b.id === +id));
if (missing.length) console.warn(`nicht in bridges.json: ${missing.join(', ')}`);
writeFileSync(new URL('../pipeline/bridge-heroes.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(out.map((b) => `${b.id} ${b.type}: ${b.pts.length} Punkte, ${b.pts.filter((p) => p[4]).length} über Wasser, Gelände ${Math.min(...b.pts.map((p) => p[3])).toFixed(1)}–${Math.max(...b.pts.map((p) => p[3])).toFixed(1)}, Deck ${Math.min(...b.pts.map((p) => p[2])).toFixed(1)}–${Math.max(...b.pts.map((p) => p[2])).toFixed(1)}`).join('\n'));
