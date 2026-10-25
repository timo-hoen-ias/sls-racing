// Full-coverage drivability scan of the drawn carriageways, shared by the pipeline's surface check
// (pipeline/surfacecheck.ts, every road of the world) and the in-game `road.scan` (around the car). Every
// cell of a grid laid over the road meshes is probed with two rays down onto the colliders: one as a wheel
// sees the world (everything), one as the chassis does (road surfaces excluded, see ROAD_GROUPS). Reports
//   hole   no surface under the drawn road
//   bump   the wheels hit something above the drawn road (terrain, a deck edge, an obstacle)
//   dip    the wheels fall below the drawn road (invisible gap)
//   step   the surface jumps between neighbouring cells (a seam the car bangs into)
//   snag   terrain, a deck or another solid pokes up through the road high enough to catch the underbody
//   seam   the terrain of two neighbouring tiles does not meet at their shared edge (pipeline only)
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { CAR_GROUPS } from '../vehicle/carPhysics.ts';

export const SURFACE_KINDS = ['hole', 'bump', 'dip', 'step', 'snag', 'seam'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** Thresholds in metres (per kind: the size above which a cell counts), plus probe geometry. */
export const SURFACE_LIMITS = {
  /** Nothing within this far below the drawn road. */
  hole: 2,
  /** The wheels rest this far above the drawn road (something sticks up through it). */
  bump: 0.12,
  /** The wheels rest this far below the drawn road. */
  dip: 0.25,
  /** Height jump between neighbouring cells (0.5 m apart: steeper than any real road, 24 %); kerbs are 8 cm. */
  step: 0.12,
  /** Solid at underbody level above the wheel surface: catches the chassis (its floor is ~0.18 m up). */
  snag: 0.12,
  /** Terrain of neighbouring tiles apart at their shared edge. */
  seam: 0.02,
  /** Rays start this far above the drawn road … */
  above: 0.6,
  /** … and reach this far below it. */
  below: 2,
  /** Drawn heights closer than this in one cell are one level (overlapping roads); farther apart, two roads. */
  level: 1.5,
} as const;

/**
 * Places that stop or throw the car, not just jolt it: every hole and snag, and steps, bumps and dips from
 * 0.25 m (the step assist lifts the car over 0.3 m above its underbody, the springs take 0.18 m). Seams from 5 cm.
 */
export function isCritical(kind: SurfaceKind, size: number) {
  return kind === 'hole' || kind === 'snag' || size >= (kind === 'seam' ? 0.05 : 0.25);
}

/** One drawn level of a cell: drawn height, where the wheels and the chassis rest (null: nothing) and on what. */
export interface SurfaceCell { yd: number; yw: number | null; wheel: string; yc: number | null; chassis: string }

export interface SurfaceIssue { key: number; y: number; kind: SurfaceKind; size: number; what: string }

/** A window of cells (size `cell` m) over local x (columns c0 … c1 - 1) and z (rows r0 … r1 - 1). */
export interface CellGrid { cell: number; c0: number; c1: number; r0: number; r1: number }

export const gridCols = (g: CellGrid) => g.c1 - g.c0;
/** Centre of a cell by key (row * cols + col). */
export function cellCentre(g: CellGrid, key: number): [number, number] {
  const cols = gridCols(g), c = key % cols, r = (key - c) / cols;
  return [(g.c0 + c + 0.5) * g.cell, (g.r0 + r + 0.5) * g.cell];
}

/** Adds the drawn height of every triangle of a mesh (local x, y, z) at each cell centre it covers. */
export function rasterizeMesh(pos: Float32Array, idx: Uint32Array | undefined, g: CellGrid, out: Map<number, number[]>) {
  const n = idx ? idx.length : pos.length / 3;
  for (let k = 0; k + 2 < n; k += 3) {
    const a = idx ? idx[k] : k, b = idx ? idx[k + 1] : k + 1, c = idx ? idx[k + 2] : k + 2;
    rasterize(pos, a, b, c, g, out);
  }
}

function rasterize(pos: Float32Array, a: number, b: number, c: number, g: CellGrid, out: Map<number, number[]>) {
  const C = g.cell, cols = gridCols(g);
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
  const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(det) < 1e-9) return;
  const i0 = Math.max(g.c0, Math.floor(Math.min(ax, bx, cx) / C - 0.5)), i1 = Math.min(g.c1 - 1, Math.ceil(Math.max(ax, bx, cx) / C - 0.5));
  const j0 = Math.max(g.r0, Math.floor(Math.min(az, bz, cz) / C - 0.5)), j1 = Math.min(g.r1 - 1, Math.ceil(Math.max(az, bz, cz) / C - 0.5));
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const x = (i + 0.5) * C, z = (j + 0.5) * C;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const key = (j - g.r0) * cols + (i - g.c0);
      let ys = out.get(key);
      if (!ys) out.set(key, (ys = []));
      ys.push(l1 * ay + l2 * by + l3 * cy);
    }
}

/** Drawn heights of one cell grouped into levels (overlapping roads at a junction are one level, the top one). */
export function mergeLevels(ys: number[]): number[] {
  ys.sort((a, b) => b - a);
  const out: number[] = [];
  for (const y of ys) if (!out.length || out[out.length - 1] - y > SURFACE_LIMITS.level) out.push(y);
  return out;
}

/**
 * Probes every level of every cell with a wheel ray and a chassis ray. `what` names the collider hit, `skip`
 * leaves out colliders that are not part of the world (the car itself, traffic).
 */
export function probeCells(
  R: typeof RAPIER_NS, world: RAPIER_NS.World, levels: Map<number, number[]>, g: CellGrid,
  what: (c: RAPIER_NS.Collider) => string, skip?: (c: RAPIER_NS.Collider) => boolean,
): Map<number, SurfaceCell[]> {
  const L = SURFACE_LIMITS;
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const keep = skip ? (c: RAPIER_NS.Collider) => !skip(c) : undefined;
  const cells = new Map<number, SurfaceCell[]>();
  for (const [key, ys] of levels) {
    const [cx, cz] = cellCentre(g, key);
    // Slightly off the cell centre: a ray exactly on a shared mesh edge can slip between two meshes.
    const x = cx + 0.013, z = cz + 0.007;
    const out: SurfaceCell[] = [];
    for (const yd of mergeLevels(ys)) {
      ray.origin = { x, y: yd + L.above, z };
      const hw = world.castRay(ray, L.above + L.below, true, undefined, undefined, undefined, undefined, keep);
      const hc = world.castRay(ray, L.above + L.below, true, undefined, CAR_GROUPS, undefined, undefined, keep);
      out.push({
        yd,
        yw: hw ? yd + L.above - hw.timeOfImpact : null,
        wheel: hw ? what(hw.collider) : 'nothing',
        yc: hc ? yd + L.above - hc.timeOfImpact : null,
        chassis: hc ? what(hc.collider) : 'nothing',
      });
    }
    cells.set(key, out);
  }
  return cells;
}

/**
 * Issues of a grid of probed cells. Only cells for which `inside` holds report; the others are neighbours to
 * compare against (the margin around a tile).
 */
export function surfaceIssues(cells: Map<number, SurfaceCell[]>, cols: number, inside: (c: number, r: number) => boolean = () => true): SurfaceIssue[] {
  const L = SURFACE_LIMITS;
  const out: SurfaceIssue[] = [];
  for (const [key, levels] of cells) {
    const c = key % cols, r = (key - c) / cols;
    if (!inside(c, r)) continue;
    for (const s of levels) {
      const add = (kind: SurfaceKind, size: number, what: string) => out.push({ key, y: s.yd, kind, size, what });
      if (s.yw === null || s.yw < s.yd - L.hole) { add('hole', L.hole, s.wheel); continue; }
      if (s.yw > s.yd + L.bump) add('bump', s.yw - s.yd, s.wheel);
      else if (s.yw < s.yd - L.dip) add('dip', s.yd - s.yw, s.wheel);
      if (s.yc !== null && s.yc > s.yw + L.snag) add('snag', s.yc - s.yw, s.chassis);
      // Steps to the right and lower neighbour, and to the left and upper one where that one does not report.
      for (const [dc, dr] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        if ((dc < 0 || dr < 0) && inside(c + dc, r + dr)) continue;
        if (c + dc < 0 || c + dc >= cols) continue;
        const o = cells.get(key + dr * cols + dc)?.find((q) => Math.abs(q.yd - s.yd) < L.level);
        if (!o || o.yw === null || o.yw < o.yd - L.hole) continue;
        const d = Math.abs(o.yw - s.yw);
        if (d > L.step) add('step', d, o.yw > s.yw ? o.wheel : s.wheel);
      }
    }
  }
  return out;
}

/** One issue per place: the worst within `radius` m (and 3 m in height), worst first. */
export function clusterIssues<T extends { x: number; y: number; z: number; kind: SurfaceKind; size: number }>(issues: T[], radius = 6): T[] {
  // Holes first, then whatever catches the car, by how far past its limit.
  const rank = (s: T) => (s.kind === 'hole' ? 1e3 : 0) + s.size / SURFACE_LIMITS[s.kind];
  const sorted = issues.slice().sort((a, b) => rank(b) - rank(a));
  const kept: T[] = [];
  const grid = new Map<string, T[]>();
  for (const s of sorted) {
    const cx = Math.floor(s.x / radius), cz = Math.floor(s.z / radius);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++)
      for (let dz = -1; dz <= 1 && !dup; dz++)
        dup = (grid.get(`${cx + dx}_${cz + dz}`) ?? []).some((o) => Math.hypot(o.x - s.x, o.z - s.z) < radius && Math.abs(o.y - s.y) < 3);
    if (dup) continue;
    kept.push(s);
    const k = `${cx}_${cz}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(s);
  }
  return kept;
}
