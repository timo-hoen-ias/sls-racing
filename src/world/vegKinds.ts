// Vegetation kinds, shared by the pipeline (pipeline/lib/vegetation.ts) and the game (src/world/vegetation.ts).
// A tile's "treeKinds" field holds one Uint8 per tree in "trees" order; "bushes" holds Float32 x, y, z, scale, kind.

export const Tree = { broadleaf: 0, conifer: 1, poplar: 2, birch: 3, fruit: 4 } as const;
export type TreeKind = (typeof Tree)[keyof typeof Tree];
export const TREE_NAMES: Record<TreeKind, string> = { 0: 'laubbaum', 1: 'nadelbaum', 2: 'pappel', 3: 'birke', 4: 'obstbaum' };

export const Bush = { round: 0, scrub: 1 } as const;
export type BushKind = (typeof Bush)[keyof typeof Bush];
export const BUSH_STRIDE = 5;
