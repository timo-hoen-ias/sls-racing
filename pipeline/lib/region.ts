import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import type { WorldInfo } from '../../src/world/format.ts';
import { type RoadProfile, setRoadProfile } from '../../src/world/roadSpec.ts';

export interface RegionConfig {
  id: string;
  name: string;
  /** admin: an administrative boundary relation by name and admin_level (6 = Landkreis). */
  boundary: { type: 'postal_code'; value: string } | { type: 'admin'; name: string; level: number } | { type: 'bbox'; south: number; west: number; north: number; east: number } | { type: 'fixture' };
  marginMeters: number;
  /** Road profile (roadSpec.ts): "game" builds wider roads with rounded corners; default "real". */
  roadProfile?: RoadProfile;
  /** PBF extracts that contain the region, tried in order. Without them fetch.ts falls back to Overpass. */
  osm?: { extracts: string[] };
  terrain: { source: 'terrarium'; zoom: number } | { source: 'flat' };
  /**
   * Laser-scan rasters (ZIPs of 1 km GeoTIFFs, 1 m grid, UTM 32N), tried in order per tile. DGM1 replaces
   * the terrain where it exists, with the terrain source above as the fallback; DOM1 gives bridge decks.
   */
  laser?: { dgm1: string[]; dom1?: string[] };
  /** LoD2 building models (ZIPs of 1 km CityGML tiles, UTM 32N, heights NHN), tried in order per tile. */
  lod2?: string[];
  spawn: { lat: number; lon: number };
  /** Far view (P3): coarse terrain and building blocks this far around the region, terrain at this Terrarium zoom. */
  far?: { marginMeters: number; zoom: number };
}

export interface WorldConfig {
  zone: number;
  origin: { lat: number; lon: number; name: string };
  tileSize: number;
  /** Regions merged into one seamless world by "npm run world:build". */
  regions: string[];
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const paths = {
  raw: (region: string) => here(`../../data/raw/${region}/`),
  terrain: here('../../data/raw/terrain/'),
  dgm1: here('../../data/raw/dgm1/'),
  dom1: here('../../data/raw/dom1/'),
  lod2: here('../../data/raw/lod2/'),
  /** SLS_TILES_OUT builds somewhere else (e.g. the real world next to the test fixture). */
  out: process.env.SLS_TILES_OUT ? `${process.env.SLS_TILES_OUT.replace(/\/$/, '')}/` : here('../../public/tiles/'),
};

export function loadRegion(id: string): RegionConfig {
  return JSON.parse(readFileSync(here(`../regions/${id}.json`), 'utf8'));
}

export function loadWorld(): { cfg: WorldConfig; info: WorldInfo; project: (lon: number, lat: number) => [number, number] } {
  const cfg: WorldConfig = JSON.parse(readFileSync(here('../world.json'), 'utf8'));
  const utm = `+proj=utm +zone=${cfg.zone} +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs`;
  const conv = proj4('EPSG:4326', utm);
  const project = (lon: number, lat: number) => conv.forward([lon, lat]) as [number, number];
  const [originE, originN] = project(cfg.origin.lon, cfg.origin.lat);
  return { cfg, info: { zone: cfg.zone, originE, originN, tileSize: cfg.tileSize }, project };
}

export function unproject(zone: number) {
  const utm = `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs`;
  const conv = proj4(utm, 'EPSG:4326');
  return (e: number, n: number) => conv.forward([e, n]) as [number, number];
}

/**
 * Road profile for a pipeline run (roadSpec.ts). The build picks it (SLS_ROAD_PROFILE, else real until the
 * road smoothing pass levels the small steps where widened roads meet; regions may opt in with
 * roadProfile: "game") and writes it into index.json; drive test and gap check pass the built index, so they
 * measure the same roads.
 */
export function useRoadProfile(o: { regions?: RegionConfig[]; index?: { roadProfile?: RoadProfile } }): RoadProfile {
  const env = process.env.SLS_ROAD_PROFILE;
  const p: RoadProfile = env === 'real' || env === 'game' ? env
    : o.index ? o.index.roadProfile ?? 'real'
    : o.regions?.some((r) => r.roadProfile === 'game') ? 'game' : 'real';
  setRoadProfile(p);
  return p;
}
