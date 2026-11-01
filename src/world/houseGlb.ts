import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PropLods } from './propGlb.ts';

// The freely designed houses and garden parts built in Blender (tools/blender/make_houses.py): per house model
// walls and roofs (<id>_lod0/1, vertex colours, uv.x surface code, uv.y tint code) and window glass (<id>_glas0/1);
// garden parts garten-<name>_lod0/1.

export const HOUSES_URL = `${(import.meta.env?.BASE_URL ?? "/")}models/houses.glb`;

export interface HouseLods { lod0: THREE.BufferGeometry; lod1: THREE.BufferGeometry; glass0: THREE.BufferGeometry; glass1: THREE.BufferGeometry }

export interface HouseSet {
  houses: Record<string, HouseLods>;
  gardens: Record<string, PropLods>;
}

export async function loadHouses(url = HOUSES_URL): Promise<HouseSet> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  return houseSetFromScene(gltf.scene);
}

/** Sorts the GLB meshes by name (exported for tests). */
export function houseSetFromScene(scene: THREE.Object3D): HouseSet {
  scene.updateMatrixWorld(true);
  const parts: Record<string, Partial<HouseLods>> = {};
  const garden: Record<string, Partial<PropLods>> = {};
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    g.computeBoundingSphere();
    let hit: RegExpExecArray | null;
    if ((hit = /^garten-(.+)_lod([01])$/.exec(m.name))) (garden[hit[1]] ??= {})[hit[2] === '0' ? 'lod0' : 'lod1'] = g;
    else if ((hit = /^(.+)_lod([01])$/.exec(m.name))) (parts[hit[1]] ??= {})[hit[2] === '0' ? 'lod0' : 'lod1'] = g;
    else if ((hit = /^(.+)_glas([01])$/.exec(m.name))) (parts[hit[1]] ??= {})[hit[2] === '0' ? 'glass0' : 'glass1'] = g;
  });
  const set: HouseSet = { houses: {}, gardens: {} };
  for (const [id, p] of Object.entries(parts)) {
    if (!p.lod0) throw new Error(`houses.glb: ${id}_lod0 fehlt`);
    const empty = new THREE.BufferGeometry();
    set.houses[id] = { lod0: p.lod0, lod1: p.lod1 ?? p.lod0, glass0: p.glass0 ?? empty, glass1: p.glass1 ?? p.glass0 ?? empty };
  }
  for (const [id, p] of Object.entries(garden)) {
    if (!p.lod0) throw new Error(`houses.glb: garten-${id}_lod0 fehlt`);
    set.gardens[id] = { lod0: p.lod0, lod1: p.lod1 ?? p.lod0 };
  }
  return set;
}
