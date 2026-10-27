// What a road looks like, packed into one number per way that the pipeline writes into the road mesh's
// uv.y (uv.x stays 0 at the right edge, 1 at the left edge). The road shader (render/pbr/surfaces.ts)
// unpacks it. Pure TypeScript: used by the pipeline and the game.
//
//   bits 0-2   surface: a street atlas cell (asphalt, worn, cracked, sett, gravel, plaza …), or 4 = Feldweg
//   bits 3-4   edge lines: 0 none, 1 both sides, 2 one-way (right at the shoulder, left at the inner strip);
//              on a Feldweg the grass on it, 0 (gravel road) … 3 (meadow track)
//   bit  5     gutter: granite sett channel along both kerbs; on a Feldweg gravel ruts instead of earth
//   bits 6-9   shoulder: edge line distance from the road edge, quarter metres
//   bits 10-17 width: carriageway width, quarter metres
//   bits 18-19 inner: one-way left edge line distance from the left edge, quarter metres (0.25 … 1)

export const SURFACE = { asphalt: 0, asphalt_worn: 1, asphalt_cracked: 2, sett: 3, field: 4, gravel: 6, plaza: 7 } as const;
export type RoadSurfaceName = keyof typeof SURFACE;

export interface RoadLook {
  surface: number;
  lines: 0 | 1 | 2 | 3;
  gutter: boolean;
  shoulder: number;
  /** One-way roads: edge line distance from the left edge. */
  inner?: number;
  width: number;
}

/** Edge line width: broad line (30 cm) on motorways and their ramps (RMS), else 15 cm. */
export const edgeLineWidth = (shoulder: number) => (shoulder >= 2 ? 0.3 : 0.15);

export function encodeRoad(r: RoadLook): number {
  const q = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v * 4)));
  // 20 bits: exact in the float32 uv.
  return (r.surface & 7) | (r.lines << 3) | ((r.gutter ? 1 : 0) << 5) | (q(r.shoulder, 15) << 6) | (q(r.width, 255) << 10) | ((Math.max(1, q(r.inner ?? 0.25, 4)) - 1) << 18);
}

export function decodeRoad(code: number): RoadLook {
  const c = Math.round(code);
  return { surface: c & 7, lines: ((c >> 3) & 3) as 0 | 1 | 2 | 3, gutter: !!((c >> 5) & 1), shoulder: ((c >> 6) & 15) / 4, width: ((c >> 10) & 255) / 4, inner: (((c >> 18) & 3) + 1) / 4 };
}

/** Surfaces a car can churn into ruts. */
export const UNPAVED = new Set(['gravel', 'fine_gravel', 'compacted', 'unpaved', 'dirt', 'ground', 'earth', 'grass', 'pebblestone', 'mud', 'sand', 'rock', 'woodchips', 'grass_paver']);
const STONY = new Set(['gravel', 'fine_gravel', 'compacted', 'pebblestone', 'rock']);

/**
 * A track drawn and driven as a Feldweg (wheel ruts, grass strip, loose grip): every track but a paved one
 * (asphalt, concrete, or grade1 without a surface tag). Unpaved paths outside town become tracks in the
 * pipeline (pipeline/lib/fieldWays.ts) and so Feldwege too.
 */
export function isFieldWay(tags: Record<string, string>): boolean {
  if (tags.highway !== 'track') return false;
  const s = tags.surface;
  if (s) return UNPAVED.has(s);
  return tags.tracktype !== 'grade1';
}

/** Grass on a Feldweg, 0 (gravel road) … 3 (meadow track), from tracktype, surface and promoted paths. */
export function fieldGrass(tags: Record<string, string>): 0 | 1 | 2 | 3 {
  const s = tags.surface ?? '';
  if (s === 'grass' || s === 'grass_paver') return 3;
  if (tags['sls:path']) return STONY.has(s) ? 1 : 3;
  switch (tags.tracktype) {
    case 'grade1': case 'grade2': return 1;
    case 'grade3': return 2;
    case 'grade4': case 'grade5': return 3;
  }
  return STONY.has(s) ? 1 : 2;
}

/** Loose stone in the ruts (light gravel) rather than earth (dark mud). */
export const fieldGravel = (tags: Record<string, string>) => STONY.has(tags.surface ?? '') || (!tags.surface && (tags.tracktype === 'grade1' || tags.tracktype === 'grade2'));

const hash = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** Classes with edge lines (where they have no kerbs). */
const EDGE_LINES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

/** Surface from the OSM surface tag, else asphalt whose wear depends on the class (and a per-way dice roll). */
export function roadSurface(tags: Record<string, string>, id: number): number {
  if (isFieldWay(tags)) return SURFACE.field;
  const s = tags.surface ?? '';
  if (['sett', 'cobblestone', 'unhewn_cobblestone', 'cobblestone:flattened'].includes(s)) return SURFACE.sett;
  if (['paving_stones', 'paving_stones:30', 'bricks', 'stone'].includes(s)) return SURFACE.plaza;
  if (['gravel', 'fine_gravel', 'compacted', 'unpaved', 'dirt', 'ground', 'earth', 'grass', 'pebblestone', 'mud', 'sand', 'grass_paver'].includes(s)) return SURFACE.gravel;
  const hw = tags.highway;
  if (!s && (hw === 'pedestrian' || hw === 'footway' || hw === 'steps')) return SURFACE.plaza;
  if (!s && (hw === 'path' || hw === 'bridleway')) return SURFACE.gravel;
  const r = hash(id);
  if (tags.smoothness === 'bad' || tags.smoothness === 'very_bad') return SURFACE.asphalt_cracked;
  if (['motorway', 'trunk', 'motorway_link', 'trunk_link'].includes(hw)) return r < 0.75 ? SURFACE.asphalt : SURFACE.asphalt_worn;
  if (['primary', 'secondary', 'primary_link', 'secondary_link'].includes(hw)) return r < 0.45 ? SURFACE.asphalt : r < 0.9 ? SURFACE.asphalt_worn : SURFACE.asphalt_cracked;
  if (['service', 'track'].includes(hw)) return r < 0.4 ? SURFACE.asphalt_worn : SURFACE.asphalt_cracked;
  return r < 0.2 ? SURFACE.asphalt : r < 0.65 ? SURFACE.asphalt_worn : SURFACE.asphalt_cracked;
}

/**
 * Look of one road way. Edge lines only where there are no kerbs (rural roads, motorways, links), at the
 * outer lane edges of the cross-section (src/world/roadSpec.ts).
 */
export function roadLook(tags: Record<string, string>, id: number, section: { width: number; oneway: boolean; outer: number; inner: number }, sidewalk: boolean): RoadLook {
  const surface = roadSurface(tags, id);
  if (surface === SURFACE.field) return { surface, lines: fieldGrass(tags), gutter: fieldGravel(tags), shoulder: 0.25, width: section.width };
  const paved = surface <= SURFACE.asphalt_cracked;
  const { width, oneway } = section;
  const lines = paved && EDGE_LINES.has(tags.highway) && !sidewalk && width > 4.5 ? (oneway ? 2 : 1) : 0;
  return { surface, lines, gutter: sidewalk && surface !== SURFACE.plaza, shoulder: Math.max(0.25, section.outer), inner: Math.max(0.25, section.inner), width };
}
