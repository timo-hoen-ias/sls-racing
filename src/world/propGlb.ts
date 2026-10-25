import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Street furniture, traffic lights and traffic signs built in Blender (tools/blender/make_props.py).
// Model space as propModels.ts: ground at y = 0, +z is the side a prop faces, linear props 1 m along z.

export const PROPS_URL = `${import.meta.env.BASE_URL}models/props.glb`;

/** Camera distance (m) from which props switch to lod1. */
export const PROP_LOD_DISTANCE = 60;

export interface PropLods { lod0: THREE.BufferGeometry; lod1: THREE.BufferGeometry }

export interface PropSet {
  /** Per prop name (PROP_NAMES, plus "bushaltestelle-dach", "ampel" and "schild_mast"). */
  props: Record<string, PropLods>;
  /** Traffic light lamps (white, tinted per instance), facing +z. */
  lamps: Record<'red' | 'yellow' | 'green', THREE.BufferGeometry>;
  /** Sign faces per type (vorfahrtstrasse, stop, tempo-50, …), uv into the atlas of signMaterial. */
  signs: Record<string, THREE.BufferGeometry>;
  signMaterial?: THREE.MeshStandardMaterial;
}

export async function loadProps(url = PROPS_URL): Promise<PropSet> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  return propSetFromScene(gltf.scene);
}

/** Sorts the GLB meshes by name (exported for tests). Geometry is baked into the model space of its part. */
export function propSetFromScene(scene: THREE.Object3D): PropSet {
  scene.updateMatrixWorld(true);
  const set: PropSet = { props: {}, lamps: {} as PropSet['lamps'], signs: {} };
  const lods: Record<string, Partial<PropLods>> = {};
  const bake = (m: THREE.Mesh) => {
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    g.computeBoundingSphere();
    return g;
  };
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = m.name;
    let hit: RegExpExecArray | null;
    if ((hit = /^(.+)_lod([01])$/.exec(name))) (lods[hit[1]] ??= {})[hit[2] === '0' ? 'lod0' : 'lod1'] = bake(m);
    else if ((hit = /^ampel_lamp_(red|yellow|green)$/.exec(name))) set.lamps[hit[1] as 'red'] = bake(m);
    else if ((hit = /^schild-(.+)_face$/.exec(name))) {
      set.signs[hit[1]] = bake(m);
      set.signMaterial ??= m.material as THREE.MeshStandardMaterial;
    }
  });
  for (const [name, l] of Object.entries(lods)) {
    if (!l.lod0) throw new Error(`props.glb: ${name}_lod0 fehlt`);
    set.props[name] = { lod0: l.lod0, lod1: l.lod1 ?? l.lod0 };
  }
  if (set.signMaterial) {
    set.signMaterial.side = THREE.FrontSide;
    set.signMaterial.roughness = 0.5;
  }
  return set;
}
