// Puddle map: one tileable noise mask repeated over the world. The road shader samples it as a
// texture and the physics samples the same bytes, so the puddles you see are the ones you hit.

/** Texels per side and metres covered by one repeat. */
export const PUDDLE_N = 256;
export const PUDDLE_SIZE = 180;
/** Mask value (0..1) from which a texel is water; the shader fades in over the next 0.12. */
export const PUDDLE_FROM = 0.62;
/** Share of the area under water. */
const PUDDLE_SHARE = 0.07;

let mask: Uint8Array | undefined;

/** Tileable fBm value noise, 0..255. */
export function puddleMask(): Uint8Array {
  if (mask) return mask;
  const N = PUDDLE_N;
  const out = new Float32Array(N * N);
  let seed = 4242;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const octaves = [
    { cells: 6, amp: 0.55 },
    { cells: 14, amp: 0.3 },
    { cells: 36, amp: 0.15 },
  ];
  for (const { cells, amp } of octaves) {
    const lat = Float32Array.from({ length: cells * cells }, rnd);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * cells, fy = (y / N) * cells;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = smooth(fx - ix), ty = smooth(fy - iy);
        const g = (a: number, b: number) => lat[(((b % cells) + cells) % cells) * cells + (((a % cells) + cells) % cells)];
        const top = g(ix, iy) + (g(ix + 1, iy) - g(ix, iy)) * tx;
        const bot = g(ix, iy + 1) + (g(ix + 1, iy + 1) - g(ix, iy + 1)) * tx;
        out[y * N + x] += (top + (bot - top) * ty) * amp;
      }
  }
  // Shift and stretch so that the top PUDDLE_SHARE of the noise (the puddles) lies above PUDDLE_FROM.
  const p = Float32Array.from(out).sort()[Math.floor(N * N * (1 - PUDDLE_SHARE))];
  mask = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) mask[i] = Math.round(Math.min(1, Math.max(0, PUDDLE_FROM + (out[i] - p) * 2.5)) * 255);
  return mask;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** How much water is at a world position, 0..1 (bilinear, like the GPU sampler). */
export function puddleAt(x: number, z: number): number {
  const m = puddleMask();
  const N = PUDDLE_N;
  const fx = (x / PUDDLE_SIZE) * N - 0.5, fz = (z / PUDDLE_SIZE) * N - 0.5;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const g = (a: number, b: number) => m[(((b % N) + N) % N) * N + (((a % N) + N) % N)] / 255;
  const top = g(ix, iz) + (g(ix + 1, iz) - g(ix, iz)) * tx;
  const bot = g(ix, iz + 1) + (g(ix + 1, iz + 1) - g(ix, iz + 1)) * tx;
  const v = top + (bot - top) * tz;
  return Math.min(1, Math.max(0, (v - PUDDLE_FROM) / 0.12));
}
