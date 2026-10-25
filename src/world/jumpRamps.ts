import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import { type Edge, type RoadGraph, pointAt } from './roadGraph.ts';

// Jump ramps (W3): a few steel kickers on long, straight and level side streets, so the landing is on the
// same road. They are placed from the road graph alone (the same on every machine), each one gets a jump
// event, and the AI traffic leaves those streets out so nobody drives into a ramp.

type R = typeof RAPIER_NS;

export interface JumpRamp {
  x: number;
  y: number;
  z: number;
  /** Driving direction: forward is (sin h, -cos h), as for event gates. */
  heading: number;
  length: number;
  height: number;
  width: number;
  name: string;
  edge: number;
  /** Where fast travel puts the car: far enough back on the same street to build up speed. */
  runup: { x: number; y: number; z: number };
}

export const RAMP = { length: 14, height: 1.6, width: 4.2 };
/** Straight and level road needed before (approach) and after (landing) the ramp centre (m). */
const RUN_UP = 60;
const LANDING = 85;
/** Wanted run-up on the same street (m): about 130 km/h at the lip. */
const SPEED_RUN = 170;
/** Shortest run-up on the street (m): about 100 km/h at the lip. */
const MIN_RUN = 110;
const STEP = 10;

const hash = (n: number) => {
  let h = Math.imul(n + 1, 2654435761);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

/** The best spot on an edge: centre distance along it, or undefined when no part is straight and level enough. */
function spotOn(e: Edge): number | undefined {
  let best: number | undefined, bestScore = Infinity;
  for (let s = RUN_UP; s <= e.length - LANDING; s += STEP) {
    const a = pointAt(e.p, e.cum, s - RUN_UP), b = pointAt(e.p, e.cum, s + LANDING);
    const dx = b[0] - a[0], dz = b[2] - a[2], len = Math.hypot(dx, dz);
    if (len < (RUN_UP + LANDING) * 0.98) continue;
    // Bounds: sideways off the chord, and height off a straight grade.
    let off = 0, bump = 0;
    for (let t = s - RUN_UP; t <= s + LANDING; t += 5) {
      const p = pointAt(e.p, e.cum, t);
      const u = (t - (s - RUN_UP)) / (RUN_UP + LANDING);
      off = Math.max(off, Math.abs(((p[0] - a[0]) * dz - (p[2] - a[2]) * dx) / len));
      bump = Math.max(bump, Math.abs(p[1] - (a[1] + (b[1] - a[1]) * u)));
    }
    const grade = Math.abs(b[1] - a[1]) / len;
    if (off > 1.2 || bump > 0.35 || grade > 0.04) continue;
    // Prefer the middle of the straight and flat ground.
    const score = off + bump * 3 + grade * 20 + Math.max(0, SPEED_RUN - s) / 60;
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

/** Up to max ramps on residential streets, at least spacing apart. */
export function placeJumpRamps(graph: RoadGraph, opts: { max?: number; spacing?: number } = {}): JumpRamp[] {
  const max = opts.max ?? 10, spacing = opts.spacing ?? 600;
  const edges = graph.edges.filter((e) => !e.noCars && e.rank === 3 && e.width >= 5 && e.length >= RUN_UP + LANDING + 10);
  edges.sort((a, b) => hash(a.id) - hash(b.id));
  const out: JumpRamp[] = [];
  const names = new Set<string>();
  for (const e of edges) {
    if (out.length >= max) break;
    const s = spotOn(e);
    if (s === undefined || s < MIN_RUN) continue;
    const [x, y, z] = pointAt(e.p, e.cum, s);
    if (out.some((r) => Math.hypot(r.x - x, r.z - z) < spacing)) continue;
    // One ramp per street name, so the event names stay apart.
    const name = e.name.split(';')[0] || 'Feldweg';
    if (names.has(name)) continue;
    names.add(name);
    const a = pointAt(e.p, e.cum, s - 5), b = pointAt(e.p, e.cum, s + 5);
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const ru = pointAt(e.p, e.cum, Math.max(5, s - SPEED_RUN));
    out.push({ x, y, z, heading: Math.atan2(dx, -dz), length: RAMP.length, height: RAMP.height, width: Math.min(RAMP.width, e.width - 1), name, edge: e.id,
      runup: { x: ru[0], y: ru[1], z: ru[2] } });
  }
  return out;
}

/** Ramp height at u = 0..1 along it: flat entry, steepening to the lip. */
export const rampProfile = (u: number) => u * u;

/** Ramp body in its own frame (x across, y up, z forward from the foot at z = 0 to the lip at z = length). */
export function rampGeometry(r: Pick<JumpRamp, 'length' | 'height' | 'width'>, steps = 16) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const hw = r.width / 2, sink = 0.05;
  const y = (u: number) => rampProfile(u) * r.height - sink;
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d);
  // Top deck.
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    pos.push(-hw, y(u), u * r.length, hw, y(u), u * r.length);
    uv.push(0, u * r.length / 2, 1, u * r.length / 2);
  }
  for (let i = 0; i < steps; i++) quad(i * 2, i * 2 + 2, i * 2 + 3, i * 2 + 1);
  // Sides down to the road.
  for (const side of [-1, 1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      pos.push(side * hw, y(u), u * r.length, side * hw, -sink, u * r.length);
      uv.push(u, 1, u, 0);
    }
    for (let i = 0; i < steps; i++) {
      const a = base + i * 2;
      if (side > 0) quad(a, a + 2, a + 3, a + 1); else quad(a, a + 1, a + 3, a + 2);
    }
  }
  // Back wall under the lip.
  const base = pos.length / 3;
  pos.push(-hw, y(1), r.length, hw, y(1), r.length, hw, -sink, r.length, -hw, -sink, r.length);
  uv.push(0, 1, 1, 1, 1, 0, 0, 0);
  quad(base, base + 3, base + 2, base + 1);
  return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}

function stripes() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2c200';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#151515';
  for (let x = -64; x < 256; x += 32) {
    g.beginPath(); g.moveTo(x, 64); g.lineTo(x + 16, 64); g.lineTo(x + 80, 0); g.lineTo(x + 64, 0); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function deck() {
  // Diamond steel plate.
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6d7175';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#8b9095';
  for (let y = 0; y < 128; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < 128; x += 16) g.fillRect(x + 2, y + 6, 10, 3);
  g.fillStyle = '#f2c200';
  g.fillRect(0, 0, 8, 128);
  g.fillRect(120, 0, 8, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export class JumpRampView {
  readonly root = new THREE.Group();
  ramps: JumpRamp[] = [];
  private bodies: RAPIER_NS.RigidBody[] = [];
  private R: R;
  private world: RAPIER_NS.World;

  constructor(R: R, world: RAPIER_NS.World) {
    this.R = R;
    this.world = world;
    this.root.name = 'jump-ramps';
  }

  set(ramps: JumpRamp[]) {
    for (const b of this.bodies) this.world.removeRigidBody(b);
    this.bodies = [];
    this.root.clear();
    this.ramps = ramps;
    if (!ramps.length || typeof document === 'undefined') return;
    const top = new THREE.MeshStandardMaterial({ map: deck(), metalness: 0.6, roughness: 0.55 });
    const side = new THREE.MeshStandardMaterial({ map: stripes(), metalness: 0.2, roughness: 0.6 });
    for (const r of ramps) {
      const g = rampGeometry(r);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
      geo.setIndex(new THREE.BufferAttribute(g.idx, 1));
      // Deck triangles first, then the sides and the back wall.
      const deckTris = 16 * 6;
      geo.addGroup(0, deckTris, 0);
      geo.addGroup(deckTris, g.idx.length - deckTris, 1);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, [top, side]);
      mesh.castShadow = mesh.receiveShadow = true;
      // Foot at the centre minus half the length, facing the heading.
      const fx = Math.sin(r.heading), fz = -Math.cos(r.heading);
      const foot = new THREE.Vector3(r.x - fx * r.length / 2, r.y, r.z - fz * r.length / 2);
      mesh.position.copy(foot);
      // Local +z must point along (fx, fz): rotate about y by atan2(fx, fz).
      const yaw = Math.atan2(fx, fz);
      mesh.rotation.y = yaw;
      this.root.add(mesh);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(foot.x, foot.y, foot.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
      this.world.createCollider(this.R.ColliderDesc.trimesh(g.pos, g.idx).setFriction(1.1), body);
      this.bodies.push(body);
    }
  }
}

export function registerJumpCommands(view: JumpRampView, pos: () => { x: number; z: number }, teleport: (x: number, z: number, heading: number) => void) {
  const byDistance = () => {
    const p = pos();
    return view.ramps.map((r) => ({ r, d: Math.hypot(r.x - p.x, r.z - p.z) })).sort((a, b) => a.d - b.d);
  };
  registerCommand({
    name: 'jump.list', help: 'Sprungschanzen nach Entfernung (Straße, Entfernung)',
    run: () => byDistance().map(({ r, d }, i) => `${i}: ${r.name} · ${d.toFixed(0)} m`).join('\n') || 'keine Schanzen (keine passende gerade Straße)',
  });
  registerCommand({
    name: 'jump.tp', help: 'Zum Anlauf einer Schanze (Nummer aus jump.list, ohne: die nächste; nah: 25 m davor)', args: '[nr] [nah]',
    complete: (a) => (a.length === 2 ? ['nah'] : []),
    run: ([n, near]) => {
      const hit = byDistance()[Number(n ?? 0)];
      if (!hit) throw new Error('keine Schanze mit dieser Nummer');
      const { r } = hit;
      const h = Math.atan2(r.x - r.runup.x, -(r.z - r.runup.z));
      if (near === 'nah') {
        const back = r.length / 2 + 25;
        teleport(r.x - Math.sin(r.heading) * back, r.z + Math.cos(r.heading) * back, r.heading);
        return `25 m vor ${r.name}`;
      }
      teleport(r.runup.x, r.runup.z, h);
      return `Anlauf ${r.name}: ${Math.hypot(r.x - r.runup.x, r.z - r.runup.z).toFixed(0)} m bis zur Schanze`;
    },
  });
  const placed = view.ramps;
  registerToggle('jump.ramps', 'Sprungschanzen in der Welt (aus: weggeräumt, die Events bleiben in der Liste)', () => view.ramps.length > 0, (v) => view.set(v ? placed : []));
}
