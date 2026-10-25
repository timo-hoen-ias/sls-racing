// Shared between the pipeline (Node) and the game client. Keep it free of DOM and Node APIs.

/** Edge length of one world tile in metres. Tiles sit on the global UTM grid, not per city. */
export const TILE_SIZE = 256;
/** Terrain samples per tile edge (TERRAIN_N - 1 cells of TILE_SIZE / (TERRAIN_N - 1) metres). */
export const TERRAIN_N = 65;
export const TERRAIN_STEP = TILE_SIZE / (TERRAIN_N - 1);

/** Far view tiles (P3): edge length in metres and terrain samples per edge (32 m grid). */
export const FAR_TILE_SIZE = 2048;
export const FAR_N = 65;
/** Floats per building block in a far tile: centre x, z, half length, half width, angle, base y, top y. */
export const FAR_BLOCK = 7;

/** Ground classes painted onto the terrain grid. */
export const Ground = { urban: 0, grass: 1, forest: 2, water: 3, farmland: 4 } as const;

export interface WorldInfo {
  /** UTM zone of the world grid (32 = ETRS89 / UTM 32N, EPSG:25832). */
  zone: number;
  /** UTM easting / northing of the local origin (x = 0, z = 0). */
  originE: number;
  originN: number;
  tileSize: number;
}

export interface WorldIndex {
  v: 1;
  /** Tile file format: "bin" = t/<key>.bin (encodeTile). Older builds without it wrote t/<key>.json. */
  format?: 'bin';
  world: WorldInfo;
  regions: { id: string; name: string }[];
  /** Global grid indices: ix = floor(E / TILE_SIZE), iy = floor(N / TILE_SIZE). */
  tiles: [number, number][];
  spawn: { x: number; y: number; z: number; heading: number };
  /** Far view tiles far/<fx>_<fy>.bin on a FAR_TILE_SIZE grid (fx = floor(E / size)): coarse terrain + building blocks. */
  far?: { size: number; n: number; tiles: [number, number][] };
  /** Road network for the minimap, street names and routing, relative to the index. */
  graph?: string;
  attribution: string[];
  /** Road profile the tiles were built with (roadSpec.ts); missing in builds before it existed (real widths). */
  roadProfile?: 'game' | 'real';
  /** Game profile (S2): rounded junction corners and smoothed kinks in the build. */
  roadShape?: { corners: number; bends: number };
}

/** A packed mesh. Arrays are base64-encoded little-endian typed arrays. */
export interface PackedMesh {
  pos: string; // Float32 xyz, local metres
  nrm?: string; // Float32 xyz
  col?: string; // Uint8 rgb
  uv?: string; // Float32 uv
  idx?: string; // Uint32
}

export interface TileData {
  v: 1;
  ix: number;
  iy: number;
  /** Float32 heights, row-major from the tile's north-west corner (row = south step, col = east step). */
  terrain: string;
  /** Uint8 ground class per terrain sample. */
  ground: string;
  roads?: PackedMesh;
  markings?: PackedMesh;
  /** Painted stall lines on car parks (src/world/stalls.ts). */
  stalls?: PackedMesh;
  buildings?: PackedMesh;
  /** Extra collision only (bridges): Float32 xyz + Uint32 idx. */
  collide?: PackedMesh;
  /** Float32 xyz + scale per tree. */
  trees?: string;
  /** Sidewalks and kerbs (visual only). */
  sidewalks?: PackedMesh;
  /** Footpaths, cycle paths and steps: road shader, wheels-only collision. */
  paths?: PackedMesh;
  /** Float32 x, y, z, heading per street lamp. */
  lamps?: string;
  /** Uint8 tree kind per tree, see vegKinds.ts. */
  treeKinds?: string;
  treeCrowns?: string;
  shops?: string;
  /** Float32 x, y, z, scale, kind per bush. */
  bushes?: string;
  /** Street furniture and parked cars, Float32 records of PROP_STRIDE values (see propKinds.ts). */
  props?: string;
  /** Float32 waterway polylines, each [count, width, x0, y0, z0, …], points run downstream. */
  waterways?: string;
  /** Float32 water surface height per terrain sample (NaN away from water): flat per lake, gently sloped along rivers. */
  waterLevel?: string;
  /** Float32 x, z, height above ground, ALKIS function group and code (31001, 1000 = Wohnhaus) per LoD2 building, for `bld.info`. */
  bldInfo?: string;
  /** Uint8 terrain texture weights per vertex, 8 channels (see SPLAT in coverKinds.ts), from the land cover. */
  splat?: string;
  /** Uint8 crop-row strength and direction per vertex (1..255 = 0..180° from east towards north, 0 = none). */
  rows?: string;
  /** Uint8 sRGB ground colour per vertex from the aerial survey (3 bytes). */
  tint?: string;
  /** Guard rail runs, Float32 [count, flags, start, total, x0, y0, z0, …] (see guardRail.ts). */
  rails?: string;
  /** Float32 x, z, r, g, b (sRGB 0..255) per building with a roof colour measured in the aerial survey, for `roof.at`. */
  roofInfo?: string;
}

/** Drivable road network of the whole world, split at junctions. Coordinates are local metres. */
export interface RoadGraphData {
  v: 1;
  names: string[];
  /** Junction and dead-end positions, x, y, z per node. */
  nodes: number[];
  edges: {
    a: number;
    b: number;
    /** Index into names, -1 when unnamed. */
    n: number;
    /** Road class rank (see pipeline ROAD_CLASSES), 0 = track … 9 = motorway. */
    c: number;
    /** One-way in a → b direction. */
    o?: 1;
    /** Carriageway width (m); missing in graphs built before it was stored. */
    w?: number;
    /** Lanes (total on two-way roads). */
    l?: number;
    /** Centre of the rightmost lane, metres right of the centreline (a → b on one-way roads). */
    r?: number;
    /** Pavement with a raised kerb: bit 1 right, bit 2 left of a → b; missing in older graphs. */
    k?: number;
    /** Closed to cars (pedestrian zone, access tags): left out of routing and traffic. */
    x?: 1;
    /** Polyline x, y, z from a to b, including both ends. */
    p: number[];
  }[];
  /** Footpaths, cycle paths and steps (not part of the network): kind index into PATH_KINDS, width in metres, surface, polyline x, y, z. */
  w?: { k: number; w: number; s: number; p: number[] }[];
  /** Junctions with traffic lights: [node, group]; nodes of one group (a big junction) share their phases. */
  s?: [number, number][];
}

export const tileKey = (ix: number, iy: number) => `${ix}_${iy}`;

/** Local scene frame: x = east, y = up, z = south. */
export function utmToLocal(w: WorldInfo, e: number, n: number): [number, number] {
  return [e - w.originE, -(n - w.originN)];
}

export function localToUtm(w: WorldInfo, x: number, z: number): [number, number] {
  return [x + w.originE, -z + w.originN];
}

/** North-west corner of a tile in local coordinates. */
export function tileOriginLocal(w: WorldInfo, ix: number, iy: number): [number, number] {
  return utmToLocal(w, ix * w.tileSize, (iy + 1) * w.tileSize);
}

export function tileOfLocal(w: WorldInfo, x: number, z: number): [number, number] {
  const [e, n] = localToUtm(w, x, z);
  return [Math.floor(e / w.tileSize), Math.floor(n / w.tileSize)];
}

// --- base64 typed arrays (works in browser and Node 22) ---

export function encode(a: ArrayBufferView): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decodeBytes(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

export const decodeF32 = (b64: string) => new Float32Array(decodeBytes(b64));
export const decodeU32 = (b64: string) => new Uint32Array(decodeBytes(b64));
export const decodeU8 = (b64: string) => new Uint8Array(decodeBytes(b64));

// --- Binary tile container (t/<ix>_<iy>.bin) ---
//
//   "SLST" · u32 version · u32 header bytes · header JSON (utf-8) · padding to 4 · sections
//
// The header is { ix, iy, s: [[name, type, byteOffset, byteLength], …] }. Data starts at the next multiple of 4
// after the header; offsets count from there and each section is 4-byte aligned so the client can view it as a typed array without copying.
// Every TileData field becomes a section: base64 strings by their name ("terrain"), packed meshes as
// "<field>.<part>" ("roads.pos", "roads.idx"). New optional TileData fields pass through without code changes;
// list their element type in SECTION_TYPES (default u8 = raw bytes).

export const TILE_MAGIC = 'SLST';
export const TILE_BIN_VERSION = 2;

export type SectionType = 'f32' | 'u8' | 'u32';

/** Element type per top-level TileData field. Add new fields here. */
export const SECTION_TYPES: Record<string, SectionType> = {
  terrain: 'f32', ground: 'u8', trees: 'f32', lamps: 'f32', props: 'f32', treeKinds: 'u8', treeCrowns: 'u8', bushes: 'f32', shops: 'f32', waterways: 'f32', waterLevel: 'f32', bldInfo: 'f32', rails: 'f32', roofInfo: 'f32',
};
const MESH_PART_TYPES: Record<string, SectionType> = { pos: 'f32', nrm: 'f32', col: 'u8', uv: 'f32', idx: 'u32' };

const BYTES: Record<SectionType, number> = { f32: 4, u8: 1, u32: 4 };

/** Packs a tile (as the pipeline builds it) into the binary container. */
export function encodeTile(tile: TileData): Uint8Array {
  const parts: { name: string; type: SectionType; bytes: Uint8Array }[] = [];
  const bytesOf = (b64: string) => new Uint8Array(decodeBytes(b64));
  for (const [field, value] of Object.entries(tile)) {
    if (value === undefined || field === 'v' || field === 'ix' || field === 'iy') continue;
    if (typeof value === 'string') parts.push({ name: field, type: SECTION_TYPES[field] ?? 'u8', bytes: bytesOf(value) });
    else if (typeof value === 'object')
      for (const [part, b64] of Object.entries(value as Record<string, string>))
        if (typeof b64 === 'string') parts.push({ name: `${field}.${part}`, type: MESH_PART_TYPES[part] ?? 'u8', bytes: bytesOf(b64) });
  }
  return packSections(tile.ix, tile.iy, parts);
}

/** Low-level writer, also used for far tiles. */
export function packSections(ix: number, iy: number, parts: { name: string; type: SectionType; bytes: Uint8Array }[], extra: Record<string, unknown> = {}): Uint8Array {
  const align = (n: number) => (n + 3) & ~3;
  let off = 0;
  const table = parts.map((p) => {
    const t: [string, SectionType, number, number] = [p.name, p.type, off, p.bytes.byteLength];
    off = align(off + p.bytes.byteLength);
    return t;
  });
  const header = new TextEncoder().encode(JSON.stringify({ ix, iy, ...extra, s: table }));
  const dataStart = align(12 + header.byteLength);
  const out = new Uint8Array(dataStart + off);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode(TILE_MAGIC), 0);
  dv.setUint32(4, TILE_BIN_VERSION, true);
  dv.setUint32(8, header.byteLength, true);
  out.set(header, 12);
  parts.forEach((p, i) => out.set(p.bytes, dataStart + table[i][2]));
  return out;
}

/** Tiles are stored gzipped; this checks the gzip magic bytes. */
export const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Decoded view of one tile: typed arrays straight into the downloaded buffer. */
export class TileContent {
  readonly ix: number;
  readonly iy: number;
  readonly key: string;
  readonly buffer: ArrayBuffer;
  /** Extra header fields (far tiles store their grid here). */
  readonly header: Record<string, unknown>;
  private sections = new Map<string, { type: SectionType; offset: number; length: number }>();

  constructor(buffer: ArrayBuffer) {
    const head = new Uint8Array(buffer, 0, 12);
    if (String.fromCharCode(...head.subarray(0, 4)) !== TILE_MAGIC) throw new Error('keine SLST-Kachel');
    const dv = new DataView(buffer);
    const version = dv.getUint32(4, true);
    if (version !== TILE_BIN_VERSION) throw new Error(`Kachel-Version ${version}, erwartet ${TILE_BIN_VERSION}`);
    const len = dv.getUint32(8, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, len)));
    const dataStart = (12 + len + 3) & ~3;
    this.buffer = buffer;
    this.ix = h.ix;
    this.iy = h.iy;
    this.key = tileKey(h.ix, h.iy);
    this.header = h;
    for (const [name, type, offset, length] of h.s as [string, SectionType, number, number][]) this.sections.set(name, { type, offset: dataStart + offset, length });
  }

  has(name: string) { return this.sections.has(name); }
  names() { return [...this.sections.keys()]; }

  private view<T>(name: string, type: SectionType, make: (b: ArrayBuffer, o: number, n: number) => T): T | undefined {
    const s = this.sections.get(name);
    if (!s) return undefined;
    if (s.type !== type && !(type === 'u8')) throw new Error(`Sektion ${name} ist ${s.type}, nicht ${type}`);
    return make(this.buffer, s.offset, s.length / BYTES[type]);
  }

  f32(name: string) { return this.view(name, 'f32', (b, o, n) => new Float32Array(b, o, n)); }
  u32(name: string) { return this.view(name, 'u32', (b, o, n) => new Uint32Array(b, o, n)); }
  /** Raw bytes of any section. */
  u8(name: string) { return this.view(name, 'u8', (b, o, n) => new Uint8Array(b, o, n)); }
}
