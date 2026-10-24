// What a road looks like, packed into one number per way that the pipeline writes into the road mesh's
// uv.y (uv.x stays 0 at the right edge, 1 at the left edge). The road shader (render/pbr/surfaces.ts)
// unpacks it. Pure TypeScript: used by the pipeline and the game.
//
//   bits 0-2   surface: a street atlas cell (asphalt, worn, cracked, sett, gravel, plaza …)
//   bits 3-4   edge lines: 0 none, 1 both sides, 2 one-way (right at the shoulder, left 0.5 m in)
//   bit  5     gutter: granite sett channel along both kerbs
//   bits 6-9   shoulder: edge line distance from the road edge, quarter metres
//   bits 10-17 width: carriageway width, quarter metres

export const SURFACE = { asphalt: 0, asphalt_worn: 1, asphalt_cracked: 2, sett: 3, gravel: 6, plaza: 7 } as const;
export type RoadSurfaceName = keyof typeof SURFACE;

export interface RoadLook {
  surface: number;
  lines: 0 | 1 | 2;
  gutter: boolean;
  shoulder: number;
  width: number;
}

export function encodeRoad(r: RoadLook): number {
  const q = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v * 4)));
  return (r.surface & 7) | (r.lines << 3) | ((r.gutter ? 1 : 0) << 5) | (q(r.shoulder, 15) << 6) | (q(r.width, 255) << 10);
}

export function decodeRoad(code: number): RoadLook {
  const c = Math.round(code);
  return { surface: c & 7, lines: ((c >> 3) & 3) as 0 | 1 | 2, gutter: !!((c >> 5) & 1), shoulder: ((c >> 6) & 15) / 4, width: (c >> 10) / 4 };
}

const hash = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** Distance of the edge line from the road edge per class (on roads without kerbs). */
const SHOULDER: Record<string, number> = {
  motorway: 2.75, trunk: 1.25, primary: 0.5, secondary: 0.5, tertiary: 0.35,
  motorway_link: 1.5, trunk_link: 1, primary_link: 0.5, secondary_link: 0.5, tertiary_link: 0.5,
};

/** Surface from the OSM surface tag, else asphalt whose wear depends on the class (and a per-way dice roll). */
export function roadSurface(tags: Record<string, string>, id: number): number {
  const s = tags.surface ?? '';
  if (['sett', 'cobblestone', 'unhewn_cobblestone', 'cobblestone:flattened'].includes(s)) return SURFACE.sett;
  if (['paving_stones', 'paving_stones:30', 'bricks', 'stone'].includes(s)) return SURFACE.plaza;
  if (['gravel', 'fine_gravel', 'compacted', 'unpaved', 'dirt', 'ground', 'earth', 'grass', 'pebblestone', 'mud', 'sand', 'grass_paver'].includes(s)) return SURFACE.gravel;
  const hw = tags.highway;
  if (!s && hw === 'track' && tags.tracktype !== 'grade1') return SURFACE.gravel;
  if (!s && hw === 'pedestrian') return SURFACE.plaza;
  const r = hash(id);
  if (tags.smoothness === 'bad' || tags.smoothness === 'very_bad') return SURFACE.asphalt_cracked;
  if (['motorway', 'trunk', 'motorway_link', 'trunk_link'].includes(hw)) return r < 0.75 ? SURFACE.asphalt : SURFACE.asphalt_worn;
  if (['primary', 'secondary', 'primary_link', 'secondary_link'].includes(hw)) return r < 0.45 ? SURFACE.asphalt : r < 0.9 ? SURFACE.asphalt_worn : SURFACE.asphalt_cracked;
  if (['service', 'track'].includes(hw)) return r < 0.4 ? SURFACE.asphalt_worn : SURFACE.asphalt_cracked;
  return r < 0.2 ? SURFACE.asphalt : r < 0.65 ? SURFACE.asphalt_worn : SURFACE.asphalt_cracked;
}

/** Look of one road way. Edge lines only where there are no kerbs (rural roads, motorways, links). */
export function roadLook(tags: Record<string, string>, id: number, width: number, sidewalk: boolean, oneway: boolean): RoadLook {
  const surface = roadSurface(tags, id);
  const paved = surface <= SURFACE.asphalt_cracked;
  const shoulder = SHOULDER[tags.highway];
  const lines = paved && shoulder !== undefined && !sidewalk && width > 4.5 ? (oneway ? 2 : 1) : 0;
  return { surface, lines, gutter: sidewalk && surface !== SURFACE.plaza, shoulder: shoulder ?? 0, width };
}
