import type { OsmData } from './osm.ts';
import { pointInRing } from './osm.ts';

// Districts to discover (W5): the town and its quarters from OSM place nodes inside the region boundary. The
// game assigns every spot to the nearest one, so there is no need for district outlines.

const KINDS = new Set(['town', 'city', 'suburb', 'quarter', 'village']);

export interface District { name: string; x: number; z: number }

export function districtList(osm: Pick<OsmData, 'points' | 'boundary'>, toLocal: (e: number, n: number) => [number, number]): District[] {
  const out: District[] = [];
  for (const p of osm.points) {
    const name = p.tags.name;
    if (!name || !KINDS.has(p.tags.place)) continue;
    if (osm.boundary && !osm.boundary.some((ring) => pointInRing(p.e, p.n, ring))) continue;
    const [x, z] = toLocal(p.e, p.n);
    // The town node itself stands for the old town.
    out.push({ name: p.tags.place === 'town' || p.tags.place === 'city' ? 'Innenstadt' : name, x: Math.round(x), z: Math.round(z) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
