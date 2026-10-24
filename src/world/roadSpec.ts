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
  /** Carriageway centre to the right of the OSM line, metres (from `placement`, see placementShift). */
  shift: number;
  /** The rightmost lane is an auxiliary lane of a motorway junction (acceleration or deceleration lane). */
  aux: boolean;
  /** Offset of the divider between the through lanes and the auxiliary lane (block marking), if any. */
  block?: number;
}

/**
 * Where the OSM line lies across a one-way carriageway. Without a `placement` tag our roads are centred on
 * the line. OSM maps the lanes of a motorway junction with `placement=right_of:1` (the line stays on the
 * through lanes while a lane is added on the right), so placements are measured against the through lanes:
 * the given lane edge lands where it would lie on the same road without the extra lanes.
 *   aux: the rightmost lane is an added lane; without a placement the line then stays on the through lanes.
 */
function placementShift(placement: string | undefined, lanes: number, lane: number, width: number, inner: number, outer: number, aux: boolean): number {
  const m = /^(left_of|middle_of|right_of):(\d+)$/.exec(placement ?? '');
  // Line position in carriageway coordinates (from the centre, right positive), in lanes from the left lane edge.
  let at: number;
  if (m) at = +m[2] - (m[1] === 'left_of' ? 1 : m[1] === 'middle_of' ? 0.5 : 0);
  else if (aux) at = (lanes - 1) / 2;
  else return 0;
  if (!(at >= 0 && at <= lanes)) return 0;
  const line = -width / 2 + inner + at * lane;
  // Where the same lane edge lies on a centred road of this class: the lane block sits (outer - inner) / 2
  // left of the centre there.
  return (inner - outer) / 2 - line;
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

/** Kerb and pavement dimensions (RASt 06: Hochbord 10–12 cm, abgesenkt 3 cm at crossings and driveways). */
export const KERB = {
  /** Raised kerb above the carriageway, metres. */
  height: 0.12,
  /** Lowered kerb (Bordsteinabsenkung) at crossings and where the pavement ends at a junction. */
  lowered: 0.03,
  /** Pavement width beside the carriageway. */
  width: 2.2,
  /** Lowered stretch around a mapped crossing, metres either side. */
  crossing: 2.5,
};
