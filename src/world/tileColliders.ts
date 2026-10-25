// Physics for one tile, shared by the game (streamer.ts) and the drive test (pipeline/drivetest.ts).
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { TERRAIN_N, type TileContent, type WorldInfo, tileOriginLocal } from './format.ts';
import { ROAD_GROUPS } from '../vehicle/carPhysics.ts';
import { terrainHeights } from './tileBuild.ts';
import { addRailColliders } from './guardRail.ts';

export type ColliderKind = 'terrain' | 'building' | 'bridge' | 'road' | 'tree' | 'lamp' | 'rail';

/** Largest trimesh piece; bigger building meshes are split so no single collider build takes long. */
export const MAX_TRIS_PER_COLLIDER = 3000;

/**
 * Creates a fixed body with the tile's colliders. Terrain is a heightfield (much cheaper to build and query than
 * the old trimesh, same triangles), buildings and bridge decks are trimeshes, trees and lamps cylinders.
 */
export function addTileColliders(
  R: typeof RAPIER_NS, world: RAPIER_NS.World, t: TileContent, w: WorldInfo,
  onCollider?: (c: RAPIER_NS.Collider, kind: ColliderKind, index: number) => void,
): RAPIER_NS.RigidBody {
  const { body, steps } = tileColliderSteps(R, world, t, w, onCollider);
  for (const step of steps) step();
  return body;
}

/**
 * Same as addTileColliders, but returns the work as small steps so the streamer can spread a tile over several
 * frames. The body exists right away; colliders appear as the steps run.
 */
export function tileColliderSteps(
  R: typeof RAPIER_NS, world: RAPIER_NS.World, t: TileContent, w: WorldInfo,
  onCollider?: (c: RAPIER_NS.Collider, kind: ColliderKind, index: number) => void,
): { body: RAPIER_NS.RigidBody; steps: (() => void)[] } {
  const body = world.createRigidBody(R.RigidBodyDesc.fixed());
  const steps: (() => void)[] = [];
  const add = (desc: RAPIER_NS.ColliderDesc, kind: ColliderKind, index = 0) => {
    const c = world.createCollider(desc, body);
    onCollider?.(c, kind, index);
  };
  const [ox, oz] = tileOriginLocal(w, t.ix, t.iy);
  const size = w.tileSize;
  steps.push(() => {
    // Rapier wants (rows = z) × (cols = x) heights in column-major order; our grid is row-major.
    const y = terrainHeights(t);
    const N = TERRAIN_N;
    const hf = new Float32Array(N * N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) hf[r + c * N] = y[r * N + c];
    add(R.ColliderDesc.heightfield(N - 1, N - 1, hf, { x: size, y: 1, z: size }).setTranslation(ox + size / 2, 0, oz + size / 2).setFriction(0.9), 'terrain');
  });

  for (const [field, kind, friction] of [['buildings', 'building', 0.6], ['collide', 'bridge', 0.9]] as const) {
    const pos = t.f32(`${field}.pos`);
    if (!pos) continue;
    const idx = t.u32(`${field}.idx`) ?? Uint32Array.from({ length: pos.length / 3 }, (_, n) => n);
    for (const [v, i] of splitMesh(pos, idx, MAX_TRIS_PER_COLLIDER)) steps.push(() => add(R.ColliderDesc.trimesh(v, i).setFriction(friction), kind));
  }
  // Roads and pavements lie a little above the terrain (ROAD_LIFT); without their own surface the tyres sink in.
  // Only the wheels ride on them (ROAD_GROUPS), so kerbs never catch the chassis. Paths lie only a few
  // centimetres above the terrain, so rolling onto one is no step either.
  for (const field of ['roads', 'sidewalks', 'paths']) {
    const pos = t.f32(`${field}.pos`);
    if (!pos) continue;
    const idx = t.u32(`${field}.idx`) ?? Uint32Array.from({ length: pos.length / 3 }, (_, n) => n);
    for (const [v, i] of splitMesh(pos, idx, MAX_TRIS_PER_COLLIDER)) steps.push(() => add(R.ColliderDesc.trimesh(v, i).setFriction(0.9).setCollisionGroups(ROAD_GROUPS), 'road'));
  }
  steps.push(() => {
    const tr = t.f32('trees');
    if (tr) for (let i = 0; i + 3 < tr.length; i += 4) {
      const sc = tr[i + 3];
      add(R.ColliderDesc.cylinder(1.6 * sc, treeColliderRadius(sc)).setTranslation(tr[i], tr[i + 1] + 1.4 * sc, tr[i + 2]), 'tree');
    }
    const l = t.f32('lamps');
    if (l) for (let i = 0; i + 3 < l.length; i += 4) add(R.ColliderDesc.cylinder(3.5, 0.12).setTranslation(l[i], l[i + 1] + 3.5, l[i + 2]), 'lamp', i / 4);
  });
  // Guard rails: boxes along the beam (guardRail.ts), the same in the game and the drive test.
  if (t.has('rails')) steps.push(() => addRailColliders(R, world, body, t.f32('rails'), (c) => onCollider?.(c, 'rail', 0)));
  return { body, steps };
}

/** Splits an indexed mesh into pieces of at most maxTris triangles, each with its own compact vertex array. */
export function splitMesh(pos: Float32Array, idx: Uint32Array, maxTris: number): [Float32Array, Uint32Array][] {
  const out: [Float32Array, Uint32Array][] = [];
  const remap = new Int32Array(pos.length / 3).fill(-1);
  for (let start = 0; start < idx.length; start += maxTris * 3) {
    const end = Math.min(idx.length, start + maxTris * 3);
    const used: number[] = [];
    const ni = new Uint32Array(end - start);
    for (let k = start; k < end; k++) {
      const v = idx[k];
      if (remap[v] < 0) { remap[v] = used.length; used.push(v); }
      ni[k - start] = remap[v];
    }
    const nv = new Float32Array(used.length * 3);
    used.forEach((v, n) => { nv[n * 3] = pos[v * 3]; nv[n * 3 + 1] = pos[v * 3 + 1]; nv[n * 3 + 2] = pos[v * 3 + 2]; remap[v] = -1; });
    out.push([nv, ni]);
  }
  return out;
}

/** Trunk collider radius (m) of a tree of this scale: like the drawn trunk, at most TREE_COLLIDER_MAX. */
export const TREE_COLLIDER_MAX = 0.5;
export const treeColliderRadius = (sc: number) => Math.min(TREE_COLLIDER_MAX, 0.1 + 0.18 * sc);
