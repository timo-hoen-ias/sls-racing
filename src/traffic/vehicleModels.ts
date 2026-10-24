import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { KINDS, type VehicleKind } from './trafficSim.ts';

// Low-poly traffic vehicles for instancing. Model space: ground at y = 0, +z forward, +x left.
// Every model has four parts: paint (tinted per instance), fixed-colour details (glass, tyres, trim),
// lights (head and tail lights, always lit), brake lights and hazard lights (shown on demand).

export interface VehicleParts {
  paint: THREE.BufferGeometry;
  detail: THREE.BufferGeometry;
  lights: THREE.BufferGeometry;
  brake: THREE.BufferGeometry;
  blink: THREE.BufferGeometry;
}

type V3 = [number, number, number];

function tint(g: THREE.BufferGeometry, hex: number) {
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Box from y0 to y1, centred on x, from z0 to z1; the top can be narrower and shorter (cabin taper). */
function box(w: number, y0: number, y1: number, z0: number, z1: number, o: { topW?: number; topZ0?: number; topZ1?: number; x?: number } = {}) {
  const g = new THREE.BoxGeometry(w, y1 - y0, z1 - z0);
  g.translate(o.x ?? 0, (y0 + y1) / 2, (z0 + z1) / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const top = y1 - 1e-4;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < top) continue;
    if (o.topW !== undefined) p.setX(i, (o.x ?? 0) + Math.sign(p.getX(i) - (o.x ?? 0)) * o.topW / 2);
    if (o.topZ0 !== undefined && p.getZ(i) < (z0 + z1) / 2) p.setZ(i, o.topZ0);
    if (o.topZ1 !== undefined && p.getZ(i) > (z0 + z1) / 2) p.setZ(i, o.topZ1);
  }
  g.computeVertexNormals();
  return g.toNonIndexed();
}

function wheels(r: number, w: number, axles: number[], track: number) {
  const out: THREE.BufferGeometry[] = [];
  for (const z of axles)
    for (const side of [1, -1]) {
      const g = new THREE.CylinderGeometry(r, r, w, 12);
      g.rotateZ(Math.PI / 2);
      g.translate(side * track / 2, r, z);
      out.push(g.toNonIndexed());
    }
  return out;
}

const merge = (parts: THREE.BufferGeometry[]) => {
  for (const p of parts) for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') p.deleteAttribute(name);
  const g = mergeGeometries(parts)!;
  g.computeBoundingSphere();
  return g;
};

/** Small light boxes at mirrored positions (x is mirrored to ±x). */
function lamps(size: V3, at: V3[], hex: number) {
  return at.flatMap(([x, y, z]) => [1, -1].map((s) => tint(box(size[0], y - size[1] / 2, y + size[1] / 2, z - size[2] / 2, z + size[2] / 2, { x: s * x }), hex)));
}

const GLASS = 0x1d242c;
const TYRE = 0x18181a;
const TRIM = 0x2a2b2e;
const HEAD = 0xfff6e0;
const TAIL = 0x7a0d0d;

function car(): VehicleParts {
  const { length: L, width: W } = KINDS.car;
  const f = L / 2, r = -L / 2;
  const paint = [
    box(W, 0.3, 0.86, r + 0.05, f - 0.05, { topZ0: r + 0.15, topZ1: f - 0.25 }),
    box(W - 0.22, 1.33, 1.42, r + 0.95, f - 1.75, { topW: W - 0.36 }),
  ];
  const detail = [
    tint(box(W - 0.12, 0.86, 1.33, r + 0.55, f - 1.25, { topW: W - 0.22, topZ0: r + 0.95, topZ1: f - 1.75 }), GLASS),
    tint(box(W + 0.02, 0.22, 0.42, f - 0.12, f + 0.02), TRIM),
    tint(box(W + 0.02, 0.22, 0.42, r - 0.02, r + 0.12), TRIM),
    ...wheels(0.32, 0.24, [f - 0.95, r + 0.95], W - 0.22).map((g) => tint(g, TYRE)),
  ];
  return {
    paint: merge(paint),
    detail: merge(detail),
    lights: merge([...lamps([0.36, 0.1, 0.06], [[W / 2 - 0.3, 0.72, f - 0.04]], HEAD), ...lamps([0.32, 0.1, 0.05], [[W / 2 - 0.28, 0.76, r + 0.03]], TAIL)]),
    brake: merge(lamps([0.3, 0.09, 0.04], [[W / 2 - 0.28, 0.76, r]], 0xff2a1a)),
    blink: merge(lamps([0.1, 0.08, 0.06], [[W / 2 - 0.06, 0.72, f - 0.03], [W / 2 - 0.06, 0.76, r + 0.02]], 0xffa000)),
  };
}

function van(): VehicleParts {
  const { length: L, width: W, height: H } = KINDS.van;
  const f = L / 2, r = -L / 2;
  const paint = [
    box(W, 0.32, H, r, f - 0.95, { topZ1: f - 1.15 }),
    box(W, 0.32, 1.05, f - 0.95, f, { topZ1: f - 0.15 }),
  ];
  const detail = [
    tint(box(W + 0.02, 1.05, H - 0.3, f - 1.25, f - 0.7, { topZ1: f - 1.1 }), GLASS),
    tint(box(W + 0.02, 0.22, 0.4, f - 0.1, f + 0.02), TRIM),
    tint(box(W + 0.02, 0.22, 0.4, r - 0.02, r + 0.1), TRIM),
    ...wheels(0.34, 0.26, [f - 0.85, r + 1.05], W - 0.2).map((g) => tint(g, TYRE)),
  ];
  return {
    paint: merge(paint),
    detail: merge(detail),
    lights: merge([...lamps([0.32, 0.12, 0.06], [[W / 2 - 0.28, 0.88, f - 0.03]], HEAD), ...lamps([0.18, 0.4, 0.05], [[W / 2 - 0.12, 0.95, r - 0.01]], TAIL)]),
    brake: merge(lamps([0.16, 0.36, 0.04], [[W / 2 - 0.12, 0.95, r - 0.03]], 0xff2a1a)),
    blink: merge(lamps([0.1, 0.1, 0.06], [[W / 2 - 0.06, 0.88, f - 0.02], [W / 2 - 0.12, 1.25, r - 0.02]], 0xffa000)),
  };
}

function bus(): VehicleParts {
  const { length: L, width: W, height: H } = KINDS.bus;
  const f = L / 2, r = -L / 2;
  const paint = [box(W, 0.35, H, r, f)];
  const detail = [
    tint(box(W + 0.03, 1.25, H - 0.3, r + 0.4, f - 0.3), GLASS),
    tint(box(W - 0.2, 0.9, H - 0.2, f - 0.01, f + 0.03), GLASS),
    tint(box(W - 0.4, 1.4, H - 0.4, r - 0.03, r + 0.01), GLASS),
    tint(box(W + 0.02, 0.3, 0.6, f - 0.05, f + 0.05), TRIM),
    ...wheels(0.5, 0.32, [f - 2.6, r + 3.2], W - 0.3).map((g) => tint(g, TYRE)),
  ];
  return {
    paint: merge(paint),
    detail: merge(detail),
    lights: merge([...lamps([0.3, 0.15, 0.06], [[W / 2 - 0.3, 0.7, f + 0.03]], HEAD), ...lamps([0.2, 0.5, 0.05], [[W / 2 - 0.15, 1.0, r - 0.02]], TAIL)]),
    brake: merge(lamps([0.18, 0.46, 0.04], [[W / 2 - 0.15, 1.0, r - 0.04]], 0xff2a1a)),
    blink: merge(lamps([0.12, 0.12, 0.06], [[W / 2 - 0.08, 0.7, f + 0.04], [W / 2 - 0.15, 1.4, r - 0.04]], 0xffa000)),
  };
}

function truck(): VehicleParts {
  const { length: L, width: W, height: H } = KINDS.truck;
  const f = L / 2, r = -L / 2;
  const cab = 2.3;
  const paint = [box(W - 0.05, 0.6, 2.9, f - cab, f, { topZ1: f - 0.15 }), box(W, 1.0, H, r, f - cab - 0.15)];
  const detail = [
    tint(box(W - 0.3, 1.8, 2.7, f - 0.1, f + 0.01, { topZ1: f - 0.2 }), GLASS),
    tint(box(W - 0.6, 0.55, 1.0, r + 0.3, f - cab), TRIM),
    tint(box(W, 0.4, 0.7, f - 0.08, f + 0.04), TRIM),
    ...wheels(0.52, 0.36, [f - 1.4, r + 2.4, r + 1.1], W - 0.4).map((g) => tint(g, TYRE)),
  ];
  return {
    paint: merge(paint),
    detail: merge(detail),
    lights: merge([...lamps([0.3, 0.14, 0.06], [[W / 2 - 0.3, 0.85, f + 0.03]], HEAD), ...lamps([0.25, 0.14, 0.05], [[W / 2 - 0.2, 1.1, r - 0.02]], TAIL)]),
    brake: merge(lamps([0.22, 0.12, 0.04], [[W / 2 - 0.2, 1.1, r - 0.04]], 0xff2a1a)),
    blink: merge(lamps([0.12, 0.12, 0.06], [[W / 2 - 0.08, 0.85, f + 0.04], [W / 2 - 0.45, 1.1, r - 0.04]], 0xffa000)),
  };
}

export function buildVehicleParts(): Record<VehicleKind, VehicleParts> {
  return { car: car(), van: van(), bus: bus(), truck: truck() };
}
