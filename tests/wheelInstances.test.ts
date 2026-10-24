import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildSportsCar } from '../src/vehicle/sportsCarModel.ts';
import { WheelInstances } from '../src/vehicle/wheelInstances.ts';

describe('wheel instances', () => {
  it('draws every wheel part once per side and matches the posed wheels, mirrored ones included', () => {
    const model = buildSportsCar();
    const root = new THREE.Group();
    const wheels = [0, 1, 2, 3].map((i) => model.makeWheel(i % 2 === 0 ? 1 : -1));
    wheels.forEach((w, i) => {
      root.add(w.pivot);
      w.pivot.position.set(i % 2 ? -0.8 : 0.8, 0.02, i < 2 ? 1.27 : -1.2);
      w.pivot.rotation.y = i < 2 ? -0.3 : 0;
      w.spin.rotation.x = 1.1 + i;
    });
    const set = new WheelInstances(wheels.map((w) => w.pivot));
    root.add(set.group);
    set.update(0);
    const perWheel = (() => { let n = 0; wheels[0].pivot.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; }); return n; })();
    expect(set.drawCount).toBe(2 * perWheel);
    expect(wheels.every((w) => !w.pivot.visible)).toBe(true);

    // Each instance sits where its source mesh is (world = root here), checked on a vertex.
    root.updateMatrixWorld(true);
    const insts = set.group.children as THREE.InstancedMesh[];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (const [side, inst] of [[0, insts[0]], [1, insts[perWheel]]] as const) {
      for (const [k, wi] of (side === 0 ? [0, 2] : [1, 3]).entries()) {
        const src: THREE.Mesh[] = [];
        wheels[wi].pivot.traverse((o) => { if ((o as THREE.Mesh).isMesh) src.push(o as THREE.Mesh); });
        const v = new THREE.Vector3().fromBufferAttribute(src[0].geometry.getAttribute('position') as THREE.BufferAttribute, 5);
        p.copy(v).applyMatrix4(src[0].matrixWorld);
        inst.getMatrixAt(k, m);
        q.copy(v).applyMatrix4(m).applyMatrix4(inst.matrixWorld);
        expect(q.distanceTo(p)).toBeLessThan(1e-5);
        // Mirrored wheels: the object matrix flips (so three.js flips the winding), the instance does not.
        expect(inst.matrixWorld.determinant() * m.determinant()).toBeCloseTo(src[0].matrixWorld.determinant());
      }
    }
    set.enabled = false;
    expect(wheels.every((w) => w.pivot.visible)).toBe(true);
  });
});
