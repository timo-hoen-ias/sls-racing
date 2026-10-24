import * as THREE from 'three';

// Draws the four wheels with one InstancedMesh per wheel part and side instead of one mesh per part and wheel
// (tyre, rim, lip, disc, caliper … times four, in the view and in the shadow map). The wheel pivots built by the
// model stay the source of truth: CarView poses them as before, they are just not drawn; their meshes' poses are
// copied into the instances. Right-hand wheels are mirrored, so they get their own InstancedMesh whose object
// matrix carries the mirror (three.js only flips the winding for a mirrored object, not per instance).

const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);

interface Part {
  inst: THREE.InstancedMesh;
  /** The same part on both wheels of this side. */
  sources: THREE.Mesh[];
  mirror: boolean;
  /** LOD level the part belongs to (-1: always shown). */
  level: number;
  levels: number;
}

function meshesOf(root: THREE.Object3D) {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
  return out;
}

/** Which level of the nearest LOD above the mesh (up to the pivot) it belongs to. */
function lodLevelOf(mesh: THREE.Object3D, pivot: THREE.Object3D) {
  for (let o = mesh; o.parent && o !== pivot; o = o.parent) {
    const lod = o.parent as THREE.LOD;
    if (lod.isLOD) return { level: lod.levels.findIndex((l) => l.object === o), levels: lod.levels.length };
  }
  return { level: -1, levels: 1 };
}

export class WheelInstances {
  readonly group = new THREE.Group();
  private parts: Part[] = [];
  private pivots: THREE.Object3D[];
  private m = new THREE.Matrix4();

  /** pivots: front left, front right, rear left, rear right (+x is left), as the model built them. */
  constructor(pivots: THREE.Object3D[]) {
    this.group.name = 'wheels';
    this.pivots = pivots;
    for (const [side, mirror] of [[[0, 2], false], [[1, 3], true]] as const) {
      const lists = side.map((i) => meshesOf(pivots[i]));
      lists[0].forEach((mesh, j) => {
        const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, 2);
        inst.castShadow = mesh.castShadow;
        inst.receiveShadow = mesh.receiveShadow;
        // The wheels move with the car; their bounds would need refreshing every frame.
        inst.frustumCulled = false;
        if (mirror) inst.scale.x = -1;
        this.group.add(inst);
        this.parts.push({ inst, sources: lists.map((l) => l[j]), mirror, ...lodLevelOf(mesh, pivots[side[0]]) });
      });
    }
    for (const p of pivots) p.visible = false;
  }

  /** Off: the wheel pivots draw themselves again, one call per part and wheel (car.wheelinst, for comparing). */
  get enabled() { return this.group.visible; }
  set enabled(on: boolean) {
    this.group.visible = on;
    for (const p of this.pivots) p.visible = !on;
  }

  /** Copies the posed wheels into the instances; lodLevel: the body's current level (0 = full detail). */
  update(lodLevel: number) {
    if (!this.group.visible) return;
    for (const p of this.pivots) p.updateMatrix();
    for (const part of this.parts) {
      const show = part.level < 0 || part.level === Math.min(lodLevel, part.levels - 1);
      part.inst.visible = show;
      if (!show) continue;
      part.sources.forEach((src, k) => {
        // Pose relative to the car root: chain the local matrices up to the pivot.
        const m = this.m.identity();
        for (let o: THREE.Object3D | null = src; o; o = o.parent) {
          o.updateMatrix();
          m.premultiply(o.matrix);
          if (this.pivots.includes(o)) break;
        }
        if (part.mirror) m.premultiply(MIRROR);
        part.inst.setMatrixAt(k, m);
      });
      part.inst.instanceMatrix.needsUpdate = true;
    }
  }

  /** Draw calls per frame without the shadow pass (for tests and car.specs). */
  get drawCount() {
    return this.parts.filter((p) => p.inst.visible).length;
  }

  dispose() {
    this.group.removeFromParent();
    for (const p of this.parts) p.inst.dispose();
  }
}
