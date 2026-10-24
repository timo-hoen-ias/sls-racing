// Street furniture kinds, shared by the pipeline (pipeline/lib/props.ts) and the game (src/world/props.ts).
// A tile's "props" field holds Float32 records of PROP_STRIDE values: kind, x, y, z, heading, size.
// heading is the direction the prop faces as atan2(dx, dz) in the local frame; size is the segment length for
// linear props (fences, walls, hedges, guard rails, bridge railings), otherwise a variant number.

export const PROP_STRIDE = 6;

export const Prop = {
  busStop: 1, sign: 2, stopSign: 3, giveWay: 4, bollard: 5, block: 6, bench: 7, bin: 8, postBox: 9, recycling: 10,
  hydrant: 11, bikeStand: 12, column: 13, parkedCar: 14, fence: 15, wall: 16, hedge: 17, guardRail: 18, cityLimit: 19, railing: 20,
  /** Leitpfosten (roadside.ts): faces the traffic on its side; rectangle reflector in front, two dots behind. */
  delineator: 21,
  /** Richtungstafel (Z 625) in sharp rural curves, arrows pointing left or right; faces the approaching traffic. */
  chevronLeft: 22, chevronRight: 23,
} as const;
export type PropKind = (typeof Prop)[keyof typeof Prop];

/** Sign faces in props.glb. A Prop.sign record's size is the type's index here + 1 (0 = unknown sign),
 * negative for signs found on photos (see DETECTED). */
export const SIGN_TYPES = ['vorfahrtstrasse', 'vorfahrt', 'vorfahrt-achten', 'stop', 'einfahrt-verboten', 'tempo-30', 'tempo-50', 'tempo-70', 'tempo-100', 'ortsschild', 'zusatz', 'fussgaenger'] as const;
export type SignType = (typeof SIGN_TYPES)[number];

/** Sign type of a sign record, if known. */
export function signTypeOf(kind: PropKind, size: number): SignType | undefined {
  if (kind === Prop.stopSign) return 'stop';
  if (kind === Prop.giveWay) return 'vorfahrt-achten';
  if (kind === Prop.cityLimit) return 'ortsschild';
  return kind === Prop.sign ? SIGN_TYPES[Math.round(size < 0 ? DETECTED - size : size) - 1] : undefined;
}

/** Point props found on street-level photos (Mapillary) rather than in OSM have a negative size: DETECTED - sign size. */
export const DETECTED = -1;
export const DETECTED_KINDS = new Set<PropKind>([Prop.sign, Prop.stopSign, Prop.giveWay, Prop.bench, Prop.bin, Prop.hydrant]);
export const isDetected = (kind: PropKind, size: number) => size < 0 && DETECTED_KINDS.has(kind);

export const PROP_NAMES: Record<PropKind, string> = {
  1: 'bushaltestelle', 2: 'schild', 3: 'stoppschild', 4: 'vorfahrt-achten', 5: 'poller', 6: 'betonblock', 7: 'bank', 8: 'muelleimer',
  9: 'briefkasten', 10: 'container', 11: 'hydrant', 12: 'fahrradstaender', 13: 'litfasssaeule', 14: 'parker', 15: 'zaun', 16: 'mauer',
  17: 'hecke', 18: 'leitplanke', 19: 'ortsschild', 20: 'gelaender', 21: 'leitpfosten', 22: 'richtungstafel-links', 23: 'richtungstafel-rechts',
};

/** Groups for props.toggle. */
export const PROP_GROUPS: Record<string, PropKind[]> = {
  schilder: [2, 3, 4, 19, 1],
  moebel: [5, 6, 7, 8, 9, 10, 11, 12, 13],
  parker: [14],
  zaeune: [15, 16, 17, 18, 20],
  leit: [21, 22, 23],
};
