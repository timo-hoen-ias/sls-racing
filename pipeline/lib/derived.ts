// Results of the slow or token-bound data steps (LiDAR, ALKIS, Mapillary) are committed gzipped under
// data/derived/<region>/, so world:build and the deploy build use them without downloading 20 GB or
// needing an API token. The steps write both the raw file and the committed copy.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { paths } from './region.ts';

export const derivedDir = (region: string) => fileURLToPath(new URL(`../../data/derived/${region}/`, import.meta.url));

/** Writes data/raw/<region>/<name>.json and data/derived/<region>/<name>.json.gz. */
export function writeDerived(region: string, name: string, data: unknown) {
  const json = JSON.stringify(data);
  mkdirSync(paths.raw(region), { recursive: true });
  writeFileSync(`${paths.raw(region)}${name}.json`, json);
  mkdirSync(derivedDir(region), { recursive: true });
  writeFileSync(`${derivedDir(region)}${name}.json.gz`, gzipSync(json, { level: 9 }));
}

/** Reads the fresh raw file if present, else the committed copy, else undefined. */
export function readDerived<T>(region: string, name: string): T | undefined {
  const raw = `${paths.raw(region)}${name}.json`;
  if (existsSync(raw)) return JSON.parse(readFileSync(raw, 'utf8')) as T;
  const gz = `${derivedDir(region)}${name}.json.gz`;
  if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8')) as T;
  return undefined;
}
