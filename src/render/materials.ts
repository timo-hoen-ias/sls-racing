import * as THREE from 'three';
import { createFacadeMaterial } from './facades.ts';
import { asphaltTexture, groundDetailTexture, pavingTexture } from './textures.ts';

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

export function createMaterials(): Materials {
  return {
    ground: new THREE.MeshStandardMaterial({ vertexColors: true, map: groundDetailTexture(), roughness: 0.95 }),
    road: new THREE.MeshStandardMaterial({
      map: asphaltTexture(), roughness: 0.82, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    marking: new THREE.MeshStandardMaterial({ color: '#e8e6dc', roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    building: createFacadeMaterial(),
    water: new THREE.MeshStandardMaterial({ color: '#27495a', roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.88 }),
    trunk: new THREE.MeshStandardMaterial({ color: '#4a3a2c', roughness: 1 }),
    crown: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true }),
    sidewalk: new THREE.MeshStandardMaterial({ map: pavingTexture(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    lampPole: new THREE.MeshStandardMaterial({ color: '#4a5058', metalness: 0.7, roughness: 0.45 }),
    lampHead: new THREE.MeshStandardMaterial({ color: '#fff4d6', emissive: '#ffd9a0', emissiveIntensity: 0.4, roughness: 0.3 }),
  };
}
