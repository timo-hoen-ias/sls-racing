import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Bush, type BushKind, Tree, type TreeKind } from './vegKinds.ts';

// Low-poly trees and bushes for instancing: one vertex-coloured geometry per kind and LOD (trunk and crown merged,
// ground at y = 0, about 8 m tall at scale 1). The "wind" attribute (0 at the trunk base, 1 at the crown top) sets
// how far a vertex sways.

type Geo = THREE.BufferGeometry;

function finish(g: Geo, hex: number, shade: (y: number) => number, top: number, jitter = 0, seed = 0) {
  const p = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(p.attributes)) if (name !== 'position') p.deleteAttribute(name);
  const pos = p.getAttribute('position') as THREE.BufferAttribute;
  if (jitter) {
    // Lumpy crowns: move shared corners the same way (hash of the position, not of the vertex index).
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
      const k = 1 + (h - Math.floor(h) - 0.5) * jitter;
      pos.setXYZ(i, x * k, y + (k - 1) * 0.6, z * k);
    }
  }
  const c = new THREE.Color(hex);
  const col = new Float32Array(pos.count * 3);
  const wind = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const s = shade(y);
    col.set([c.r * s, c.g * s, c.b * s], i * 3);
    wind[i] = Math.max(0, Math.min(1, y / top)) ** 1.5;
  }
  p.setAttribute('color', new THREE.BufferAttribute(col, 3));
  p.setAttribute('wind', new THREE.BufferAttribute(wind, 1));
  return p;
}

const merge = (parts: Geo[]) => {
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
};

/** Crown shading: darker underneath (self shadow), lighter on top. */
const crownShade = (y0: number, y1: number) => (y: number) => 0.62 + 0.5 * Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));

function trunk(r0: number, r1: number, h: number, hex: number, top: number, seg = 6) {
  return finish(new THREE.CylinderGeometry(r1, r0, h, seg).translate(0, h / 2, 0), hex, () => 1, top);
}

function blob(r: number, detail: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) {
  return new THREE.IcosahedronGeometry(r, detail).scale(sx, sy, sz).translate(x, y, z);
}

function broadleaf(lod: number) {
  const top = 8.4;
  const leaf = 0x4f6f2e;
  const shade = crownShade(3, top);
  if (lod) return merge([trunk(0.28, 0.2, 3.4, 0x4a3a2c, top, 5), finish(blob(2.9, 1, 0, 5.4, 0, 1, 1.05, 1), leaf, shade, top, 0.25, 3)]);
  return merge([
    trunk(0.3, 0.18, 4.2, 0x4a3a2c, top),
    finish(new THREE.CylinderGeometry(0.05, 0.12, 2.4, 4).rotateZ(0.7).translate(0.8, 4.2, 0), 0x4a3a2c, () => 1, top),
    finish(blob(2.2, 1, 0, 6.2, 0), leaf, shade, top, 0.3, 5),
    finish(blob(1.8, 1, 1.3, 5.0, 0.5), leaf, shade, top, 0.3, 6),
    finish(blob(1.7, 1, -1.2, 5.2, -0.6), leaf, shade, top, 0.3, 7),
    finish(blob(1.6, 1, 0.2, 5.0, -1.4), leaf, shade, top, 0.3, 8),
    finish(blob(1.5, 1, -0.4, 4.8, 1.4), leaf, shade, top, 0.3, 9),
  ]);
}

function conifer(lod: number) {
  const top = 11;
  const needle = 0x2f4a2a;
  const shade = crownShade(1.5, top);
  const cone = (r: number, h: number, y: number, seg: number) => finish(new THREE.ConeGeometry(r, h, seg).translate(0, y + h / 2, 0), needle, shade, top, 0.12, 11);
  if (lod) return merge([trunk(0.25, 0.15, 2, 0x3f3125, top, 5), cone(2.3, 9.5, 1.5, 6)]);
  return merge([trunk(0.28, 0.12, 4, 0x3f3125, top), cone(2.5, 4.2, 1.4, 8), cone(2, 3.8, 3.8, 8), cone(1.5, 3.4, 6, 8), cone(0.9, 3, 8, 7)]);
}

function poplar(lod: number) {
  const top = 14;
  const shade = crownShade(2, top);
  return merge([
    trunk(0.3, 0.15, 3, 0x4d4436, top, lod ? 5 : 6),
    finish(blob(1, lod ? 0 : 1, 0, 8, 0, 1.5, 6.2, 1.5), 0x56742f, shade, top, lod ? 0.1 : 0.22, 13),
  ]);
}

function birch(lod: number) {
  const top = 9;
  const leaf = 0x7a9440;
  const shade = crownShade(3, top);
  const bark = finish(new THREE.CylinderGeometry(0.1, 0.2, 6.5, lod ? 5 : 7).translate(0, 3.25, 0).rotateZ(0.06), 0xd8d4c8, (y) => (Math.floor(y * 1.7) % 3 === 0 ? 0.35 : 1), top);
  if (lod) return merge([bark, finish(blob(1.9, 0, 0.3, 6.2, 0, 1, 1.4, 1), leaf, shade, top, 0.2, 17)]);
  return merge([
    bark,
    finish(blob(1.4, 1, 0.3, 7, 0, 1, 1.3, 1), leaf, shade, top, 0.35, 18),
    finish(blob(1.1, 1, -0.6, 5.6, 0.4, 1, 1.3, 1), leaf, shade, top, 0.35, 19),
    finish(blob(1.0, 1, 0.9, 5.2, -0.5, 1, 1.3, 1), leaf, shade, top, 0.35, 20),
  ]);
}

function fruit(lod: number) {
  const top = 5;
  const shade = crownShade(1.6, top);
  return merge([
    trunk(0.2, 0.14, 1.8, 0x5a4632, top, 5),
    finish(blob(2.1, lod ? 0 : 1, 0, 3.2, 0, 1.15, 0.8, 1.15), 0x5c7a34, shade, top, 0.3, 23),
  ]);
}

export function buildTreeGeometries(): Record<TreeKind, [Geo, Geo]> {
  const both = (f: (lod: number) => Geo): [Geo, Geo] => [f(0), f(1)];
  return {
    [Tree.broadleaf]: both(broadleaf), [Tree.conifer]: both(conifer), [Tree.poplar]: both(poplar),
    [Tree.birch]: both(birch), [Tree.fruit]: both(fruit),
  };
}

export function buildBushGeometries(): Record<BushKind, Geo> {
  const top = 1.6;
  const shade = crownShade(0, top);
  return {
    [Bush.round]: merge([finish(blob(0.9, 1, 0, 0.7, 0, 1.1, 0.85, 1.1), 0x48662b, shade, top, 0.3, 29)]),
    [Bush.scrub]: merge([
      finish(blob(0.8, 0, 0, 0.6, 0, 1.2, 0.9, 1), 0x4a5f2c, shade, top, 0.3, 31),
      finish(blob(0.6, 0, 0.8, 0.45, 0.3, 1, 0.9, 1), 0x56692f, shade, top, 0.3, 32),
    ]),
  };
}

/** Grass clump: three crossed blades quads, 0.5 m tall. */
export function buildGrassGeometry(): Geo {
  const parts: Geo[] = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(0.6, 0.5, 1, 1).translate(0, 0.25, 0).rotateY((i * Math.PI) / 3);
    parts.push(finish(g, 0x6f8a3c, (y) => 0.55 + y, 0.5));
  }
  const g = mergeGeometries(parts)!;
  // Upright normals so the clumps light like the ground they stand on.
  const n = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < n.length; i += 3) n[i + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.computeBoundingSphere();
  return g;
}
