import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/** Draws every collider as lines (phys.colliders show). Refreshes twice a second, since it is slow on a full city. */
export class PhysicsDebugView {
  readonly lines: THREE.LineSegments;
  private world: RAPIER_NS.World;
  private timer = 0;

  constructor(world: RAPIER_NS.World) {
    this.world = world;
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.7 });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.visible = false;
  }

  setVisible(v: boolean) {
    this.lines.visible = v;
    this.timer = 0;
  }

  update(dt: number) {
    if (!this.lines.visible || (this.timer -= dt) > 0) return;
    this.timer = 0.5;
    const { vertices, colors } = this.world.debugRender();
    const g = this.lines.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(vertices.slice(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors.slice(), 4));
  }
}
