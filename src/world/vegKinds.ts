// Vegetation kinds, shared by the pipeline (pipeline/lib/vegetation.ts) and the game (src/world/vegetation.ts).
// A tile's "treeKinds" field holds one Uint8 per tree in "trees" order; "bushes" holds Float32 x, y, z, scale, kind.
// "treeCrowns" (optional, also one Uint8 per tree) is the measured crown radius in decimetres for trees from the
// LiDAR survey, 0 for mapped or scattered trees (drawn with the model's own crown).

export const Tree = { broadleaf: 0, conifer: 1, poplar: 2, birch: 3, fruit: 4 } as const;
export type TreeKind = (typeof Tree)[keyof typeof Tree];
export const TREE_NAMES: Record<TreeKind, string> = { 0: 'laubbaum', 1: 'nadelbaum', 2: 'pappel', 3: 'birke', 4: 'obstbaum' };

/** Height (m) of a tree of scale 1 per kind: scale = measured height / TREE_HEIGHT[kind]. */
export const TREE_HEIGHT: Record<TreeKind, number> = { 0: 8.4, 1: 10.8, 2: 13.6, 3: 8.8, 4: 4.8 };

export const Bush = { round: 0, scrub: 1 } as const;
export type BushKind = (typeof Bush)[keyof typeof Bush];
export const BUSH_STRIDE = 5;
