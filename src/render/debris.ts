import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { DEBRIS_GROUPS } from '../vehicle/carPhysics.ts';

// Loose parts (from car damage or knocked-over street furniture) as small dynamic bodies that
// tumble, settle and are cleared after a while.

type R = typeof RAPIER_NS;

interface Piece { obj: THREE.Object3D; body: RAPIER_NS.RigidBody; life: number }

export class Debris {
  readonly root = new THREE.Group();
  /** Seconds a piece stays before it is removed. */
  lifetime = 25;
  private pieces: Piece[] = [];
  private R: R;
  private world: RAPIER_NS.World;

  constructor(R: R, world: RAPIER_NS.World) {
    this.R = R;
    this.world = world;
  }

  get count() { return this.pieces.length; }

  /**
   * Adds objects as one loose piece. matrixWorld: where they are now; velocity and spin to start with.
   * The objects are re-parented under one group placed at their centre.
   */
  spawn(objects: THREE.Object3D[], parentWorld: THREE.Matrix4, velocity: THREE.Vector3, spin: THREE.Vector3, mass = 4) {
    const group = new THREE.Group();
    const box = new THREE.Box3();
    for (const o of objects) {
      o.updateMatrix();
      o.matrix.premultiply(parentWorld).decompose(o.position, o.quaternion, o.scale);
      o.updateMatrixWorld(true);
      box.expandByObject(o);
    }
    const centre = box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.03, 0.03, 0.03));
    group.position.copy(centre);
    for (const o of objects) {
      o.position.sub(centre);
      group.add(o);
    }
    this.root.add(group);
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.dynamic()
        .setTranslation(centre.x, centre.y, centre.z)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setAngvel({ x: spin.x, y: spin.y, z: spin.z })
        .setLinearDamping(0.1)
        .setAngularDamping(0.3)
        .setCcdEnabled(true),
    );
    const vol = 8 * half.x * half.y * half.z;
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setDensity(mass / vol).setFriction(0.7).setRestitution(0.2).setCollisionGroups(DEBRIS_GROUPS),
      body,
    );
    this.pieces.push({ obj: group, body, life: this.lifetime });
    return body;
  }

  update(dt: number) {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.life -= dt;
      if (p.life <= 0 || p.obj.children.length === 0 || p.body.translation().y < -500) {
        this.remove(i);
        continue;
      }
      const t = p.body.translation();
      const q = p.body.rotation();
      p.obj.position.set(t.x, t.y, t.z);
      p.obj.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }

  clear() {
    for (let i = this.pieces.length - 1; i >= 0; i--) this.remove(i);
  }

  private remove(i: number) {
    const p = this.pieces[i];
    p.obj.removeFromParent();
    this.world.removeRigidBody(p.body);
    this.pieces.splice(i, 1);
  }
}
