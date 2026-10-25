import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BARKS, FOLIAGE_GRID, LEAF_CARDS, type SpeciesShape } from './treeSpecies.ts';

// Tree generator: grows a species (treeSpecies.ts) into a trunk and branches of tapered tubes with bark
// (bark.webp) and leaf cluster cards (leaves.webp) at the twigs. Two levels of detail from the same skeleton:
// lod 0 with every branch and card, lod 1 with the main branches and fewer, larger cards.
// Geometry groups: 0 wood, 1 leaves. Attributes: position, normal, uv, color (ambient occlusion), wind (0 at the
// base, 1 at the top; how far a vertex sways), leaf (the crown radius on leaf cards, 0 on bark: the shadow pass
// draws both groups with one material, and leaves look up their shadow from the crown's sunny side). Trunk base at
// the origin, +Y up.

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export interface TreeGeometry {
  lods: THREE.BufferGeometry[];
  /** Height of the built model (top leaf, m) and the crown radius it was grown with. */
  height: number;
  crown: number;
  /** Half width and height (m) the impostor frames cover. */
  boxR: number;
  boxH: number;
}

interface Limb { pts: V3[]; r0: number; r1: number; level: number }
interface Card { p: V3; up: V3; n: V3; size: number; lod1: boolean; shell?: boolean }

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** Distance along dir from p to the far side of the crown ellipsoid (centre c, radii R horizontal, Rv vertical). */
function toShell(p: V3, dir: V3, c: V3, R: number, Rv: number) {
  const ox = (p.x - c.x) / R, oy = (p.y - c.y) / Rv, oz = (p.z - c.z) / R;
  const dx = dir.x / R, dy = dir.y / Rv, dz = dir.z / R;
  const a = dx * dx + dy * dy + dz * dz, b = 2 * (ox * dx + oy * dy + oz * dz), cc = ox * ox + oy * oy + oz * oz - 1;
  const disc = b * b - 4 * a * cc;
  // Missing the crown (a branch below it pointing past): half the crown radius.
  if (disc < 0) return R * 0.5;
  return Math.max(R * 0.25, (-b + Math.sqrt(disc)) / (2 * a));
}

/** Any unit vector perpendicular to d. */
function perp(d: V3) {
  const a = Math.abs(d.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  return a.cross(d).normalize();
}

/** Grows the skeleton of one tree: limbs (trunk level 0, branches 1, twigs 2) and leaf cards. */
function grow(sp: SpeciesShape, seed: number) {
  const r = rng(seed);
  const H = sp.height, R = sp.crown;
  const limbs: Limb[] = [];
  const cards: Card[] = [];
  const g = sp.gnarl;
  // Crown ellipsoid.
  const Rv = Math.min(R * sp.crownAspect, H * (1 - sp.bole) * 0.55 + R * 0.2);
  const c = v3(0, H - Rv, 0);

  /** A bent limb from p along dir for len, n segments; returns its points. */
  const limb = (p: V3, dir: V3, len: number, n: number, bendUp: number, gn: number) => {
    const pts = [p.clone()];
    const d = dir.clone().normalize();
    const step = len / n;
    let q = p.clone();
    for (let i = 0; i < n; i++) {
      d.x += (r() - 0.5) * gn * 0.8;
      d.z += (r() - 0.5) * gn * 0.8;
      d.y += (r() - 0.5) * gn * 0.4 + bendUp;
      d.normalize();
      q = q.clone().addScaledVector(d, step);
      pts.push(q);
    }
    return pts;
  };
  const along = (pts: V3[], t: number) => {
    const f = t * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f));
    return pts[i].clone().lerp(pts[i + 1], f - i);
  };
  const dirAt = (pts: V3[], t: number) => {
    const i = Math.min(pts.length - 2, Math.floor(t * (pts.length - 1)));
    return pts[i + 1].clone().sub(pts[i]).normalize();
  };
  /** Leaf cards along a twig from t0 to its tip. */
  const leaves = (pts: V3[], t0: number, count: number, sizeK = 1) => {
    for (let k = 0; k < count; k++) {
      const t = t0 + (1 - t0) * ((k + r() * 0.8) / count);
      const p = along(pts, Math.min(1, t));
      const out = p.clone().sub(c);
      out.y *= R / Rv;
      out.normalize();
      const td = dirAt(pts, Math.min(0.999, t));
      const up = td.clone().multiplyScalar(0.55).addScaledVector(out, 0.6);
      if (sp.form === 'cone') up.y = Math.max(up.y, -0.2);
      up.x += (r() - 0.5) * 0.6; up.y += (r() - 0.5) * 0.4 + 0.15; up.z += (r() - 0.5) * 0.6;
      up.normalize();
      // Card faces outwards (and for conifers mostly up, like the sprigs on a bough).
      let n = out.clone().addScaledVector(up, -out.dot(up));
      if (sp.form === 'cone') n = v3(0, 1, 0).addScaledVector(up, -up.y).normalize().lerp(n, 0.35);
      if (n.lengthSq() < 1e-4) n = perp(up);
      n.normalize();
      const roll = (r() - 0.5) * 1.4;
      n.applyAxisAngle(up, roll);
      cards.push({ p, up, n, size: sp.card * sizeK * (0.8 + r() * 0.4), lod1: false });
    }
  };

  if (sp.form === 'bush') {
    // Several stems from the ground spreading into a dome.
    for (let i = 0; i < sp.branches; i++) {
      const az = i * 2.39996 + r() * 0.5;
      const lean = 0.25 + r() * 0.55;
      const dir = v3(Math.cos(az) * lean, 1, Math.sin(az) * lean).normalize();
      const p = v3(Math.cos(az) * 0.08, 0, Math.sin(az) * 0.08);
      const len = toShell(p, dir, c, R, Rv) * (0.85 + r() * 0.15);
      const pts = limb(p, dir, len, 3, 0, g * 0.5);
      limbs.push({ pts, r0: sp.trunk, r1: sp.trunk * 0.3, level: 1 });
      leaves(pts, 0.25, Math.round(len * sp.density));
      for (let s = 0; s < sp.subs; s++) {
        const q = along(pts, 0.35 + r() * 0.45);
        const sd = perp(dir).applyAxisAngle(dir, r() * 6.28).multiplyScalar(0.9).add(dir).normalize();
        const sl = toShell(q, sd, c, R, Rv) * 0.9;
        const sub = limb(q, sd, sl, 2, 0.05, g);
        limbs.push({ pts: sub, r0: sp.trunk * 0.5, r1: sp.trunk * 0.2, level: 2 });
        leaves(sub, 0.2, Math.max(1, Math.round(sl * sp.density)));
      }
    }
  } else {
    // Trunk: up to the top for conifers and poplars, into the crown for broadleaves.
    const leader = sp.form === 'cone' || sp.form === 'column' ? 0.97 : Math.min(0.75, (c.y - Rv * 0.1) / H) + r() * 0.05;
    const trunk = limb(v3(), v3(0, 1, 0), H * leader, sp.form === 'cone' || sp.form === 'column' ? 8 : 6, 0.02, g * 0.12);
    limbs.push({ pts: trunk, r0: sp.trunk, r1: sp.trunk * (sp.form === 'cone' || sp.form === 'column' ? 0.12 : 0.45), level: 0 });
    const y0 = H * sp.bole, y1 = H * leader;
    for (let i = 0; i < sp.branches; i++) {
      const f = sp.branches > 1 ? i / (sp.branches - 1) : 0;
      // Conifers: whorls evenly up the trunk. Others: clustered in the upper trunk.
      const t = (sp.form === 'cone' || sp.form === 'column' ? f * 0.95 : 0.25 + 0.75 * f ** 0.8);
      const p = along(trunk, Math.min(0.999, (y0 + (y1 - y0) * t) / (H * leader)));
      const az = i * 2.39996 + (r() - 0.5) * 0.7;
      let rise = sp.rise + (r() - 0.5) * 0.3;
      if (sp.form === 'round') rise += (1 - f) * -0.25 + f * 0.35;
      const dir = v3(Math.cos(az) * Math.cos(rise), Math.sin(rise), Math.sin(az) * Math.cos(rise)).normalize();
      let len = toShell(p, dir, c, R, Rv);
      if (sp.form === 'cone') len = R * Math.pow(1 - (p.y - y0) / (H - y0), 0.9) * (0.8 + r() * 0.3) + 0.3;
      if (sp.form === 'column') len = Math.max(0.6, len * 0.95);
      len *= 0.88 + r() * 0.12;
      if (len < 0.4) continue;
      const bend = sp.form === 'cone' ? 0.05 : sp.form === 'round' ? 0.03 : 0.02;
      const pts = limb(p, dir, len, 4, bend - sp.droop * 0.12, g * 0.5);
      const br = sp.trunk * (sp.form === 'cone' ? 0.22 : 0.5) * Math.min(1, 0.4 + len / R * 0.6) * (1 - f * 0.3);
      limbs.push({ pts, r0: br, r1: br * 0.25, level: 1 });
      // Twigs off the branch towards the shell, with leaves.
      const subs = sp.form === 'cone' ? Math.max(1, Math.round(sp.subs * len / R)) : sp.subs;
      for (let s = 0; s < subs; s++) {
        const ts = 0.3 + 0.65 * ((s + r()) / subs);
        const q = along(pts, ts);
        const bd = dirAt(pts, ts);
        const side = perp(bd).applyAxisAngle(bd, r() * 6.28);
        if (sp.form !== 'cone') side.y = Math.abs(side.y) * 0.8 + 0.2;
        else side.y *= 0.2;
        const sd = bd.clone().multiplyScalar(0.8).add(side).normalize();
        let sl = toShell(q, sd, c, R, Rv) * (0.8 + r() * 0.25);
        if (sp.form === 'cone') sl = len * (1 - ts) * 0.6 + 0.3;
        sl = Math.max(0.35, Math.min(sl, R * 0.9));
        const sub = limb(q, sd, sl, 2, -sp.droop * 0.25, g);
        limbs.push({ pts: sub, r0: br * 0.4, r1: br * 0.1, level: 2 });
        leaves(sub, 0.15, Math.max(1, Math.round(sl * sp.density)));
      }
      leaves(pts, sp.form === 'cone' ? 0.15 : 0.55, Math.max(1, Math.round(len * sp.density * (sp.form === 'cone' ? 0.8 : 0.5))));
    }
    // Top of the crown.
    const top = trunk[trunk.length - 1];
    if (sp.form !== 'umbrella') {
      const pts = limb(top, v3(0, 1, 0), Math.max(0.5, H - top.y - (sp.form === 'cone' ? sp.card * 0.3 : sp.card * 0.9)), 2, 0, g * 0.3);
      limbs.push({ pts, r0: sp.trunk * 0.12, r1: sp.trunk * 0.04, level: 2 });
      leaves(pts, 0.1, Math.max(2, Math.round((H - top.y) * sp.density * 0.6)));
    }
  }
  // Conifers: sprig cards on the cone between the boughs.
  if (sp.form === 'cone' && sp.fill > 0) {
    const yb = H * sp.bole;
    const n = Math.round(((Math.PI * R * Math.hypot(R, H - yb)) / (sp.card * sp.card)) * sp.fill);
    for (let i = 0; i < n; i++) {
      const y = yb + (H - yb) * Math.sqrt(r()) * 0.98;
      const rad = R * Math.pow(1 - (y - yb) / (H - yb), 0.9) * (0.45 + 0.5 * r());
      const az = r() * Math.PI * 2;
      const out = v3(Math.cos(az), 0, Math.sin(az));
      const p = v3(out.x * rad, y, out.z * rad);
      const up = out.clone().multiplyScalar(0.9).add(v3(0, -0.15 - sp.droop * 0.5, 0)).normalize();
      const nn = v3(0, 1, 0).addScaledVector(up, -up.y).normalize();
      nn.applyAxisAngle(up, (r() - 0.5) * 0.9);
      cards.push({ p: p.addScaledVector(up, -sp.card * 0.3), up, n: nn, size: sp.card * (0.85 + r() * 0.3), lod1: false, shell: true });
    }
  }
  // Leaf mass inside the crown: cards on an inner shell, facing out, so the crown does not look see-through.
  if (sp.form !== 'cone') {
    const area = 4 * Math.PI * ((R * R * 2 + R * Rv) / 3);
    const n = Math.round((area / (sp.card * sp.card)) * sp.fill);
    for (let i = 0; i < n; i++) {
      const u = v3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      if (u.lengthSq() > 1 || u.lengthSq() < 0.05) { i--; continue; }
      u.normalize();
      const f = 0.5 + 0.38 * Math.sqrt(r());
      const p = v3(c.x + u.x * R * f, c.y + u.y * Rv * f, c.z + u.z * R * f);
      if (p.y < H * sp.bole * 0.8) continue;
      const up = v3(u.x * 0.5 + (r() - 0.5) * 0.5, 1, u.z * 0.5 + (r() - 0.5) * 0.5).normalize();
      const nn = u.clone().addScaledVector(up, -u.dot(up)).normalize();
      if (nn.lengthSq() < 1e-4) continue;
      nn.applyAxisAngle(up, (r() - 0.5) * 1.2);
      const size = sp.card * 1.25 * (0.85 + r() * 0.3);
      // Centred on the shell point, so the outer cards do not stick out of the crown.
      p.addScaledVector(up, -size * 0.38);
      // Not into the ground (bushes).
      p.y = Math.max(p.y, size * 0.12 + 0.03);
      cards.push({ p, up, n: nn, size, lod1: false, shell: true });
    }
  }
  // The simple model keeps every other card of the inner shell and every fourth twig card (conifers: every other,
  // their boughs are the outline), both larger (lod1Scale).
  const [es, et] = lod1Every(sp);
  let k = 0, ks = 0;
  for (const cd of cards) cd.lod1 = cd.shell ? ks++ % es === 0 : k++ % et === 0;
  return { limbs, cards, c, R, Rv };
}

interface Buf { pos: number[]; nrm: number[]; uv: number[]; col: number[]; wind: number[]; idx: number[] }
const buf = (): Buf => ({ pos: [], nrm: [], uv: [], col: [], wind: [], idx: [] });

/** Tapered tube along a limb's points with bark UVs (u around, v along; v repeats every two circumferences). */
function tube(b: Buf, l: Limb, sides: number, barkCell: number, H: number) {
  const n = l.pts.length;
  const base = b.pos.length / 3;
  const u0 = barkCell / BARKS.length, u1 = (barkCell + 1) / BARKS.length;
  const circ = Math.max(0.25, 2 * Math.PI * l.r0);
  let v = 0;
  let side = perp(l.pts[1].clone().sub(l.pts[0]).normalize());
  for (let i = 0; i < n; i++) {
    const d = (i < n - 1 ? l.pts[i + 1].clone().sub(l.pts[i]) : l.pts[i].clone().sub(l.pts[i - 1])).normalize();
    // Parallel transport keeps the rings from twisting.
    side = side.addScaledVector(d, -side.dot(d)).normalize();
    const up = d.clone().cross(side);
    const rad = l.r0 + (l.r1 - l.r0) * (i / (n - 1));
    if (i > 0) v += l.pts[i].distanceTo(l.pts[i - 1]) / (2 * circ);
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const nn = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
      const p = l.pts[i].clone().addScaledVector(nn, rad);
      // Root flare at the trunk base.
      if (l.level === 0 && i === 0) p.addScaledVector(nn, rad * 0.35);
      b.pos.push(p.x, p.y, p.z);
      b.nrm.push(nn.x, nn.y, nn.z);
      b.uv.push(u0 + (u1 - u0) * (0.02 + 0.96 * (k / sides)), v);
      const ao = l.level === 0 ? 0.75 + 0.25 * Math.min(1, p.y / 2) : 0.8;
      b.col.push(ao, ao, ao);
      b.wind.push(Math.max(0, Math.min(1, p.y / H)) ** 1.5 * (l.level === 0 ? 0.6 : 1));
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let k = 0; k < sides; k++) {
      const a = base + i * (sides + 1) + k, c = a + sides + 1;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
}

/** The simple model keeps every n-th card of the inner shell and of the twigs. */
const lod1Every = (sp: SpeciesShape) => [2, sp.form === 'cone' ? 2 : 4];
/** Size factor of a kept card: about the same leaf area as the cards left out. */
const lod1Scale = (every: number) => Math.sqrt(every) * 0.96;

/**
 * One leaf card: square quad, bottom centre at the twig, cell of the leaf atlas; normals bent towards the crown's.
 * A larger card (sizeK > 1) keeps the centre of the original, so the simple model has the same outline.
 */
function card(b: Buf, cd: Card, cell: number, sizeK: number, c: V3, R: number, Rv: number, H: number) {
  const base = b.pos.length / 3;
  const s = cd.size * sizeK;
  const side = cd.up.clone().cross(cd.n).normalize();
  const lift = -(sizeK - 1) * cd.size * 0.38;
  const cu = (cell % FOLIAGE_GRID) / FOLIAGE_GRID, cv = 1 - (Math.floor(cell / FOLIAGE_GRID) + 1) / FOLIAGE_GRID;
  const e = 1 / FOLIAGE_GRID;
  const corners: [number, number][] = [[-0.5, 0], [0.5, 0], [-0.5, 1], [0.5, 1]];
  for (const [x, y] of corners) {
    const p = cd.p.clone().addScaledVector(side, x * s).addScaledVector(cd.up, y * s - s * 0.12 + lift);
    b.pos.push(p.x, p.y, p.z);
    // Mostly the crown's normal (soft volume shading), a little of the card's own.
    const out = p.clone().sub(c);
    out.y *= (R / Rv) ** 2;
    out.normalize();
    const nn = out.multiplyScalar(0.75).addScaledVector(cd.n, 0.25).normalize();
    b.nrm.push(nn.x, nn.y, nn.z);
    b.uv.push(cu + (x + 0.5) * e * 0.996 + e * 0.002, cv + y * e * 0.996 + e * 0.002);
    // Darker inside and under the crown.
    const rel = Math.min(1, Math.hypot((p.x - c.x) / R, (p.y - c.y) / Rv, (p.z - c.z) / R));
    const under = Math.max(0, Math.min(1, (p.y - (c.y - Rv)) / (2 * Rv)));
    const ao = 0.42 + 0.4 * rel ** 1.5 + 0.22 * under;
    b.col.push(ao, ao, ao);
    b.wind.push(Math.max(0, Math.min(1, p.y / H)) ** 1.5 + 0.15 * y);
  }
  b.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
}

function toGeometry(b: Buf, leaf: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.setAttribute('wind', new THREE.Float32BufferAttribute(b.wind, 1));
  g.setAttribute('leaf', new THREE.Float32BufferAttribute(new Float32Array(b.wind.length).fill(leaf), 1));
  g.setIndex(b.idx);
  return g;
}

/** Builds both levels of detail of a species. */
export function buildTree(sp: SpeciesShape, seed = 1): TreeGeometry {
  const { limbs, cards, c, R, Rv } = grow(sp, seed);
  const barkCell = BARKS.findIndex((b) => b.id === sp.bark);
  const leafCell = LEAF_CARDS.findIndex((l) => l.id === sp.leaf);
  const H = sp.height;
  const lods: THREE.BufferGeometry[] = [];
  for (let lod = 0; lod < 2; lod++) {
    const wood = buf(), leaf = buf();
    for (const l of limbs) {
      if (lod === 1 && l.level === 2) continue;
      if (lod === 1 && l.level === 1 && l.r0 < sp.trunk * 0.2) continue;
      const sides = l.level === 0 ? (lod ? 5 : 8) : l.level === 1 ? (lod ? 3 : 4) : 3;
      // Twigs are thin: one straight segment is enough, the leaves hide the bend.
      const straight = l.level === 2 || (lod === 1 && l.level === 1);
      tube(wood, straight ? { ...l, pts: [l.pts[0], l.pts[l.pts.length - 1]] } : l, sides, Math.max(0, barkCell), H);
    }
    for (const cd of cards) {
      if (lod === 1 && !cd.lod1) continue;
      card(leaf, cd, Math.max(0, leafCell), lod ? lod1Scale(lod1Every(sp)[cd.shell ? 0 : 1]) : 1, c, R, Rv, H);
    }
    const g = mergeGeometries([toGeometry(wood, 0), toGeometry(leaf, R)], true)!;
    g.computeBoundingSphere();
    lods.push(g);
  }
  // Frame of the impostors: the widest point of the detailed model and its top.
  const pos = lods[0].getAttribute('position') as THREE.BufferAttribute;
  let boxR = 0, boxH = 0;
  for (let i = 0; i < pos.count; i++) {
    boxR = Math.max(boxR, Math.hypot(pos.getX(i), pos.getZ(i)));
    boxH = Math.max(boxH, pos.getY(i));
  }
  return { lods, height: boxH, crown: R, boxR: boxR * 1.02, boxH: boxH * 1.02 };
}

/** Triangles per level of detail (veg.species). */
export function triangles(g: THREE.BufferGeometry) {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
