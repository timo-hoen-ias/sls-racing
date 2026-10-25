// Terrain height and road heights shared by the build and the drive test, so both see the same world.
import { bridgeDecks } from './decks.ts';
import { demoteRoughFieldPaths } from './fieldWays.ts';
import { isDrivable } from './roads.ts';
import { roadProfiles } from './profiles.ts';
import { laserSampler } from './laser.ts';
import type { Polygon, Way } from './osm.ts';
import { liftOverpasses } from './overpasses.ts';
import { planPlazas, type Plaza } from './plazas.ts';
import { paths, type RegionConfig } from './region.ts';
import { flatSampler, terrariumSampler, type HeightSampler } from './terrain.ts';

/** Width (m) over which laser-scan terrain blends into the coarse terrain at the edge of its coverage. */
const BLEND = 150;

/**
 * Terrain height at a UTM position: DGM1 where the regions have it, else their coarse terrain source. With the
 * OSM polygons, squares and surface car parks are flattened to one plane each (plazas.ts).
 */
export function terrainHeight(regions: RegionConfig[], toLonLat: (e: number, n: number) => [number, number], log = (_: string) => {}, polygons: Polygon[] = []) {
  const terrarium = regions.find((r) => r.terrain.source === 'terrarium')?.terrain as { zoom: number } | undefined;
  const sampler: HeightSampler = terrarium ? terrariumSampler(paths.terrain, terrarium.zoom) : flatSampler();
  const dgm = regions.some((r) => r.laser) ? laserSampler(paths.dgm1) : undefined;
  if (dgm && !dgm.tiles) throw missing('DGM1', paths.dgm1, regions);
  if (dgm) log(`Terrain: DGM1 1 m grid in ${dgm.tiles} km tiles${terrarium ? `, Terrarium z${terrarium.zoom} outside` : ''}`);
  const measured = (e: number, n: number) => {
    const d = dgm?.at(e, n);
    if (d === undefined) return sampler.at(...toLonLat(e, n));
    const c = dgm!.coverage(e, n, BLEND);
    return c >= BLEND ? d : d * (c / BLEND) + sampler.at(...toLonLat(e, n)) * (1 - c / BLEND);
  };
  const flat = planPlazas(polygons, measured);
  if (polygons.length) log(`Plazas: ${flat.report.plazas} flattened to a plane (${flat.report.polygons} outlines, max. ${(flat.report.maxRms * 100).toFixed(0)} cm RMS off the terrain), ${flat.report.skipped} left as measured (sloped or uneven)`);
  const raw = (e: number, n: number) => flat.apply(e, n, measured(e, n));
  // Roads and buildings ask for the same points many times; the terrain grid asks once per vertex and
  // reads `raw` so the cache stays small.
  const cache = new Map<number, number>();
  const height = (e: number, n: number) => {
    const k = Math.round(e * 2) * 33_554_432 + Math.round(n * 2);
    let h = cache.get(k);
    if (h === undefined) { h = raw(e, n); cache.set(k, h); }
    return h;
  };
  return Object.assign(height, { raw, plazas: flat.plazas as Plaza[] });
}

/**
 * A region asks for laser data that was never downloaded (an old data/raw from before fetch.ts got it).
 * Building anyway would put bridge decks on the valley floor, so stop and say how to get it.
 */
export const missing = (what: string, dir: string, regions: RegionConfig[]) =>
  new Error(`${what} expected but ${dir} has no tiles. Run "node pipeline/fetch.ts ${regions.map((r) => r.id).join(' ')}" first.`);

/** Bridge decks from DOM1 (where available), then lifts for crossings that still lack headroom. */
export function roadHeights(ways: Way[], regions: RegionConfig[], height: (e: number, n: number) => number, log = (_: string) => {}) {
  const dom = regions.some((r) => r.laser?.dom1?.length) ? laserSampler(paths.dom1) : undefined;
  if (dom && !dom.tiles) throw missing('DOM1', paths.dom1, regions);
  const rough = demoteRoughFieldPaths(ways, height, (w) => isDrivable(w.tags));
  log(`Feldwege: ${rough.steep + rough.slope + rough.crossing} unpaved paths left as paths (${rough.steep} steep, ${rough.slope} on a steep slope, ${rough.crossing} crossing a road without a junction)`);
  const d = bridgeDecks(ways, dom, height);
  if (dom) log(`Bridges: ${d.measured}/${d.bridges} decks measured from DOM1, max. ${d.maxRise.toFixed(1)} m above the straight span`);
  const p = roadProfiles(ways, height, d.anchors);
  log(`Road profiles: ${p.roads} roads, ${p.nodes} node heights, largest correction ${p.maxCorrection.toFixed(1)} m, bumps (off a 40 m mean) max. ${(p.roughness.max * 100).toFixed(1)} cm, mean ${(p.roughness.mean * 100).toFixed(2)} cm`);
  const over = liftOverpasses(ways, height);
  log(`Overpasses: ${over.crossings} crossings, ${over.lifted} roads lifted, min. headroom ${over.crossings ? over.minClearance.toFixed(1) : '-'} m`);
}
