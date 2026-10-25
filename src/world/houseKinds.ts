// Freely designed houses and their front gardens, shared by the pipeline (pipeline/lib/houses.ts), the game
// (src/world/houses.ts) and the physics (tileColliders.ts). The models come from tools/blender/make_houses.py.
//
// A tile's "houses" field holds Float32 records of HOUSE_STRIDE values:
//   model (index into HOUSE_MODELS), x, y (ground under the lowest corner), z, heading (direction the front faces,
//   atan2(dx, dz) in the local frame), sx (scale along the front), sz (scale front to back), wall tint (index into
//   the style's TINTS), seed (0..1, lit windows and small variations).
// A tile's "gardens" field holds Float32 records of GARDEN_STRIDE values: part (index into GARDEN_PARTS), x, y, z,
//   heading (linear parts: direction along the piece; point parts: the way they face), length (linear parts).
import catalog from './houseCatalog.json' with { type: 'json' };

export const HOUSE_STRIDE = 9;
export const GARDEN_STRIDE = 6;

export type HouseStyle = keyof typeof catalog.styles;
export type HouseKind = 'haus' | 'villa' | 'gross';

export interface HouseModel {
  id: string;
  name: string;
  style: HouseStyle;
  kind: HouseKind;
  /** Footprint along the front and front to back (m). */
  w: number;
  d: number;
  /** Wall height (m) for the collider. */
  h: number;
  /** x of the front door and the garage door in model space, null if none. */
  door: number;
  garage: number | null;
  garden: GardenStyle;
  /** How far (m) steps and porches reach out in front of the footprint, and eaves or towers at the back and sides. */
  front: number;
  reach: number;
}

export const HOUSE_MODELS = catalog.models as HouseModel[];
export const HOUSE_STYLES = catalog.styles as Record<HouseStyle, string>;
export const houseIndex = (id: string) => HOUSE_MODELS.findIndex((m) => m.id === id);

/** Surface codes in the models' uv.x (keep in sync with SURF in make_houses.py). */
export const SURFACE = {
  paint: 0, plaster: 1, rough: 2, brick: 3, concrete: 4, clay: 5, slate: 6, gravel: 7, metal: 8, wood: 9, glass: 10,
  stone: 11, foliage: 12, lawn: 13, paving: 14, kies: 15, timber: 16, seam: 17,
} as const;

/** Tint codes in the models' uv.y (keep in sync with T_* in make_houses.py): what the game varies per house. */
export const TINT = { fixed: 0, wall: 1, roof: 2, shutter: 3, door: 4 } as const;

/** Roof shades (linear multipliers on the tile colour), picked per house by its seed. */
export const ROOF_SHADES: [number, number, number][] = [
  [1, 1, 1], [1, 1, 1], [0.78, 0.68, 0.64], [0.55, 0.5, 0.5], [1.12, 0.98, 0.88], [0.86, 0.86, 0.9],
];
/** Shutter and door colours (sRGB hex), picked per house by its seed; null keeps the model's own colour. */
export const SHUTTER_COLOURS: (number | null)[] = [null, null, 0x2f5a3c, 0x3a5470, 0x7a2a2a, 0x8a8c88, 0xece8de, 0x5a4a3a];
export const DOOR_COLOURS: (number | null)[] = [null, null, 0x2c2e31, 0x7a1e22, 0x24406a, 0x2f4a36, 0xe8e6e0, 0x6a4a2e];

/** Wall colours per style (sRGB hex), multiplied onto the model's light wall colour where it is tintable. */
export const TINTS: Record<HouseStyle, number[]> = {
  modern: [0xffffff, 0xf4f2ee, 0xe8e8e8, 0xfff8ec, 0xdedcd8],
  antik: [0xffffff, 0xfff0d8, 0xf0e4d0, 0xffe8d0, 0xe8f0ec, 0xf8e0c8],
  architekt: [0xffffff, 0xf0f0f0, 0xe4e0d8],
  landhaus: [0xffffff, 0xfffaf0, 0xfff0d8, 0xf4ecdc, 0xffe8e0],
  klassisch: [0xffffff, 0xfff6e8, 0xf4ecd8, 0xece4d4, 0xfff0e0, 0xe8e8e4],
  stadtvilla: [0xffffff, 0xfff4e4, 0xffe8d4, 0xf8f0e0, 0xffe0c8, 0xf4f4ee],
  villa: [0xffffff, 0xfff4e0, 0xf8ecd8, 0xfffaf2],
  verwaltung: [0xffffff, 0xfff0dc, 0xf4e8d4],
};

/** Garden parts in houses.glb (garten-<name>), the order is the tile encoding. */
export const GARDEN_PARTS = [
  'zaun-holz', 'zaun-schmiede', 'gabione', 'mauer-beton', 'mauer-klinker', 'hecke', 'hecke-hoch', 'pfeiler', 'pfeiler-klinker',
  'tor-holz', 'tor-schmiede', 'weg', 'kiesweg', 'auffahrt', 'beet', 'rosen', 'graeser', 'strauch', 'buchskugel', 'baeumchen',
  'briefkasten', 'tonnen', 'laterne', 'brunnen', 'fahnenmast', 'zwerg', 'bank',
] as const;
export type GardenPart = (typeof GARDEN_PARTS)[number];
export const gardenIndex = (p: GardenPart) => GARDEN_PARTS.indexOf(p);

/** Parts 1 m long along their heading, scaled by the record's length. */
export const GARDEN_LINEAR = new Set<GardenPart>(['zaun-holz', 'zaun-schmiede', 'gabione', 'mauer-beton', 'mauer-klinker', 'hecke', 'hecke-hoch', 'tor-holz', 'tor-schmiede', 'weg', 'kiesweg', 'auffahrt', 'beet', 'rosen']);

/** Colliders: cuboid [width across, height] for linear parts, [w, h, d] boxes or [r, h] cylinders for point parts. */
export const GARDEN_COLLIDERS: Partial<Record<GardenPart, { w: number; h: number; d?: number } | { r: number; h: number }>> = {
  'zaun-holz': { w: 0.1, h: 0.95 }, 'zaun-schmiede': { w: 0.3, h: 1.4 }, gabione: { w: 0.4, h: 1.0 }, 'mauer-beton': { w: 0.24, h: 0.7 },
  'mauer-klinker': { w: 0.3, h: 0.82 }, hecke: { w: 0.7, h: 1.1 }, 'hecke-hoch': { w: 0.7, h: 1.8 }, 'tor-holz': { w: 0.1, h: 0.9 },
  'tor-schmiede': { w: 0.06, h: 1.5 }, pfeiler: { w: 0.5, h: 1.6, d: 0.5 }, 'pfeiler-klinker': { w: 0.45, h: 1.3, d: 0.45 },
  baeumchen: { r: 0.08, h: 1.8 }, brunnen: { r: 1.4, h: 0.45 }, fahnenmast: { r: 0.07, h: 8 }, briefkasten: { r: 0.06, h: 1.2 },
  laterne: { r: 0.05, h: 1.1 },
};

export type GardenStyle = 'modern' | 'antik' | 'architekt' | 'landhaus' | 'klassisch' | 'hecke' | 'villa' | 'amt';

export interface GardenSpec {
  /** Linear part along the property line. */
  fence: GardenPart;
  gate?: GardenPart;
  pillar?: GardenPart;
  path: GardenPart;
  beds: GardenPart[];
  /** Point parts scattered over the free ground, in order of preference. */
  points: GardenPart[];
}

export const GARDENS: Record<GardenStyle, GardenSpec> = {
  modern: { fence: 'gabione', path: 'weg', beds: ['graeser'], points: ['buchskugel', 'briefkasten', 'graeser', 'tonnen', 'laterne', 'buchskugel'] },
  antik: { fence: 'zaun-schmiede', gate: 'tor-schmiede', pillar: 'pfeiler', path: 'kiesweg', beds: ['rosen'], points: ['buchskugel', 'briefkasten', 'strauch', 'buchskugel', 'laterne'] },
  architekt: { fence: 'mauer-beton', path: 'weg', beds: ['graeser'], points: ['baeumchen', 'briefkasten', 'graeser', 'tonnen', 'graeser'] },
  landhaus: { fence: 'zaun-holz', gate: 'tor-holz', path: 'kiesweg', beds: ['beet', 'rosen'], points: ['strauch', 'zwerg', 'briefkasten', 'bank', 'strauch', 'tonnen'] },
  klassisch: { fence: 'mauer-klinker', gate: 'tor-schmiede', pillar: 'pfeiler-klinker', path: 'weg', beds: ['beet'], points: ['strauch', 'briefkasten', 'tonnen', 'zwerg', 'buchskugel'] },
  hecke: { fence: 'hecke', gate: 'tor-schmiede', pillar: 'pfeiler', path: 'kiesweg', beds: ['rosen'], points: ['buchskugel', 'briefkasten', 'laterne', 'buchskugel', 'strauch'] },
  villa: { fence: 'zaun-schmiede', gate: 'tor-schmiede', pillar: 'pfeiler', path: 'kiesweg', beds: ['rosen', 'beet'], points: ['brunnen', 'baeumchen', 'buchskugel', 'laterne', 'baeumchen', 'bank', 'buchskugel'] },
  amt: { fence: 'hecke', path: 'weg', beds: ['beet', 'rosen'], points: ['fahnenmast', 'fahnenmast', 'fahnenmast', 'bank', 'laterne', 'baeumchen'] },
};
