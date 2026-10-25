import * as THREE from 'three';
import type { Place } from './workshop.ts';

// Markers for the dealer and the home garage: a soft column of light and a ring on the road side, seen
// from far away like the event starts.

export class PlaceView {
  readonly root = new THREE.Group();
  private rings: THREE.Mesh[] = [];
  private t = 0;

  constructor() {
    this.root.name = 'places';
  }

  set(places: Place[], height: (x: number, z: number) => number | undefined) {
    this.root.clear();
    this.rings = [];
    for (const p of places) {
      const y = height(p.x, p.z) ?? 0;
      const color = new THREE.Color(p.color);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 1.6, 40, 24, 1, true).translate(0, 20, 0),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(4, 4.6, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }),
      );
      ring.position.y = 0.25;
      const g = new THREE.Group();
      g.position.set(p.x, y, p.z);
      g.add(beam, ring);
      this.root.add(g);
      this.rings.push(ring);
    }
  }

  update(dt: number) {
    this.t += dt;
    const s = 1 + Math.sin(this.t * 2.5) * 0.06;
    for (const r of this.rings) r.scale.set(s, 1, s);
  }
}
