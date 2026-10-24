// Street furniture detected by Mapillary in street-level photos (map features, CC BY-SA 4.0).
// Mapillary needs a free access token; it is read from MAPILLARY_TOKEN and never stored.
import { existsSync, readFileSync } from 'node:fs';
import { readDerived } from './derived.ts';

export const MAPILLARY_ATTRIBUTION = 'Mapillary contributors, CC BY-SA 4.0';

/** [UTM east, UTM north, Mapillary object value, facing direction in degrees from north or -1, last seen (year)] */
export type MapillaryFeature = [number, number, string, number, number];

export interface MapillaryFile {
  crs: 'EPSG:25832';
  attribution: string;
  features: MapillaryFeature[];
}

export function readMapillary(file: string): MapillaryFile | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as MapillaryFile) : undefined;
}

/** Mapillary features of a region: fresh from data/raw, else the committed copy in data/derived. */
export const loadMapillary = (region: string) => readDerived<MapillaryFile>(region, 'mapillary');

/** Game categories for the Mapillary values that matter for a street scene. */
export type FeatureCategory = 'trafficLight' | 'pedestrianLight' | 'streetLight' | 'stopSign' | 'giveWay' | 'sign' | 'bench' | 'bin' | 'hydrant' | 'pole';

export function categorize(value: string): FeatureCategory | undefined {
  if (value.startsWith('object--traffic-light--pedestrians')) return 'pedestrianLight';
  if (value.startsWith('object--traffic-light')) return 'trafficLight';
  if (value === 'object--street-light') return 'streetLight';
  if (value.startsWith('regulatory--stop--')) return 'stopSign';
  if (value.startsWith('regulatory--yield--')) return 'giveWay';
  if (/^(regulatory|warning|information|complementary)--/.test(value) || value === 'object--traffic-sign--front') return 'sign';
  if (value === 'object--bench') return 'bench';
  if (value === 'object--trash-can') return 'bin';
  if (value === 'object--fire-hydrant') return 'hydrant';
  if (value.startsWith('object--support--')) return 'pole';
  return undefined;
}
