// SLSU: the tile format the Unreal port reads (unreal/SlsRacing/Source/SlsRacing/World/SlsTileFile.cpp).
//
// Same container as the web tiles (format.ts packSections: "SLSU" · u32 version · u32 header bytes · header JSON ·
// 4-byte aligned sections), gzipped. Everything is already in Unreal's frame so the C++ side only copies:
//   Unreal X = east  = three x,  Unreal Y = south = three z,  Unreal Z = up = three y,  centimetres,
//   positions relative to the tile's north-west corner (the tile actor sits there; large world coordinates
//   carry the offset). Swapping two axes mirrors the frame, which turns three's right-handed counter-clockwise
//   front faces into Unreal's left-handed front faces without touching the index order.
//
// Sections (all little endian):
//   m.<layer>.pos f32 xyz · .nrm f32 xyz · .uv f32 uv · .col u8 rgba (sRGB) · .idx u32 · terrain also
//   .splatA u8×4, .splatB u8×4, .rows u8×2 (ground shader weights, see tileBuild.ts coverAttributes)
//   c.<n>.pos f32 xyz + c.<n>.idx u32: a collision trimesh (header `colliders[n]`)
//   h.pos f32 xyz + h.cnt u32: convex hulls (point clouds) one after another, h.meta f32 [collider group n] per hull
//   r.key u32 (row * REF_N + col of a REF_CELL grid aligned to the tile corner) · r.yd f32 drawn road height ·
//   r.yw i16 / r.yc i16: where the wheel / chassis ray stopped in the web game, millimetres relative to yd
//   (REF_NONE = nothing hit). The reference the Unreal surface test compares itself against cell by cell.
import { packSections, type SectionType } from '../../src/world/format.ts';

export const SLSU_MAGIC = 'SLSU';
export const SLSU_VERSION = 1;
/** Reference cell edge (m) and cells per tile edge. */
export const REF_CELL = 0.5;
export const REF_N = 512;
export const REF_NONE = -32768;

/** Collider groups as the Unreal side needs them: one component per group. */
export interface ColliderGroup {
  /** Same names as the web game's ColliderKind (terrain, building, bridge, road, tree, lamp, rail, tunnel). */
  kind: string;
  /** Wheels only (ROAD_GROUPS): the chassis passes through, wheel rays and the wheel channel hit it. */
  wheelsOnly: boolean;
  friction: number;
  /** "tri": sections c.<n>.*; "hull": hulls in h.* whose meta says n. */
  shape: 'tri' | 'hull';
  tris?: number;
  hulls?: number;
}

export interface LayerInfo { name: string; verts: number; tris: number; uv: boolean; col: boolean; splat: boolean }

export interface SlsuHeader {
  ix: number;
  iy: number;
  v: number;
  /** North-west corner in three's local metres (x east, z south) and in Unreal centimetres (X, Y). */
  originLocal: [number, number];
  originUE: [number, number];
  layers: LayerInfo[];
  colliders: ColliderGroup[];
  ref?: { cell: number; n: number; count: number };
}

export interface Section { name: string; type: SectionType; bytes: Uint8Array }

export const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

export function packSlsu(h: SlsuHeader, sections: Section[]): Uint8Array {
  const out = packSections(h.ix, h.iy, sections, { v: h.v, originLocal: h.originLocal, originUE: h.originUE, layers: h.layers, colliders: h.colliders, ...(h.ref ? { ref: h.ref } : {}) });
  out.set(new TextEncoder().encode(SLSU_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, SLSU_VERSION, true);
  return out;
}

/** Reads an (ungzipped) SLSU file back: header plus typed views of its sections. */
export function readSlsu(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(...buf.subarray(0, 4));
  if (magic !== SLSU_MAGIC) throw new Error(`keine SLSU-Datei (${magic})`);
  if (dv.getUint32(4, true) !== SLSU_VERSION) throw new Error(`SLSU-Version ${dv.getUint32(4, true)}`);
  const len = dv.getUint32(8, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + len)));
  const start = (12 + len + 3) & ~3;
  const table = new Map<string, [SectionType, number, number]>();
  for (const [name, type, off, n] of head.s as [string, SectionType, number, number][]) table.set(name, [type, start + off, n]);
  const copy = (name: string) => {
    const s = table.get(name);
    if (!s) return undefined;
    // A real copy (Buffer.slice would share the whole pool), so typed views start at offset 0.
    const out = new Uint8Array(s[2]);
    out.set(buf.subarray(s[1], s[1] + s[2]));
    return out;
  };
  return {
    header: head as SlsuHeader,
    names: () => [...table.keys()],
    f32: (n: string) => { const b = copy(n); return b && new Float32Array(b.buffer); },
    u32: (n: string) => { const b = copy(n); return b && new Uint32Array(b.buffer); },
    i16: (n: string) => { const b = copy(n); return b && new Int16Array(b.buffer); },
    u8: (n: string) => copy(n),
  };
}
