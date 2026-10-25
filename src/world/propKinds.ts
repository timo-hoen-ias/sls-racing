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
  // OSM details (2026-10-25): access barriers, technical boxes, advertising, culture and leisure furniture.
  /** barrier=gate: closed across paths and fields, swung open beside a road it is mapped on. size 1 = open. */
  gate: 24,
  /** barrier=lift_gate: boom raised (the road stays open), breakable. */
  liftGate: 25,
  cycleBarrier: 26, streetCabinet: 27, guidepost: 28,
  /** tourism=information board (size 0) or map (size 1). */
  infoBoard: 29,
  chargingStation: 30, camera: 31, emergencyPhone: 32, billboard: 33, posterBox: 34, flagpole: 35, huntingStand: 36,
  waysideCross: 37,
  /** historic=memorial/monument: size 0 stone, 1 stele, 2 plaque on a post, 3 monument on a plinth. */
  memorial: 38,
  artwork: 39, shelter: 40, picnicTable: 41,
  /** amenity=vending_machine: size 0 cigarettes and other goods, 1 parking tickets. */
  vending: 42,
  trafficMirror: 43,
  /** highway=speed_camera: the Blitzer column (speed traps, src/game/speedTraps.ts). */
  speedCamera: 44,
  fountain: 45, parcelLocker: 46, bunker: 47, boundaryStone: 48,
  /** barrier=retaining_wall: linear, 1 m along z like walls, stepped stone. */
  retainingWall: 49,
  /** Maschendrahtzaun (fence_type=chain_link, OSM fixes in osmFixes.ts): linear like fences, a see-through wire mesh. */
  chainLink: 50,
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
/** Hedges measured from the laser heights rather than mapped in OSM have a negative length. */
export const isMeasured = (kind: PropKind, size: number) => size < 0 && kind === Prop.hedge;
/** Length of a linear prop record (measured hedges store it negated). */
export const linearLength = (size: number) => Math.max(0.2, Math.abs(size));

export const PROP_NAMES: Record<PropKind, string> = {
  1: 'bushaltestelle', 2: 'schild', 3: 'stoppschild', 4: 'vorfahrt-achten', 5: 'poller', 6: 'betonblock', 7: 'bank', 8: 'muelleimer',
  9: 'briefkasten', 10: 'container', 11: 'hydrant', 12: 'fahrradstaender', 13: 'litfasssaeule', 14: 'parker', 15: 'zaun', 16: 'mauer',
  17: 'hecke', 18: 'leitplanke', 19: 'ortsschild', 20: 'gelaender', 21: 'leitpfosten', 22: 'richtungstafel-links', 23: 'richtungstafel-rechts',
  24: 'tor', 25: 'schranke', 26: 'umlaufsperre', 27: 'verteilerkasten', 28: 'wegweiser', 29: 'infotafel', 30: 'ladesaeule',
  31: 'kamera', 32: 'notrufsaeule', 33: 'werbetafel', 34: 'plakatvitrine', 35: 'fahnenmast', 36: 'hochsitz', 37: 'wegkreuz',
  38: 'denkmal', 39: 'kunstwerk', 40: 'schutzhuette', 41: 'picknicktisch', 42: 'automat', 43: 'verkehrsspiegel', 44: 'blitzer',
  45: 'brunnen', 46: 'packstation', 47: 'bunker', 48: 'grenzstein', 49: 'stuetzmauer', 50: 'maschendrahtzaun',
};

/** Groups for props.toggle. */
export const PROP_GROUPS: Record<string, PropKind[]> = {
  schilder: [2, 3, 4, 19, 1],
  moebel: [5, 6, 7, 8, 9, 10, 11, 12, 13],
  parker: [14],
  zaeune: [15, 16, 17, 18, 20, 50],
  leit: [21, 22, 23],
  zugang: [24, 25, 26],
  technik: [27, 30, 31, 32, 42, 43, 44, 46],
  werbung: [33, 34, 35],
  kultur: [37, 38, 39, 45, 47, 48],
  freizeit: [28, 29, 36, 40, 41],
  mauern: [49],
};
