// Corrections to the OSM data where timo knows the place better than the map, applied to the raw elements before
// readOsm. A fix changes tags of mapped ways or adds ways along mapped nodes; added nodes and ways get ids from
// FIX_ID down (negative, above SYNTHETIC_NODE in osm.ts).
import type { OsmJson } from './osm.ts';

export const FIX_ID = -500_000_000;

export interface OsmFix {
  note: string;
  /** Extra tags for mapped ways, by way id. */
  tags?: Record<number, Record<string, string>>;
  /** New ways through mapped nodes, `offset` metres to the left of their direction (to stand beside a wall). */
  ways?: { tags: Record<string, string>; nodes: number[]; offset?: number }[];
}

export const OSM_FIXES: OsmFix[] = [
  {
    // Car park on the west side of Oberförstereistraße (only its aisles are mapped, no amenity=parking area):
    // the fence along the street is chain-link, and chain-link runs inside the wall on the park side too. The
    // way in from the street and the drive to the west stay open (props.ts leaves pieces on lanes out).
    note: 'Parkplatz Oberförstereistraße: Maschendrahtzaun ringsum (timo, 2026-10-25)',
    tags: { 114108235: { fence_type: 'chain_link' } },
    ways: [{ tags: { barrier: 'fence', fence_type: 'chain_link' }, nodes: [855078701, 855078359, 855078369, 855078375], offset: 0.6 }],
  },
];

/** Applies the fixes in place; returns what was done for the build log. */
export function applyOsmFixes(json: OsmJson, fixes = OSM_FIXES): string[] {
  const nodes = new Map<number, { lat: number; lon: number }>();
  const ways = new Map<number, { tags?: Record<string, string> }>();
  for (const el of json.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
  }
  const log: string[] = [];
  let id = FIX_ID;
  for (const fix of fixes) {
    let changed = 0, added = 0;
    for (const [wid, tags] of Object.entries(fix.tags ?? {})) {
      const w = ways.get(Number(wid));
      if (!w) continue;
      w.tags = { ...w.tags, ...tags };
      changed++;
    }
    for (const way of fix.ways ?? []) {
      const pts = way.nodes.map((n) => nodes.get(n));
      if (pts.some((p) => !p)) continue;
      const ids: number[] = [];
      shifted(pts as { lat: number; lon: number }[], way.offset ?? 0).forEach(([lat, lon]) => {
        json.elements.push({ type: 'node', id, lat, lon });
        ids.push(id--);
      });
      json.elements.push({ type: 'way', id: id--, nodes: ids, tags: way.tags });
      added++;
    }
    if (changed || added) log.push(`${fix.note}: ${changed} ways changed, ${added} added`);
  }
  return log;
}

/** The polyline moved `offset` metres to the left, corners on the bisector. */
function shifted(pts: { lat: number; lon: number }[], offset: number): [number, number][] {
  if (!offset) return pts.map((p) => [p.lat, p.lon]);
  const M = 111_320, k = Math.cos((pts[0].lat * Math.PI) / 180);
  const xy = pts.map((p) => [p.lon * M * k, p.lat * M]);
  const dir = (a: number[], b: number[]) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  return xy.map((p, i) => {
    const d0 = dir(xy[Math.max(0, i - 1)], xy[Math.max(1, i)]);
    const d1 = dir(xy[Math.min(xy.length - 2, i)], xy[Math.min(xy.length - 1, i + 1)]);
    // Left normals of both segments, averaged and lengthened so the offset holds on both sides of the corner.
    let nx = -(d0[1] + d1[1]), ny = d0[0] + d1[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const cos = Math.max(0.3, nx * -d1[1] + ny * d1[0]);
    const x = p[0] + (nx * offset) / cos, y = p[1] + (ny * offset) / cos;
    return [y / M, x / (M * k)];
  });
}
