// Single trees from the LVGL Saarland LiDAR point cloud (dl-de/by-2-0, © GeoBasis DE/LVGL-SL (2025)).
// One 1 km LAZ tile in, a list of trees out: position, height above ground, crown radius and leaf type.
// Method: ground model from class 2, canopy height model from vegetation points (class 20) on a 1 m grid,
// tree tops as local maxima with a height dependent window, crowns grown downhill from the tops (watershed).
import { existsSync, readFileSync } from 'node:fs';
import type { LasPoints } from './laz.ts';

/** ASPRS/AdV classes in the Saarland 2025 flight: 2 ground, 6 building, 20 vegetation (non-ground). */
export const CLS_GROUND = 2, CLS_BUILDING = 6, CLS_VEG = 20;

export const Leaf = { unknown: -1, broadleaf: 0, conifer: 1, poplar: 2 } as const;
export type LeafType = (typeof Leaf)[keyof typeof Leaf];

/** [UTM east, UTM north, height above ground m, crown radius m, leaf type] */
export type LidarTree = [number, number, number, number, LeafType];

export interface LidarFile {
  crs: 'EPSG:25832';
  attribution: string;
  /** Processed 1 km tiles as [e0, n0, e1, n1]; inside them the trees are measured, outside nothing is known. */
  coverage: [number, number, number, number][];
  trees: LidarTree[];
}

export const LIDAR_ATTRIBUTION = '© GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0';

/** Reads data/raw/<region>/lidar.json, or undefined when the LiDAR step has not run. */
export function readLidar(file: string): LidarFile | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LidarFile) : undefined;
}

export interface TreeOptions {
  /** Lowest tree top above ground (default 3 m; lower vegetation is bushes and hedges). */
  minHeight?: number;
  /** Smallest crown area in m² (default 6; removes lamp posts, wires and noise). */
  minCrown?: number;
}

const CELL = 1;

/** Extracts the trees of one tile with origin (x0, y0) and the given size in metres. */
export function extractTrees(p: LasPoints, x0: number, y0: number, size = 1000, o: TreeOptions = {}): LidarTree[] {
  const minH = o.minHeight ?? 3, minCells = (o.minCrown ?? 6) / (CELL * CELL);
  const N = Math.round(size / CELL), NN = N * N;
  const cellOf = (x: number, y: number) => {
    const cx = Math.floor((x - x0) / CELL), cy = Math.floor((y - y0) / CELL);
    return cx < 0 || cy < 0 || cx >= N || cy >= N ? -1 : cy * N + cx;
  };

  // Ground: lowest ground point per cell, holes (buildings, water) filled from the rim inwards.
  const dtm = new Float32Array(NN).fill(NaN);
  const building = new Uint8Array(NN);
  for (let i = 0; i < p.count; i++) {
    const k = cellOf(p.x[i], p.y[i]);
    if (k < 0) continue;
    if (p.cls[i] === CLS_GROUND) { if (!(dtm[k] <= p.z[i])) dtm[k] = p.z[i]; }
    else if (p.cls[i] === CLS_BUILDING) building[k] = 1;
  }
  fillHoles(dtm, N);

  // Canopy height: highest vegetation point above ground per cell.
  const chm = new Float32Array(NN);
  for (let i = 0; i < p.count; i++) {
    if (p.cls[i] !== CLS_VEG) continue;
    const k = cellOf(p.x[i], p.y[i]);
    if (k < 0) continue;
    const h = p.z[i] - dtm[k];
    if (h > chm[k] && h < 60) chm[k] = h;
  }
  // Vegetation on or right next to roofs is mostly roof edges and antennas.
  for (let k = 0; k < NN; k++) {
    if (!building[k]) continue;
    const cx = k % N, cy = (k - cx) / N;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const xx = cx + a, yy = cy + b;
      if (xx >= 0 && yy >= 0 && xx < N && yy < N) chm[yy * N + xx] = 0;
    }
  }
  const smooth = blur(chm, N);

  // Tree tops: local maxima of the smoothed canopy, window grows with height (bigger trees, wider crowns).
  const seeds: number[] = [];
  for (let k = 0; k < NN; k++) {
    const h = smooth[k];
    if (h < minH) continue;
    const r = Math.max(1, Math.min(4, Math.round((1 + 0.08 * h) / CELL)));
    const cx = k % N, cy = (k - cx) / N;
    let top = true;
    for (let a = -r; a <= r && top; a++)
      for (let b = -r; b <= r; b++) {
        if ((a === 0 && b === 0) || a * a + b * b > r * r) continue;
        const xx = cx + a, yy = cy + b;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const j = yy * N + xx, v = smooth[j];
        // Ties go to the lower index, so a plateau gets one top.
        if (v > h || (v === h && j < k)) { top = false; break; }
      }
    if (top) seeds.push(k);
  }

  // Crowns: visit canopy cells from high to low, each joins the tallest neighbouring crown it may belong to.
  const label = new Int32Array(NN).fill(-1);
  const topH = seeds.map((k) => smooth[k]);
  seeds.forEach((k, i) => (label[k] = i));
  const cells: number[] = [];
  for (let k = 0; k < NN; k++) if (smooth[k] >= 2 && label[k] < 0) cells.push(k);
  cells.sort((a, b) => smooth[b] - smooth[a]);
  for (const k of cells) {
    const cx = k % N, cy = (k - cx) / N;
    let best = -1;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const xx = cx + a, yy = cy + b;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
      const l = label[yy * N + xx];
      if (l < 0 || (best >= 0 && topH[l] <= topH[best])) continue;
      const s = seeds[l], sx = s % N, sy = (s - sx) / N;
      const maxR = Math.min(12, 2 + 0.45 * topH[l]) / CELL;
      if (smooth[k] >= 0.3 * topH[l] && (cx - sx) ** 2 + (cy - sy) ** 2 <= maxR * maxR) best = l;
    }
    if (best >= 0) label[k] = best;
  }

  const area = new Float64Array(seeds.length), fill = new Float64Array(seeds.length), hMax = new Float64Array(seeds.length);
  for (let k = 0; k < NN; k++) {
    const l = label[k];
    if (l < 0) continue;
    area[l]++;
    fill[l] += smooth[k];
    if (chm[k] > hMax[l]) hMax[l] = chm[k];
  }

  const trees: LidarTree[] = [];
  seeds.forEach((k, i) => {
    if (area[i] < minCells) return;
    const h = Math.max(hMax[i], topH[i]);
    const r = Math.sqrt((area[i] * CELL * CELL) / Math.PI);
    // Cones (conifers) are much lower on average than their top; rounded broadleaf crowns are fuller.
    const fullness = fill[i] / area[i] / h;
    const slender = r / h;
    let leaf: LeafType = Leaf.broadleaf;
    if (fullness < 0.62 && slender < 0.32) leaf = Leaf.conifer;
    else if (h >= 16 && slender < 0.16) leaf = Leaf.poplar;
    const cx = k % N, cy = (k - cx) / N;
    trees.push([r1(x0 + (cx + 0.5) * CELL), r1(y0 + (cy + 0.5) * CELL), r1(h), r1(r), leaf]);
  });
  // In closed woods every tree grows tall and narrow; a columnar shape only means poplar where trees stand apart
  // (rows along roads and fields have at most two neighbours this close).
  const near = new Map<string, LidarTree[]>();
  const gk = (e: number, n: number) => `${Math.floor(e / 6)}_${Math.floor(n / 6)}`;
  for (const t of trees) (near.get(gk(t[0], t[1])) ?? near.set(gk(t[0], t[1]), []).get(gk(t[0], t[1]))!).push(t);
  for (const t of trees) {
    if (t[4] !== Leaf.poplar) continue;
    let count = 0;
    const ce = Math.floor(t[0] / 6), cn = Math.floor(t[1] / 6);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++)
      for (const u of near.get(`${ce + a}_${cn + b}`) ?? []) if (u !== t && Math.hypot(u[0] - t[0], u[1] - t[1]) < 6) count++;
    if (count > 2) t[4] = Leaf.broadleaf;
  }
  return trees;
}

/**
 * A tree on a tile border is seen from both sides; keeps the taller of two tops closer than their crowns allow.
 * Only trees within `band` metres of a tile edge are compared.
 */
export function dedupeBorders(trees: LidarTree[], tile = 1000, band = 10): LidarTree[] {
  const nearEdge = (t: LidarTree) => {
    const fx = ((t[0] % tile) + tile) % tile, fy = ((t[1] % tile) + tile) % tile;
    return fx < band || fx > tile - band || fy < band || fy > tile - band;
  };
  const edge = trees.filter(nearEdge).sort((a, b) => b[2] - a[2]);
  const drop = new Set<LidarTree>();
  const grid = new Map<string, LidarTree[]>();
  const key = (e: number, n: number) => `${Math.floor(e / 10)}_${Math.floor(n / 10)}`;
  for (const t of edge) {
    let dup: LidarTree | undefined;
    const ce = Math.floor(t[0] / 10), cn = Math.floor(t[1] / 10);
    for (let a = -1; a <= 1 && !dup; a++)
      for (let b = -1; b <= 1 && !dup; b++)
        for (const u of grid.get(`${ce + a}_${cn + b}`) ?? [])
          if (Math.hypot(u[0] - t[0], u[1] - t[1]) < 0.6 * Math.max(u[3], t[3])) { dup = u; break; }
    if (dup) {
      drop.add(t);
      dup[3] = Math.max(dup[3], t[3]);
      continue;
    }
    const k = key(t[0], t[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(t);
  }
  return trees.filter((t) => !drop.has(t));
}

/** Fills NaN cells with the mean of their filled neighbours, ring by ring. */
function fillHoles(g: Float32Array, N: number) {
  for (let pass = 0; pass < 200; pass++) {
    const next: [number, number][] = [];
    for (let k = 0; k < g.length; k++) {
      if (g[k] === g[k]) continue;
      const cx = k % N, cy = (k - cx) / N;
      let s = 0, c = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const xx = cx + a, yy = cy + b;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const v = g[yy * N + xx];
        if (v === v) { s += v; c++; }
      }
      if (c) next.push([k, s / c]);
    }
    if (!next.length) return;
    for (const [k, v] of next) g[k] = v;
  }
}

/** 3x3 binomial blur; empty cells stay empty so crowns do not bleed into open ground. */
function blur(g: Float32Array, N: number) {
  const out = new Float32Array(g.length);
  const w = [1, 2, 1];
  for (let cy = 0; cy < N; cy++)
    for (let cx = 0; cx < N; cx++) {
      const k = cy * N + cx;
      if (g[k] <= 0) continue;
      let s = 0, c = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const xx = cx + a, yy = cy + b;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const wt = w[a + 1] * w[b + 1];
        s += g[yy * N + xx] * wt;
        c += wt;
      }
      out[k] = s / c;
    }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
