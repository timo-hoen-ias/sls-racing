// Minimal LAS/LAZ reader on top of laz-perf (WASM). Yields x, y, z, classification and return info per point.
// Header layout: https://www.asprs.org/wp-content/uploads/2019/07/LAS_1_4_r15.pdf
import { createLazPerf } from 'laz-perf';

export interface LasPoints {
  count: number;
  /** Absolute coordinates in the file's CRS, metres. */
  x: Float64Array; y: Float64Array; z: Float32Array;
  /** ASPRS class (2 ground, 3-5 vegetation, 6 building, 9 water, 17 bridge deck ...). */
  cls: Uint8Array;
  /** Return number and number of returns. */
  ret: Uint8Array; nret: Uint8Array;
}

let lazPerf: Promise<Awaited<ReturnType<typeof createLazPerf>>> | undefined;

/** Decodes a whole LAZ (or LAS) file into flat arrays. `keep` filters by class before storing. */
export async function readLaz(file: Uint8Array, keep: (cls: number) => boolean = () => true): Promise<LasPoints> {
  lazPerf ??= createLazPerf();
  const L = await lazPerf;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);

  const filePtr = L._malloc(file.byteLength);
  L.HEAPU8.set(file, filePtr);
  const las = new L.LASZip();
  las.open(filePtr, file.byteLength);
  const n = las.getCount();
  const fmt = las.getPointFormat() & 0x3f;
  const len = las.getPointLength();
  const ptPtr = L._malloc(len);
  const legacy = fmt < 6;

  const x = new Float64Array(n), y = new Float64Array(n), z = new Float32Array(n);
  const cls = new Uint8Array(n), ret = new Uint8Array(n), nret = new Uint8Array(n);
  let m = 0;
  try {
    for (let i = 0; i < n; i++) {
      las.getPoint(ptPtr);
      const p = new DataView(L.HEAPU8.buffer, ptPtr, len);
      const c = legacy ? p.getUint8(15) & 0x1f : p.getUint8(16);
      if (!keep(c)) continue;
      const rb = p.getUint8(14);
      x[m] = p.getInt32(0, true) * sx + ox;
      y[m] = p.getInt32(4, true) * sy + oy;
      z[m] = p.getInt32(8, true) * sz + oz;
      cls[m] = c;
      ret[m] = legacy ? rb & 7 : rb & 15;
      nret[m] = legacy ? (rb >> 3) & 7 : rb >> 4;
      m++;
    }
  } finally {
    las.delete();
    L._free(ptPtr);
    L._free(filePtr);
  }
  return { count: m, x: x.subarray(0, m), y: y.subarray(0, m), z: z.subarray(0, m), cls: cls.subarray(0, m), ret: ret.subarray(0, m), nret: nret.subarray(0, m) };
}
