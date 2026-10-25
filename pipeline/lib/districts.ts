import type { OsmData } from './osm.ts';
import { pointInRing } from './osm.ts';

// Districts to discover (W5): the town and its quarters from OSM place nodes inside the region boundary. The
// game assigns every spot to the nearest one, so there is no need for district outlines.

const KINDS = new Set(['town', 'city', 'suburb', 'quarter', 'village']);

export interface District { name: string; x: number; z: number }

/** home: the world origin; the town node closest to it is the old town ("Innenstadt"), other towns keep their name. */
export function districtList(osm: Pick<OsmData, 'points' | 'boundary'>, toLocal: (e: number, n: number) => [number, number], home?: [number, number]): District[] {
  const towns = osm.points.filter((p) => p.tags.name && (p.tags.place === 'town' || p.tags.place === 'city'));
  const dist = (p: { e: number; n: number }) => (home ? Math.hypot(p.e - home[0], p.n - home[1]) : 0);
  const old = towns.reduce<(typeof towns)[number] | undefined>((a, p) => (!a || dist(p) < dist(a) ? p : a), undefined);
  const out: District[] = [];
  for (const p of osm.points) {
    const name = p.tags.name;
    if (!name || !KINDS.has(p.tags.place)) continue;
    if (osm.boundary && !osm.boundary.some((ring) => pointInRing(p.e, p.n, ring))) continue;
    const [x, z] = toLocal(p.e, p.n);
    // The home town's node stands for its old town.
    out.push({ name: p === old ? 'Innenstadt' : name, x: Math.round(x), z: Math.round(z) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
