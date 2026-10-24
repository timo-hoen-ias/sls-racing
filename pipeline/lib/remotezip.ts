// Reads single files out of a large remote ZIP with HTTP range requests, so the pipeline fetches the
// few DGM1/LoD2 tiles it needs instead of the whole ~1 GB archive per district.
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

async function range(url: string, start: number, end: number): Promise<Buffer> {
  let last = '';
  for (let attempt = 0, wait = 2; attempt < 5; attempt++, wait *= 2) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status === 206) return Buffer.from(await res.arrayBuffer());
      last = `HTTP ${res.status}`;
      if (res.status === 200) throw new Error(`${url}: server ignores range requests`);
    } catch (e) {
      last = (e as Error).message;
      if (last.includes('ignores range')) throw e;
    }
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  throw new Error(`${url} bytes ${start}-${end}: ${last}`);
}

export class RemoteZip {
  readonly url: string;
  readonly entries: Map<string, ZipEntry>;
  private constructor(url: string, entries: Map<string, ZipEntry>) {
    this.url = url;
    this.entries = entries;
  }

  static async open(url: string): Promise<RemoteZip> {
    // End of central directory (plus the ZIP64 record for large archives) sits in the last 64 KB.
    const res = await fetch(url, { headers: { Range: 'bytes=-65600' } });
    if (res.status !== 206) throw new Error(`${url}: HTTP ${res.status}, expected a range response`);
    const tail = Buffer.from(await res.arrayBuffer());
    let cdSize: number, cdOffset: number;
    const z64 = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
    if (z64 >= 0) {
      cdSize = Number(tail.readBigUInt64LE(z64 + 40));
      cdOffset = Number(tail.readBigUInt64LE(z64 + 48));
    } else {
      const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (eocd < 0) throw new Error(`${url}: not a ZIP`);
      cdSize = tail.readUInt32LE(eocd + 12);
      cdOffset = tail.readUInt32LE(eocd + 16);
    }
    const cd = await range(url, cdOffset, cdOffset + cdSize - 1);
    const entries = new Map<string, ZipEntry>();
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString('latin1', p + 46, p + 46 + nameLen);
      let compressedSize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
      // ZIP64 extra field holds the values that overflowed, in this order.
      for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen;) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      entries.set(name, { name, method: cd.readUInt16LE(p + 10), compressedSize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new RemoteZip(url, entries);
  }

  /** The raw (still compressed) bytes of an entry, and how to inflate them. */
  async readRaw(e: ZipEntry): Promise<Buffer> {
    // Local header: 30 bytes plus name and extra field, whose lengths can differ from the central directory.
    const local = await range(this.url, e.offset, e.offset + 29);
    const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    return e.compressedSize ? range(this.url, start, start + e.compressedSize - 1) : Buffer.alloc(0);
  }

  async read(e: ZipEntry): Promise<Buffer> {
    return inflateEntry(e.method, await this.readRaw(e));
  }
}

export function inflateEntry(method: number, raw: Buffer): Buffer {
  if (method === 0) return raw;
  if (method === 8) return inflateRawSync(raw);
  throw new Error(`ZIP method ${method} not supported`);
}
