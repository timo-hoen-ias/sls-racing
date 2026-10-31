// A set of integer grid cells as a sparse bitset: chunks of 64 × 64 cells, one bit each. Road and path masks
// over the Landkreis hold tens of millions of cells, which as a Set of numbers took gigabytes.

const SHIFT = 6;
const SIZE = 1 << SHIFT;
const MASK = SIZE - 1;

export class CellSet {
  private chunks = new Map<number, Uint32Array>();

  private static chunkKey(cx: number, cy: number) {
    // cy below 2^23 and cx below 2^20 (UTM metres on a 1 m grid): the key stays a small integer.
    return (cx >> SHIFT) * 131_072 + ((cy >> SHIFT) & 131_071);
  }

  add(cx: number, cy: number) {
    const k = CellSet.chunkKey(cx, cy);
    let c = this.chunks.get(k);
    if (!c) this.chunks.set(k, (c = new Uint32Array((SIZE * SIZE) / 32)));
    const i = ((cy & MASK) << SHIFT) | (cx & MASK);
    c[i >> 5] |= 1 << (i & 31);
  }

  has(cx: number, cy: number): boolean {
    const c = this.chunks.get(CellSet.chunkKey(cx, cy));
    if (!c) return false;
    const i = ((cy & MASK) << SHIFT) | (cx & MASK);
    return (c[i >> 5] & (1 << (i & 31))) !== 0;
  }

  /** Bytes held by the chunks. */
  get bytes() {
    return this.chunks.size * (SIZE * SIZE) / 8;
  }
}
