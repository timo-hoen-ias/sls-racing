import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Prop, type PropKind } from './propKinds.ts';

// Low-poly street furniture for instancing, one vertex-coloured geometry per kind. Model space: ground at y = 0,
// +z is the direction the prop faces (signs show their face that way). Linear props (fences, walls, hedges,
// guard rails) are 1 m long along z and get scaled by the segment length. Parked cars use the traffic models.

type Geo = THREE.BufferGeometry;

function tint(g: Geo, hex: number) {
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number) =>
  tint(new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed(), hex);

const cyl = (r: number, h: number, x: number, y: number, z: number, hex: number, seg = 8, rTop = r) =>
  tint(new THREE.CylinderGeometry(rTop, r, h, seg).translate(x, y + h / 2, z).toNonIndexed(), hex);

/** Flat plate facing +z, centred at (x, y, z), as a polygon with `sides` corners (rotated by `rot`). */
function plate(radius: number, sides: number, rot: number, x: number, y: number, z: number, hex: number, depth = 0.03) {
  const shape = new THREE.Shape();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    if (i === 0) shape.moveTo(Math.cos(a) * radius, Math.sin(a) * radius);
    else shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }).translate(x, y, z - depth / 2);
  return tint(g.index ? g.toNonIndexed() : g, hex);
}

const merge = (parts: Geo[]) => {
  for (const p of parts) for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') p.deleteAttribute(name);
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
};

const POLE = 0x8f969c;
const WHITE = 0xf2f2ee;
const RED = 0xc8202a;
const CONCRETE = 0xa9a59c;

const pole = (h: number, x = 0, z = -0.03) => cyl(0.04, h, x, 0, z, POLE, 6);

function busStop(shelter: boolean) {
  // German stop sign: green H in a yellow disc on a pole, optionally with a glass shelter behind it.
  const parts = [pole(2.6), plate(0.22, 20, 0, 0, 2.35, 0.03, 0xf4c400), plate(0.15, 20, 0, 0, 2.35, 0.05, 0x1f7a3a, 0.01)];
  if (shelter) {
    const glass = 0x9fb8c4;
    parts.push(
      box(3.2, 0.08, 1.6, 0, 2.45, -0.9, 0x5d646b), // roof
      box(3.2, 1.9, 0.04, 0, 1.25, -1.65, glass), // back wall
      box(0.04, 1.9, 1.4, -1.58, 1.25, -0.95, glass),
      box(0.04, 1.9, 1.4, 1.58, 1.25, -0.95, glass),
      box(0.08, 2.4, 0.08, -1.58, 1.2, -0.2, 0x5d646b),
      box(0.08, 2.4, 0.08, 1.58, 1.2, -0.2, 0x5d646b),
      box(2.4, 0.06, 0.4, 0, 0.48, -1.4, 0x6b4a2f), // bench
    );
  }
  return merge(parts);
}

export function buildPropGeometries(): Partial<Record<PropKind | 'busShelter', Geo>> {
  return {
    [Prop.busStop]: busStop(false),
    busShelter: busStop(true),
    [Prop.sign]: merge([pole(2.4), box(0.6, 0.6, 0.03, 0, 2.2, 0.02, 0x1d4f9c), box(0.44, 0.08, 0.01, 0, 2.2, 0.04, WHITE)]),
    [Prop.stopSign]: merge([pole(2.3), plate(0.33, 8, Math.PI / 8, 0, 2.1, 0.03, RED), box(0.36, 0.08, 0.01, 0, 2.1, 0.05, WHITE)]),
    [Prop.giveWay]: merge([pole(2.3), plate(0.42, 3, -Math.PI / 2, 0, 2.15, 0.03, RED), plate(0.28, 3, -Math.PI / 2, 0, 2.1, 0.05, WHITE, 0.01)]),
    [Prop.cityLimit]: merge([pole(2.4, -0.55), pole(2.4, 0.55), box(1.3, 0.75, 0.03, 0, 2.0, 0.02, 0xf4c400), box(1.1, 0.12, 0.01, 0, 2.08, 0.04, 0x111111), box(0.7, 0.07, 0.01, 0, 1.86, 0.04, 0x111111)]),
    [Prop.bollard]: merge([cyl(0.09, 0.75, 0, 0, 0, 0x4a4d52, 10), cyl(0.092, 0.08, 0, 0.6, 0, WHITE, 10), cyl(0.092, 0.06, 0, 0.45, 0, RED, 10)]),
    [Prop.block]: merge([box(1.2, 0.6, 0.6, 0, 0.3, 0, CONCRETE)]),
    [Prop.bench]: merge([
      box(1.8, 0.05, 0.42, 0, 0.45, 0, 0x7a5232), box(1.8, 0.35, 0.04, 0, 0.7, -0.22, 0x7a5232),
      box(0.06, 0.45, 0.4, -0.75, 0.22, 0, 0x2d2f33), box(0.06, 0.45, 0.4, 0.75, 0.22, 0, 0x2d2f33),
    ]),
    [Prop.bin]: merge([pole(0.9, 0, -0.18), cyl(0.2, 0.55, 0, 0.35, 0, 0x2f4a3a, 10), cyl(0.205, 0.04, 0, 0.88, 0, 0x22252a, 10)]),
    [Prop.postBox]: merge([pole(0.8, 0, -0.1), box(0.42, 0.5, 0.32, 0, 1.0, 0.02, 0xf4c400), box(0.44, 0.06, 0.34, 0, 1.28, 0.02, 0xd9ac00), box(0.24, 0.02, 0.01, 0, 1.12, 0.185, 0x222222)]),
    [Prop.recycling]: merge([
      box(1.1, 1.6, 1.1, -1.2, 0.8, 0, 0x2e6b3a), box(1.1, 1.6, 1.1, 0, 0.8, 0, 0x6b4426), box(1.1, 1.6, 1.1, 1.2, 0.8, 0, 0xdcdcd6),
      cyl(0.5, 0.15, -1.2, 1.6, 0, 0x2e6b3a, 10), cyl(0.5, 0.15, 0, 1.6, 0, 0x6b4426, 10), cyl(0.5, 0.15, 1.2, 1.6, 0, 0xdcdcd6, 10),
    ]),
    [Prop.hydrant]: merge([cyl(0.11, 0.75, 0, 0, 0, RED, 10), cyl(0.13, 0.08, 0, 0.75, 0, RED, 10, 0.06), box(0.34, 0.07, 0.07, 0, 0.5, 0, 0xb01a22), cyl(0.12, 0.05, 0, 0.3, 0, WHITE, 10)]),
    [Prop.bikeStand]: merge([-0.9, -0.3, 0.3, 0.9].flatMap((x) => [box(0.04, 0.8, 0.04, x, 0.4, -0.35, POLE), box(0.04, 0.8, 0.04, x, 0.4, 0.35, POLE), box(0.04, 0.04, 0.74, x, 0.8, 0, POLE)])),
    [Prop.column]: merge([cyl(0.62, 2.6, 0, 0, 0, 0xd8cfb8, 16), cyl(0.63, 0.9, 0, 0.9, 0, 0xc84a2a, 16), cyl(0.63, 0.5, 0, 1.9, 0, 0x2a6f9b, 16), cyl(0.68, 0.18, 0, 2.6, 0, 0x2f5e3d, 16), cyl(0.68, 0.45, 0, 2.78, 0, 0x2f5e3d, 16, 0.1)]),
    [Prop.fence]: merge([box(0.03, 1.2, 1, 0, 0.7, 0, 0x5c6a5c), box(0.06, 1.4, 0.06, 0, 0.7, 0.47, 0x3d4640), box(0.05, 0.05, 1, 0, 1.35, 0, 0x3d4640)]),
    [Prop.wall]: merge([box(0.3, 1.6, 1, 0, 0.8, 0, 0xb3a58e), box(0.36, 0.08, 1, 0, 1.64, 0, 0x9a8e7a)]),
    [Prop.hedge]: merge([box(0.9, 1.3, 1, 0, 0.65, 0, 0x34572a), box(0.7, 0.2, 1, 0, 1.4, 0, 0x3d6431)]),
    [Prop.guardRail]: merge([box(0.05, 0.32, 1, 0, 0.6, 0, 0xb4b9bd), box(0.12, 0.75, 0.12, 0.06, 0.375, 0, 0x8f969c)]),
    // Bridge railing: handrail, knee rail and bottom rail on a post, galvanised steel.
    [Prop.railing]: merge([
      box(0.07, 0.05, 1, 0, 1.08, 0, 0x9aa1a6), box(0.04, 0.04, 1, 0, 0.6, 0, 0x8a9196), box(0.04, 0.04, 1, 0, 0.14, 0, 0x8a9196),
      box(0.05, 1.08, 0.05, 0, 0.54, 0.47, 0x7d8489),
    ]),
  };
}
