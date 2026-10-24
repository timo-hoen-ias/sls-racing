// Street furniture kinds, shared by the pipeline (pipeline/lib/props.ts) and the game (src/world/props.ts).
// A tile's "props" field holds Float32 records of PROP_STRIDE values: kind, x, y, z, heading, size.
// heading is the direction the prop faces as atan2(dx, dz) in the local frame; size is the segment length for
// linear props (fences, walls, hedges, guard rails), otherwise a variant number.

export const PROP_STRIDE = 6;

export const Prop = {
  busStop: 1, sign: 2, stopSign: 3, giveWay: 4, bollard: 5, block: 6, bench: 7, bin: 8, postBox: 9, recycling: 10,
  hydrant: 11, bikeStand: 12, column: 13, parkedCar: 14, fence: 15, wall: 16, hedge: 17, guardRail: 18, cityLimit: 19,
} as const;
export type PropKind = (typeof Prop)[keyof typeof Prop];

export const PROP_NAMES: Record<PropKind, string> = {
  1: 'bushaltestelle', 2: 'schild', 3: 'stoppschild', 4: 'vorfahrt-achten', 5: 'poller', 6: 'betonblock', 7: 'bank', 8: 'muelleimer',
  9: 'briefkasten', 10: 'container', 11: 'hydrant', 12: 'fahrradstaender', 13: 'litfasssaeule', 14: 'parker', 15: 'zaun', 16: 'mauer',
  17: 'hecke', 18: 'leitplanke', 19: 'ortsschild',
};

/** Groups for props.toggle. */
export const PROP_GROUPS: Record<string, PropKind[]> = {
  schilder: [2, 3, 4, 19, 1],
  moebel: [5, 6, 7, 8, 9, 10, 11, 12, 13],
  parker: [14],
  zaeune: [15, 16, 17, 18],
};
