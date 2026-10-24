// Hand-made landmark models (tools/blender → public/models/landmarks/<id>.glb), placed by the world build
// (public/tiles/landmarks.json). Each GLB has <id>_lod0, <id>_lod1 and a hidden <id>_collider mesh; the models
// load as the car comes near, switch to the light version far away and get their collider only close by.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface LandmarkInfo {
  id: string;
  glb: string;
  x: number;
  /** Height of the model origin (m NHN). */
  y: number;
  z: number;
  /** Degrees clockwise from north. */
  heading: number;
  /** Footprint radius around the origin (m). */
  radius: number;
  name?: string;
  bridge?: number;
}

/** Models load within this distance of the car (plus their radius), and are dropped again beyond UNLOAD. */
const LOAD = 1500, UNLOAD = 1800;
/** Full detail within this distance. */
const LOD0 = 250;
/** Colliders within this distance (plus radius). */
const PHYS = 300;

interface Placed {
  info: LandmarkInfo;
  root?: THREE.Group;
  lod0?: THREE.Object3D;
  lod1?: THREE.Object3D;
  collider?: { vertices: Float32Array; indices: Uint32Array };
  body?: RAPIER_NS.RigidBody;
  loading?: boolean;
  failed?: boolean;
}

export class Landmarks {
  readonly root = new THREE.Group();
  readonly list: Placed[];
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private R: typeof RAPIER_NS;
  private world: RAPIER_NS.World;
  private modelBase: string;
  private shadows: boolean;
  /** Called once per landmark when its model is in the scene. */
  onLoad?: (p: Placed) => void;
  constructor(R: typeof RAPIER_NS, world: RAPIER_NS.World, list: LandmarkInfo[], modelBase: string, shadows: boolean) {
    this.R = R;
    this.world = world;
    this.modelBase = modelBase;
    this.shadows = shadows;
    this.list = list.map((info) => ({ info }));
    this.root.name = 'landmarks';
  }

  static async fetch(R: typeof RAPIER_NS, world: RAPIER_NS.World, tilesUrl: string, modelBase: string, shadows: boolean) {
    const res = await fetch(`${tilesUrl}/landmarks.json`).catch(() => undefined);
    const list: LandmarkInfo[] = res?.ok ? ((await res.json()) as { landmarks: LandmarkInfo[] }).landmarks : [];
    return new Landmarks(R, world, list, modelBase, shadows);
  }

  get loadedCount() { return this.list.filter((p) => p.root).length; }

  update(x: number, z: number) {
    for (const p of this.list) {
      const d = Math.hypot(p.info.x - x, p.info.z - z) - p.info.radius;
      if (!p.root && !p.loading && !p.failed && d < LOAD) this.load(p);
      if (p.root) {
        if (d > UNLOAD) { this.unload(p); continue; }
        const near = d < LOD0;
        if (p.lod0) p.lod0.visible = near || !p.lod1;
        if (p.lod1) p.lod1.visible = !near;
        if (d < PHYS && !p.body) this.addBody(p);
        else if (d > PHYS + 50 && p.body) { this.world.removeRigidBody(p.body); p.body = undefined; }
      }
    }
  }

  private async load(p: Placed) {
    p.loading = true;
    try {
      const gltf = await this.loader.loadAsync(`${this.modelBase}${p.info.glb}`);
      const root = new THREE.Group();
      root.name = p.info.id;
      root.position.set(p.info.x, p.info.y, p.info.z);
      root.rotation.y = -THREE.MathUtils.degToRad(p.info.heading);
      root.add(gltf.scene);
      root.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (o.name.endsWith('_lod0')) p.lod0 = o;
        else if (o.name.endsWith('_lod1')) p.lod1 = o;
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (o.name.endsWith('_collider')) {
          o.visible = false;
          p.collider = worldTriangles(m);
        } else {
          m.castShadow = this.shadows;
          m.receiveShadow = true;
        }
      });
      p.root = root;
      this.root.add(root);
      this.onLoad?.(p);
    } catch (e) {
      p.failed = true;
      console.warn(`Wahrzeichen ${p.info.id} nicht geladen`, e);
    } finally {
      p.loading = false;
    }
  }

  private addBody(p: Placed) {
    if (!p.collider) return;
    p.body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    this.world.createCollider(this.R.ColliderDesc.trimesh(p.collider.vertices, p.collider.indices).setFriction(0.7), p.body);
  }

  private unload(p: Placed) {
    if (p.body) { this.world.removeRigidBody(p.body); p.body = undefined; }
    if (!p.root) return;
    this.root.remove(p.root);
    p.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of [m.material].flat()) mat.dispose();
    });
    p.root = p.lod0 = p.lod1 = undefined;
    p.collider = undefined;
  }
}

/** World-space triangles of a mesh, for a trimesh collider. */
function worldTriangles(m: THREE.Mesh) {
  const g = m.geometry;
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  const vertices = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
    vertices.set([v.x, v.y, v.z], i * 3);
  }
  const indices = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { vertices, indices };
}
