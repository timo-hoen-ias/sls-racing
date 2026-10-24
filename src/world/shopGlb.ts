import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PropLods } from './propGlb.ts';

// Shop parts for the old-town facades built in Blender (tools/blender/make_shops.py). The facade is the plane
// z = 0, parts project towards +z; awning, awning box and fascia board are 1 m along x (scale by the shop width),
// the sign faces are not scaled.

export const SHOPS_URL = `${import.meta.env.BASE_URL}models/shops.glb`;

export const SHOP_TYPES = ['baeckerei', 'metzgerei', 'cafe', 'restaurant', 'apotheke', 'friseur', 'mode', 'buch', 'blumen', 'eis', 'kiosk', 'bank', 'laden'] as const;
export type ShopType = (typeof SHOP_TYPES)[number];

export interface ShopSet {
  /** markise, markise-kasten, nasenschild, ladenschild, cafe-tisch, aufsteller. */
  parts: Record<string, PropLods>;
  /** Fascia lettering (1.0 x 0.375 m at y 2.85, z 0.06) and both faces of the projecting sign, per shop type. */
  faces: Record<string, { fascia: THREE.BufferGeometry; projecting: THREE.BufferGeometry }>;
  signMaterial?: THREE.MeshStandardMaterial;
}

export async function loadShops(url = SHOPS_URL): Promise<ShopSet> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  return shopSetFromScene(gltf.scene);
}

/** Sorts the GLB meshes by name (exported for tests). */
export function shopSetFromScene(scene: THREE.Object3D): ShopSet {
  scene.updateMatrixWorld(true);
  const set: ShopSet = { parts: {}, faces: {} };
  const lods: Record<string, Partial<PropLods>> = {};
  const faces: Record<string, Partial<ShopSet['faces'][string]>> = {};
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    g.computeBoundingSphere();
    let hit: RegExpExecArray | null;
    if ((hit = /^(.+)_lod([01])$/.exec(m.name))) (lods[hit[1]] ??= {})[hit[2] === '0' ? 'lod0' : 'lod1'] = g;
    else if ((hit = /^laden-(.+)_(face|nase)$/.exec(m.name))) {
      (faces[hit[1]] ??= {})[hit[2] === 'face' ? 'fascia' : 'projecting'] = g;
      set.signMaterial ??= m.material as THREE.MeshStandardMaterial;
    }
  });
  for (const [name, l] of Object.entries(lods)) {
    if (!l.lod0) throw new Error(`shops.glb: ${name}_lod0 fehlt`);
    set.parts[name] = { lod0: l.lod0, lod1: l.lod1 ?? l.lod0 };
  }
  for (const [type, f] of Object.entries(faces)) {
    if (!f.fascia || !f.projecting) throw new Error(`shops.glb: Schildflächen für ${type} unvollständig`);
    set.faces[type] = f as ShopSet['faces'][string];
  }
  return set;
}
