// Water surface heights. The terrain under rivers, ponds and brooks is bumpy (bank points, bridges,
// interpolated laser holes), so a surface that follows it shows hills. Here every connected body of
// water gets a smooth level across all tiles: the lowest terrain in a window around each sample, then
// blurred, so lakes come out flat and rivers keep only a gentle slope along their course. The ground
// under the water is pressed down to that level so it never pokes through.

/** Terrain and ground class of one tile, row-major from the north-west corner (n × n samples). */
export interface TileGrid { h: Float32Array; g: Uint8Array }

export interface WaterLevelOptions {
  /** Window half size in samples for the lowest-terrain pass and each blur pass. */
  radius?: number;
  blurPasses?: number;
}

/**
 * Computes the water level per terrain sample for all tiles (NaN where there is no water nearby) and
 * lowers `h` of water samples to their level in place. Bank samples next to water get the level too,
 * so the water mesh, which spans every quad touching a water sample, stays flat up to the bank.
 * `step` is the number of samples between tile origins (n - 1, edges are shared).
 */
export function waterLevels(tiles: Map<string, TileGrid>, n: number, waterClass: number, opts: WaterLevelOptions = {}): Map<string, Float32Array> {
  const R = opts.radius ?? 8;
  const passes = opts.blurPasses ?? 2;
  const step = n - 1;
  // Global sample coordinates: x east, y north. Shared tile edges map to the same key.
  const key = (x: number, y: number) => x * 4_194_304 + y;
  const height = new Map<number, number>();
  const at = (k: string) => k.split('_').map(Number);
  for (const [k, t] of tiles) {
    const [ix, iy] = at(k);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        if (t.g[i] === waterClass) height.set(key(ix * step + c, iy * step + step - r), t.h[i]);
      }
  }

  // Connected bodies of water (4-neighbourhood).
  const comp = new Map<number, number>();
  const xy = (k: number): [number, number] => [Math.floor(k / 4_194_304), k % 4_194_304];
  let nc = 0;
  for (const start of height.keys()) {
    if (comp.has(start)) continue;
    const stack = [start];
    comp.set(start, nc);
    while (stack.length) {
      const [x, y] = xy(stack.pop()!);
      for (const nk of [key(x + 1, y), key(x - 1, y), key(x, y + 1), key(x, y - 1)])
        if (height.has(nk) && !comp.has(nk)) { comp.set(nk, nc); stack.push(nk); }
    }
    nc++;
  }

  // Separable window passes over the samples of the same body of water.
  const pass = (src: Map<number, number>, dx: number, dy: number, reduce: 'min' | 'mean') => {
    const out = new Map<number, number>();
    for (const [k, v] of src) {
      const [x, y] = xy(k);
      const c = comp.get(k);
      let acc = v, cnt = 1;
      for (let d = -R; d <= R; d++) {
        if (d === 0) continue;
        const nk = key(x + dx * d, y + dy * d);
        const nv = src.get(nk);
        if (nv === undefined || comp.get(nk) !== c) continue;
        if (reduce === 'min') acc = Math.min(acc, nv);
        else { acc += nv; cnt++; }
      }
      out.set(k, reduce === 'min' ? acc : acc / cnt);
    }
    return out;
  };
  let level = pass(pass(height, 1, 0, 'min'), 0, 1, 'min');
  for (let p = 0; p < passes; p++) level = pass(pass(level, 1, 0, 'mean'), 0, 1, 'mean');

  // Bank samples (8-neighbourhood) take the lowest neighbouring level.
  const bank = new Map<number, number>();
  for (const [k, v] of level) {
    const [x, y] = xy(k);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const nk = key(x + dx, y + dy);
        if (level.has(nk)) continue;
        const b = bank.get(nk);
        if (b === undefined || v < b) bank.set(nk, v);
      }
  }

  const out = new Map<string, Float32Array>();
  for (const [k, t] of tiles) {
    const [ix, iy] = at(k);
    const lv = new Float32Array(n * n).fill(NaN);
    let any = false;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const gk = key(ix * step + c, iy * step + step - r);
        const v = level.get(gk) ?? bank.get(gk);
        if (v === undefined) continue;
        lv[i] = Math.round(v * 100) / 100;
        any = true;
        if (t.g[i] === waterClass) t.h[i] = Math.min(t.h[i], lv[i]);
      }
    if (any) out.set(k, lv);
  }
  return out;
}
