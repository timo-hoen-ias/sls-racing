// Turns the "Generic passenger car pack" (Comrade1280, CC BY 4.0, assets-src/cars/passenger-pack/) into traffic and
// parked cars for src/traffic/vehicleGlb.ts: one variant per car, with the five instanced parts of
// vehicleModels.ts ("<kind>-<variant>_<paint|detail|lights|brake|blink>" plus "_lod1" for paint and detail).
// The traffic draws untextured, instanced geometry, so the textures are baked into vertex colours: each triangle
// takes the texel under its centre. Body triangles in the body colour become paint (tinted per vehicle), red
// rear optics also the brake lights, amber optics the hazard lights. Real size; the game draws it at VEHICLE.scale.
// Run: node tools/import-traffic.ts [--info]   →   public/models/traffic-cars.glb
import { type Accessor, Document, type Material, type Node, NodeIO, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { quantize, reorder, simplifyPrimitive, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { commonest, sampleTriangles } from './texSample.ts';

const DIR = 'assets-src/cars/passenger-pack';
const OUT = 'public/models/traffic-cars.glb';
const INFO = process.argv.includes('--info');

/** Body node name → kind and variant in the game. */
const CARS: Record<string, [kind: 'car' | 'van', variant: string]> = {
  'Compact Body': ['car', 'compact'],
  'Coupe Body': ['car', 'coupe'],
  'Hatchback Body': ['car', 'hatchback'],
  'Sedan Body': ['car', 'saloon'],
  'Sport body': ['car', 'sport'],
  'Wagon Body': ['car', 'wagon'],
  'SUV Body': ['car', 'suv'],
  'Offroad Body': ['car', 'offroad'],
  'Pickup Body': ['van', 'pickup'], // 5.2 m: longer than the simulation's cars
  'minivan body': ['van', 'minivan'],
};
/** Linear colours like tools/blender/make_traffic.py: tinted glass, glowing brake and hazard lights. */
const GLASS = [0.012, 0.016, 0.022];
const BRAKE = [1, 0.023, 0.01];
const BLINK = [1, 0.352, 0];
/** Overlays sit this far out over the optics they light up (m). */
const PUSH = { brake: 0.006, blink: 0.008 };

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const src = await io.read(join(DIR, readdirSync(DIR).find((f) => f.endsWith('.glb'))!));

const world = (n: Node) => new THREE.Matrix4().fromArray(n.getWorldMatrix());
const centreOf = (n: Node) => new THREE.Vector3().setFromMatrixPosition(world(n));
const meshNodes = (n: Node): Node[] => [...(n.getMesh() ? [n] : []), ...n.listChildren().flatMap(meshNodes)];
const nodes = src.getRoot().listNodes();
const bodies = nodes.filter((n) => CARS[n.getName()]);
const wheels = nodes.filter((n) => /^Wheel_/.test(n.getName()) && !n.getMesh());

// Texel colours snap to 16 steps per channel so that neighbouring triangles share vertices after welding.
const srgb = (c: number) => { const v = Math.round((c / 255) * 15) / 15; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

/** Triangles of one part: positions, normals and a colour per triangle (flat, not indexed). */
class Soup {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  add(p: THREE.Vector3[], n: THREE.Vector3[], c: number[], push = 0) {
    for (let k = 0; k < 3; k++) {
      this.pos.push(p[k].x + n[k].x * push, p[k].y + n[k].y * push, p[k].z + n[k].z * push);
      this.nrm.push(n[k].x, n[k].y, n[k].z);
      this.col.push(c[0], c[1], c[2]);
    }
  }
  get tris() { return this.pos.length / 9; }
}

interface Tri { p: THREE.Vector3[]; n: THREE.Vector3[]; rgb: number[]; area: number; mat: Material }

const out = new Document();
const buffer = out.createBuffer();
const scene = out.createScene('traffic-cars');
const plain = out.createMaterial('vehicle');
const summary: string[] = [];

for (const body of bodies) {
  const [kind, variant] = CARS[body.getName()];
  // World space is metres (the pack's root carries the millimetre scale and the FBX rotation), y up.
  const bp = centreOf(body);
  const mine = wheels.filter((w) => centreOf(w).distanceTo(bp) < 3).sort((a, b) => centreOf(a).distanceTo(bp) - centreOf(b).distanceTo(bp)).slice(0, 4);
  const tris: Tri[] = [];
  for (const node of [...meshNodes(body), ...mine.flatMap(meshNodes)]) {
    const m = world(node);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    for (const prim of node.getMesh()!.listPrimitives()) {
      const mat = prim.getMaterial()!;
      const sampled = mat.getBaseColorTexture() ? await sampleTriangles(prim, mat) : null;
      const base = mat.getBaseColorFactor();
      const idx = prim.getIndices()!.getArray()!;
      const P = prim.getAttribute('POSITION')!, N = prim.getAttribute('NORMAL')!;
      const a: number[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        const p = [0, 1, 2].map((k) => new THREE.Vector3().fromArray(P.getElement(idx[t + k], a)).applyMatrix4(m));
        const n = [0, 1, 2].map((k) => new THREE.Vector3().fromArray(N.getElement(idx[t + k], a)).applyMatrix3(nm).normalize());
        const rgb = sampled ? sampled.colours.slice(t, t + 3) : base.slice(0, 3).map((c) => c * 255);
        tris.push({ p, n, rgb, area: new THREE.Triangle(p[0], p[1], p[2]).getArea(), mat });
      }
    }
  }
  // Car space: each body sits rotated differently, so the frame comes from its wheels. The long axis of the
  // four wheel centres (wheelbase is longer than the track) becomes z, and the red rear optics go to -z.
  const hubs = mine.map((w) => {
    const bb = new THREE.Box3();
    for (const n of meshNodes(w)) for (const prim of n.getMesh()!.listPrimitives()) {
      const P = prim.getAttribute('POSITION')!, m = world(n), a: number[] = [];
      for (let i = 0; i < P.getCount(); i++) bb.expandByPoint(new THREE.Vector3().fromArray(P.getElement(i, a)).applyMatrix4(m));
    }
    return bb.getCenter(new THREE.Vector3());
  });
  const mid = hubs.reduce((s, h) => s.add(h), new THREE.Vector3()).divideScalar(hubs.length);
  let sxx = 0, sxz = 0, szz = 0;
  for (const h of hubs) { const dx = h.x - mid.x, dz = h.z - mid.z; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
  let heading = 0.5 * Math.atan2(2 * sxz, sxx - szz); // angle of the long axis from +x
  const redOptics = tris.filter((t) => /^Optics/.test(t.mat.getName()) && t.rgb[0] > 1.6 * t.rgb[1] && t.rgb[0] > 90);
  const along = (v: THREE.Vector3) => (v.x - mid.x) * Math.cos(heading) + (v.z - mid.z) * Math.sin(heading);
  const redAlong = redOptics.reduce((s, t) => s + along(t.p[0]), 0) / Math.max(1, redOptics.length);
  if (redAlong > 0) heading += Math.PI; // +axis points to the front
  // Rotate the axis (cos h, 0, sin h) onto +z.
  const fix = new THREE.Matrix4().makeRotationY(heading - Math.PI / 2).multiply(new THREE.Matrix4().makeTranslation(-mid.x, 0, -mid.z));
  const box = new THREE.Box3();
  for (const t of tris) for (const v of t.p) box.expandByPoint(v.applyMatrix4(fix));
  const nfix = new THREE.Matrix3().getNormalMatrix(fix);
  for (const t of tris) for (const n of t.n) n.applyMatrix3(nfix).normalize();
  const shift = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  for (const t of tris) for (const v of t.p) v.add(shift);
  box.translate(shift);
  const size = box.getSize(new THREE.Vector3());
  if (INFO) {
    // Which end is the front: the lamps there are white, at the back red.
    const optics = tris.filter((t) => /^Optics/.test(t.mat.getName()));
    const red = optics.filter((t) => t.rgb[0] > 1.6 * t.rgb[1] && t.rgb[0] > 90);
    const z = (l: Tri[]) => (l.length ? l.reduce((s, t) => s + t.p[0].z, 0) / l.length : NaN);
    console.log(variant, size.toArray().map((v) => v.toFixed(2)).join(' × '), `rote Leuchten z ≈ ${z(red).toFixed(2)}, alle ${z(optics).toFixed(2)}`);
    continue;
  }

  // Paint: the colour covering most of the body material.
  const bodyTris = tris.filter((t) => /^Body/.test(t.mat.getName()) && t.mat.getBaseColorTexture());
  const key = commonest(bodyTris.flatMap((t) => t.rgb), bodyTris.map((t) => t.area));
  const parts = { paint: new Soup(), detail: new Soup(), lights: new Soup(), brake: new Soup(), blink: new Soup() };
  for (const t of tris) {
    const name = t.mat.getName();
    const lin = t.rgb.map(srgb);
    if (/^Glass/.test(name)) parts.detail.add(t.p, t.n, GLASS);
    else if (/^Optics/.test(name)) {
      const [r, g, b] = t.rgb;
      const red = r > 1.6 * g && r > 90, amber = r > 150 && g > 60 && g < 0.75 * r && b < 0.45 * g;
      const back = t.p[0].z < 0;
      parts.lights.add(t.p, t.n, lin);
      if (red && back) parts.brake.add(t.p, t.n, BRAKE, PUSH.brake);
      if (amber) parts.blink.add(t.p, t.n, BLINK, PUSH.blink);
    } else if (/^Body/.test(name) && Math.hypot(t.rgb[0] - key[0], t.rgb[1] - key[1], t.rgb[2] - key[2]) < 0.15 * 255) parts.paint.add(t.p, t.n, [1, 1, 1]);
    else parts.detail.add(t.p, t.n, lin);
  }
  // No amber in the optics: the outer ends of the lamp clusters flash.
  if (!parts.blink.tris) {
    const l = parts.lights;
    let outer = 0;
    for (let i = 0; i < l.pos.length; i += 3) outer = Math.max(outer, Math.abs(l.pos[i]));
    for (let i = 0; i < l.pos.length; i += 9) {
      const x = Math.abs(l.pos[i]);
      if (x < outer - 0.2) continue;
      const p = [0, 3, 6].map((k) => new THREE.Vector3(l.pos[i + k], l.pos[i + k + 1], l.pos[i + k + 2]));
      const n = [0, 3, 6].map((k) => new THREE.Vector3(l.nrm[i + k], l.nrm[i + k + 1], l.nrm[i + k + 2]));
      parts.blink.add(p, n, BLINK, PUSH.blink);
    }
  }

  const acc = (data: ArrayLike<number>): Accessor => out.createAccessor().setType('VEC3').setArray(new Float32Array(data)).setBuffer(buffer);
  const prim = (s: Soup, colours: boolean) => {
    const p = out.createPrimitive().setMaterial(plain).setAttribute('POSITION', acc(s.pos)).setAttribute('NORMAL', acc(s.nrm));
    if (colours) p.setAttribute('COLOR_0', acc(s.col));
    weldPrimitive(p);
    return p;
  };
  // The far level: hard edges and colour seams split the vertices and stop the simplifier, so it welds positions
  // with coarser colours only, simplifies, and smooths the normals afterwards (seen from 60 m and further).
  const far = (s: Soup, colours: boolean) => {
    const p = out.createPrimitive().setMaterial(plain).setAttribute('POSITION', acc(s.pos));
    if (colours) p.setAttribute('COLOR_0', acc(s.col.map((c) => Math.round(c ** (1 / 2.2) * 5) ** 2.2 / 5 ** 2.2)));
    weldPrimitive(p);
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0.3, error: 0.02 });
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(p.getAttribute('POSITION')!.getArray() as Float32Array, 3));
    g.setIndex(new THREE.BufferAttribute(p.getIndices()!.getArray() as Uint32Array, 1));
    g.computeVertexNormals();
    return p.setAttribute('NORMAL', acc(g.getAttribute('normal').array));
  };
  const add = (name: string, p: Primitive) => scene.addChild(out.createNode(name).setMesh(out.createMesh(name).addPrimitive(p)));
  const id = `${kind}-${variant}`;
  for (const [part, soup] of Object.entries(parts)) {
    add(`${id}_${part}`, prim(soup, part !== 'paint'));
    if (part === 'paint' || part === 'detail') add(`${id}_${part}_lod1`, far(soup, part !== 'paint'));
  }
  summary.push(`${id}: ${size.toArray().map((v) => v.toFixed(2)).join(' × ')} m, ${Object.entries(parts).map(([k, s]) => `${k} ${s.tris}`).join(', ')}`);
}

if (!INFO) {
  out.getRoot().getAsset().extras = { source: 'Generic passenger car pack von Comrade1280, CC BY 4.0, sketchfab.com/3d-models/20f9af9b8a404d5cb022ac6fe87f21f5' };
  // Positions stay float (vehicleGlb.ts bakes node transforms into them); normals and colours fit in bytes.
  await out.transform(reorder({ encoder: MeshoptEncoder }), quantize({ pattern: /^(NORMAL|COLOR_0)$/, quantizeNormal: 8, quantizeColor: 8 }));
  out.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  await io.write(OUT, out);
  console.log(summary.join('\n'));
  console.log(`${OUT}: ${Math.round(statSync(OUT).size / 1024)} KB`);
}
