import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Trees, bushes and a hedge built in Blender (tools/blender/make_vegetation.py) for instancing.
// Per species: lod0 (400–800 triangles), lod1 (≤ 120) and, for trees, a billboard (two crossed quads with a
// baked picture). Vertex colours, trunk base at the origin, +Y up. Trees are 8 m tall (scale y by height / 8
// and xz by crown radius / crown); bushes are about 1.5 m; the hedge is a 1 m segment along z.

export const VEGETATION_URL = `${import.meta.env.BASE_URL}models/vegetation.glb`;

/** Species per vegetation kind (names as in vegKinds.ts TREE_NAMES, plus bush kinds and the hedge). */
export const SPECIES_BY_KIND: Record<string, string[]> = {
  laubbaum: ['platane', 'linde', 'kastanie', 'ahorn'],
  nadelbaum: ['fichte', 'kiefer'],
  pappel: ['pappel'],
  birke: ['birke'],
  obstbaum: ['obstbaum'],
  busch: ['busch'],
  gebuesch: ['gebuesch'],
  hecke: ['hecke'],
};

export interface VegSpecies {
  id: string;
  kind: string;
  /** Model height and crown radius (m) the geometry is built at. */
  height: number;
  crown: number;
  lod0: THREE.BufferGeometry;
  lod1: THREE.BufferGeometry;
  billboard?: THREE.BufferGeometry;
}

export interface VegetationSet {
  species: Record<string, VegSpecies>;
  /** Alpha-tested material for the billboards (atlas embedded in the GLB). */
  billboardMaterial?: THREE.MeshStandardMaterial;
}

export async function loadVegetation(url = VEGETATION_URL): Promise<VegetationSet> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  return vegetationFromScene(gltf.scene);
}

/** Collects the species nodes (exported for tests). Adds the "wind" attribute vegModels.ts uses. */
export function vegetationFromScene(scene: THREE.Object3D): VegetationSet {
  scene.updateMatrixWorld(true);
  const species: Record<string, VegSpecies> = {};
  let billboardMaterial: THREE.MeshStandardMaterial | undefined;
  scene.traverse((node) => {
    if (typeof node.userData.kind !== 'string') return;
    const id = node.name;
    const geo = (part: string, wind: boolean) => {
      const m = node.getObjectByName(`${id}_${part}`) as THREE.Mesh | undefined;
      if (!m) return undefined;
      if (part === 'billboard') billboardMaterial ??= m.material as THREE.MeshStandardMaterial;
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld.clone().premultiply(new THREE.Matrix4().copy(node.matrixWorld).invert()));
      if (wind) addWind(g, node.userData.height);
      g.computeBoundingSphere();
      return g;
    };
    const lod0 = geo('lod0', true), lod1 = geo('lod1', true);
    if (!lod0 || !lod1) throw new Error(`vegetation.glb: ${id} unvollständig`);
    species[id] = { id, kind: node.userData.kind, height: node.userData.height, crown: node.userData.crown, lod0, lod1, billboard: geo('billboard', true) };
  });
  if (billboardMaterial) {
    billboardMaterial.alphaTest = 0.5;
    billboardMaterial.transparent = false;
    billboardMaterial.side = THREE.DoubleSide;
    billboardMaterial.depthWrite = true;
  }
  return { species, billboardMaterial };
}

/** Same sway weights as vegModels.ts: 0 at the base, 1 at the top. */
function addWind(g: THREE.BufferGeometry, top: number) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const wind = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) wind[i] = Math.max(0, Math.min(1, pos.getY(i) / top)) ** 1.5;
  g.setAttribute('wind', new THREE.BufferAttribute(wind, 1));
}
