import * as THREE from 'three';
import { type GameEvent, type Gate, RACE_TYPES, type EventType } from './types.ts';

// 3D markers for events: glowing arches for checkpoints, start gates of skills nearby, light columns over
// race starts (visible from afar) and traffic cones for slaloms. Plain emissive materials, so bloom makes
// them glow at night too.

export const TYPE_COLORS: Record<EventType, number> = {
  sprint: 0x3d8bff, circuit: 0x3d8bff, duel: 0x8a5cff, speedtrap: 0xff3b30, speedzone: 0xff9500, drift: 0xff2fd0, nearmiss: 0xffd60a,
  slalom: 0xff7a1a, jump: 0x2fe0ff, escape: 0xff3b30, delivery: 0x34c759,
};

const POST = new THREE.BoxGeometry(0.35, 1, 0.35).translate(0, 0.5, 0);
const BEAM = new THREE.BoxGeometry(1, 0.7, 0.18).translate(0, 0.35, 0);
const COLUMN = new THREE.CylinderGeometry(2.2, 2.2, 1, 24, 1, true).translate(0, 0.5, 0);
const CONE = new THREE.ConeGeometry(0.22, 0.75, 12).translate(0, 0.375, 0);
const ARROW = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, 1.2); s.lineTo(1, 0); s.lineTo(0.4, 0); s.lineTo(0.4, -1.1); s.lineTo(-0.4, -1.1); s.lineTo(-0.4, 0); s.lineTo(-1, 0); s.closePath();
  return new THREE.ShapeGeometry(s);
})();

const glow = (color: number, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false, depthWrite: opacity >= 1, side: THREE.DoubleSide });

/** One arch across the road. */
function arch(g: Gate, color: number, height: number, opacity = 1) {
  const group = new THREE.Group();
  const mat = glow(color, opacity);
  const w = g.w;
  const heading = Math.atan2(g.dx, g.dz);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(POST, mat);
    post.scale.y = height;
    post.position.set(side * w, 0, 0);
    group.add(post);
  }
  const beam = new THREE.Mesh(BEAM, mat);
  beam.scale.x = w * 2 + 0.35;
  beam.position.y = height - 0.7;
  group.add(beam);
  group.position.set(g.x, g.y, g.z);
  group.rotation.y = heading;
  return group;
}

export class GateView {
  readonly root = new THREE.Group();
  /** Draw markers of skills and race starts within this distance (m). */
  markerRange = 500;
  visible = true;
  private active = new THREE.Group();
  private markers = new THREE.Group();
  private cones: THREE.InstancedMesh;
  private markerKey = '';
  private activeKey = '';
  private t = 0;

  constructor() {
    this.root.name = 'event-gates';
    this.root.add(this.active, this.markers);
    this.cones = new THREE.InstancedMesh(CONE, new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0x401800, roughness: 0.6 }), 64);
    this.cones.count = 0;
    this.cones.frustumCulled = false;
    this.cones.castShadow = true;
    this.root.add(this.cones);
  }

  /** The running event: next checkpoint bright, the one after dimmed; slalom cones. */
  showActive(e: GameEvent | undefined, next: number) {
    const key = e ? `${e.id}:${next}` : '';
    if (key === this.activeKey) return;
    this.activeKey = key;
    this.active.clear();
    if (!e) { this.setCones(undefined); return; }
    const color = TYPE_COLORS[e.type];
    const g = e.gates[next];
    if (g) {
      const a = arch(g, color, 6);
      // A big arrow floating over the gate, pointing the way.
      const arrow = new THREE.Mesh(ARROW, glow(0xffffff, 0.85));
      arrow.position.set(0, 7.5, 0);
      arrow.scale.setScalar(1.2);
      a.add(arrow);
      a.userData.pulse = true;
      this.active.add(a);
    }
    const after = e.gates[next + 1];
    if (after) this.active.add(arch(after, color, 5, 0.35));
    this.setCones(e);
  }

  private setCones(e: GameEvent | undefined) {
    const cones = e?.extra?.cones ?? [];
    const m = new THREE.Matrix4();
    let n = 0;
    for (const g of cones) for (const side of [-1, 1]) {
      if (n >= 64) break;
      m.makeTranslation(g.x - g.dz * side * g.w, g.y, g.z + g.dx * side * g.w);
      this.cones.setMatrixAt(n++, m);
    }
    this.cones.count = n;
    this.cones.instanceMatrix.needsUpdate = true;
  }

  /** Markers of the events near the car (start gates and race columns); hidden while an event runs. */
  showMarkers(events: GameEvent[], x: number, z: number, hide: boolean) {
    const near = hide ? [] : events.filter((e) => Math.hypot(e.start.x - x, e.start.z - z) < this.markerRange);
    const key = near.map((e) => e.id).join(',');
    if (key === this.markerKey) return;
    this.markerKey = key;
    this.markers.clear();
    for (const e of near) {
      const color = TYPE_COLORS[e.type];
      if (RACE_TYPES.has(e.type)) {
        const col = new THREE.Mesh(COLUMN, glow(color, 0.28));
        col.scale.y = 60;
        col.position.set(e.start.x, e.start.y, e.start.z);
        col.renderOrder = 3;
        this.markers.add(col);
        this.markers.add(arch(e.start, color, 4.5, 0.6));
      } else {
        this.markers.add(arch(e.start, color, 4, 0.75));
        // Slaloms show their cones all the time, so you see where to drive.
        if (e.extra?.cones) for (const g of e.extra.cones) for (const side of [-1, 1]) {
          const c = new THREE.Mesh(CONE, (this.cones.material as THREE.Material));
          c.position.set(g.x - g.dz * side * g.w, g.y, g.z + g.dx * side * g.w);
          this.markers.add(c);
        }
      }
    }
  }

  update(dt: number) {
    this.t += dt;
    this.root.visible = this.visible;
    const s = 1 + Math.sin(this.t * 5) * 0.04;
    for (const o of this.active.children) if (o.userData.pulse) o.scale.set(s, s, s);
  }
}
