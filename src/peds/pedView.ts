import * as THREE from 'three';
import type { Ped, PedState } from './pedSim.ts';

const STATE_COLORS: Record<PedState, number> = { walk: 0x3ddc84, cross: 0xffc400, wait: 0xff40ff, dodge: 0xff7a00, down: 0xff2d2d, stand: 0x4aa3ff };

/** Simple instanced people: torso, head, swinging legs and arms. Model space: feet at y = 0, +z forward. */
export class PedView {
  readonly root = new THREE.Group();
  debug = false;
  private torso: THREE.InstancedMesh;
  private head: THREE.InstancedMesh;
  private legs: THREE.InstancedMesh;
  private arms: THREE.InstancedMesh;
  private markers: THREE.InstancedMesh;
  private base = new THREE.Matrix4();
  private m = new THREE.Matrix4();
  private part = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(capacity: number, shadows: boolean) {
    this.root.name = 'pedestrians';
    const cloth = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 });
    const make = (g: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const im = new THREE.InstancedMesh(g, mat, n);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = shadows;
      im.receiveShadow = shadows;
      this.root.add(im);
      return im;
    };
    const torso = new THREE.BoxGeometry(0.42, 0.62, 0.24).translate(0, 1.24, 0);
    // Slightly tapered towards the waist.
    const tp = torso.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < tp.count; i++) if (tp.getY(i) < 1.0) tp.setX(i, tp.getX(i) * 0.82);
    torso.computeVertexNormals();
    this.torso = make(torso, cloth, capacity);
    this.head = make(new THREE.IcosahedronGeometry(0.12, 1).scale(0.9, 1.1, 1).translate(0, 1.7, 0.01), skin, capacity);
    // Legs and arms hang from their pivot (hip, shoulder) at the origin.
    this.legs = make(new THREE.BoxGeometry(0.16, 0.92, 0.18).translate(0, -0.46, 0), cloth, capacity * 2);
    this.arms = make(new THREE.BoxGeometry(0.1, 0.6, 0.12).translate(0, -0.3, 0), cloth, capacity * 2);
    this.markers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false }), capacity);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 10;
    this.markers.count = 0;
    this.root.add(this.markers);
  }

  update(peds: readonly Ped[]) {
    const n = Math.min(peds.length, this.torso.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const p = peds[i];
      // Falling over backwards about the feet.
      this.e.set(-p.fall * Math.PI * 0.48, p.yaw, 0);
      this.q.setFromEuler(this.e);
      this.base.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.setScalar(p.height));
      this.torso.setMatrixAt(i, this.base);
      this.torso.setColorAt(i, this.c.setHex(p.shirt));
      this.head.setMatrixAt(i, this.base);
      this.head.setColorAt(i, this.c.setHex(p.skin));
      const moving = p.state === 'walk' || p.state === 'cross' || p.state === 'dodge';
      const swing = moving ? Math.sin(p.phase) * (p.state === 'dodge' ? 0.9 : 0.45) : 0;
      for (const side of [0, 1]) {
        const sgn = side ? -1 : 1;
        this.part.makeRotationX(swing * sgn).setPosition(0.1 * sgn, 0.93, 0);
        this.m.multiplyMatrices(this.base, this.part);
        this.legs.setMatrixAt(i * 2 + side, this.m);
        this.legs.setColorAt(i * 2 + side, this.c.setHex(p.trousers));
        this.part.makeRotationX(-swing * sgn * 0.8 + (p.state === 'dodge' ? -1.2 : 0)).setPosition(0.27 * sgn, 1.52, 0);
        this.m.multiplyMatrices(this.base, this.part);
        this.arms.setMatrixAt(i * 2 + side, this.m);
        this.arms.setColorAt(i * 2 + side, this.c.setHex(p.shirt));
      }
      if (this.debug) {
        this.m.makeTranslation(p.x, p.y + 2.3, p.z);
        this.markers.setMatrixAt(i, this.m);
        this.markers.setColorAt(i, this.c.setHex(STATE_COLORS[p.state]));
      }
    }
    for (const [im, k] of [[this.torso, 1], [this.head, 1], [this.legs, 2], [this.arms, 2]] as const) {
      im.count = n * k;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.markers.count = this.debug ? n : 0;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }
}
