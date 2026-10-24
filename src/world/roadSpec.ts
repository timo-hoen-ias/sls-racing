// Carriageway cross-sections per OSM road class, shared by the pipeline (road meshes) and the game (traffic, surface, debug).
// Lane widths follow German guidelines (RAA/RAL/RASt): 3.75 m on motorways, 3.5 m on trunk and primary roads,
// 3.25 m on secondary and tertiary roads, about 3 m in residential streets.

interface ClassSection {
  /** Lane width, metres. */
  lane: number;
  /** Paved strip beyond the outermost lane on the right (hard shoulder or edge strip). */
  outer: number;
  /** Paved strip left of the leftmost lane of a one-way carriageway (beside the median). */
  inner: number;
  /** Lanes when OSM has no lanes tag: total for two-way roads, per carriageway for motorways. */
  lanes: number;
  /** Narrowest plausible carriageway (one-way streets with parking, short links). */
  min: number;
}

const SECTIONS: Record<string, ClassSection> = {
  motorway: { lane: 3.75, outer: 3, inner: 0.75, lanes: 2, min: 7 },
  trunk: { lane: 3.5, outer: 1.5, inner: 0.75, lanes: 2, min: 6 },
  primary: { lane: 3.5, outer: 0.5, inner: 0.5, lanes: 2, min: 5 },
  secondary: { lane: 3.25, outer: 0.5, inner: 0.5, lanes: 2, min: 5 },
  tertiary: { lane: 3.25, outer: 0.25, inner: 0.25, lanes: 2, min: 4.5 },
  motorway_link: { lane: 3.5, outer: 2, inner: 0.5, lanes: 1, min: 5 },
  trunk_link: { lane: 3.5, outer: 1.5, inner: 0.5, lanes: 1, min: 5 },
  primary_link: { lane: 3.25, outer: 0.75, inner: 0.5, lanes: 1, min: 4.5 },
  secondary_link: { lane: 3.25, outer: 0.75, inner: 0.5, lanes: 1, min: 4.5 },
  tertiary_link: { lane: 3.25, outer: 0.75, inner: 0.5, lanes: 1, min: 4.5 },
  unclassified: { lane: 3, outer: 0, inner: 0.25, lanes: 2, min: 4.5 },
  residential: { lane: 3, outer: 0, inner: 0.25, lanes: 2, min: 4.5 },
  living_street: { lane: 2.5, outer: 0, inner: 0, lanes: 2, min: 3.5 },
  pedestrian: { lane: 3, outer: 0, inner: 0, lanes: 2, min: 4 },
  service: { lane: 2, outer: 0, inner: 0, lanes: 2, min: 3 },
  track: { lane: 1.5, outer: 0, inner: 0, lanes: 2, min: 2.5 },
};

/** Cross-section of one OSM way. Offsets are metres to the right of the centreline, looking along the way. */
export interface RoadSection {
  width: number;
  lanes: number;
  lane: number;
  oneway: boolean;
  /** Offsets of the lines between lanes (no centre line of two-way roads). */
  dividers: number[];
  /** Centre of the rightmost lane in the direction of travel (a → b for one-way roads). */
  rightLane: number;
  /** Paved strip outside the outer lane edge (where the edge line sits), metres. */
  outer: number;
  /** Paved strip left of a one-way carriageway's leftmost lane, metres. */
  inner: number;
  /** Where the width came from, for the debug console. */
  source: 'width' | 'lanes' | 'default';
}

export const hasSection = (highway: string | undefined) => !!highway && highway in SECTIONS;

export function roadSection(tags: Record<string, string>): RoadSection | undefined {
  const s = SECTIONS[tags.highway];
  if (!s) return undefined;
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout' || tags.highway === 'motorway';
  const tagged = parseInt(tags.lanes);
  const lanes = tagged > 0 && tagged < 10 ? tagged : oneway && s.lanes === 2 && tags.highway !== 'motorway' && tags.highway !== 'trunk' ? 1 : s.lanes;
  const natural = lanes * s.lane + (oneway ? s.outer + s.inner : 2 * s.outer);
  const w = parseFloat(tags.width);
  const explicit = w > 2 && w < 40;
  const width = explicit ? w : Math.max(s.min, natural);
  // Spread the extra (or missing) width evenly over lanes and edge strips.
  const k = width / natural;
  const lane = s.lane * k;
  const left = oneway ? -width / 2 + s.inner * k : -(lanes * lane) / 2;
  const dividers: number[] = [];
  for (let i = 1; i < lanes; i++) {
    const o = left + i * lane;
    if (!oneway && Math.abs(o) < 0.01) continue;
    dividers.push(o);
  }
  const rightLane = oneway ? left + (lanes - 0.5) * lane : lanes >= 2 ? (Math.floor(lanes / 2) - 0.5) * lane + (lanes % 2 ? lane / 2 : 0) : width / 4;
  return { width, lanes, lane, oneway, dividers, rightLane, outer: s.outer * k, inner: s.inner * k, source: explicit ? 'width' : tagged > 0 && tagged < 10 ? 'lanes' : 'default' };
}

// Ways without cars: footpaths, cycle paths and steps are drawn as narrow paths beside the road network
// (pipeline/lib/paths.ts), never part of it. Pedestrian zones and roads closed to cars keep their carriageway
// but are left out of routing, traffic and the drive test.

/** Path kinds by index (graph.json `w` entries, debug console). */
export const PATH_KINDS = ['footway', 'path', 'cycleway', 'bridleway', 'steps'] as const;
export type PathKind = (typeof PATH_KINDS)[number];
const PATH_WIDTH: Record<PathKind, number> = { footway: 2, path: 1.5, cycleway: 2, bridleway: 2, steps: 2 };

/** Path width in metres: the width tag where plausible, else by kind. */
export function pathWidth(tags: Record<string, string>): number {
  const w = parseFloat(tags.width);
  return w >= 0.8 && w <= 6 ? w : PATH_WIDTH[tags.highway as PathKind] ?? 1.5;
}

/** Values of motorcar, motor_vehicle, vehicle and access (most specific first) that keep cars out. */
const NO_CARS = new Set(['no', 'private', 'agricultural', 'forestry', 'agricultural;forestry', 'delivery', 'permit', 'emergency', 'bus', 'psv', 'discouraged']);

/** Closed to cars: pedestrian zones, and roads whose access tags keep motor vehicles out. */
export function noCars(tags: Record<string, string>): boolean {
  if (tags.highway === 'pedestrian') return true;
  const v = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  return !!v && NO_CARS.has(v);
}

/** Entrances that get a row of bollards: pedestrian zones and roads explicitly closed to all motor vehicles. */
export function bollardedEntry(tags: Record<string, string>): boolean {
  if (tags.highway === 'pedestrian') return true;
  const v = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  return v === 'no';
}
