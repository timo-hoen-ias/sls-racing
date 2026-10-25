import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleKind } from './trafficSim.ts';
import { buildVehicleParts, type VehicleParts } from './vehicleModels.ts';

// Traffic and parked vehicles: buses, lorries and panel vans built in Blender (tools/blender/make_traffic.py),
// passenger cars and a minivan from the CC-BY "Generic passenger car pack" (tools/import-traffic.ts). Several
// variants per kind, each with the five instanced parts of vehicleModels.ts at two levels of detail.

export const TRAFFIC_MODELS_URL = `${import.meta.env.BASE_URL}models/traffic.glb`;
export const TRAFFIC_PACK_URL = `${import.meta.env.BASE_URL}models/traffic-cars.glb`;

/** Which vehicles the traffic draws (traffic.models): pack cars over the Blender set, Blender only, or procedural. */
export type VehicleModels = 'pack' | 'glb' | 'procedural';

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

/**
 * Loads the Blender vehicles and, for 'pack', the passenger car pack on top (its cars replace the Blender cars,
 * its minivan joins the vans). Rejects if traffic.glb is missing or incomplete (callers keep buildVehicleParts);
 * a missing pack only falls back to the Blender cars.
 */
export async function loadVehicleParts(models: Exclude<VehicleModels, 'procedural'> = 'pack'): Promise<VehicleSet> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const base = vehicleSetFromScene((await loader.loadAsync(TRAFFIC_MODELS_URL)).scene);
  if (models === 'glb') return base;
  try {
    return withPack(base, vehicleSetFromScene((await loader.loadAsync(TRAFFIC_PACK_URL)).scene, false));
  } catch (e) {
    console.warn('[traffic] Auto-Paket nicht geladen, nehme die Blender-Autos', e);
    return base;
  }
}

/** The pack's cars replace the base cars; its other kinds join the base variants (exported for tests). */
export function withPack(base: VehicleSet, pack: Partial<VehicleSet>): VehicleSet {
  const set = { ...base };
  if (pack.car?.length) set.car = pack.car;
  for (const kind of KINDS) if (kind !== 'car' && pack[kind]?.length) set[kind] = [...base[kind], ...pack[kind]];
  return set;
}

/** Collects "<kind>-<variant>_<part>[_lod1]" meshes into variants (exported for tests). */
export function vehicleSetFromScene(scene: THREE.Object3D): VehicleSet;
/** With complete = false, kinds without models stay empty (the passenger car pack has no buses or lorries). */
export function vehicleSetFromScene(scene: THREE.Object3D, complete: false): Partial<VehicleSet>;
export function vehicleSetFromScene(scene: THREE.Object3D, complete = true): Partial<VehicleSet> {
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
    if (!set[kind].length && complete) throw new Error(`traffic.glb: keine Modelle für ${kind}`);
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
