import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleKind } from './trafficSim.ts';
import { buildVehicleParts, type VehicleParts } from './vehicleModels.ts';

// Traffic and parked vehicles built in Blender (tools/blender/make_traffic.py): several variants per kind,
// each with the five instanced parts of vehicleModels.ts at two levels of detail.

export const TRAFFIC_MODELS_URL = `${import.meta.env.BASE_URL}models/traffic.glb`;

/** Camera distance (m) from which vehicles are drawn with the simpler level of detail. */
export const VEHICLE_LOD_DISTANCE = 60;

export interface VehicleVariant {
  name: string;
  lod0: VehicleParts;
  /** Simpler paint and detail; lights are shared with lod0. */
  lod1: VehicleParts;
}

export type VehicleSet = Record<VehicleKind, VehicleVariant[]>;

const KINDS: VehicleKind[] = ['car', 'van', 'bus', 'truck'];
const PARTS = ['paint', 'detail', 'lights', 'brake', 'blink'] as const;

/** Loads the Blender vehicles. Rejects if the file is missing or incomplete (callers keep buildVehicleParts). */
export async function loadVehicleParts(url = TRAFFIC_MODELS_URL): Promise<VehicleSet> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  return vehicleSetFromScene(gltf.scene);
}

/** Collects "<kind>-<variant>_<part>[_lod1]" meshes into variants (exported for tests). */
export function vehicleSetFromScene(scene: THREE.Object3D): VehicleSet {
  const found = new Map<string, Partial<Record<string, THREE.BufferGeometry>>>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    const hit = m.isMesh && /^(car|van|bus|truck)-(\w+?)_(paint|detail|lights|brake|blink)(_lod1)?$/.exec(m.name);
    if (!hit) return;
    const key = `${hit[1]}-${hit[2]}`;
    const parts = found.get(key) ?? {};
    // Meshes sit at the origin of the model; bake any node transform so instancing sees model space.
    m.updateWorldMatrix(true, false);
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    g.computeBoundingSphere();
    parts[hit[3] + (hit[4] ?? '')] = g;
    found.set(key, parts);
  });
  const set = {} as VehicleSet;
  for (const kind of KINDS) {
    set[kind] = [];
    for (const [key, p] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.startsWith(kind + '-')) continue;
      const lod0 = {} as VehicleParts;
      for (const part of PARTS) {
        const g = p[part];
        if (!g) throw new Error(`traffic.glb: ${key}_${part} fehlt`);
        lod0[part] = g;
      }
      const lod1 = { ...lod0, paint: p.paint_lod1 ?? lod0.paint, detail: p.detail_lod1 ?? lod0.detail };
      set[kind].push({ name: key, lod0, lod1 });
    }
    if (!set[kind].length) throw new Error(`traffic.glb: keine Modelle für ${kind}`);
  }
  return set;
}

/** The procedural low-poly vehicles as a set (one variant per kind, no LOD). */
export function proceduralVehicleSet(): VehicleSet {
  const parts = buildVehicleParts();
  const set = {} as VehicleSet;
  for (const kind of KINDS) set[kind] = [{ name: `${kind}-procedural`, lod0: parts[kind], lod1: parts[kind] }];
  return set;
}
