// Terrain height and road heights shared by the build and the drive test, so both see the same world.
import { bridgeDecks } from './decks.ts';
import { roadProfiles } from './profiles.ts';
import { laserSampler } from './laser.ts';
import type { Way } from './osm.ts';
import { liftOverpasses } from './overpasses.ts';
import { paths, type RegionConfig } from './region.ts';
import { flatSampler, terrariumSampler, type HeightSampler } from './terrain.ts';

/** Width (m) over which laser-scan terrain blends into the coarse terrain at the edge of its coverage. */
const BLEND = 150;

/** Terrain height at a UTM position: DGM1 where the regions have it, else their coarse terrain source. */
export function terrainHeight(regions: RegionConfig[], toLonLat: (e: number, n: number) => [number, number], log = (_: string) => {}) {
  const terrarium = regions.find((r) => r.terrain.source === 'terrarium')?.terrain as { zoom: number } | undefined;
  const sampler: HeightSampler = terrarium ? terrariumSampler(paths.terrain, terrarium.zoom) : flatSampler();
  const dgm = regions.some((r) => r.laser) ? laserSampler(paths.dgm1) : undefined;
  if (dgm) log(`Terrain: DGM1 1 m grid in ${dgm.tiles} km tiles${terrarium ? `, Terrarium z${terrarium.zoom} outside` : ''}`);
  const raw = (e: number, n: number) => {
    const d = dgm?.at(e, n);
    if (d === undefined) return sampler.at(...toLonLat(e, n));
    const c = dgm!.coverage(e, n, BLEND);
    return c >= BLEND ? d : d * (c / BLEND) + sampler.at(...toLonLat(e, n)) * (1 - c / BLEND);
  };
  // Roads and buildings ask for the same points many times; the terrain grid asks once per vertex and
  // reads `raw` so the cache stays small.
  const cache = new Map<number, number>();
  const height = (e: number, n: number) => {
    const k = Math.round(e * 2) * 33_554_432 + Math.round(n * 2);
    let h = cache.get(k);
    if (h === undefined) { h = raw(e, n); cache.set(k, h); }
    return h;
  };
  return Object.assign(height, { raw });
}

/** Bridge decks from DOM1 (where available), then lifts for crossings that still lack headroom. */
export function roadHeights(ways: Way[], regions: RegionConfig[], height: (e: number, n: number) => number, log = (_: string) => {}) {
  const dom = regions.some((r) => r.laser?.dom1?.length) ? laserSampler(paths.dom1) : undefined;
  const d = bridgeDecks(ways, dom, height);
  if (dom) log(`Bridges: ${d.measured}/${d.bridges} decks measured from DOM1, max. ${d.maxRise.toFixed(1)} m above the straight span`);
  const p = roadProfiles(ways, height, d.anchors);
  log(`Road profiles: ${p.roads} roads, ${p.nodes} node heights, largest correction ${p.maxCorrection.toFixed(1)} m`);
  const over = liftOverpasses(ways, height);
  log(`Overpasses: ${over.crossings} crossings, ${over.lifted} roads lifted, min. headroom ${over.crossings ? over.minClearance.toFixed(1) : '-'} m`);
}
