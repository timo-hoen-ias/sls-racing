import * as THREE from 'three';
import { createFacadeMaterial } from './facades.ts';
import { patchCrown, patchGround, patchMarking, patchPaintedMetal, patchRoad, patchSidewalk, patchTrunk } from './pbr/surfaces.ts';

export interface Materials {
  ground: THREE.MeshStandardMaterial;
  road: THREE.MeshStandardMaterial;
  marking: THREE.MeshStandardMaterial;
  building: THREE.MeshStandardMaterial;
  /** Replaced by the water shader (render/water.ts) in main. */
  water: THREE.Material;
  trunk: THREE.MeshStandardMaterial;
  crown: THREE.MeshStandardMaterial;
  sidewalk: THREE.MeshStandardMaterial;
  lampPole: THREE.MeshStandardMaterial;
  lampHead: THREE.MeshStandardMaterial;
}

/** World materials with PBR atlas textures (render/pbr/); load them with PbrTextures. */
export function createMaterials(): Materials {
  const m: Materials = {
    ground: new THREE.MeshStandardMaterial({ vertexColors: true }),
    road: new THREE.MeshStandardMaterial({ metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    marking: new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    building: createFacadeMaterial(),
    water: new THREE.MeshStandardMaterial({ color: '#27495a', roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.88 }),
    trunk: new THREE.MeshStandardMaterial(),
    crown: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true }),
    sidewalk: new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    lampPole: new THREE.MeshStandardMaterial({ color: '#4a5058', metalness: 0.35, roughness: 0.8 }),
    lampHead: new THREE.MeshStandardMaterial({ color: '#fff4d6', emissive: '#ffd9a0', emissiveIntensity: 0.4, roughness: 0.3 }),
  };
  patchGround(m.ground);
  patchRoad(m.road);
  patchMarking(m.marking);
  patchSidewalk(m.sidewalk);
  patchTrunk(m.trunk);
  patchCrown(m.crown);
  patchPaintedMetal(m.lampPole, 'lamp-pole');
  return m;
}
