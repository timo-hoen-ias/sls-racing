// Where streets have a raised kerb and a pavement: only in built-up areas (innerorts), on the sides OSM gives,
// lowered at crossings. Rural roads get edge lines, delineators and guard rails instead (roadside.ts).
// Sets way.sidewalks before the graph and the road meshes are built, so both agree.

import { GroundIndex } from './ground.ts';
import { Ground } from '../../src/world/format.ts';
import type { OsmData, Polygon, Way } from './osm.ts';
import { KERB } from '../../src/world/roadSpec.ts';

export { KERB };

/** Road classes that can have kerbs and pavements (pipeline ROAD_CLASSES street: true, except living streets). */
const KERB_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential']);
const URBAN_LANDUSE = new Set(['residential', 'commercial', 'retail', 'industrial']);

export interface Sidewalks { left: boolean; right: boolean }

const yes = (v: string | undefined) => v === 'yes' || v === 'separate' || v === 'both';
const no = (v: string | undefined) => v === 'no' || v === 'none';

/**
 * Pavement sides of a way from its tags (left/right relative to the way's direction), or undefined when the tags
 * say nothing and the area decides. sidewalk=separate keeps the kerb and pavement here (the footway mapped beside
 * it is left out by the path builder).
 */
export function taggedSidewalks(tags: Record<string, string>): Sidewalks | undefined {
  const s = tags.sidewalk ?? tags['sidewalk:both'];
  let left: boolean | undefined, right: boolean | undefined;
  if (s === 'both' || s === 'yes' || s === 'separate') left = right = true;
  else if (no(s)) left = right = false;
  else if (s === 'left') { left = true; right = false; }
  else if (s === 'right') { left = false; right = true; }
  const l = tags['sidewalk:left'], r = tags['sidewalk:right'];
  if (yes(l)) left = true; else if (no(l)) left = false;
  if (yes(r)) right = true; else if (no(r)) right = false;
  if (left === undefined && right === undefined) return undefined;
  return { left: left ?? false, right: right ?? false };
}

/** Motorways, trunk roads, their ramps and roads signed as Kraftfahrstraße (motorroad / expressway). */
export function isExpressway(tags: Record<string, string>) {
  return /^(motorway|trunk)(_link)?$/.test(tags.highway ?? '') || tags.motorroad === 'yes' || tags.expressway === 'yes';
}

/** Rural by its tags: an out-of-town speed limit or traffic zone. */
export function ruralByTags(tags: Record<string, string>) {
  const zone = tags['zone:traffic'] ?? tags['source:maxspeed'] ?? '';
  if (/DE:urban/.test(zone)) return false;
  if (/DE:rural|DE:motorway/.test(zone)) return true;
  const v = parseInt(tags.maxspeed);
  if (v >= 70) return true;
  return undefined;
}

/** Point lookup: inside a built-up area (residential, commercial, retail or industrial landuse). */
export class BuiltUp {
  private index: GroundIndex;
  constructor(polygons: Polygon[]) {
    this.index = new GroundIndex(polygons.filter((p) => URBAN_LANDUSE.has(p.tags.landuse)));
  }
  has(e: number, n: number) { return this.index.at(e, n, Ground.grass) === Ground.urban; }

  /** Share of a way's length inside built-up areas (samples every 20 m, also 15 m to either side). */
  share(way: Way) {
    let inside = 0, total = 0;
    for (let i = 1; i < way.pts.length; i++) {
      const [ae, an] = way.pts[i - 1], [be, bn] = way.pts[i];
      const l = Math.hypot(be - ae, bn - an);
      const k = Math.max(1, Math.round(l / 20));
      const ue = (be - ae) / (l || 1), un = (bn - an) / (l || 1);
      for (let j = 0; j < k; j++) {
        const t = (j + 0.5) / k;
        const e = ae + (be - ae) * t, n = an + (bn - an) * t;
        // Roads often run along the edge of the landuse area rather than inside it.
        if (this.has(e, n) || this.has(e + un * 15, n - ue * 15) || this.has(e - un * 15, n + ue * 15)) inside++;
        total++;
      }
    }
    return total ? inside / total : 0;
  }
}

/**
 * Decides kerbs for every road: sets way.urban and way.sidewalks (also { false, false }), so the graph, the road
 * meshes and the roadside furniture agree.
 */
export function planKerbs(ways: Way[], polygons: Polygon[], points: OsmData['points'] = []): { urban: number; rural: number; tagged: number; crossings: number } {
  const built = new BuiltUp(polygons);
  const stats = { urban: 0, rural: 0, tagged: 0, crossings: 0 };
  // Crossings and lowered kerbs mapped on the road's own nodes.
  const lowered = new Set(points.filter((p) => p.tags.highway === 'crossing' || p.tags.railway === 'crossing' || /^(lowered|flush|no)$/.test(p.tags.kerb ?? '')).map((p) => p.id));
  for (const w of ways) {
    const hw = w.tags.highway;
    if (!hw) continue;
    let dist = 0;
    const at: number[] = [];
    w.ids.forEach((id, i) => {
      if (i) dist += Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
      if (lowered.has(id)) at.push(dist);
    });
    if (at.length) { w.lowered = at; stats.crossings += at.length; }
    // Schnellstraßen (motorways, Kraftfahrstraßen, trunk roads and their ramps) never have kerbs: edge line, verge,
    // delineators or a guard rail instead.
    const motorway = isExpressway(w.tags);
    const rural = motorway || (ruralByTags(w.tags) ?? built.share(w) < 0.5);
    w.urban = !rural;
    const tagged = taggedSidewalks(w.tags);
    if (!KERB_CLASSES.has(hw) || motorway || (w.tags.bridge && w.tags.bridge !== 'no')) { w.sidewalks = { left: false, right: false }; continue; }
    if (tagged) { w.sidewalks = tagged; stats.tagged++; if (tagged.left || tagged.right) w.urban = true; continue; }
    w.sidewalks = { left: !rural, right: !rural };
    if (rural) stats.rural++; else stats.urban++;
  }
  return stats;
}
