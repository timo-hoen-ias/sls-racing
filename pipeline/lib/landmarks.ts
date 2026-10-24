// Hand-made landmark models (tools/blender, manifest pipeline/landmarks.json): placed into the world as they
// are, in place of the generic buildings on their footprint. The game loads the GLBs itself
// (src/world/landmarks.ts) from public/tiles/landmarks.json, which this module writes.
import { existsSync, readFileSync } from 'node:fs';
import { utmToLocal, type WorldInfo } from '../../src/world/format.ts';
import { Footprints } from './lod2.ts';

export interface LandmarkEntry {
  id: string;
  glb: string;
  e: number;
  n: number;
  heading: number;
  footprint: [number, number][];
  osm?: number[];
  /** Absolute height (m NHN) of the model origin; else the terrain at (e, n). */
  y?: number;
  /** OSM way of the road bridge this model dresses (railings, piers). */
  bridge?: number;
  name?: string;
}

/** Footbridges whose origin is the deck top: their deck lies level with the banks at both ends. */
const BANK_DECK = new Set(['schleusenbruecke']);

/** Landmarks that stand over or around other things rather than replacing a building. */
const KEEP_BUILDINGS = new Set(['festung-vauban-insel']);

export function readLandmarks(file: string): LandmarkEntry[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LandmarkEntry[]) : [];
}

/** Footprints whose generic buildings the landmark replaces (not bridges, not the fortress ring). */
export function landmarkArea(list: LandmarkEntry[]): Footprints {
  const area = new Footprints();
  for (const l of list) if (!l.bridge && !KEEP_BUILDINGS.has(l.id) && l.footprint.length >= 3) area.add([l.footprint]);
  return area;
}

/** The game's landmark list: local position, origin height and heading per model. */
export function landmarkList(list: LandmarkEntry[], world: WorldInfo, height: (e: number, n: number) => number, inWorld: (e: number, n: number) => boolean) {
  return list.filter((l) => inWorld(l.e, l.n)).map((l) => {
    const [x, z] = utmToLocal(world, l.e, l.n);
    let r = 0;
    for (const [e, n] of l.footprint) r = Math.max(r, Math.hypot(e - l.e, n - l.n));
    let y = l.y ?? height(l.e, l.n);
    if (BANK_DECK.has(l.id)) {
      // The two footprint points farthest apart are the bridge ends, on the banks.
      let best: [[number, number], [number, number]] = [l.footprint[0], l.footprint[0]], d = 0;
      for (const a of l.footprint) for (const b of l.footprint) {
        const ab = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (ab > d) { d = ab; best = [a, b]; }
      }
      y = Math.max(...best.map(([e, n]) => height(e, n)));
    }
    return {
      id: l.id, glb: l.glb, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), heading: l.heading, radius: +r.toFixed(1),
      ...(l.name ? { name: l.name } : {}), ...(l.bridge ? { bridge: l.bridge } : {}),
    };
  });
}
