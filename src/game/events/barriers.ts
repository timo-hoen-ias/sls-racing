import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { RoadGraph } from '../../world/roadGraph.ts';

// Race barriers (S6): while a race runs, red-and-white fences close the side streets at every junction on
// the route, so the course is clear to read. They exist only during the event, never in the tiles. Their
// colliders stop the player and the rivals but not the AI traffic, which drives on behind them.

type R = typeof RAPIER_NS;

/** One fence across a side street: centre, direction across, width (m). */
export interface Barrier {
  x: number;
  y: number;
  z: number;
  /** Unit direction along the fence. */
  ax: number;
  az: number;
  width: number;
}

/** Membership 0x0010, collides with cars (0x0001) only, not with traffic (0x0008) or debris. */
export const BARRIER_GROUPS = (0x0010 << 16) | 0x0001;
/** Panel length (m). */
const PANEL = 2.2;

/**
 * Side streets along a route (x, z pairs): at every junction within a few metres of the route, each road
 * that leaves it away from the route gets a fence a little way in.
 */
export function findBarriers(graph: RoadGraph, path: number[], opts: { near?: number; inset?: number } = {}): Barrier[] {
  const near = opts.near ?? 7, inset = opts.inset ?? 7;
  const CELL = 12;
  const grid = new Map<number, number[]>();
  const key = (x: number, z: number) => Math.floor(x / CELL) * 73856093 ^ Math.floor(z / CELL) * 19349663;
  // Densified route points in a hash grid.
  const pts: number[] = [];
  for (let i = 0; i + 3 < path.length; i += 2) {
    const ax = path[i], az = path[i + 1], bx = path[i + 2], bz = path[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3));
    for (let k = 0; k < n; k++) pts.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
  }
  for (let i = 0; i < pts.length; i += 2) {
    const k = key(pts[i], pts[i + 1]);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  }
  const dist = (x: number, z: number) => {
    let best = Infinity;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get((cx + dx) * 73856093 ^ (cz + dz) * 19349663) ?? []) best = Math.min(best, Math.hypot(pts[i] - x, pts[i + 1] - z));
    }
    return best;
  };
  const out: Barrier[] = [];
  const seen = new Set<number>();
  const nodes = graph.nodes;
  for (let n = 0; n < graph.adj.length; n++) {
    const adj = graph.adj[n];
    if (adj.length < 3) continue;
    const nx = nodes[n * 3], nz = nodes[n * 3 + 2];
    if (!grid.has(key(nx, nz)) && dist(nx, nz) > near) continue;
    if (dist(nx, nz) > near) continue;
    for (const [id] of adj) {
      if (seen.has(id)) continue;
      const e = graph.edges[id];
      if (e.noCars || e.rank < 1) continue;
      const fromA = e.a === n;
      const d = Math.min(inset + e.width / 2, e.length * 0.45);
      // Point d metres into the edge from this node, and the edge direction there.
      const p = pointOn(e.p, e.cum, fromA ? d : e.length - d);
      const q = pointOn(e.p, e.cum, fromA ? d + 1 : e.length - d - 1);
      if (dist(p[0], p[2]) < Math.max(near, e.width / 2 + 2)) continue;
      seen.add(id);
      const dx = q[0] - p[0], dz = q[2] - p[2], l = Math.hypot(dx, dz) || 1;
      out.push({ x: p[0], y: p[1], z: p[2], ax: -dz / l, az: dx / l, width: e.width + 1.5 });
    }
  }
  return out;
}

function pointOn(p: Float32Array, cum: Float32Array, d: number): [number, number, number] {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
  return [p[i * 3 - 3] + (p[i * 3] - p[i * 3 - 3]) * t, p[i * 3 - 2] + (p[i * 3 + 1] - p[i * 3 - 2]) * t, p[i * 3 - 1] + (p[i * 3 + 2] - p[i * 3 - 1]) * t];
}

function stripes() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#d0141c';
  for (let x = -32; x < 128; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class BarrierView {
  readonly root = new THREE.Group();
  enabled = true;
  /** Fences with colliders (off: only drawn). */
  solid = true;
  count = 0;
  private panels?: THREE.InstancedMesh;
  private feet?: THREE.InstancedMesh;
  private body?: RAPIER_NS.RigidBody;
  private R: R;
  private world: RAPIER_NS.World;

  constructor(R: R, world: RAPIER_NS.World) {
    this.R = R;
    this.world = world;
    this.root.name = 'race-barriers';
  }

  show(list: Barrier[]) {
    this.clear();
    if (!this.enabled || !list.length) return;
    let n = 0;
    for (const b of list) n += Math.max(1, Math.ceil(b.width / PANEL));
    const panelGeo = new THREE.BoxGeometry(PANEL - 0.1, 0.55, 0.06).translate(0, 0.75, 0);
    const footGeo = new THREE.BoxGeometry(PANEL, 0.12, 0.5).translate(0, 0.06, 0);
    const mat = typeof document === 'undefined' ? new THREE.MeshStandardMaterial({ color: 0xd0141c }) : new THREE.MeshStandardMaterial({ map: stripes(), roughness: 0.55 });
    const footMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.8 });
    this.panels = new THREE.InstancedMesh(panelGeo, mat, n);
    this.feet = new THREE.InstancedMesh(footGeo, footMat, n);
    this.panels.castShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    if (this.solid) this.body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    let i = 0;
    for (const b of list) {
      const k = Math.max(1, Math.ceil(b.width / PANEL));
      const yaw = Math.atan2(-b.az, b.ax);
      q.setFromAxisAngle(up, yaw);
      for (let j = 0; j < k; j++) {
        const off = (j - (k - 1) / 2) * PANEL;
        m.compose(new THREE.Vector3(b.x + b.ax * off, b.y, b.z + b.az * off), q, s);
        this.panels.setMatrixAt(i, m);
        this.feet.setMatrixAt(i, m);
        i++;
      }
      if (this.body) {
        const c = this.R.ColliderDesc.cuboid((k * PANEL) / 2, 0.6, 0.25)
          .setTranslation(b.x, b.y + 0.6, b.z)
          .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
          .setCollisionGroups(BARRIER_GROUPS)
          .setFriction(0.2);
        this.world.createCollider(c, this.body);
      }
    }
    this.root.add(this.panels, this.feet);
    this.count = list.length;
  }

  clear() {
    for (const o of [this.panels, this.feet]) {
      if (!o) continue;
      this.root.remove(o);
      o.geometry.dispose();
      (o.material as THREE.MeshStandardMaterial).map?.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.panels = this.feet = undefined;
    if (this.body) { this.world.removeRigidBody(this.body); this.body = undefined; }
    this.count = 0;
  }
}
