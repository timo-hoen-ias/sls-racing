// Minimal baseline GeoTIFF reader for the LVGL TrueDOP20 tiles: 8-bit samples, chunky (RGBI interleaved),
// one or more rows per strip, LZW (5) or no compression, optionally with the horizontal predictor (317 = 2).
// Rows are handed to a callback one at a time, so a 10000 × 10000 × 4 tile never sits in memory decoded.

export interface TiffInfo {
  width: number;
  height: number;
  samples: number;
}

interface Ifd {
  get(tag: number): number[] | undefined;
}

function readIfd(buf: Buffer): Ifd {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error('not a classic TIFF (BigTIFF is not supported)');
  const ifd = u32(4);
  const tags = new Map<number, number[]>();
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const o = ifd + 2 + i * 12;
    const type = u16(o + 2), count = u32(o + 4);
    if (type !== 3 && type !== 4) continue;
    const size = type === 3 ? 2 : 4;
    const at = count * size <= 4 ? o + 8 : u32(o + 8);
    const vals = new Array<number>(count);
    for (let k = 0; k < count; k++) vals[k] = type === 3 ? u16(at + k * 2) : u32(at + k * 4);
    tags.set(u16(o), vals);
  }
  return { get: (t) => tags.get(t) };
}

/** Decodes one TIFF LZW strip (MSB-first codes, early change) into `out`; returns the bytes written. */
export function lzwDecode(src: Uint8Array, out: Uint8Array): number {
  // Dictionary as prefix links: each code > 257 is (prefix code, last byte), with its length and first byte.
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
  let next = 258, width = 9, bitPos = 0, old = -1, o = 0;
  const total = src.length * 8;
  while (bitPos + width <= total && o < out.length) {
    // Read `width` bits MSB first.
    const byte = bitPos >>> 3;
    const chunk = (src[byte] << 16) | ((src[byte + 1] ?? 0) << 8) | (src[byte + 2] ?? 0);
    const code = (chunk >>> (24 - (bitPos & 7) - width)) & ((1 << width) - 1);
    bitPos += width;
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; old = -1; continue; }
    // A code past the table means a corrupt strip; stop rather than follow broken prefix links.
    if (code > next || next >= 4096) break;
    let c: number;
    if (old < 0) {
      out[o++] = code;
      old = code;
      continue;
    }
    if (code < next) {
      c = code;
      // New entry: old + first byte of code.
      prefix[next] = old; suffix[next] = first[code]; first[next] = first[old]; len[next] = len[old] + 1;
    } else {
      c = next;
      prefix[next] = old; suffix[next] = first[old]; first[next] = first[old]; len[next] = len[old] + 1;
    }
    next++;
    const l = len[c];
    if (o + l > out.length) break;
    for (let k = o + l - 1, p = c; p >= 0; k--, p = prefix[p]) out[k] = suffix[p];
    o += l;
    old = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return o;
}

/**
 * Calls `row(y, data)` for every image row in order; `data` holds width × samples bytes and is reused,
 * so copy what you keep.
 */
export function readTiffRows(buf: Buffer, row: (y: number, data: Uint8Array) => void): TiffInfo {
  const t = readIfd(buf);
  const width = t.get(256)![0], height = t.get(257)![0];
  const samples = t.get(277)?.[0] ?? 1;
  const bits = t.get(258) ?? [8];
  const compression = t.get(259)?.[0] ?? 1;
  const predictor = t.get(317)?.[0] ?? 1;
  const planar = t.get(284)?.[0] ?? 1;
  const rowsPerStrip = t.get(278)?.[0] ?? height;
  if (bits.some((b) => b !== 8) || planar !== 1 || (compression !== 1 && compression !== 5) || (predictor !== 1 && predictor !== 2))
    throw new Error(`TIFF ${bits} bit, planar ${planar}, compression ${compression}, predictor ${predictor} not supported`);
  const offsets = t.get(273)!, counts = t.get(279)!;
  const stride = width * samples;
  const strip = new Uint8Array(stride * rowsPerStrip);
  let y = 0;
  for (let s = 0; s < offsets.length && y < height; s++) {
    const src = buf.subarray(offsets[s], offsets[s] + counts[s]);
    const rows = Math.min(rowsPerStrip, height - y);
    if (compression === 5) lzwDecode(src, strip.subarray(0, rows * stride));
    else strip.set(src.subarray(0, rows * stride));
    for (let r = 0; r < rows; r++, y++) {
      const data = strip.subarray(r * stride, (r + 1) * stride);
      if (predictor === 2) for (let i = samples; i < stride; i++) data[i] = (data[i] + data[i - samples]) & 255;
      row(y, data);
    }
  }
  return { width, height, samples };
}
