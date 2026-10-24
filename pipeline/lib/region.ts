import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import type { WorldInfo } from '../../src/world/format.ts';

export interface RegionConfig {
  id: string;
  name: string;
  boundary: { type: 'postal_code'; value: string } | { type: 'bbox'; south: number; west: number; north: number; east: number } | { type: 'fixture' };
  marginMeters: number;
  /** PBF extracts that contain the region, tried in order. Without them fetch.ts falls back to Overpass. */
  osm?: { extracts: string[] };
  terrain: { source: 'terrarium'; zoom: number } | { source: 'flat' };
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
  out: here('../../public/tiles/'),
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
