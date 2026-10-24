import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarGeometry, SportsCarModel } from './sportsCarModel.ts';

// The sports coupé built in Blender (tools/blender/make_sportscar.py), as a drop-in for the procedural
// model: same model space (ground at y = 0, +z forward, +x left), same materials and hooks.

export const SPORTS_CAR_URL = `${import.meta.env.BASE_URL}models/sportscar.glb`;

/** Camera distance (m) from which the body and wheels switch to the next level of detail. */
export const CAR_LOD_DISTANCES = [0, 30, 80];

/** GLB materials whose meshes cast shadows. */
const SHADOW_CASTERS = new Set(['paint', 'black', 'carbon', 'tyre']);

export type CarModelKind = 'glb' | 'procedural';

/** Loads and prepares the GLB. Rejects if the file is missing or broken (callers fall back to the procedural car). */
export async function loadSportsCar(color = '#c0141c', url = SPORTS_CAR_URL): Promise<SportsCarModel> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  return sportsCarFromScene(gltf.scene, color);
}

/** Turns the loaded glTF scene into a SportsCarModel (exported for tests). */
export function sportsCarFromScene(scene: THREE.Object3D, color = '#c0141c'): SportsCarModel {
  const car = scene.getObjectByName('car');
  if (!car) throw new Error('sportscar.glb: Knoten "car" fehlt');
  const need = (name: string) => {
    const o = car.getObjectByName(name);
    if (!o) throw new Error(`sportscar.glb: Knoten "${name}" fehlt`);
    return o;
  };

  // Same look as the procedural car; the GLB only names the materials.
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.5 });
  const head = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#f4f8ff', emissiveIntensity: 2.4 });
  const brake = new THREE.MeshStandardMaterial({ color: '#4a0000', emissive: '#ff1010', emissiveIntensity: 0.7 });
  const replace: Record<string, THREE.Material> = {
    paint,
    head,
    brake,
    glass: new THREE.MeshPhysicalMaterial({ color: '#0a0e13', metalness: 0.3, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.8 }),
    trim: new THREE.MeshPhysicalMaterial({ color: '#0b0c0e', metalness: 0.2, roughness: 0.25, clearcoat: 0.6 }),
    carbon: new THREE.MeshPhysicalMaterial({ color: '#16181b', roughness: 0.35, metalness: 0.4, clearcoat: 0.8 }),
    indicator: new THREE.MeshStandardMaterial({ color: '#6a3a00', emissive: '#ff8a00', emissiveIntensity: 0.3 }),
  };
  const wellMat = new THREE.MeshStandardMaterial({ color: '#08090a', roughness: 0.9 });
  const fix = (m: THREE.Material) => {
    if (replace[m.name]) return replace[m.name];
    if (m.name === 'well') return wellMat;
    return m;
  };

  car.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).name;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fix) : fix(mesh.material);
    // glTF splits multi-material meshes into a group of primitives: extras sit on the group.
    const parent = mesh.parent;
    if (parent && !(parent as THREE.Mesh).isMesh && parent.userData.dent) mesh.userData.dent = true;
    // Only the parts that shape the silhouette cast shadows; trim, lights, rims and brakes would cost a
    // shadow-map draw each for nothing visible.
    mesh.castShadow = SHADOW_CASTERS.has(name);
  });

  const body = new THREE.Group();
  body.name = 'sportscar';
  const lod = new THREE.LOD();
  lod.name = 'bodyLod';
  CAR_LOD_DISTANCES.forEach((d, i) => lod.addLevel(need(`lod${i}`), d));
  body.add(lod);
  for (const name of ['splitter', 'wing', 'mirrorL', 'mirrorR', 'plate']) body.add(need(name));

  car.updateMatrixWorld(true);
  const at = (name: string) => need(name).getWorldPosition(new THREE.Vector3());
  // Left (+x) first, like the procedural model.
  const exhausts = [at('exhaust_L'), at('exhaust_R')];
  const headlights = [at('headlight_L'), at('headlight_R')];

  const wheel = need('wheel');
  const caliper = need('caliper');
  const makeWheel = (side: 1 | -1) => {
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    pivot.add(spin);
    // The GLB wheel faces +x; the right-hand wheels are mirrored.
    const w = new THREE.LOD();
    w.name = 'wheelLod';
    w.addLevel(wheel.getObjectByName('wheel_lod0')!.clone(), CAR_LOD_DISTANCES[0]);
    w.addLevel(wheel.getObjectByName('wheel_lod1')!.clone(), CAR_LOD_DISTANCES[1]);
    w.scale.x = side;
    spin.add(w);
    // Caliper stays put while the wheel turns (it steers with the pivot).
    const c = caliper.clone();
    c.position.set(0, 0, 0);
    c.scale.x = side;
    pivot.add(c);
    return { pivot, spin };
  };

  return { body, materials: { paint, brake, head }, exhausts, headlights, makeWheel, geometry: carGeometry(car.userData) };
}

/** Reads the dimensions from the "car" node's extras; undefined when they are missing or incomplete. */
export function carGeometry(extras: Record<string, unknown>): CarGeometry | undefined {
  const w = extras.wheel as Record<string, unknown> | undefined;
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!w || ![w.front, w.rear, w.track, w.radius, w.width, extras.length, extras.width].every(ok)) return undefined;
  return {
    name: typeof extras.name === 'string' ? extras.name : undefined,
    wheel: { front: w.front as number, rear: w.rear as number, track: w.track as number, radius: w.radius as number, width: w.width as number },
    length: extras.length as number,
    width: extras.width as number,
  };
}

/** Triangles drawn at full detail (for car.model). */
export function triangleCount(root: THREE.Object3D) {
  const lower = new Set<THREE.Object3D>();
  root.traverse((o) => {
    if ((o as THREE.LOD).isLOD) for (const l of (o as THREE.LOD).levels.slice(1)) l.object.traverse((c) => lower.add(c));
  });
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || lower.has(m)) return;
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return Math.round(n);
}
