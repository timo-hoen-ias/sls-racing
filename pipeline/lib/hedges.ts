// Hedges from the laser heights and the aerial survey (pipeline/landcover.ts): runs of low, green vegetation
// (0.8–3.5 m above the terrain in DOM1 − DGM1, NDVI of growing plants) that are at most a few metres wide.
// Wide patches (shrubbery, maize, young forest) and the sloping rims of tree crowns and roofs are left out;
// what remains is thinned to its centre line and traced into polylines (UTM metres).

/** Height band of a hedge above the terrain (m). */
export const HEDGE_LOW = 0.8, HEDGE_HIGH = 3.5;
/** Shortest hedge kept (m). */
export const HEDGE_MIN_LENGTH = 6;

/** Grow (value 1) or shrink (value 0) a 0/1 mask by one cell, 8-neighbourhood. */
function morph(m: Uint8Array, N: number, grow: boolean) {
  const out = new Uint8Array(N * N);
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      let v = grow ? 0 : 1;
      for (let dr = -1; dr <= 1 && v === (grow ? 0 : 1); dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          const x = rr < 0 || cc < 0 || rr >= N || cc >= N ? 0 : m[rr * N + cc];
          if (grow ? x : !x) { v = grow ? 1 : 0; break; }
        }
      out[r * N + c] = v;
    }
  return out;
}

const repeat = (m: Uint8Array, N: number, grow: boolean, k: number) => { for (let i = 0; i < k; i++) m = morph(m, N, grow); return m; };

/** Low green cells that belong to narrow runs: cells of patches that survive two erosions (≥ 5 cells wide) go,
 * with three cells around them, and so do cells within `rim` cells of `exclude` (crowns, buildings). */
export function narrowRuns(low: Uint8Array, exclude: Uint8Array, N: number, rim = 2) {
  const blob = repeat(repeat(low, N, false, 2), N, true, 5);
  const near = repeat(exclude, N, true, rim);
  const out = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) out[i] = low[i] && !blob[i] && !near[i] ? 1 : 0;
  return out;
}

/** Zhang–Suen thinning of a 0/1 mask to one-cell-wide lines (in place). */
export function thin(m: Uint8Array, N: number) {
  const at = (r: number, c: number) => (r < 0 || c < 0 || r >= N || c >= N ? 0 : m[r * N + c]);
  const del: number[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) {
          if (!m[r * N + c]) continue;
          // Neighbours clockwise from north: P2..P9.
          const p = [at(r - 1, c), at(r - 1, c + 1), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c), at(r + 1, c - 1), at(r, c - 1), at(r - 1, c - 1)];
          const b = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++;
          if (a !== 1) continue;
          if (pass === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
          del.push(r * N + c);
        }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  return m;
}

const NB = [[-1, 0], [0, 1], [1, 0], [0, -1], [-1, 1], [1, 1], [1, -1], [-1, -1]] as const;

/** Cell chains of a one-cell-wide skeleton, split at junctions (cell indices). */
export function traceChains(sk: Uint8Array, N: number) {
  const nbs = (i: number) => {
    const r = Math.floor(i / N), c = i % N, out: number[] = [];
    const on = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr < N && cc < N && sk[rr * N + cc] === 1;
    // A diagonal step counts only where no edge neighbour already links the two cells (staircases, corners).
    for (const [dr, dc] of NB) if (on(r + dr, c + dc) && (!dr || !dc || (!on(r + dr, c) && !on(r, c + dc)))) out.push((r + dr) * N + c + dc);
    return out;
  };
  const seen = new Uint8Array(N * N);
  const chains: number[][] = [];
  const walk = (path: number[]) => {
    for (;;) {
      const cur = path[path.length - 1];
      const next = nbs(cur).find((j) => !seen[j]);
      if (next === undefined) {
        // Close onto a junction the chain runs into.
        const j = nbs(cur).find((k) => k !== path[path.length - 2] && nbs(k).length > 2);
        if (j !== undefined && path.length > 1) path.push(j);
        break;
      }
      seen[next] = 1;
      path.push(next);
      if (nbs(next).length !== 2) break;
    }
    if (path.length > 1) chains.push(path);
  };
  for (let i = 0; i < N * N; i++) if (sk[i] && !seen[i] && nbs(i).length === 1) { seen[i] = 1; walk([i]); }
  for (let i = 0; i < N * N; i++) if (sk[i] && nbs(i).length > 2) { seen[i] = 1; for (const j of nbs(i)) if (!seen[j]) { seen[j] = 1; walk([i, j]); } }
  for (let i = 0; i < N * N; i++) if (sk[i] && !seen[i]) { seen[i] = 1; walk([i]); }
  return chains;
}

/** Douglas–Peucker simplification of a polyline. */
export function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [ae, an] = pts[0], [be, bn] = pts[pts.length - 1];
  const dx = be - ae, dy = bn - an, l = Math.hypot(dx, dy);
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = l > 1e-9 ? Math.abs((pts[i][0] - ae) * dy - (pts[i][1] - an) * dx) / l : Math.hypot(pts[i][0] - ae, pts[i][1] - an);
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

const lengthOf = (p: [number, number][]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0);

/** Centre lines of a thin polygon (an ALKIS wall), from a raster with `step` m cells (UTM, m). */
export function centreLines(rings: [number, number][][], step: number, rasterize: (rings: [number, number][][], grid: Uint8Array, cols: number, rows: number, e0: number, n1: number, s: number, value: number) => void) {
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (const [e, n] of rings[0]) { e0 = Math.min(e0, e); e1 = Math.max(e1, e); n0 = Math.min(n0, n); n1 = Math.max(n1, n); }
  // One empty cell around it, so thinning sees its edges.
  e0 -= step; n1 += step;
  const N = Math.ceil(Math.max(e1 - e0, n1 - n0) / step) + 2;
  if (N > 1200) return [];
  const m = new Uint8Array(N * N);
  rasterize(rings, m, N, N, e0, n1, step, 1);
  const out: [number, number][][] = [];
  for (const chain of traceChains(thin(m, N), N)) {
    const pts = chain.map((i) => [e0 + ((i % N) + 0.5) * step, n1 - (Math.floor(i / N) + 0.5) * step] as [number, number]);
    if (lengthOf(pts) < 1.5) continue;
    out.push(simplify(pts, step).map(([e, n]) => [Math.round(e * 10) / 10, Math.round(n * 10) / 10]));
  }
  return out;
}

/** Hedge centre lines of one grid tile: `low` marks low green cells, `exclude` crowns and buildings.
 * Cell (r, c) has its centre at e0 + (c + 0.5)·step, n1 − (r + 0.5)·step. */
export function traceHedges(low: Uint8Array, exclude: Uint8Array, N: number, e0: number, n1: number, step: number) {
  const sk = thin(narrowRuns(low, exclude, N), N);
  const out: [number, number][][] = [];
  for (const chain of traceChains(sk, N)) {
    const pts = chain.map((i) => [e0 + ((i % N) + 0.5) * step, n1 - (Math.floor(i / N) + 0.5) * step] as [number, number]);
    if (lengthOf(pts) < HEDGE_MIN_LENGTH) continue;
    out.push(simplify(pts, step * 0.75).map(([e, n]) => [Math.round(e * 10) / 10, Math.round(n * 10) / 10]));
  }
  return out;
}
