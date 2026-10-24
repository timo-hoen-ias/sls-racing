// Turns a decoded tile into ready-to-upload vertex arrays. Pure TypeScript without three.js or DOM,
// so it runs in the tile worker (tileWorker.ts), on the main thread (stream.worker off) and in Node tests.
import { Ground, TERRAIN_N, TERRAIN_STEP, type TileContent, type WorldInfo, tileOriginLocal } from './format.ts';

export interface MeshArrays {
  pos: Float32Array;
  nrm: Float32Array;
  uv?: Float32Array;
  /** Linear RGB 0..1. */
  col?: Float32Array;
  idx?: Uint32Array;
}

export interface BuiltTile {
  key: string;
  ix: number;
  iy: number;
  terrain: MeshArrays;
  water?: MeshArrays;
  /** Packed mesh layers by field name (roads, sidewalks, markings, buildings, and any new ones). */
  meshes: Record<string, MeshArrays>;
}

/** Ground colours in linear RGB (three.js converts the hex sRGB values the same way). */
const GROUND_SRGB: Record<number, string> = {
  [Ground.urban]: '#8d8a7f',
  [Ground.grass]: '#5f7a3e',
  [Ground.forest]: '#3d5229',
  [Ground.water]: '#2f5566',
  [Ground.farmland]: '#8f8a55',
};
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const GROUND_LINEAR: Record<number, [number, number, number]> = Object.fromEntries(
  Object.entries(GROUND_SRGB).map(([k, hex]) => [k, [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number]]),
);

const fract = (v: number) => v - Math.floor(v);
/** Water sits below the bank so the surface plane shows. */
export const WATER_DEPTH = 0.6;

/** Terrain vertex heights as rendered and collided (water cells lowered). */
export function terrainHeights(t: TileContent): Float32Array {
  const h = t.f32('terrain')!;
  const g = t.u8('ground')!;
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) out[i] = h[i] - (g[i] === Ground.water ? WATER_DEPTH : 0);
  return out;
}

/** Grid triangles (a, d, b) and (b, d, e): the same diagonal as Rapier's heightfield. */
export function gridIndex(n: number): Uint32Array {
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c, b = a + 1, d = a + n, e = d + 1;
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
      idx[k++] = b; idx[k++] = d; idx[k++] = e;
    }
  return idx;
}

/** Vertex normals like three's computeVertexNormals: area-weighted for indexed meshes, per face otherwise. */
export function computeNormals(pos: Float32Array, idx?: Uint32Array): Float32Array {
  const nrm = new Float32Array(pos.length);
  const tri = (a: number, b: number, c: number, accumulate: boolean) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
    const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
    // e1 × e2 equals three's (c - b) × (a - b).
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      if (accumulate) { nrm[v * 3] += nx; nrm[v * 3 + 1] += ny; nrm[v * 3 + 2] += nz; }
      else { nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; }
    }
  };
  if (idx) for (let i = 0; i + 2 < idx.length; i += 3) tri(idx[i], idx[i + 1], idx[i + 2], true);
  else for (let i = 0; i + 2 < pos.length / 3; i += 3) tri(i, i + 1, i + 2, false);
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }
  return nrm;
}

function buildTerrain(t: TileContent, w: WorldInfo): { terrain: MeshArrays; water?: MeshArrays } {
  const [ox, oz] = tileOriginLocal(w, t.ix, t.iy);
  const h = t.f32('terrain')!;
  const y = terrainHeights(t);
  const g = t.u8('ground')!;
  const N = TERRAIN_N;
  const pos = new Float32Array(N * N * 3);
  const col = new Float32Array(N * N * 3);
  const uv = new Float32Array(N * N * 2);
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      const x = ox + c * TERRAIN_STEP, z = oz + r * TERRAIN_STEP;
      pos[i * 3] = x; pos[i * 3 + 1] = y[i]; pos[i * 3 + 2] = z;
      const base = GROUND_LINEAR[g[i]] ?? GROUND_LINEAR[Ground.grass];
      const n = 0.92 + 0.16 * fract(Math.sin((ox + c * 8) * 12.9898 + (oz + r * 8) * 78.233) * 43758.5453);
      col[i * 3] = base[0] * n; col[i * 3 + 1] = base[1] * n; col[i * 3 + 2] = base[2] * n;
      uv[i * 2] = x / 6; uv[i * 2 + 1] = z / 6;
    }
  const idx = gridIndex(N);
  const terrain: MeshArrays = { pos, col, uv, idx, nrm: computeNormals(pos, idx) };

  let water: MeshArrays | undefined;
  if (g.some((v) => v === Ground.water)) {
    const wp = pos.slice();
    for (let i = 0; i < N * N; i++) wp[i * 3 + 1] = h[i] - 0.15;
    const wi: number[] = [];
    for (let r = 0; r < N - 1; r++)
      for (let c = 0; c < N - 1; c++) {
        const a = r * N + c;
        if (g[a] === Ground.water || g[a + 1] === Ground.water || g[a + N] === Ground.water || g[a + N + 1] === Ground.water)
          wi.push(a, a + N, a + 1, a + 1, a + N, a + N + 1);
      }
    const widx = Uint32Array.from(wi);
    water = { pos: wp, uv: uv.slice(), idx: widx, nrm: computeNormals(wp, widx) };
  }
  return { terrain, water };
}

/** Field names that hold packed meshes ("roads" for roads.pos, roads.idx …). */
export function meshFields(t: TileContent): string[] {
  return [...new Set(t.names().filter((n) => n.endsWith('.pos')).map((n) => n.slice(0, -4)))];
}

export function buildMesh(t: TileContent, field: string): MeshArrays | undefined {
  const pos = t.f32(`${field}.pos`);
  if (!pos) return undefined;
  const idx = t.u32(`${field}.idx`);
  const raw = t.u8(`${field}.col`);
  let col: Float32Array | undefined;
  if (raw) {
    col = new Float32Array(raw.length);
    const lut = new Float32Array(256).map((_, i) => srgbToLinear(i / 255));
    for (let i = 0; i < raw.length; i++) col[i] = lut[raw[i]];
  }
  // Copies, so the result owns its buffers (transferable, independent of the download).
  return { pos: pos.slice(), nrm: t.f32(`${field}.nrm`)?.slice() ?? computeNormals(pos, idx), uv: t.f32(`${field}.uv`)?.slice(), col, idx: idx?.slice() };
}

export function buildTile(t: TileContent, w: WorldInfo): BuiltTile {
  const meshes: Record<string, MeshArrays> = {};
  // "collide" is physics only.
  for (const f of meshFields(t)) if (f !== 'collide') meshes[f] = buildMesh(t, f)!;
  return { key: t.key, ix: t.ix, iy: t.iy, ...buildTerrain(t, w), meshes };
}

/** All buffers of a built tile, for postMessage transfer. */
export function transferList(b: BuiltTile): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (m?: MeshArrays) => { if (m) for (const a of [m.pos, m.nrm, m.uv, m.col, m.idx]) if (a) out.add(a.buffer as ArrayBuffer); };
  add(b.terrain);
  add(b.water);
  for (const m of Object.values(b.meshes)) add(m);
  return [...out];
}
