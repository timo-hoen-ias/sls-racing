// Carriageway cross-sections per OSM road class, shared by the pipeline (road meshes) and the game (traffic, surface, debug).
// Lane widths follow German guidelines (RAA/RAL/RASt): 3.75 m on motorways, 3.5 m on trunk and primary roads,
// 3.25 m on secondary and tertiary roads, about 3 m in residential streets.

/** Feldwege (highway=track, and unpaved paths outside town promoted to tracks, pipeline/lib/fieldWays.ts). */
export const FIELD_WAY = {
  /** Narrowest carriageway, metres, also over a smaller width tag. */
  min: 3.6,
  /** Wheel ruts: centre offset either side of the way's centre and half width, metres. */
  rut: 0.8,
  rutHalf: 0.26,
};

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
  // Feldwege and forest tracks: real ones are 2.5–3.5 m; the game builds them 4 m wide (at least 3.6 m, also
  // where OSM has a narrower width tag) so two wheel ruts and a grass strip fit and they can be driven like a rally stage.
  track: { lane: 2, outer: 0, inner: 0, lanes: 2, min: FIELD_WAY.min },
};

/**
 * Road profile (S1, fun racer; the default since timo's final road pass, 2026-10-25): "game" widens every
 * carriageway by a factor per class (residential lanes 3.0 → 4.05 m, main roads 3.5 → 4.4 m, motorways
 * 3.75 → 4.3 m); "real" keeps the guideline widths. The data stays
 * 1:1, only the carriageways grow, up to the street space between the houses (tag sls:street from ALKIS)
 * minus narrow sidewalks. The pipeline builds with one profile (useRoadProfile in pipeline/lib/region.ts) and
 * writes it into index.json.
 */
export type RoadProfile = 'game' | 'real';
export const GAME_WIDEN: Record<string, number> = {
  motorway: 1.15, trunk: 1.2, primary: 1.25, secondary: 1.25, tertiary: 1.3,
  motorway_link: 1.15, trunk_link: 1.15, primary_link: 1.2, secondary_link: 1.2, tertiary_link: 1.2,
  unclassified: 1.35, residential: 1.35, living_street: 1.3, service: 1.25,
};
/** Narrowest sidewalk left beside a widened carriageway, metres. */
export const MIN_SIDEWALK = 1.2;
let profile: RoadProfile = 'real';
export const activeRoadProfile = () => profile;
export function setRoadProfile(p: RoadProfile) {
  profile = p;
}

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
  /** Carriageway centre to the right of the OSM line, metres (one-way roads: OSM line on the lanes, see placementShift). */
  shift: number;
  /** The rightmost lane is an auxiliary lane of a motorway junction (acceleration or deceleration lane). */
  aux: boolean;
  /** Offset of the divider between the through lanes and the auxiliary lane (block marking), if any. */
  block?: number;
}

/**
 * Where the OSM line lies across a one-way carriageway. Without a `placement` tag OSM puts the line in the middle
 * of the lanes (not of the paved width with its hard shoulder), so the carriageway centre lies (outer - inner) / 2
 * right of it. OSM maps the lanes of a motorway junction with `placement=right_of:1` (the line stays on the
 * through lanes while a lane is added on the right), so placements are measured against the through lanes:
 * the given lane edge lands where it would lie on the same road without the extra lanes.
 *   aux: the rightmost lane is an added lane; without a placement the line then stays on the through lanes.
 */
function placementShift(placement: string | undefined, lanes: number, lane: number, width: number, inner: number, outer: number, aux: boolean): number {
  const m = /^(left_of|middle_of|right_of):(\d+)$/.exec(placement ?? '');
  // Line position in carriageway coordinates (from the centre, right positive), in lanes from the left lane edge.
  let at: number;
  // The lane block of the same road without a placement is centred on the line.
  const centred = (outer - inner) / 2;
  if (m) at = +m[2] - (m[1] === 'left_of' ? 1 : m[1] === 'middle_of' ? 0.5 : 0);
  else if (aux) at = (lanes - 1) / 2;
  else return centred;
  if (!(at >= 0 && at <= lanes)) return centred;
  const line = -width / 2 + inner + at * lane;
  // Where the same lane edge lies on that road: the lane block sits (outer - inner) / 2 left of the centre.
  return (inner - outer) / 2 - line + centred;
}

export const hasSection = (highway: string | undefined) => !!highway && highway in SECTIONS;

/** `as` picks a profile other than the active one (the measured widths are 1:1, pipeline/lib/alkis.ts). */
export function roadSection(tags: Record<string, string>, as: RoadProfile = profile): RoadSection | undefined {
  const s = SECTIONS[tags.highway];
  if (!s) return undefined;
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout' || tags.highway === 'motorway';
  const tagged = parseInt(tags.lanes);
  const lanes = tagged > 0 && tagged < 10 ? tagged : oneway && s.lanes === 2 && tags.highway !== 'motorway' && tags.highway !== 'trunk' ? 1 : s.lanes;
  const natural = lanes * s.lane + (oneway ? s.outer + s.inner : 2 * s.outer);
  const w = parseFloat(tags.width);
  const explicit = w > 2 && w < 40;
  const base = explicit ? (tags.highway === 'track' ? Math.max(w, s.min) : w) : Math.max(s.min, natural);
  // Game profile: wider, but within the street space (keeping sidewalks of MIN_SIDEWALK), never narrower.
  const street = parseFloat(tags['sls:street']);
  const room = street > 0 ? street - 2 * MIN_SIDEWALK : Infinity;
  const width = as === 'game' ? Math.max(base, Math.min(base * (GAME_WIDEN[tags.highway] ?? 1), room)) : base;
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
  const aux = oneway && lanes >= 2 && tags['sls:aux'] === 'yes';
  const shift = oneway ? placementShift(tags.placement, lanes, lane, width, s.inner * k, s.outer * k, aux) : 0;
  // Traffic keeps to the rightmost through lane; the auxiliary lane is only for leaving or joining.
  const through = aux ? lanes - 1 : lanes;
  const rightLane = (oneway ? left + (through - 0.5) * lane : lanes >= 2 ? (Math.floor(lanes / 2) - 0.5) * lane + (lanes % 2 ? lane / 2 : 0) : width / 4) + shift;
  return {
    width, lanes, lane, oneway, dividers: dividers.map((d) => d + shift), rightLane, outer: s.outer * k, inner: s.inner * k,
    source: explicit ? 'width' : tagged > 0 && tagged < 10 ? 'lanes' : 'default', shift, aux, ...(aux ? { block: left + (lanes - 1) * lane + shift } : {}),
  };
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
  // Feldwege stay open for rally driving.
  if (tags.highway === 'track') return false;
  const v = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  return v === 'no';
}
/**
 * Kerb and pavement dimensions (RASt 06: Hochbord 10–12 cm, abgesenkt 3 cm at crossings and driveways).
 * The game keeps the kerb low (8 cm, like a Rundbord) so the car can cut across pavements and squares.
 */
export const KERB = {
  /** Raised kerb above the carriageway, metres. */
  height: 0.08,
  /** Lowered kerb (Bordsteinabsenkung) at crossings and where the pavement ends at a junction. */
  lowered: 0.03,
  /** Pavement width beside the carriageway. */
  width: 2.2,
  /** Lowered stretch around a mapped crossing, metres either side. */
  crossing: 2.5,
};
