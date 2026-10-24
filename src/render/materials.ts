import * as THREE from 'three';
import { asphaltTexture, facadeTexture, groundDetailTexture } from './textures.ts';

export interface Materials {
  ground: THREE.MeshStandardMaterial;
  road: THREE.MeshStandardMaterial;
  marking: THREE.MeshStandardMaterial;
  building: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  trunk: THREE.MeshStandardMaterial;
  crown: THREE.MeshStandardMaterial;
}

export function createMaterials(): Materials {
  return {
    ground: new THREE.MeshStandardMaterial({ vertexColors: true, map: groundDetailTexture(), roughness: 0.95 }),
    road: new THREE.MeshStandardMaterial({
      map: asphaltTexture(), roughness: 0.82, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    marking: new THREE.MeshStandardMaterial({ color: '#e8e6dc', roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    building: new THREE.MeshStandardMaterial({ vertexColors: true, map: facadeTexture(), roughness: 0.88 }),
    water: new THREE.MeshStandardMaterial({ color: '#27495a', roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.88 }),
    trunk: new THREE.MeshStandardMaterial({ color: '#4a3a2c', roughness: 1 }),
    crown: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true }),
  };
}
