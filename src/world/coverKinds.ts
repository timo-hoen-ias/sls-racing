// Land cover of the terrain (pipeline/lib/landcover.ts) and how the ground shader draws it. Shared by the
// pipeline, the tile builder and the shader, so all three agree on the classes and the splat channels.
import { Ground } from './format.ts';

/** Land cover classes of the 2 m raster. Values are stored in the committed rasters. */
export const Cover = {
  none: 0, lawn: 1, meadow: 2, dryGrass: 3, cropGreen: 4, cropRipe: 5, soil: 6, vegRows: 7, forestFloor: 8,
  scrub: 9, paved: 10, gravel: 11, ballast: 12, clay: 13, water: 14, wetland: 15, orchard: 16, roof: 17, underTree: 18,
} as const;
export type CoverClass = (typeof Cover)[keyof typeof Cover];
export const COVER_NAMES = Object.keys(Cover) as (keyof typeof Cover)[];

/**
 * Texture channels of the terrain, blended per vertex (tile field "splat", 8 bytes per vertex): the ground
 * shader maps each to an atlas cell. Order is part of the tile format.
 */
export const SPLAT = ['lawn', 'meadow', 'patchy', 'forest', 'field', 'paved', 'gravel', 'mud'] as const;
export type SplatChannel = (typeof SPLAT)[number];

type Mix = Partial<Record<SplatChannel, number>> & { rows?: number };

/** What each cover class looks like: texture channel weights, and how strongly crop rows show (0..1). */
export const COVER_LOOK: Record<CoverClass, Mix> = {
  [Cover.none]: {},
  [Cover.lawn]: { lawn: 1 },
  [Cover.meadow]: { meadow: 1 },
  [Cover.dryGrass]: { patchy: 0.6, meadow: 0.4 },
  [Cover.cropGreen]: { meadow: 0.75, field: 0.25, rows: 1 },
  [Cover.cropRipe]: { meadow: 0.45, field: 0.55, rows: 1 },
  [Cover.soil]: { field: 1, rows: 0.45 },
  [Cover.vegRows]: { field: 0.5, lawn: 0.5, rows: 1 },
  [Cover.forestFloor]: { forest: 1 },
  [Cover.scrub]: { forest: 0.5, meadow: 0.5 },
  [Cover.paved]: { paved: 1 },
  [Cover.gravel]: { gravel: 1 },
  [Cover.ballast]: { gravel: 1 },
  [Cover.clay]: { gravel: 0.5, field: 0.5 },
  [Cover.water]: { mud: 1 },
  [Cover.wetland]: { mud: 0.4, meadow: 0.6 },
  [Cover.orchard]: { meadow: 1 },
  // Ground under a building does not show; paved keeps the walls' feet clean.
  [Cover.roof]: { paved: 1 },
  [Cover.underTree]: { patchy: 0.5, lawn: 0.3, forest: 0.2 },
};

/** Looks for tiles without land cover (outside the aerial survey), from the coarse OSM ground class. */
export const GROUND_LOOK: Record<number, Mix> = {
  [Ground.urban]: { patchy: 0.5, paved: 0.5 },
  [Ground.grass]: { lawn: 0.5, meadow: 0.5 },
  [Ground.forest]: { forest: 1 },
  [Ground.water]: { mud: 1 },
  [Ground.farmland]: { field: 0.6, meadow: 0.4, rows: 1 },
};

/** sRGB colours (0..255) the aerial survey typically shows per channel: the reference its tint is relative to. */
export const SPLAT_AERIAL_REF: Record<SplatChannel, [number, number, number]> = {
  lawn: [92, 104, 84],
  meadow: [102, 118, 92],
  patchy: [121, 130, 110],
  forest: [86, 100, 80],
  field: [168, 160, 150],
  paved: [158, 157, 153],
  gravel: [165, 158, 147],
  mud: [80, 88, 76],
};

/** Art-directed ground colour per channel (sRGB) that the aerial tint varies around. */
export const SPLAT_COLOUR: Record<SplatChannel, string> = {
  lawn: '#5c7a3a',
  meadow: '#6c7f42',
  patchy: '#7f7a52',
  forest: '#4a4a30',
  field: '#7d6a4f',
  paved: '#8a8780',
  gravel: '#9a8f7c',
  mud: '#4d4a3a',
};

/** Splat weights (8 channels, summing to 1) and row strength of a look. */
export function lookWeights(m: Mix): { w: number[]; rows: number } {
  const w = SPLAT.map((c) => m[c] ?? 0);
  const s = w.reduce((a, b) => a + b, 0);
  return { w: s > 0 ? w.map((v) => v / s) : w, rows: m.rows ?? 0 };
}
