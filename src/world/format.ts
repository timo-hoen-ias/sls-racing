// Shared between the pipeline (Node) and the game client. Keep it free of DOM and Node APIs.

/** Edge length of one world tile in metres. Tiles sit on the global UTM grid, not per city. */
export const TILE_SIZE = 256;
/** Terrain samples per tile edge (TERRAIN_N - 1 cells of TILE_SIZE / (TERRAIN_N - 1) metres). */
export const TERRAIN_N = 33;
export const TERRAIN_STEP = TILE_SIZE / (TERRAIN_N - 1);

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
  world: WorldInfo;
  regions: { id: string; name: string }[];
  /** Global grid indices: ix = floor(E / TILE_SIZE), iy = floor(N / TILE_SIZE). */
  tiles: [number, number][];
  spawn: { x: number; y: number; z: number; heading: number };
  attribution: string[];
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
  buildings?: PackedMesh;
  /** Extra collision only (bridges): Float32 xyz + Uint32 idx. */
  collide?: PackedMesh;
  /** Float32 xyz + scale per tree. */
  trees?: string;
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
