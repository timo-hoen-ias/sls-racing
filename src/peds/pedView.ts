import * as THREE from 'three';
import type { PedVariant } from '../world/propGlb.ts';
import type { Ped, PedState } from './pedSim.ts';

const STATE_COLORS: Record<PedState, number> = { walk: 0x3ddc84, cross: 0xffc400, wait: 0xff40ff, dodge: 0xff7a00, down: 0xff2d2d, stand: 0x4aa3ff };

/** One figure model: instanced parts, drawn at `scale` on top of each pedestrian's height. */
interface Figure {
  scale: number;
  /** Share of the pedestrians drawn with this figure (weights, normalised over all figures). */
  weight: number;
  torso: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  hair?: THREE.InstancedMesh;
  legs: THREE.InstancedMesh;
  arms: THREE.InstancedMesh;
}

const HAIR = [0x2a1d14, 0x4a3020, 0x6b4a2b, 0x15120f, 0x9a7a4a, 0xb8b2a6, 0x3b2a20];
/** Figure weights by Blender variant name; children are rarer. */
const VARIANT_WEIGHT: Record<string, number> = { kind: 0.4 };

/** Instanced people: torso, head, hair, swinging legs and arms. Model space: feet at y = 0, +z forward. */
export class PedView {
  readonly root = new THREE.Group();
  debug = false;
  /** Which figures are in use (peds.models). */
  models: 'glb' | 'procedural' = 'procedural';
  /** The Blender figures once loaded. */
  variants?: PedVariant[];
  private figures: Figure[] = [];
  private capacity: number;
  private shadows: boolean;
  private cloth = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
  private skin = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 });
  // The Blender parts carry greyscale shading as vertex colours.
  private clothShaded = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, vertexColors: true });
  private skinShaded = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, vertexColors: true });
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
    this.capacity = capacity;
    this.shadows = shadows;
    this.setProcedural();
    this.markers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false }), capacity);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 10;
    this.markers.count = 0;
    this.root.add(this.markers);
  }

  /** The Blender figures (propGlb.ts), vertex-shaded greyscale and tinted per pedestrian. */
  setVariants(variants: PedVariant[]) {
    if (!variants.length) return;
    this.variants = variants;
    this.setFigures(variants.map((v) => ({ scale: v.scale, weight: VARIANT_WEIGHT[v.variant] ?? 1, torso: v.torso, head: v.head, hair: v.hair, leg: v.leg, arm: v.arm })));
    this.models = 'glb';
  }

  /** Back to the simple box figure. */
  setProcedural() {
    const torso = new THREE.BoxGeometry(0.42, 0.62, 0.24).translate(0, 1.24, 0);
    // Slightly tapered towards the waist.
    const tp = torso.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < tp.count; i++) if (tp.getY(i) < 1.0) tp.setX(i, tp.getX(i) * 0.82);
    torso.computeVertexNormals();
    this.setFigures([{
      scale: 1, weight: 1, torso,
      head: new THREE.IcosahedronGeometry(0.12, 1).scale(0.9, 1.1, 1).translate(0, 1.7, 0.01),
      // Legs and arms hang from their pivot (hip, shoulder) at the origin.
      leg: new THREE.BoxGeometry(0.16, 0.92, 0.18).translate(0, -0.46, 0),
      arm: new THREE.BoxGeometry(0.1, 0.6, 0.12).translate(0, -0.3, 0),
    }]);
    this.models = 'procedural';
  }

  private setFigures(list: { scale: number; weight: number; torso: THREE.BufferGeometry; head: THREE.BufferGeometry; hair?: THREE.BufferGeometry; leg: THREE.BufferGeometry; arm: THREE.BufferGeometry }[]) {
    for (const f of this.figures) for (const im of [f.torso, f.head, f.hair, f.legs, f.arms]) if (im) { this.root.remove(im); im.dispose(); }
    const make = (g: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const im = new THREE.InstancedMesh(g, mat, n);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = this.shadows;
      im.receiveShadow = this.shadows;
      this.root.add(im);
      return im;
    };
    const n = this.capacity;
    const cloth = (g: THREE.BufferGeometry) => (g.getAttribute('color') ? this.clothShaded : this.cloth);
    const skin = (g: THREE.BufferGeometry) => (g.getAttribute('color') ? this.skinShaded : this.skin);
    this.figures = list.map((f) => ({
      scale: f.scale, weight: f.weight,
      torso: make(f.torso, cloth(f.torso), n), head: make(f.head, skin(f.head), n), hair: f.hair && make(f.hair, cloth(f.hair), n),
      legs: make(f.leg, cloth(f.leg), n * 2), arms: make(f.arm, cloth(f.arm), n * 2),
    }));
  }

  /** Figure of a pedestrian, by id and the weights. */
  figureOf(id: number) {
    const total = this.figures.reduce((a, f) => a + f.weight, 0);
    let r = fract(Math.sin(id * 78.233) * 43758.5453) * total;
    for (let i = 0; i < this.figures.length; i++) if ((r -= this.figures[i].weight) <= 0) return i;
    return this.figures.length - 1;
  }

  update(peds: readonly Ped[]) {
    const n = Math.min(peds.length, this.capacity);
    const used = this.figures.map(() => 0);
    for (let i = 0; i < n; i++) {
      const p = peds[i];
      const fi = this.figureOf(p.id);
      const f = this.figures[fi];
      const k = used[fi]++;
      // Falling over backwards about the feet.
      this.e.set(-p.fall * Math.PI * 0.48, p.yaw, 0);
      this.q.setFromEuler(this.e);
      this.base.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.setScalar(p.height * f.scale));
      f.torso.setMatrixAt(k, this.base);
      f.torso.setColorAt(k, this.c.setHex(p.shirt));
      f.head.setMatrixAt(k, this.base);
      f.head.setColorAt(k, this.c.setHex(p.skin));
      if (f.hair) {
        f.hair.setMatrixAt(k, this.base);
        f.hair.setColorAt(k, this.c.setHex(HAIR[p.id % HAIR.length]));
      }
      const moving = p.state === 'walk' || p.state === 'cross' || p.state === 'dodge';
      const swing = moving ? Math.sin(p.phase) * (p.state === 'dodge' ? 0.9 : 0.45) : 0;
      for (const side of [0, 1]) {
        const sgn = side ? -1 : 1;
        this.part.makeRotationX(swing * sgn).setPosition(0.1 * sgn, 0.93, 0);
        this.m.multiplyMatrices(this.base, this.part);
        f.legs.setMatrixAt(k * 2 + side, this.m);
        f.legs.setColorAt(k * 2 + side, this.c.setHex(p.trousers));
        this.part.makeRotationX(-swing * sgn * 0.8 + (p.state === 'dodge' ? -1.2 : 0)).setPosition(0.27 * sgn, 1.52, 0);
        this.m.multiplyMatrices(this.base, this.part);
        f.arms.setMatrixAt(k * 2 + side, this.m);
        f.arms.setColorAt(k * 2 + side, this.c.setHex(p.shirt));
      }
      if (this.debug) {
        this.m.makeTranslation(p.x, p.y + 2.3, p.z);
        this.markers.setMatrixAt(i, this.m);
        this.markers.setColorAt(i, this.c.setHex(STATE_COLORS[p.state]));
      }
    }
    this.figures.forEach((f, fi) => {
      for (const [im, k] of [[f.torso, 1], [f.head, 1], [f.hair, 1], [f.legs, 2], [f.arms, 2]] as const) {
        if (!im) continue;
        im.count = used[fi] * k;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    });
    this.markers.count = this.debug ? n : 0;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }

  /** Pedestrians drawn per figure in the last update. */
  get figureCount() { return this.figures.length; }
}

const fract = (v: number) => v - Math.floor(v);
