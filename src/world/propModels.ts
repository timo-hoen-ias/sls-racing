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
const CHAIN = 0x9ba39f;

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

/** Leitpfosten: white post 1 m above the ground with a black band at the top, 0.25 m below ground. */
function delineator() {
  return merge([box(0.1, 1.25, 0.12, 0, 0.375, 0, WHITE), box(0.104, 0.25, 0.124, 0, 0.87, 0, 0x16171a), box(0.104, 0.05, 0.124, 0, 0.98, -0.01, 0x16171a)]);
}

/** Richtungstafel (Z 625): white board 1 × 0.3 m with three red chevrons, on two posts; arrows point to -x (left) or +x. */
function chevron(dir: 1 | -1) {
  const parts = [pole(1.35, -0.38, -0.04), pole(1.35, 0.38, -0.04), box(1.0, 0.3, 0.03, 0, 1.15, 0, WHITE)];
  const a = Math.atan2(0.13, 0.11);
  for (const x of [-0.3, 0, 0.3]) {
    for (const s of [1, -1]) {
      const bar = new THREE.BoxGeometry(0.075, 0.18, 0.01).rotateZ(s * a * dir).translate(x + 0.04 * dir, 1.15 + s * 0.065, 0.02).toNonIndexed();
      parts.push(tint(bar, RED));
    }
  }
  return merge(parts);
}

/** Retroreflectors, drawn with their own (glowing) material: kind → geometry in the same model space. */
export function buildReflectorGeometries(): Partial<Record<PropKind, Geo>> {
  return {
    // Rectangle towards the traffic on the post's side, two round ones on the back for the oncoming lane.
    [Prop.delineator]: merge([
      box(0.045, 0.16, 0.01, 0, 0.87, 0.066, WHITE),
      plate(0.024, 10, 0, 0, 0.92, -0.066, WHITE, 0.01), plate(0.024, 10, 0, 0, 0.83, -0.066, WHITE, 0.01),
    ]),
  };
}

/** Kinds drawn in several variants (record size = variant): model key "v:<kind>.<variant>", variant 0 is the kind itself. */
const VARIANTS: Partial<Record<PropKind, number>> = { [Prop.gate]: 1, [Prop.infoBoard]: 1, [Prop.memorial]: 3, [Prop.vending]: 1 };

export function variantKey(kind: PropKind, size: number): string | undefined {
  const max = VARIANTS[kind];
  const v = Math.round(size);
  return max && v >= 1 && v <= max ? `v:${kind}.${v}` : undefined;
}

/** A box rotated about z (x tilted towards y), for diagonal braces, roofs and ladders. */
const tilted = (w: number, h: number, d: number, x: number, y: number, z: number, rotZ: number, hex: number, rotX = 0) =>
  tint(new THREE.BoxGeometry(w, h, d).rotateX(rotX).rotateZ(rotZ).translate(x, y, z).toNonIndexed(), hex);

const sphere = (r: number, x: number, y: number, z: number, hex: number, seg = 12) =>
  tint(new THREE.SphereGeometry(r, seg, Math.max(6, seg / 2)).translate(x, y, z).toNonIndexed(), hex);

const WOOD = 0x7a5534, WOOD_DARK = 0x4f3824, GALV = 0x9aa1a6, ANTHRACITE = 0x3a3e43, STONE = 0xa49c8c, SANDSTONE = 0xb98f6a;

/** Field gate: tubular steel frame 3 m wide with a diagonal brace, hinged on a post at x = -1.5. Open: swung back by 90°. */
function gate(open: boolean) {
  const leaf = [
    box(3, 0.06, 0.06, 0, 1.1, 0, GALV), box(3, 0.06, 0.06, 0, 0.25, 0, GALV), box(3, 0.04, 0.04, 0, 0.68, 0, GALV),
    box(0.06, 0.9, 0.06, 1.47, 0.68, 0, GALV), box(0.06, 0.9, 0.06, 0, 0.68, 0, GALV),
    tilted(0.04, 1.6, 0.04, -0.75, 0.68, 0, -1.02, GALV),
  ];
  const parts = [cyl(0.08, 1.3, -1.55, 0, 0, WOOD_DARK, 10), cyl(0.08, 1.3, 1.6, 0, 0, WOOD_DARK, 10)];
  for (const g of leaf) {
    if (open) g.translate(1.5, 0, 0).rotateY(Math.PI / 2).translate(-1.5, 0, 0);
    parts.push(g);
  }
  return merge(parts);
}

/** Lift gate (Schranke): housing at the kerb, boom raised almost upright (the road stays open), red and white. */
function liftGate() {
  const parts = [box(0.35, 1.0, 0.35, 0, 0.5, 0, 0xe8e6df), box(0.37, 0.1, 0.37, 0, 1.05, 0, RED)];
  for (let i = 0; i < 8; i++) parts.push(tilted(0.08, 0.5, 0.06, Math.cos(1.4) * (0.25 + i * 0.5), 1.1 + Math.sin(1.4) * (0.25 + i * 0.5), 0.2, 1.4 - Math.PI / 2, i % 2 ? WHITE : RED));
  return merge(parts);
}

/** Umlaufsperre: two staggered U-shaped tube barriers, red and white. */
function cycleBarrier() {
  const parts: Geo[] = [];
  for (const [x, z] of [[-0.45, -0.6], [0.45, 0.6]] as const) {
    parts.push(box(1.3, 0.06, 0.06, x, 1.0, z, RED), box(1.3, 0.06, 0.06, x, 0.55, z, WHITE));
    for (const dx of [-0.62, 0.62]) parts.push(cyl(0.03, 1.0, x + dx, 0, z, WHITE, 8));
  }
  return merge(parts);
}

function guidepost() {
  // Wooden post with three finger boards (hiking signs), white with green text bands.
  const parts = [cyl(0.06, 2.2, 0, 0, 0, WOOD, 8), box(0.14, 0.04, 0.14, 0, 2.21, 0, WOOD_DARK)];
  [[0.3, 1.95], [-2.0, 1.75], [1.4, 1.55]].forEach(([a, y]) => {
    const fb = new THREE.BoxGeometry(0.55, 0.12, 0.025).translate(0.33, y, 0).rotateY(a).toNonIndexed();
    const band = new THREE.BoxGeometry(0.4, 0.03, 0.028).translate(0.33, y, 0).rotateY(a).toNonIndexed();
    parts.push(tint(fb, WHITE), tint(band, 0x2f6b3a));
  });
  return merge(parts);
}

function infoBoard(map: boolean) {
  // Board 1.2 × 0.9 m under a small roof on two posts (map: a lectern-like slanted map panel instead).
  if (map) return merge([cyl(0.05, 0.9, -0.3, 0, 0, WOOD_DARK), cyl(0.05, 0.9, 0.3, 0, 0, WOOD_DARK), tilted(0.9, 0.04, 0.7, 0, 1.0, 0, 0, WOOD, -0.6), tilted(0.82, 0.01, 0.62, 0, 1.03, 0.02, 0, 0x5f8f6a, -0.6)]);
  return merge([
    box(0.1, 2.1, 0.1, -0.65, 1.05, 0, WOOD_DARK), box(0.1, 2.1, 0.1, 0.65, 1.05, 0, WOOD_DARK),
    box(1.2, 0.9, 0.05, 0, 1.45, 0, WOOD), box(1.1, 0.8, 0.01, 0, 1.45, 0.03, 0xd9d2bf), box(1.0, 0.18, 0.012, 0, 1.68, 0.035, 0x2f5e3d),
    tilted(1.5, 0.04, 0.45, 0, 2.08, -0.06, 0, WOOD_DARK, 0.35),
  ]);
}

function chargingStation() {
  return merge([
    box(0.5, 1.5, 0.25, 0, 0.75, 0, 0xe9ecef), box(0.5, 0.12, 0.27, 0, 1.44, 0, 0x2a8c4a), box(0.3, 0.22, 0.02, 0, 1.15, 0.13, 0x1b1d21),
    box(0.12, 0.18, 0.08, -0.15, 0.85, 0.15, ANTHRACITE), box(0.12, 0.18, 0.08, 0.15, 0.85, 0.15, ANTHRACITE),
    box(0.6, 0.06, 0.3, 0, 0.03, 0, CONCRETE),
  ]);
}

const camera = () => merge([cyl(0.06, 4, 0, 0, 0, POLE, 8), box(0.06, 0.06, 0.4, 0, 3.9, 0.2, POLE), box(0.14, 0.14, 0.32, 0, 3.8, 0.42, 0xe4e4e0), box(0.1, 0.1, 0.02, 0, 3.8, 0.59, 0x111111)]);

/** Notrufsäule: orange post with a small hood, as on German motorways. */
const emergencyPhone = () => merge([cyl(0.16, 1.2, 0, 0, 0, 0xe36b12, 12), cyl(0.18, 0.12, 0, 1.2, 0, 0xc4570c, 12), box(0.2, 0.26, 0.04, 0, 0.95, 0.15, 0x2a2a2a), box(0.16, 0.05, 0.03, 0, 1.15, 0.16, WHITE)]);

/** Großfläche 18/1: 3.56 × 2.52 m poster in a frame on two steel legs. */
function billboard() {
  const poster = [0xd84a2b, 0x2a6fb5, 0xf2c230, 0x3c9a5f];
  return merge([
    box(0.14, 2.2, 0.14, -1.2, 1.1, -0.1, ANTHRACITE), box(0.14, 2.2, 0.14, 1.2, 1.1, -0.1, ANTHRACITE),
    box(3.76, 2.72, 0.12, 0, 3.36, 0, 0x2d3034),
    ...poster.map((c, i) => box(0.89, 2.52, 0.01, -1.335 + i * 0.89, 3.36, 0.065, c)),
    box(3.56, 0.4, 0.012, 0, 2.5, 0.07, WHITE),
  ]);
}

const posterBox = () => merge([box(1.25, 1.8, 0.2, 0, 1.2, 0, 0x34383d), box(1.15, 1.7, 0.01, 0, 1.2, 0.105, 0xf0e6c8), box(1.0, 0.5, 0.012, 0, 1.55, 0.11, 0x8c3a6b), box(0.12, 0.3, 0.12, 0, 0.15, 0, 0x34383d)]);

const flagpole = () => merge([cyl(0.06, 8, 0, 0, 0, 0xe0e2e4, 10, 0.035), sphere(0.06, 0, 8.03, 0, 0xd9b44a, 8), box(0.01, 0.9, 1.5, 0, 7.4, 0.76, 0x1d5fa8), box(0.012, 0.18, 1.5, 0, 7.2, 0.76, WHITE)]);

/** Hochsitz: open wooden seat on four splayed legs 3 m up, with a ladder at the front. */
function huntingStand() {
  const parts: Geo[] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push(tilted(0.1, 3.3, 0.1, sx * 0.72, 1.6, sz * 0.72, -sx * 0.06, WOOD_DARK, sz * 0.06));
  parts.push(
    box(1.3, 0.06, 1.3, 0, 3.15, 0, WOOD), // floor
    box(1.3, 0.7, 0.04, 0, 3.55, -0.64, WOOD), box(0.04, 0.7, 1.3, -0.64, 3.55, 0, WOOD), box(0.04, 0.7, 1.3, 0.64, 3.55, 0, WOOD),
    box(1.3, 0.35, 0.04, 0, 3.35, 0.64, WOOD), box(1.1, 0.05, 0.3, 0, 3.6, -0.4, WOOD_DARK), // seat
    tilted(1.6, 0.05, 1.7, 0, 4.25, 0, 0, 0x4b4f45, 0.12), // roof
  );
  for (const sx of [-0.25, 0.25]) parts.push(tilted(0.07, 3.4, 0.07, sx, 1.6, 1.15, 0, WOOD_DARK, -0.28));
  for (let i = 0; i < 9; i++) parts.push(box(0.5, 0.04, 0.05, 0, 0.3 + i * 0.35, 1.48 - i * 0.1, WOOD));
  return merge(parts);
}

const waysideCross = () => merge([box(0.6, 0.3, 0.45, 0, 0.15, 0, SANDSTONE), box(0.4, 0.8, 0.3, 0, 0.7, 0, SANDSTONE), box(0.12, 1.5, 0.1, 0, 1.85, 0, STONE), box(0.7, 0.1, 0.1, 0, 2.25, 0, STONE), box(0.08, 0.32, 0.03, 0, 2.15, 0.065, 0x6e6a62)]);

function memorial(v: number) {
  if (v === 1) return merge([box(0.9, 0.2, 0.6, 0, 0.1, 0, CONCRETE), box(0.6, 1.9, 0.35, 0, 1.15, 0, 0x8b8578), box(0.45, 0.6, 0.01, 0, 1.4, 0.18, 0x6c6558)]); // stele
  if (v === 2) return merge([cyl(0.05, 1.1, 0, 0, 0, ANTHRACITE), tilted(0.6, 0.45, 0.04, 0, 1.15, 0, 0, 0x8a6a3a, -0.3)]); // plaque
  if (v === 3) return merge([box(2.2, 0.4, 2.2, 0, 0.2, 0, STONE), box(1.6, 0.4, 1.6, 0, 0.6, 0, STONE), box(1.0, 1.6, 1.0, 0, 1.6, 0, SANDSTONE), cyl(0.35, 1.2, 0, 2.4, 0, 0x5b6b5e, 12, 0.2)]); // monument
  // Rough memorial stone with a bronze plate.
  return merge([tint(new THREE.DodecahedronGeometry(0.7, 0).scale(1.1, 1.2, 0.7).translate(0, 0.65, 0).toNonIndexed(), 0x8f8a80), box(0.4, 0.3, 0.02, 0, 0.8, 0.47, 0x8a6a3a)]);
}

/** Abstract sculpture: a twisted stack of stone and bronze blocks on a plinth. */
function artwork() {
  const parts = [box(1.2, 0.3, 1.2, 0, 0.15, 0, CONCRETE)];
  for (let i = 0; i < 5; i++) parts.push(tint(new THREE.BoxGeometry(0.7 - i * 0.08, 0.45, 0.35).rotateY(i * 0.5).translate(Math.sin(i) * 0.1, 0.55 + i * 0.45, 0).toNonIndexed(), i % 2 ? 0x8a6a3a : 0xb0aa9c));
  parts.push(sphere(0.25, 0, 2.75, 0, 0x8a6a3a));
  return merge(parts);
}

/** Wooden shelter (Schutzhütte): three closed sides, gable roof, a bench inside. */
function shelter() {
  const parts = [
    box(3.0, 2.0, 0.08, 0, 1.0, -1.1, WOOD), box(0.08, 2.0, 2.2, -1.5, 1.0, 0, WOOD), box(0.08, 2.0, 2.2, 1.5, 1.0, 0, WOOD),
    box(0.14, 2.1, 0.14, -1.5, 1.05, 1.1, WOOD_DARK), box(0.14, 2.1, 0.14, 1.5, 1.05, 1.1, WOOD_DARK),
    box(2.8, 0.06, 0.4, 0, 0.45, -0.85, WOOD_DARK),
    tilted(3.4, 0.08, 1.55, 0, 2.38, -0.62, 0, 0x5a3f2a, -0.62), tilted(3.4, 0.08, 1.55, 0, 2.38, 0.62, 0, 0x5a3f2a, 0.62),
  ];
  return merge(parts);
}

const picnicTable = () => merge([
  box(1.8, 0.05, 0.75, 0, 0.75, 0, WOOD), box(1.8, 0.05, 0.28, 0, 0.45, -0.62, WOOD), box(1.8, 0.05, 0.28, 0, 0.45, 0.62, WOOD),
  ...[-0.7, 0.7].flatMap((x) => [tilted(0.07, 0.95, 0.07, x, 0.4, -0.3, 0, WOOD_DARK, -0.5), tilted(0.07, 0.95, 0.07, x, 0.4, 0.3, 0, WOOD_DARK, 0.5), box(0.07, 0.07, 1.5, x, 0.4, 0, WOOD_DARK)]),
]);

function vending(parking: boolean) {
  if (parking) return merge([box(0.45, 1.3, 0.3, 0, 0.65, 0, 0x1f4c8f), box(0.47, 0.12, 0.32, 0, 1.36, 0, 0x163a6e), box(0.28, 0.2, 0.02, 0, 1.1, 0.16, 0x9fd3c7), box(0.08, 0.08, 0.04, 0.12, 0.85, 0.17, 0xc0c4c8), box(0.32, 0.25, 0.04, 0, 1.55, 0, WHITE), box(0.2, 0.17, 0.01, 0, 1.55, 0.03, 0x1d4f9c)]);
  return merge([box(0.6, 1.4, 0.3, 0, 0.8, 0, 0x7d8288), box(0.5, 0.9, 0.02, 0, 0.95, 0.16, 0x2d3540), box(0.12, 0.25, 0.03, 0.2, 0.55, 0.16, 0xbcc0c4), cyl(0.05, 0.1, 0, 0, 0, POLE)]);
}

/** Traffic mirror: round convex mirror with a red-white rim on a post. */
function trafficMirror() {
  const g = new THREE.SphereGeometry(0.45, 16, 8, 0, Math.PI * 2, 0, 0.5).rotateX(Math.PI / 2).scale(1, 1, 0.35).translate(0, 2.45, 0.08);
  const rim = new THREE.TorusGeometry(0.46, 0.035, 6, 24).translate(0, 2.45, 0.06).toNonIndexed();
  return merge([pole(2.5), box(0.5, 0.06, 0.06, 0, 2.45, 0, POLE), tint(rim, RED), tint(g.toNonIndexed(), 0xcfd8de)]);
}

/** Blitzersäule: tall grey-blue column with two dark windows (both directions). */
const speedCamera = () => merge([
  box(0.5, 0.15, 0.5, 0, 0.075, 0, CONCRETE), cyl(0.25, 3.0, 0, 0.15, 0, 0x7f8c95, 16), cyl(0.27, 0.12, 0, 3.15, 0, 0x5b6770, 16),
  box(0.22, 0.35, 0.05, 0, 2.5, 0.24, 0x161a1e), box(0.22, 0.35, 0.05, 0, 2.5, -0.24, 0x161a1e), box(0.12, 0.12, 0.05, 0, 1.9, 0.24, 0x161a1e),
]);

function fountain() {
  // Round sandstone basin 3.6 m across with a column and a small top bowl; the water is flat.
  const parts = [cyl(1.8, 0.6, 0, 0, 0, SANDSTONE, 24), cyl(1.6, 0.02, 0, 0.5, 0, 0x5f8fa3, 24), cyl(0.25, 1.4, 0, 0.5, 0, SANDSTONE, 12), cyl(0.6, 0.15, 0, 1.75, 0, SANDSTONE, 16, 0.7), cyl(0.5, 0.02, 0, 1.88, 0, 0x5f8fa3, 16)];
  return merge(parts);
}

const parcelLocker = () => merge([box(3.0, 1.9, 0.6, 0, 0.95, 0, 0xf2c200), box(3.0, 0.1, 0.65, 0, 1.92, 0, 0xd9a900), ...[-1.2, -0.6, 0, 0.6, 1.2].map((x) => box(0.55, 1.7, 0.01, x, 0.95, 0.305, 0xe6b800)), box(0.4, 0.3, 0.02, 0, 1.3, 0.31, 0x222222)]);

/** Bunker: low concrete block, half in the ground, with an embrasure. */
const bunker = () => merge([box(5, 1.6, 4, 0, 0.6, 0, 0x8f8c84), box(5.3, 0.25, 4.3, 0, 1.45, 0, 0x7d7a72), box(1.2, 0.3, 0.1, 0, 0.9, 2.01, 0x1e1e1e)]);

const boundaryStone = () => merge([box(0.25, 0.6, 0.18, 0, 0.3, 0, 0xc2b8a3), box(0.12, 0.05, 0.01, 0, 0.45, 0.095, 0x5a5348)]);

export function buildPropGeometries(): Record<string, Geo> {
  return {
    [Prop.gate]: gate(false), [`v:${Prop.gate}.1`]: gate(true),
    [Prop.liftGate]: liftGate(),
    [Prop.cycleBarrier]: cycleBarrier(),
    [Prop.streetCabinet]: merge([box(0.85, 1.15, 0.32, 0, 0.6, 0, 0x9ea39a), box(0.87, 0.06, 0.36, 0, 1.2, 0, 0x8a8f86), box(0.02, 0.9, 0.01, 0, 0.6, 0.165, 0x7a7f76)]),
    [Prop.guidepost]: guidepost(),
    [Prop.infoBoard]: infoBoard(false), [`v:${Prop.infoBoard}.1`]: infoBoard(true),
    [Prop.chargingStation]: chargingStation(),
    [Prop.camera]: camera(),
    [Prop.emergencyPhone]: emergencyPhone(),
    [Prop.billboard]: billboard(),
    [Prop.posterBox]: posterBox(),
    [Prop.flagpole]: flagpole(),
    [Prop.huntingStand]: huntingStand(),
    [Prop.waysideCross]: waysideCross(),
    [Prop.memorial]: memorial(0), [`v:${Prop.memorial}.1`]: memorial(1), [`v:${Prop.memorial}.2`]: memorial(2), [`v:${Prop.memorial}.3`]: memorial(3),
    [Prop.artwork]: artwork(),
    [Prop.shelter]: shelter(),
    [Prop.picnicTable]: picnicTable(),
    [Prop.vending]: vending(false), [`v:${Prop.vending}.1`]: vending(true),
    [Prop.trafficMirror]: trafficMirror(),
    [Prop.speedCamera]: speedCamera(),
    [Prop.fountain]: fountain(),
    [Prop.parcelLocker]: parcelLocker(),
    [Prop.bunker]: bunker(),
    [Prop.boundaryStone]: boundaryStone(),
    // Retaining wall: rough stone face, a little battered, with a capping course.
    [Prop.retainingWall]: merge([tilted(0.45, 1.2, 1, 0, 0.6, 0, 0.05, 0x9c9485), box(0.5, 0.1, 1, 0.03, 1.22, 0, 0x8a8273)]),
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
    // Maschendrahtzaun: galvanised post at the piece's end, top rail and bottom tension wire; the mesh itself is
    // chainLinkPanel() with chainLinkMaterial(). Posts are thin since the piece is stretched along z.
    [Prop.chainLink]: merge([box(0.06, 1.75, 0.014, 0, 0.875, 0.493, CHAIN), box(0.042, 0.042, 1, 0, 1.68, 0, CHAIN), box(0.012, 0.012, 1, 0, 0.06, 0, CHAIN)]),
    // Andreaskreuz (Z 201): red-white boards crossed at 2.2 m on a grey post.
    [Prop.railCross]: merge([pole(2.6), ...[-1, 1].flatMap((s) => {
      const arm = (hex: number, y: number) => box(1.0, 0.18, 0.02, 0, 0, 0, hex).rotateZ((s * Math.PI) / 4).translate(0, y, 0.04);
      return [arm(WHITE, 2.2), box(0.25, 0.185, 0.022, 0, 0, 0, RED).translate(-0.33, 0, 0).rotateZ((s * Math.PI) / 4).translate(0, 2.2, 0.04), box(0.25, 0.185, 0.022, 0, 0, 0, RED).translate(0.33, 0, 0).rotateZ((s * Math.PI) / 4).translate(0, 2.2, 0.04)];
    })]),
    [Prop.wall]: merge([box(0.3, 1.6, 1, 0, 0.8, 0, 0xb3a58e), box(0.36, 0.08, 1, 0, 1.64, 0, 0x9a8e7a)]),
    [Prop.hedge]: merge([box(0.9, 1.3, 1, 0, 0.65, 0, 0x34572a), box(0.7, 0.2, 1, 0, 1.4, 0, 0x3d6431)]),
    [Prop.guardRail]: merge([box(0.05, 0.32, 1, 0, 0.6, 0, 0xb4b9bd), box(0.12, 0.75, 0.12, 0.06, 0.375, 0, 0x8f969c)]),
    [Prop.delineator]: delineator(),
    [Prop.chevronLeft]: chevron(-1),
    [Prop.chevronRight]: chevron(1),
    // Bridge railing: handrail, knee rail and bottom rail on a post, galvanised steel.
    [Prop.railing]: merge([
      box(0.07, 0.05, 1, 0, 1.08, 0, 0x9aa1a6), box(0.04, 0.04, 1, 0, 0.6, 0, 0x8a9196), box(0.04, 0.04, 1, 0, 0.14, 0, 0x8a9196),
      box(0.05, 1.08, 0.05, 0, 0.54, 0.47, 0x7d8489),
    ]),
  };
}

/** The wire mesh of a chain-link piece: a plane across x (1 m along z, 1.6 m high) drawn by chainLinkMaterial. */
export function chainLinkPanel(): Geo {
  const g = new THREE.PlaneGeometry(1, 1.6).rotateY(Math.PI / 2).translate(0, 0.86, 0);
  g.deleteAttribute('uv');
  return g;
}

/**
 * Diamond wire mesh cut out in the fragment shader: 5 cm meshes along the piece (its z scale is its length, so the
 * pattern does not stretch) and up the panel. Where a mesh gets smaller than a few pixels the wires fade into an
 * even dither of the same coverage, so the fence reads as a grey veil far away instead of shimmering.
 */
export function chainLinkMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: CHAIN, roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMesh;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vMesh = vec2(position.z * length(instanceMatrix[2].xyz), position.y);
      #else
        vMesh = position.zy;
      #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMesh;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      {
        vec2 q = vec2(vMesh.x + vMesh.y, vMesh.x - vMesh.y) / 0.07;
        vec2 f = abs(fract(q) - 0.5);
        float d = 0.5 - max(f.x, f.y);
        float px = max(max(fwidth(q.x), fwidth(q.y)), 1e-4);
        float cov = clamp((0.05 - d) / px + 0.5, 0.0, 1.0);
        cov = mix(cov, 0.32, smoothstep(0.15, 0.6, px));
        float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        if (cov < dither * 0.98 + 0.01) discard;
      }`);
  };
  mat.customProgramCacheKey = () => 'chainLink';
  return mat;
}
