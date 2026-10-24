// Tree species: the leaf cards and bark strips of the foliage atlases (tools/textures/build-foliage.ts) and the
// shape parameters the tree generator (treeGen.ts) builds each species from. Shared by the tool and the game.

/** Leaf atlas: FOLIAGE_GRID × FOLIAGE_GRID cells of FOLIAGE_CELL pixels. */
export const FOLIAGE_CELL = 512;
export const FOLIAGE_GRID = 4;

export interface LeafCard {
  id: string;
  /** ambientCG LeafSet with the leaf photos ("needles" are drawn). */
  set?: string;
  style: 'leaves' | 'sprigs' | 'needles';
  seed: number;
  /** Side twigs, leaves per side twig, side twig length (px at 512) and angle from the stem (rad). */
  sides: number;
  perSide: number;
  sideLen: number;
  spread: number;
  /** Leaf length (px at 512) and angle from its twig (rad). */
  leafPx: number;
  leafAngle: number;
  /** Stem width (px at 512) and twig colour. */
  stem: number;
  twig: [number, number, number];
  /** Leaf colour multiplier and the brightness range from inside to outside of the clump. */
  tint: [number, number, number];
  shade: [number, number];
}

const TWIG: [number, number, number] = [0.27, 0.21, 0.15];

export const LEAF_CARDS: LeafCard[] = [
  { id: 'linde', set: 'LeafSet004', style: 'leaves', seed: 11, sides: 9, perSide: 4, sideLen: 150, spread: 1.0, leafPx: 92, leafAngle: 0.9, stem: 7, twig: TWIG, tint: [0.92, 1, 0.82], shade: [0.62, 1.05] },
  { id: 'ahorn', set: 'LeafSet010', style: 'leaves', seed: 12, sides: 8, perSide: 3, sideLen: 145, spread: 1.0, leafPx: 104, leafAngle: 0.8, stem: 7, twig: TWIG, tint: [0.66, 0.92, 0.5], shade: [0.6, 1.0] },
  { id: 'eiche', set: 'LeafSet016', style: 'leaves', seed: 13, sides: 9, perSide: 4, sideLen: 140, spread: 1.0, leafPx: 96, leafAngle: 0.9, stem: 8, twig: TWIG, tint: [0.72, 0.9, 0.55], shade: [0.55, 0.95] },
  { id: 'buche', set: 'LeafSet014', style: 'leaves', seed: 14, sides: 10, perSide: 4, sideLen: 150, spread: 1.15, leafPx: 84, leafAngle: 1.0, stem: 6, twig: TWIG, tint: [0.78, 0.98, 0.6], shade: [0.6, 1.02] },
  { id: 'platane', set: 'LeafSet010', style: 'leaves', seed: 15, sides: 8, perSide: 3, sideLen: 140, spread: 1.0, leafPx: 108, leafAngle: 0.8, stem: 8, twig: TWIG, tint: [0.72, 0.95, 0.55], shade: [0.62, 1.0] },
  { id: 'birke', set: 'LeafSet022', style: 'leaves', seed: 16, sides: 12, perSide: 5, sideLen: 130, spread: 0.7, leafPx: 66, leafAngle: 0.7, stem: 4, twig: [0.3, 0.22, 0.17], tint: [0.95, 1.05, 0.75], shade: [0.65, 1.08] },
  { id: 'pappel', set: 'LeafSet022', style: 'leaves', seed: 17, sides: 11, perSide: 4, sideLen: 110, spread: 0.6, leafPx: 80, leafAngle: 0.7, stem: 6, twig: TWIG, tint: [0.8, 0.95, 0.65], shade: [0.58, 1.0] },
  { id: 'obst', set: 'LeafSet018', style: 'leaves', seed: 18, sides: 9, perSide: 4, sideLen: 140, spread: 1.0, leafPx: 84, leafAngle: 0.9, stem: 7, twig: TWIG, tint: [0.85, 1, 0.75], shade: [0.6, 1.02] },
  { id: 'fichte', set: 'LeafSet019', style: 'sprigs', seed: 19, sides: 16, perSide: 0, sideLen: 0, spread: 1.0, leafPx: 260, leafAngle: 0, stem: 10, twig: [0.25, 0.19, 0.14], tint: [0.72, 0.9, 0.74], shade: [0.6, 1.0] },
  { id: 'kiefer', style: 'needles', seed: 20, sides: 10, perSide: 26, sideLen: 120, spread: 1.0, leafPx: 95, leafAngle: 0, stem: 9, twig: [0.33, 0.24, 0.16], tint: [0.3, 0.46, 0.27], shade: [0.7, 1.15] },
  { id: 'busch', set: 'LeafSet001', style: 'leaves', seed: 21, sides: 11, perSide: 4, sideLen: 150, spread: 1.2, leafPx: 80, leafAngle: 1.0, stem: 5, twig: TWIG, tint: [0.78, 0.98, 0.62], shade: [0.55, 1.0] },
  { id: 'gebuesch', set: 'LeafSet005', style: 'leaves', seed: 22, sides: 10, perSide: 3, sideLen: 150, spread: 1.2, leafPx: 110, leafAngle: 0.9, stem: 5, twig: TWIG, tint: [0.75, 0.92, 0.6], shade: [0.55, 1.0] },
];

export interface BarkSpec {
  id: string;
  set: string;
  /** Target colour (sRGB) and how far the photo is pulled towards it (0..1). */
  tint: [number, number, number, number];
  lenticels?: boolean;
}

export const BARKS: BarkSpec[] = [
  { id: 'rau', set: 'Bark001', tint: [0.36, 0.32, 0.28, 0.35] },
  { id: 'glatt', set: 'Bark010', tint: [0.5, 0.5, 0.48, 0.8] },
  { id: 'birke', set: 'Bark007', tint: [0.86, 0.84, 0.8, 0.6], lenticels: true },
  { id: 'fichte', set: 'Bark006', tint: [0.33, 0.24, 0.2, 0.45] },
  { id: 'kiefer', set: 'Bark012', tint: [0.5, 0.33, 0.22, 0.4] },
  { id: 'platane', set: 'Bark009', tint: [0.6, 0.58, 0.48, 0.25] },
];

/** How a species grows (treeGen.ts). Lengths are in metres for a tree of `height`. */
export interface SpeciesShape {
  id: string;
  leaf: string;
  bark: string;
  /** Model height and crown radius (m); the game scales instances from these. */
  height: number;
  crown: number;
  /** Habit: round broadleaf crown, conical conifer, columnar poplar, umbrella pine, multi-stem bush. */
  form: 'round' | 'cone' | 'column' | 'umbrella' | 'bush';
  /** Height of the first branches as a share of the height. */
  bole: number;
  /** Crown vertical radius relative to its horizontal radius. */
  crownAspect: number;
  /** Trunk radius at the base (m). */
  trunk: number;
  /** Main branches, their upward angle (rad from horizontal) and sub branches per main branch. */
  branches: number;
  rise: number;
  subs: number;
  /** Random bends in trunk and branches 0..1. */
  gnarl: number;
  /** Leaf card size (m) and cards per metre of outer twig (detailed model). */
  card: number;
  density: number;
  /** Branch tips droop (m per m of length, birch and spruce). */
  droop: number;
  /** Cards on the inner crown shell per card area of shell (leaf mass, 0 = only twig cards). */
  fill: number;
}

export const SPECIES: SpeciesShape[] = [
  { id: 'linde', leaf: 'linde', bark: 'rau', height: 14, crown: 5, form: 'round', bole: 0.2, crownAspect: 1.15, trunk: 0.32, branches: 11, rise: 0.7, subs: 6, gnarl: 0.35, card: 2.3, density: 1.95, droop: 0.05, fill: 0.77 },
  { id: 'ahorn', leaf: 'ahorn', bark: 'rau', height: 13, crown: 5, form: 'round', bole: 0.2, crownAspect: 1.0, trunk: 0.3, branches: 10, rise: 0.8, subs: 6, gnarl: 0.4, card: 2.4, density: 1.8, droop: 0, fill: 0.68 },
  { id: 'eiche', leaf: 'eiche', bark: 'rau', height: 15, crown: 6.5, form: 'round', bole: 0.22, crownAspect: 0.85, trunk: 0.45, branches: 10, rise: 0.4, subs: 6, gnarl: 0.8, card: 2.5, density: 1.8, droop: 0, fill: 0.64 },
  { id: 'buche', leaf: 'buche', bark: 'glatt', height: 18, crown: 5.5, form: 'round', bole: 0.26, crownAspect: 1.3, trunk: 0.34, branches: 11, rise: 0.9, subs: 6, gnarl: 0.25, card: 2.3, density: 1.95, droop: 0.05, fill: 0.77 },
  { id: 'platane', leaf: 'platane', bark: 'platane', height: 16, crown: 6.5, form: 'round', bole: 0.22, crownAspect: 0.95, trunk: 0.4, branches: 9, rise: 0.6, subs: 6, gnarl: 0.55, card: 2.6, density: 1.65, droop: 0, fill: 0.64 },
  { id: 'birke', leaf: 'birke', bark: 'birke', height: 14, crown: 3.4, form: 'round', bole: 0.25, crownAspect: 1.7, trunk: 0.2, branches: 12, rise: 0.95, subs: 5, gnarl: 0.3, card: 1.8, density: 2.1, droop: 0.4, fill: 0.47 },
  { id: 'pappel', leaf: 'pappel', bark: 'rau', height: 22, crown: 2.6, form: 'column', bole: 0.1, crownAspect: 4, trunk: 0.36, branches: 24, rise: 1.25, subs: 2, gnarl: 0.2, card: 2.0, density: 1.95, droop: 0, fill: 0.77 },
  { id: 'obst', leaf: 'obst', bark: 'rau', height: 5.5, crown: 3, form: 'round', bole: 0.28, crownAspect: 0.75, trunk: 0.16, branches: 7, rise: 0.6, subs: 5, gnarl: 0.8, card: 1.4, density: 2.25, droop: 0.1, fill: 0.59 },
  { id: 'fichte', leaf: 'fichte', bark: 'fichte', height: 22, crown: 3.6, form: 'cone', bole: 0.08, crownAspect: 3.2, trunk: 0.3, branches: 36, rise: -0.15, subs: 3, gnarl: 0.1, card: 2.2, density: 2.1, droop: 0.25, fill: 0.68 },
  { id: 'kiefer', leaf: 'kiefer', bark: 'kiefer', height: 20, crown: 3.8, form: 'umbrella', bole: 0.55, crownAspect: 0.75, trunk: 0.28, branches: 9, rise: 0.75, subs: 4, gnarl: 0.65, card: 1.8, density: 1.95, droop: 0, fill: 0.68 },
  { id: 'busch', leaf: 'busch', bark: 'rau', height: 1.6, crown: 1.1, form: 'bush', bole: 0, crownAspect: 0.8, trunk: 0.04, branches: 6, rise: 1.0, subs: 2, gnarl: 0.5, card: 0.9, density: 3.75, droop: 0, fill: 0.85 },
  { id: 'gebuesch', leaf: 'gebuesch', bark: 'rau', height: 2.2, crown: 1.5, form: 'bush', bole: 0, crownAspect: 0.7, trunk: 0.05, branches: 8, rise: 0.9, subs: 2, gnarl: 0.6, card: 1.1, density: 3.0, droop: 0, fill: 0.85 },
];
