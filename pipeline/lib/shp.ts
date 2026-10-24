// Minimal ESRI shapefile reader: polygon geometry from .shp and text attributes from .dbf.
// Spec: https://www.esri.com/content/dam/esrisites/sitecore-archive/Files/Pdfs/library/whitepapers/pdfs/shapefile.pdf

export interface ShpPolygon {
  /** Rings in file coordinates; outer rings run clockwise, holes counter-clockwise. */
  rings: [number, number][][];
  bbox: [number, number, number, number];
}

/** Reads all polygon records (shape types 5, 15, 25); other or null shapes become undefined. */
export function readShpPolygons(buf: Uint8Array): (ShpPolygon | undefined)[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: (ShpPolygon | undefined)[] = [];
  for (let p = 100; p + 8 <= buf.length; ) {
    const len = v.getInt32(p + 4, false) * 2;
    const r = p + 8;
    const type = v.getInt32(r, true);
    if (type === 5 || type === 15 || type === 25) {
      const bbox: ShpPolygon['bbox'] = [v.getFloat64(r + 4, true), v.getFloat64(r + 12, true), v.getFloat64(r + 20, true), v.getFloat64(r + 28, true)];
      const nParts = v.getInt32(r + 36, true), nPts = v.getInt32(r + 40, true);
      const parts: number[] = [];
      for (let i = 0; i < nParts; i++) parts.push(v.getInt32(r + 44 + i * 4, true));
      const pts = r + 44 + nParts * 4;
      const rings: [number, number][][] = [];
      for (let i = 0; i < nParts; i++) {
        const ring: [number, number][] = [];
        for (let k = parts[i]; k < (i + 1 < nParts ? parts[i + 1] : nPts); k++) ring.push([v.getFloat64(pts + k * 16, true), v.getFloat64(pts + k * 16 + 8, true)]);
        rings.push(ring);
      }
      out.push({ rings, bbox });
    } else out.push(undefined);
    p = r + len;
  }
  return out;
}

/** Reads the given text columns of a .dbf file (dBase III), one object per record. */
export function readDbf(buf: Uint8Array, columns: string[], encoding = 'latin1'): Record<string, string>[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = v.getUint32(4, true), headerLen = v.getUint16(8, true), recLen = v.getUint16(10, true);
  const fields: { name: string; offset: number; len: number }[] = [];
  for (let p = 32, offset = 1; buf[p] !== 0x0d; p += 32) {
    const name = new TextDecoder().decode(buf.subarray(p, p + 11)).replace(/\0.*$/, '');
    const len = buf[p + 16];
    fields.push({ name, offset, len });
    offset += len;
  }
  const want = fields.filter((f) => columns.includes(f.name));
  const dec = new TextDecoder(encoding);
  const out: Record<string, string>[] = [];
  for (let i = 0; i < n; i++) {
    const r = headerLen + i * recLen;
    const rec: Record<string, string> = {};
    for (const f of want) rec[f.name] = dec.decode(buf.subarray(r + f.offset, r + f.offset + f.len)).trim();
    out.push(rec);
  }
  return out;
}
