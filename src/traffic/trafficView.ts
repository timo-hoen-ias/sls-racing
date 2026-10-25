import * as THREE from 'three';
import { type Agent, type AgentState, type VehicleKind } from './trafficSim.ts';
import { proceduralVehicleSet, VEHICLE_LOD_DISTANCE, type VehicleSet } from './vehicleGlb.ts';
import type { VehicleParts } from './vehicleModels.ts';

type PartMeshes = Record<keyof VehicleParts, THREE.InstancedMesh>;

const STATE_COLORS: Record<AgentState, number> = { drive: 0x3ddc84, follow: 0x4aa3ff, yield: 0xffc400, player: 0xff7a00, crashed: 0xff2d2d };

/** Draws all traffic with a few instanced meshes per vehicle type, variant and level of detail. */
export class TrafficView {
  readonly root = new THREE.Group();
  /** Coloured markers above every vehicle showing its state (traffic.debug). */
  debug = false;
  /** Which models are drawn (traffic.models). */
  models: 'glb' | 'procedural' = 'procedural';
  /** Forced level of detail (traffic.lod), or null for automatic by camera distance. */
  forcedLod: 0 | 1 | null = null;
  /** Per kind and variant: [lod0, lod1]. */
  private parts = {} as Record<VehicleKind, PartMeshes[][]>;
  private markers: THREE.InstancedMesh;
  private materials: Record<keyof VehicleParts, THREE.Material>;
  private capacity: number;
  private shadows: boolean;
  private m = new THREE.Matrix4();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();

  constructor(capacity: number, shadows: boolean) {
    this.root.name = 'traffic';
    this.capacity = capacity;
    this.shadows = shadows;
    // Brake and hazard lights glow above the bloom threshold.
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.materials = {
      paint: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.45, envMapIntensity: 1.2 }),
      detail: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 }),
      lights: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: '#ffffff', emissiveIntensity: 0.25, roughness: 0.3 }),
      brake: glow,
      blink: glow,
    };
    this.setModels(proceduralVehicleSet(), 'procedural');
    this.markers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.45), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false }), capacity);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 10;
    this.markers.count = 0;
    this.root.add(this.markers);
  }

  /** Swaps the vehicle models (the Blender set once it has loaded, or back to the procedural one). */
  setModels(set: VehicleSet, models: 'glb' | 'procedural') {
    for (const kind of Object.keys(this.parts) as VehicleKind[])
      for (const variant of this.parts[kind]) for (const lod of variant) for (const im of Object.values(lod)) { im.removeFromParent(); im.dispose(); }
    this.models = models;
    const make = (g: THREE.BufferGeometry, mat: THREE.Material, cast = false) => {
      const im = new THREE.InstancedMesh(g, mat, this.capacity);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = cast && this.shadows;
      im.receiveShadow = this.shadows;
      this.root.add(im);
      return im;
    };
    const mats = this.materials;
    const meshes = (g: VehicleParts): PartMeshes => ({
      paint: make(g.paint, mats.paint, true), detail: make(g.detail, mats.detail, true), lights: make(g.lights, mats.lights),
      brake: make(g.brake, mats.brake), blink: make(g.blink, mats.blink),
    });
    for (const kind of Object.keys(set) as VehicleKind[]) this.parts[kind] = set[kind].map((v) => [meshes(v.lod0), meshes(v.lod1)]);
    // Same render layers as the root (post-processing may select by layer).
    this.root.traverse((o) => (o.layers.mask = this.root.layers.mask));
  }

  /** eye: camera position for the level of detail. */
  update(agents: readonly Agent[], time: number, eye?: THREE.Vector3) {
    const counts = new Map<PartMeshes, number>();
    const blinkOn = time % 0.9 < 0.45;
    let mk = 0;
    for (const a of agents) {
      const variants = this.parts[a.kind];
      const v = variants[a.id % variants.length];
      const far = this.forcedLod ?? (eye && (a.x - eye.x) ** 2 + (a.z - eye.z) ** 2 > VEHICLE_LOD_DISTANCE ** 2 ? 1 : 0);
      const set = v[far];
      const i = counts.get(set) ?? 0;
      if (i >= set.paint.instanceMatrix.count) continue;
      counts.set(set, i + 1);
      if (a.quat) this.q.set(a.quat.x, a.quat.y, a.quat.z, a.quat.w);
      else this.q.setFromEuler(this.e.set(-a.pitch, a.yaw, 0));
      this.m.compose(this.p.set(a.x, a.y, a.z), this.q, this.one);
      set.paint.setMatrixAt(i, this.m);
      set.paint.setColorAt(i, this.c.setHex(a.color));
      set.detail.setMatrixAt(i, this.m);
      set.lights.setMatrixAt(i, this.m);
      set.brake.setMatrixAt(i, a.braking || a.crashed > 0 ? this.m : this.hidden);
      set.blink.setMatrixAt(i, a.crashed > 0 && blinkOn ? this.m : this.hidden);
      if (this.debug) {
        this.m.makeTranslation(a.x, a.y + a.spec.height + 1.2, a.z);
        this.markers.setMatrixAt(mk, this.m);
        this.markers.setColorAt(mk++, this.c.setHex(STATE_COLORS[a.state]));
      }
    }
    for (const kind of Object.keys(this.parts) as VehicleKind[])
      for (const variant of this.parts[kind])
        for (const set of variant) {
          const n = counts.get(set) ?? 0;
          for (const im of Object.values(set)) {
            im.count = n;
            im.instanceMatrix.needsUpdate = true;
            if (im.instanceColor) im.instanceColor.needsUpdate = true;
          }
        }
    this.markers.count = mk;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }

  /** Vehicles drawn per level of detail and the triangles they cost (traffic.lod). */
  stats() {
    const out = { lod0: 0, lod1: 0, tris: 0 };
    for (const kind of Object.keys(this.parts) as VehicleKind[])
      for (const variant of this.parts[kind])
        variant.forEach((set, lod) => {
          out[lod ? 'lod1' : 'lod0'] += set.paint.count;
          for (const im of Object.values(set)) {
            const g = im.geometry;
            out.tris += (im.count * (g.index ? g.index.count : g.getAttribute('position').count)) / 3;
          }
        });
    out.tris = Math.round(out.tris);
    return out;
  }
}
