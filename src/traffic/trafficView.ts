import * as THREE from 'three';
import { type Agent, type AgentState, type VehicleKind } from './trafficSim.ts';
import { buildVehicleParts } from './vehicleModels.ts';

const STATE_COLORS: Record<AgentState, number> = { drive: 0x3ddc84, follow: 0x4aa3ff, yield: 0xffc400, player: 0xff7a00, crashed: 0xff2d2d };

/** Draws all traffic with a few instanced meshes per vehicle type. */
export class TrafficView {
  readonly root = new THREE.Group();
  /** Coloured markers above every vehicle showing its state (traffic.debug). */
  debug = false;
  private parts: Record<VehicleKind, { paint: THREE.InstancedMesh; detail: THREE.InstancedMesh; lights: THREE.InstancedMesh; brake: THREE.InstancedMesh; blink: THREE.InstancedMesh }>;
  private markers: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();

  constructor(capacity: number, shadows: boolean) {
    this.root.name = 'traffic';
    const geos = buildVehicleParts();
    const paint = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.45, envMapIntensity: 1.2 });
    const detail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 });
    const lights = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: '#ffffff', emissiveIntensity: 0.25, roughness: 0.3 });
    // Brake and hazard lights glow above the bloom threshold.
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const make = (g: THREE.BufferGeometry, mat: THREE.Material, cast = false) => {
      const im = new THREE.InstancedMesh(g, mat, capacity);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = cast && shadows;
      im.receiveShadow = shadows;
      this.root.add(im);
      return im;
    };
    this.parts = {} as typeof this.parts;
    for (const kind of Object.keys(geos) as VehicleKind[]) {
      const g = geos[kind];
      this.parts[kind] = {
        paint: make(g.paint, paint, true), detail: make(g.detail, detail, true), lights: make(g.lights, lights),
        brake: make(g.brake, glow), blink: make(g.blink, glow),
      };
    }
    this.markers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.45), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false }), capacity);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 10;
    this.markers.count = 0;
    this.root.add(this.markers);
  }

  update(agents: readonly Agent[], time: number) {
    const counts: Record<string, number> = { car: 0, van: 0, bus: 0, truck: 0 };
    const blinkOn = time % 0.9 < 0.45;
    let mk = 0;
    for (const a of agents) {
      const set = this.parts[a.kind];
      const i = counts[a.kind]++;
      if (i >= set.paint.instanceMatrix.count) continue;
      this.e.set(-a.pitch, a.yaw, 0);
      this.q.setFromEuler(this.e);
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
    for (const kind of Object.keys(this.parts) as VehicleKind[]) {
      const set = this.parts[kind];
      for (const im of Object.values(set)) {
        im.count = Math.min(counts[kind], im.instanceMatrix.count);
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
    this.markers.count = mk;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }
}
