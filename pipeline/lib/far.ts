// Far view tiles (P3): coarse terrain, land cover and building blocks out to the horizon.
// One file per 2048 m square: far/<fx>_<fy>.bin, the same binary container as near tiles (packSections).
//   terrain  Float32 FAR_N × FAR_N heights, row-major from the north-west corner
//   ground   Uint8 ground class per sample
//   blocks   Float32 FAR_BLOCK per building: oriented box (centre x, z, half length, half width, angle, base y, top y)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { FAR_BLOCK, FAR_N, FAR_TILE_SIZE, Ground, packSections, utmToLocal, type WorldInfo } from '../../src/world/format.ts';
import { buildingHeight } from './buildings.ts';
import { GroundIndex, groundClassOf } from './ground.ts';
import type { Polygon } from './osm.ts';

/** OSM ways the far extract keeps: buildings and land cover, no roads. */
export function farWanted(tags: Record<string, string>): boolean {
  return !!tags.building || !!groundClassOf(tags);
}

/** Smallest-area rectangle around a footprint: [cx, cy, half length, half width, angle]. */
export function orientedBox(pts: [number, number][]): [number, number, number, number, number] {
  const hull = convexHull(pts);
  let best: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length];
    const a = Math.atan2(by - ay, bx - ax);
    const c = Math.cos(a), s = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s, v = -x * s + y * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      best = [uc * c - vc * s, uc * s + vc * c, (u1 - u0) / 2, (v1 - v0) / 2, a];
    }
  }
  return best;
}

function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export interface FarInput {
  info: WorldInfo;
  polygons: Polygon[];
  /** UTM box to cover. */
  box: { e0: number; n0: number; e1: number; n1: number };
  height: (e: number, n: number) => number;
  out: string;
}

/** Writes far/<fx>_<fy>.bin and returns the tile list for the index. */
export function buildFar({ info, polygons, box, height, out }: FarInput): [number, number][] {
  const S = FAR_TILE_SIZE, N = FAR_N, step = S / (N - 1);
  const ground = new GroundIndex(polygons);
  // Buildings by far tile; tiny sheds vanish at this distance anyway.
  const blocks = new Map<string, number[]>();
  for (const p of polygons) {
    if (!p.tags.building || p.tags.building === 'no') continue;
    const outer = p.outer.slice(0, -1);
    if (outer.length < 3) continue;
    const [ce, cn, hl, hw, a] = orientedBox(outer);
    if (hl * hw * 4 < 30) continue;
    const base = height(ce, cn) - 1;
    const [x, z] = utmToLocal(info, ce, cn);
    const k = `${Math.floor(ce / S)}_${Math.floor(cn / S)}`;
    if (!blocks.has(k)) blocks.set(k, []);
    // UTM angle (counter-clockwise from east) becomes a rotation about +y in the local frame (z = south).
    blocks.get(k)!.push(x, z, hl, hw, a, base, base + 1 + buildingHeight(p.tags));
  }

  rmSync(`${out}far`, { recursive: true, force: true });
  mkdirSync(`${out}far`, { recursive: true });
  const list: [number, number][] = [];
  let bytes = 0;
  for (let fx = Math.floor(box.e0 / S); fx <= Math.floor(box.e1 / S); fx++)
    for (let fy = Math.floor(box.n0 / S); fy <= Math.floor(box.n1 / S); fy++) {
      const E0 = fx * S, N0 = (fy + 1) * S;
      const h = new Float32Array(N * N);
      const g = new Uint8Array(N * N);
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) {
          const e = E0 + c * step, n = N0 - r * step;
          h[r * N + c] = Math.round(height(e, n) * 10) / 10;
          g[r * N + c] = ground.at(e, n, Ground.grass);
        }
      const b = new Float32Array((blocks.get(`${fx}_${fy}`) ?? []).map((v) => Math.round(v * 100) / 100));
      const bin = gzipSync(packSections(fx, fy, [
        { name: 'terrain', type: 'f32', bytes: new Uint8Array(h.buffer) },
        { name: 'ground', type: 'u8', bytes: g },
        { name: 'blocks', type: 'f32', bytes: new Uint8Array(b.buffer) },
      ], { far: { size: S, n: N, block: FAR_BLOCK } }), { level: 9 });
      bytes += bin.byteLength;
      writeFileSync(`${out}far/${fx}_${fy}.bin`, bin);
      list.push([fx, fy]);
    }
  console.log(`Far view: ${list.length} tiles, ${[...blocks.values()].reduce((s, b) => s + b.length / FAR_BLOCK, 0)} building blocks (${(bytes / 1e6).toFixed(1)} MB)`);
  return list;
}
