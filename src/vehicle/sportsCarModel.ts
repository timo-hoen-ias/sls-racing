import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAR } from './tuning.ts';

// Procedural sports coupé (no real make): lofted body with flared wheel arches, a glass
// greenhouse with a painted roof, rear wing, light bars, splitter, diffuser and twin tailpipes.
// Model space: ground at y = 0, +z forward, +x left. CarView shifts it onto the physics origin.

/** One cross-section of a loft. */
interface Station {
  z: number;
  /** Half width at the widest point. */
  w: number;
  bottom: number;
  top: number;
  /** Lowers the centre of the top (hood/engine cover between raised fenders). */
  dip: number;
  /** Superellipse exponent: 2 = round, higher = boxier. */
  n: number;
  /** Narrows the upper half (tumblehome). */
  tumble: number;
}

const S = (z: number, w: number, bottom: number, top: number, dip: number, n: number, tumble = 0.12): Station => ({ z, w, bottom, top, dip, n, tumble });

/** Lower body, rear to front. */
const BODY: Station[] = [
  S(-2.31, 0.42, 0.36, 0.64, 0.0, 2.4),
  S(-2.27, 0.66, 0.3, 0.72, 0.0, 2.8),
  S(-2.2, 0.86, 0.24, 0.8, 0.02, 3.2),
  S(-2.0, 0.93, 0.2, 0.86, 0.03, 3.6),
  S(-1.6, 0.955, 0.17, 0.87, 0.04, 3.8),
  S(-1.2, 0.96, 0.17, 0.87, 0.05, 3.8),
  S(-0.7, 0.94, 0.16, 0.84, 0.05, 3.6),
  S(0.0, 0.91, 0.16, 0.8, 0.06, 3.4),
  S(0.6, 0.92, 0.16, 0.79, 0.1, 3.4),
  S(1.27, 0.95, 0.17, 0.8, 0.13, 3.6),
  S(1.75, 0.93, 0.18, 0.74, 0.12, 3.4),
  S(2.05, 0.86, 0.2, 0.62, 0.08, 3.0),
  S(2.22, 0.72, 0.23, 0.5, 0.04, 2.6),
  S(2.29, 0.5, 0.27, 0.42, 0.0, 2.2),
];

/** Greenhouse: steep-ish windscreen, long roof, fastback rear window. */
const CABIN: Station[] = [
  S(-1.98, 0.5, 0.66, 0.82, 0, 2.6, 0.3),
  S(-1.65, 0.6, 0.66, 0.9, 0, 2.6, 0.3),
  S(-1.15, 0.7, 0.66, 1.05, 0, 2.6, 0.32),
  S(-0.65, 0.76, 0.66, 1.21, 0, 2.6, 0.34),
  S(-0.15, 0.78, 0.66, 1.23, 0, 2.6, 0.34),
  S(0.3, 0.79, 0.66, 1.08, 0, 2.6, 0.32),
  S(0.78, 0.78, 0.66, 0.74, 0, 2.6, 0.3),
];

const WHEEL_ARCH = { r: CAR.wheel.radius + 0.07, cy: CAR.wheel.radius + 0.03 };

/** Fritsch–Carlson monotone cubic: smooth without overshoot. */
function monotone(xs: number[], ys: number[]) {
  const n = xs.length;
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 / (1 / d[i - 1] + 1 / d[i]);
  return (x: number) => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = Math.min(1, Math.max(0, (x - xs[i]) / h));
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const spow = (v: number, p: number) => Math.sign(v) * Math.abs(v) ** p;

interface LoftOpts {
  rings: number;
  around: number;
  /** Section angle range (radians, −π/2 = bottom centre, π/2 = top centre). */
  from?: number;
  to?: number;
  /** Raises the bottom over the wheels. */
  arches?: boolean;
  /** Pushes the surface out (m) for overlays. */
  inflate?: number;
  zFrom?: number;
  zTo?: number;
  caps?: boolean;
}

function loft(st: Station[], o: LoftOpts) {
  const zs = st.map((s) => s.z);
  const f = (k: keyof Station) => monotone(zs, st.map((s) => s[k]));
  const W = f('w'), B = f('bottom'), T = f('top'), D = f('dip'), N = f('n'), TU = f('tumble');
  const z0 = o.zFrom ?? zs[0];
  const z1 = o.zTo ?? zs[zs.length - 1];
  const a0 = o.from ?? -Math.PI / 2;
  const a1 = o.to ?? Math.PI / 2;
  const inflate = o.inflate ?? 0;
  const half = o.around;
  const ring = half * 2 + 1; // right side, left side, sharing the centre line
  const pos: number[] = [];
  for (let r = 0; r <= o.rings; r++) {
    // Denser rings near the ends for round noses.
    const u = r / o.rings;
    const z = z0 + (z1 - z0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    const w = W(z) + inflate;
    let bottom = B(z);
    const top = T(z) + inflate;
    if (o.arches) {
      for (const wz of [CAR.wheel.front, CAR.wheel.rear]) {
        const dz = z - wz;
        if (Math.abs(dz) < WHEEL_ARCH.r) bottom = Math.max(bottom, WHEEL_ARCH.cy + Math.sqrt(WHEEL_ARCH.r ** 2 - dz * dz));
      }
      bottom = Math.min(bottom, top - 0.06);
    }
    const mid = (top + bottom) / 2;
    const hh = (top - bottom) / 2;
    const n = N(z), dip = D(z), tumble = TU(z);
    for (let k = 0; k < ring; k++) {
      // k = 0..half: right side (−x) from a0 to a1; then mirrored on the left.
      const side = k <= half ? -1 : 1;
      const j = k <= half ? k : ring - 1 - k;
      const a = a0 + ((a1 - a0) * j) / half;
      const c = Math.cos(a), s = Math.sin(a);
      let x = w * spow(c, 2 / n);
      let y = mid + hh * spow(s, 2 / n);
      if (s > 0) {
        x *= 1 - tumble * s * s;
        y -= dip * (1 - (x / w) ** 2) * s * s;
      }
      pos.push(side * x, y, z);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < o.rings; r++) {
    for (let k = 0; k < ring - 1; k++) {
      const a = r * ring + k, b = a + 1, c = a + ring, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (!o.caps) return geo;
  // End caps as separate fans, so the body's side normals stay crisp at the ends.
  const parts = [geo];
  for (const [r, flip] of [[0, true], [o.rings, false]] as const) {
    const base = r * ring;
    const cap: number[] = [];
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < ring; k++) { cx += pos[(base + k) * 3]; cy += pos[(base + k) * 3 + 1]; cz += pos[(base + k) * 3 + 2]; }
    cap.push(cx / ring, cy / ring, cz / ring);
    for (let k = 0; k < ring; k++) cap.push(pos[(base + k) * 3], pos[(base + k) * 3 + 1], pos[(base + k) * 3 + 2]);
    const ci: number[] = [];
    for (let k = 1; k <= ring; k++) {
      const a = k, b = (k % ring) + 1;
      if (flip) ci.push(0, a, b); else ci.push(0, b, a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cap, 3));
    g.setIndex(ci);
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

export interface CarMaterials {
  paint: THREE.MeshPhysicalMaterial;
  brake: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
}

export interface SportsCarModel {
  body: THREE.Group;
  materials: CarMaterials;
  /** Tailpipe ends and headlight positions (model space). */
  exhausts: THREE.Vector3[];
  headlights: THREE.Vector3[];
  makeWheel(side: 1 | -1): { pivot: THREE.Group; spin: THREE.Group };
  /** Dimensions the GLB states in the extras of its "car" node (newer car models); the physics follows them. */
  geometry?: CarGeometry;
}

/** Wheel positions (z, + = forward), track (centre to centre), wheel radius and width, body length and width (m). */
export interface CarGeometry {
  name?: string;
  wheel: { front: number; rear: number; track: number; radius: number; width: number };
  length: number;
  width: number;
}

export function buildSportsCar(color = '#c0141c'): SportsCarModel {
  const body = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.5 });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#0a0e13', metalness: 0.3, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.8 });
  const black = new THREE.MeshStandardMaterial({ color: '#0d0e10', roughness: 0.55, metalness: 0.2 });
  const carbon = new THREE.MeshPhysicalMaterial({ color: '#16181b', roughness: 0.35, metalness: 0.4, clearcoat: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#d9dde2', metalness: 1, roughness: 0.18 });
  const head = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#f4f8ff', emissiveIntensity: 2.4 });
  const brake = new THREE.MeshStandardMaterial({ color: '#4a0000', emissive: '#ff1010', emissiveIntensity: 0.7 });
  const add = (g: THREE.BufferGeometry, m: THREE.Material, cast = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = cast;
    body.add(mesh);
    return mesh;
  };

  // Body, greenhouse, painted roof.
  // Panels that take dents (CarDamage deforms them in model space).
  add(loft(BODY, { rings: 180, around: 28, arches: true, caps: true }), paint).userData.dent = true;
  // Cabin in paint, glass laid over it: windscreen, side windows, fastback rear window.
  add(loft(CABIN, { rings: 60, around: 22, caps: true }), paint).userData.dent = true;
  const glassOver = (from: number, to: number, zFrom: number, zTo: number, rings = 30) =>
    (add(loft(CABIN, { rings, around: 12, from, to, inflate: 0.004, zFrom, zTo }), glass, false).userData.dent = true);
  glassOver(0.42, Math.PI / 2, 0.3, 0.74);
  glassOver(0.42, Math.PI / 2, -1.9, -0.95);
  for (const s of [-1, 1]) {
    // Side windows: one side of the section only.
    const g = loft(CABIN, { rings: 30, around: 12, from: 0.06, to: 1.02, inflate: 0.004, zFrom: -0.92, zTo: 0.24 }).toNonIndexed();
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const keep: number[] = [];
    for (let i = 0; i < p.count; i += 3) if ([0, 1, 2].every((k) => Math.sign(p.getX(i + k)) === s)) keep.push(i, i + 1, i + 2);
    const side = new THREE.BufferGeometry();
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    side.setAttribute('position', new THREE.Float32BufferAttribute(keep.flatMap((i) => [p.getX(i), p.getY(i), p.getZ(i)]), 3));
    side.setAttribute('normal', new THREE.Float32BufferAttribute(keep.flatMap((i) => [nrm.getX(i), nrm.getY(i), nrm.getZ(i)]), 3));
    add(side, glass, false).userData.dent = true;
  }

  // Underbody fills the space between the wheels; wheel-well liners hide the inside.
  const floor = add(new THREE.BoxGeometry(1.28, 0.16, 4.2), black, false);
  floor.position.set(0, 0.2, 0);
  for (const wz of [CAR.wheel.front, CAR.wheel.rear]) {
    const well = new THREE.CylinderGeometry(WHEEL_ARCH.r, WHEEL_ARCH.r, 1.78, 24, 1, true, Math.PI * 0.5, Math.PI);
    well.rotateZ(Math.PI / 2);
    const m = add(well, new THREE.MeshStandardMaterial({ color: '#08090a', roughness: 0.9, side: THREE.BackSide }), false);
    m.position.set(0, WHEEL_ARCH.cy, wz);
  }

  // Front: splitter, intakes, headlights with daytime-running strips.
  const splitter = add(new THREE.BoxGeometry(1.56, 0.025, 0.26), carbon);
  splitter.position.set(0, 0.17, 2.06);
  // Parts that can break off (CarDamage).
  splitter.userData.part = 'splitter';
  const intake = add(new THREE.BoxGeometry(1.1, 0.12, 0.1), black, false);
  intake.position.set(0, 0.29, 2.2);
  const headlights: THREE.Vector3[] = [];
  for (const s of [-1, 1]) {
    const side = add(new THREE.BoxGeometry(0.26, 0.14, 0.1), black, false);
    side.position.set(s * 0.6, 0.3, 2.12);
    side.rotation.y = -s * 0.35;
    const lens = add(new THREE.SphereGeometry(1, 20, 10), glass, false);
    lens.scale.set(0.19, 0.035, 0.15);
    lens.position.set(s * 0.64, 0.6, 1.96);
    lens.rotation.set(-0.35, -s * 0.5, 0);
    const lamp = add(new THREE.SphereGeometry(1, 12, 8), head, false);
    lamp.scale.set(0.06, 0.025, 0.04);
    lamp.position.set(s * 0.6, 0.6, 2.02);
    const drl = add(new THREE.BoxGeometry(0.22, 0.012, 0.02), head, false);
    drl.position.set(s * 0.68, 0.57, 2.0);
    drl.rotation.set(-0.35, -s * 0.55, s * 0.1);
    headlights.push(new THREE.Vector3(s * 0.6, 0.6, 2.1));
  }

  // Rear: full-width light bar, lamp clusters, diffuser, twin centre tailpipes, wing.
  const bar = add(new THREE.BoxGeometry(1.5, 0.035, 0.03), brake, false);
  bar.position.set(0, 0.79, -2.2);
  for (const s of [-1, 1]) {
    const cl = add(new THREE.BoxGeometry(0.3, 0.07, 0.04), brake, false);
    cl.position.set(s * 0.68, 0.76, -2.17);
    cl.rotation.y = s * 0.3;
  }
  const plate = add(new THREE.BoxGeometry(0.52, 0.12, 0.02), new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.5 }), false);
  plate.position.set(0, 0.5, -2.315);
  plate.userData.part = 'plate';
  const diff = add(new THREE.BoxGeometry(1.36, 0.14, 0.3), carbon, false);
  diff.position.set(0, 0.25, -2.12);
  for (let i = -2; i <= 2; i++) {
    const fin = add(new THREE.BoxGeometry(0.015, 0.1, 0.32), carbon, false);
    fin.position.set(i * 0.26, 0.21, -2.16);
  }
  const exhausts: THREE.Vector3[] = [];
  for (const s of [-1, 1]) {
    const tip = add(new THREE.CylinderGeometry(0.055, 0.05, 0.16, 18, 1, true), chrome, false);
    tip.rotation.x = Math.PI / 2;
    tip.position.set(s * 0.11, 0.3, -2.24);
    const inner = add(new THREE.CircleGeometry(0.05, 18), black, false);
    inner.position.set(s * 0.11, 0.3, -2.2);
    inner.rotation.y = Math.PI;
    exhausts.push(new THREE.Vector3(s * 0.11, 0.3, -2.33));
  }
  const wing = add(new THREE.BoxGeometry(1.62, 0.025, 0.3), carbon);
  wing.position.set(0, 1.07, -1.98);
  wing.rotation.x = -0.12;
  wing.userData.part = 'wing';
  for (const s of [-1, 1]) {
    const plate = add(new THREE.BoxGeometry(0.02, 0.14, 0.34), carbon);
    plate.position.set(s * 0.81, 1.04, -1.98);
    plate.userData.part = 'wing';
    const strut = add(new THREE.BoxGeometry(0.03, 0.22, 0.1), carbon);
    strut.position.set(s * 0.42, 0.95, -1.96);
  }

  // Mirrors and side intakes.
  for (const s of [-1, 1]) {
    const stalk = add(new THREE.BoxGeometry(0.12, 0.025, 0.05), black, false);
    stalk.position.set(s * 0.84, 0.86, 0.5);
    stalk.userData.part = s > 0 ? 'mirrorL' : 'mirrorR';
    const cap = add(new THREE.SphereGeometry(1, 14, 8), paint);
    cap.scale.set(0.09, 0.055, 0.11);
    cap.position.set(s * 0.92, 0.88, 0.48);
    cap.userData.part = s > 0 ? 'mirrorL' : 'mirrorR';
    const side = add(new THREE.BoxGeometry(0.02, 0.09, 0.36), black, false);
    side.position.set(s * 0.93, 0.56, -0.66);
    side.rotation.z = s * 0.1;
  }

  // Wheels: 20" multi-spoke rims, cross-drilled discs, coloured calipers.
  const r = CAR.wheel.radius;
  const tw = CAR.wheel.width;
  const rimR = r * 0.7;
  const tyreProfile = [
    [rimR, -tw * 0.47], [r * 0.86, -tw * 0.5], [r * 0.96, -tw * 0.47], [r, -tw * 0.36],
    [r, tw * 0.36], [r * 0.96, tw * 0.47], [r * 0.86, tw * 0.5], [rimR, tw * 0.47],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const tyreGeo = new THREE.LatheGeometry(tyreProfile, 48).rotateZ(Math.PI / 2);
  const tyreMat = new THREE.MeshStandardMaterial({ color: '#161616', roughness: 0.92 });
  const rimMat = new THREE.MeshStandardMaterial({ color: '#2c2f33', metalness: 0.9, roughness: 0.28 });
  const rimLipMat = new THREE.MeshStandardMaterial({ color: '#b8bcc2', metalness: 1, roughness: 0.2 });
  const discMat = new THREE.MeshStandardMaterial({ color: '#5d5f62', metalness: 0.8, roughness: 0.45 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: '#f0c419', roughness: 0.4, metalness: 0.2 });
  const barrel = new THREE.CylinderGeometry(rimR, rimR, tw * 0.9, 32, 1, true).rotateZ(Math.PI / 2);
  const lip = new THREE.TorusGeometry(rimR - 0.008, 0.01, 8, 40).rotateY(Math.PI / 2);
  const spoke = new THREE.BoxGeometry(0.03, rimR - 0.05, 0.035);
  spoke.translate(0, (rimR - 0.05) / 2 + 0.045, 0);
  const hub = new THREE.CylinderGeometry(0.06, 0.07, 0.05, 16).rotateZ(Math.PI / 2);
  const disc = new THREE.CylinderGeometry(rimR * 0.85, rimR * 0.85, 0.032, 32).rotateZ(Math.PI / 2);
  const caliper = new THREE.BoxGeometry(0.07, 0.15, 0.1);

  const makeWheel = (side: 1 | -1) => {
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    pivot.add(spin);
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.castShadow = true;
    spin.add(tyre, new THREE.Mesh(barrel, rimMat));
    const face = side * tw * 0.36;
    const l = new THREE.Mesh(lip, rimLipMat);
    l.position.x = face;
    const h = new THREE.Mesh(hub, rimLipMat);
    h.position.x = face;
    spin.add(l, h);
    for (let k = 0; k < 5; k++) {
      for (const off of [-0.11, 0.11]) {
        const sp = new THREE.Mesh(spoke, rimMat);
        sp.position.x = face - side * 0.01;
        sp.rotation.x = (k / 5) * Math.PI * 2 + off;
        sp.rotation.y = side * 0.12;
        spin.add(sp);
      }
    }
    const d = new THREE.Mesh(disc, discMat);
    d.position.x = face - side * 0.075;
    spin.add(d);
    // Caliper stays put while the wheel turns (it steers with the pivot).
    const c = new THREE.Mesh(caliper, caliperMat);
    c.position.set(face - side * 0.045, rimR * 0.62, -rimR * 0.35);
    c.rotation.x = 0.5;
    pivot.add(c);
    return { pivot, spin };
  };

  return { body, materials: { paint, brake, head }, exhausts, headlights, makeWheel };
}
