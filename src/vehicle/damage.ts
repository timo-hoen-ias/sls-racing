import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Car damage: dents pressed into the body panels at the point of impact, paint that loses its
// shine, parts that break off (splitter, number plate, mirrors, wing) and, optionally, less power
// and a steering pull. Works in model space (sportsCarModel: ground at y = 0, +z forward, +x left).

export type Zone = 'front' | 'rear' | 'left' | 'right';
export const ZONES: Zone[] = ['front', 'rear', 'left', 'right'];

/** Body half extents (m) used to put an impact direction onto the hull. */
const HULL = { x: 0.95, z: 2.3, y: 0.55 };
/** Zone damage from which each part comes off. */
const BREAKS: { part: string; zone: Zone; at: number }[] = [
  { part: 'splitter', zone: 'front', at: 0.45 },
  { part: 'plate', zone: 'rear', at: 0.4 },
  { part: 'mirrorL', zone: 'left', at: 0.35 },
  { part: 'mirrorR', zone: 'right', at: 0.35 },
  { part: 'wing', zone: 'rear', at: 0.75 },
];

interface Panel { mesh: THREE.Mesh; original: THREE.BufferGeometry }

export class CarDamage {
  /** Hits dent the car at all. */
  enabled = true;
  /** Damage costs power and pulls the steering. */
  performance = true;
  readonly zones: Record<Zone, number> = { front: 0, rear: 0, left: 0, right: 0 };
  /** Called with each part that breaks off (already removed from the car, still in model space). */
  onDetach?: (part: THREE.Object3D[]) => void;
  private model: THREE.Group;
  private paint: THREE.MeshPhysicalMaterial;
  private paintBase: { roughness: number; clearcoat: number; color: THREE.Color };
  private panels: Panel[] = [];
  private parts = new Map<string, THREE.Object3D[]>();
  private detached = new Set<string>();

  constructor(model: THREE.Group, paint: THREE.MeshPhysicalMaterial) {
    this.model = model;
    this.paint = paint;
    this.paintBase = { roughness: paint.roughness, clearcoat: paint.clearcoat, color: paint.color.clone() };
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.dent) this.panels.push({ mesh: m, original: m.geometry.clone() });
      if (o.userData.part) {
        const list = this.parts.get(o.userData.part) ?? [];
        list.push(o);
        this.parts.set(o.userData.part, list);
      }
    });
  }

  /** Call after the paint colour changed (car.color). */
  rebase() {
    const t = this.total;
    this.paintBase.color.copy(this.paint.color).multiplyScalar(1 / (1 - 0.25 * t));
  }

  /** Overall damage 0..1. */
  get total() {
    return Math.min(1, (this.zones.front + this.zones.rear + this.zones.left + this.zones.right) / 2.2);
  }

  /** Engine power factor (front damage hurts the cooling and intake most). */
  get power() {
    if (!this.performance) return 1;
    return 1 - 0.35 * this.zones.front - 0.08 * this.zones.rear - 0.05 * (this.zones.left + this.zones.right);
  }

  /** Steering offset (rad, + = right) from a bent front corner. */
  get steerPull() {
    if (!this.performance) return 0;
    return (this.zones.left - this.zones.right) * 0.03 * Math.min(1, this.zones.front + 0.5);
  }

  /** Zone of a direction from the car centre (body frame). */
  static zoneOf(dx: number, dz: number): Zone {
    if (Math.abs(dz) / HULL.z > Math.abs(dx) / HULL.x) return dz > 0 ? 'front' : 'rear';
    return dx > 0 ? 'left' : 'right';
  }

  /**
   * A hit. from: direction from the car centre towards the obstacle (body frame), strength 0..1.
   * Returns the zone that took it.
   */
  hit(from: THREE.Vector3, strength: number): Zone | null {
    if (!this.enabled || strength <= 0) return null;
    const d = new THREE.Vector3(from.x, 0, from.z);
    if (d.lengthSq() < 1e-6) return null;
    d.normalize();
    const zone = CarDamage.zoneOf(d.x, d.z);
    this.zones[zone] = Math.min(1, this.zones[zone] + strength * 0.45);
    // Impact point on the hull: scale the direction until it meets the body's bounding box.
    const k = 1 / Math.max(Math.abs(d.x) / HULL.x, Math.abs(d.z) / HULL.z);
    const p = new THREE.Vector3(d.x * k, HULL.y, d.z * k);
    this.dent(p, d.clone().negate(), 0.03 + 0.11 * strength, 0.4 + 0.45 * strength);
    this.updatePaint();
    for (const b of BREAKS) if (this.zones[b.zone] >= b.at && !this.detached.has(b.part)) this.detach(b.part);
    return zone;
  }

  repair() {
    for (const z of ZONES) this.zones[z] = 0;
    for (const p of this.panels) {
      p.mesh.geometry.dispose();
      p.mesh.geometry = p.original.clone();
    }
    for (const name of this.detached) for (const o of this.parts.get(name) ?? []) {
      o.removeFromParent();
      this.model.add(o);
      o.position.copy(o.userData.home.position);
      o.quaternion.copy(o.userData.home.quaternion);
      o.scale.copy(o.userData.home.scale);
    }
    this.detached.clear();
    this.updatePaint();
  }

  /** Pushes the panels in around p (model space) along dir. */
  private dent(p: THREE.Vector3, dir: THREE.Vector3, depth: number, radius: number) {
    const r2 = radius * radius;
    for (const panel of this.panels) {
      const g = panel.mesh.geometry;
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      let moved = false;
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - p.x, dy = pos.getY(i) - p.y, dz = pos.getZ(i) - p.z;
        const q = (dx * dx + dy * dy * 1.5 + dz * dz) / r2;
        if (q >= 1) continue;
        // Smooth bowl with a gentle ripple so dents do not look stamped.
        const f = (1 - q) * (1 - q) * (0.85 + 0.15 * Math.sin(pos.getX(i) * 9 + pos.getY(i) * 7 + pos.getZ(i) * 5));
        pos.setXYZ(i, pos.getX(i) + dir.x * depth * f, pos.getY(i) + dir.y * depth * f - depth * 0.25 * f, pos.getZ(i) + dir.z * depth * f);
        moved = true;
      }
      if (!moved) continue;
      pos.needsUpdate = true;
      // Smooth shading across the dent, hard edges stay hard.
      const fresh = toCreasedNormals(g, 0.7);
      if (fresh !== g) { g.dispose(); panel.mesh.geometry = fresh; }
      fresh.computeBoundingSphere();
    }
  }

  private updatePaint() {
    const t = this.total;
    const b = this.paintBase;
    this.paint.roughness = b.roughness + (0.75 - b.roughness) * t;
    this.paint.clearcoat = b.clearcoat * (1 - 0.8 * t);
    this.paint.color.copy(b.color).multiplyScalar(1 - 0.25 * t);
  }

  private detach(name: string) {
    const list = this.parts.get(name);
    if (!list) return;
    this.detached.add(name);
    for (const o of list) o.userData.home = { position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() };
    for (const o of list) o.removeFromParent();
    this.onDetach?.(list);
  }

  /** Breaks a part off by name (debug). */
  breakPart(name: string) {
    if (!this.parts.has(name)) throw new Error(`Teil unbekannt: ${[...this.parts.keys()].join(', ')}`);
    if (!this.detached.has(name)) this.detach(name);
  }

  get partNames() { return [...this.parts.keys()]; }
}
