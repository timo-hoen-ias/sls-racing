import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Navigation } from '../nav/navigation.ts';
import { pointAt } from '../world/roadGraph.ts';

type R = typeof RAPIER_NS;
const AHEAD = 320;
const BEHIND = 10;
const STEP = 2;

/** Glowing chevron ribbon on the road along the GPS route, rebuilt as the car advances. */
export class RouteLine {
  readonly mesh: THREE.Mesh;
  private texture: THREE.CanvasTexture;
  private builtAt = -Infinity;
  private builtVersion = -1;
  private R: R;
  private world: RAPIER_NS.World;
  private nav: Navigation;
  private exclude: RAPIER_NS.RigidBody;

  constructor(R: R, world: RAPIER_NS.World, nav: Navigation, exclude: RAPIER_NS.RigidBody) {
    this.R = R;
    this.world = world;
    this.nav = nav;
    this.exclude = exclude;
    this.texture = chevronTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture, color: '#43c0ff', transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  update(dt: number) {
    this.texture.offset.y -= dt * 0.9;
    const r = this.nav.route;
    if (!r) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    if (this.builtVersion === this.nav.version && this.nav.progress - this.builtAt < 30) return;
    this.builtVersion = this.nav.version;
    this.builtAt = this.nav.progress;
    this.rebuild();
  }

  private rebuild() {
    const r = this.nav.route!;
    const start = Math.max(0, this.nav.progress - BEHIND);
    const end = Math.min(r.length, this.nav.progress + AHEAD);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const ray = new this.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    for (let d = start, i = 0; d <= end; d += STEP, i++) {
      const p = pointAt(r.pts, r.cum, d);
      const q = pointAt(r.pts, r.cum, d + 1);
      let dx = q[0] - p[0], dz = q[2] - p[2];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      // Height from the loaded world, so the ribbon follows the road between graph points.
      ray.origin = { x: p[0], y: p[1] + 25, z: p[2] };
      const hit = this.world.castRay(ray, 60, true, undefined, undefined, undefined, this.exclude);
      const y = (hit ? p[1] + 25 - hit.timeOfImpact : p[1]) + 0.06;
      const half = 0.7;
      pos.push(p[0] - dz * half, y, p[2] + dx * half, p[0] + dz * half, y, p[2] - dx * half);
      uv.push(0, d / 2.2, 1, d / 2.2);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = this.mesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
  }
}

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 9;
  g.lineCap = 'round';
  g.beginPath();
  // Points towards +v, the direction of travel.
  g.moveTo(10, 46);
  g.lineTo(32, 20);
  g.lineTo(54, 46);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
