// Turns a downloaded car model (e.g. a CC-BY GLB from Sketchfab, kept in assets-src/cars/<id>/) into a player car
// with the node layout src/vehicle/sportsCarGlb.ts loads, like the Blender cars (tools/blender/make_gt.py):
//   car (extras: name, length, width, wheel{front, rear, track, radius, width}, source), lod0..2,
//   exhaust_L/R, headlight_L/R, wheel (wheel_lod0/1, the rear left wheel centred, facing +x), caliper.
// Steps: bake every node transform into car space (ground at y = 0, +z forward, +x left, metres), sort the parts
// into body, wheels and calipers (assets-src/cars/<id>/car.json), split the painted body texture into "paint"
// (the game's colour-changeable lacquer) and the rest, join by material, simplify for LOD 1/2, WebP textures,
// Meshopt. Run: node tools/import-car.ts <id> [--info]   →   public/models/cars/<id>.glb
import { type Document, type Material, type Node, NodeIO, type Primitive, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, joinPrimitives, metalRough, prune, reorder, simplifyPrimitive, textureCompress, transformPrimitive, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import * as THREE from 'three';
import { commonest, hex, sampleTriangles } from './texSample.ts';

interface CarConfig {
  /** Shown in the menu (extras.name). */
  name: string;
  /** Source credit, written into the extras (CREDITS.md has the full line). */
  credit: string;
  /** Which way the car points in the source file, in its world space. */
  forward: '+x' | '-x' | '+z' | '-z';
  /** Uniform scale to metres, or the real overall length the car is scaled to. */
  scale?: number;
  length?: number;
  /** Regexes on the node path (ancestor names joined by "/", mesh name last). */
  drop?: string;
  /** Tyres, rims and discs: everything that spins. Sorted to the nearest corner. */
  wheels: string;
  calipers?: string;
  /** Parts that become the head- and brake-light material of the game (they light up at night / when braking). */
  head?: string;
  brake?: string;
  /** Material names whose meshes are split into paint and the rest by the colour of the base texture. */
  paint: { materials: string[]; key?: string; tolerance?: number; whole?: boolean };
  /** Material names renamed "tyre" (they cast shadows like the Blender cars' tyres). */
  tyre?: string[];
  /** Dropped from LOD 2 (interior, engine bay: not visible from 80 m). */
  hidden?: string[];
  /** Tailpipe ends in car space; without them the rear-most point of the exhaust parts is used. */
  exhausts?: [number, number, number][];
  exhaust?: string;
  /** Triangle ratios for LOD 1 and 2. */
  lod?: [number, number];
}

const id = process.argv[2];
const INFO = process.argv.includes('--info');
if (!id) throw new Error('Aufruf: node tools/import-car.ts <id> [--info]');
const DIR = join('assets-src/cars', id);
const cfg = JSON.parse(readFileSync(join(DIR, 'car.json'), 'utf8')) as CarConfig;
const src = readdirSync(DIR).find((f) => f.endsWith('.glb'));
if (!src) throw new Error(`${DIR}: keine GLB`);
const OUT = `public/models/cars/${id}.glb`;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(join(DIR, src));
const root = doc.getRoot();
if (root.listExtensionsUsed().some((e) => e.extensionName === 'KHR_materials_pbrSpecularGlossiness')) await doc.transform(metalRough());

const re = (s?: string) => (s ? new RegExp(s, 'i') : null);
const DROP = re(cfg.drop), WHEELS = re(cfg.wheels)!, CALIPERS = re(cfg.calipers), HEAD = re(cfg.head), BRAKE = re(cfg.brake), EXHAUST = re(cfg.exhaust);

/** Source world space → car space without the final offset: forward to +z, y stays up. */
const yaw = { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 }[cfg.forward];
const orient = new THREE.Matrix4().makeRotationY(yaw);

interface Part {
  path: string;
  prim: Primitive;
  kind: 'body' | 'wheel' | 'caliper';
  box: THREE.Box3;
}

function pathOf(n: Node) {
  const names: string[] = [];
  for (let p: Node | null = n; p; p = p.getParentNode()) names.unshift(p.getName());
  return names.join('/') + '/' + (n.getMesh()?.getName() ?? '');
}

function boxOf(prim: Primitive) {
  const p = prim.getAttribute('POSITION')!;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const el: number[] = [];
  for (let i = 0; i < p.getCount(); i++) box.expandByPoint(v.fromArray(p.getElement(i, el)));
  return box;
}

const parts: Part[] = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const path = pathOf(node);
  if (DROP?.test(path)) continue;
  const kind = WHEELS.test(path) ? 'wheel' : CALIPERS?.test(path) ? 'caliper' : 'body';
  const world = orient.clone().multiply(new THREE.Matrix4().fromArray(node.getWorldMatrix()));
  for (const src of mesh.listPrimitives()) {
    if (src.getMode() !== 4) continue;
    // Own copy of the vertex streams: instanced meshes share them, and every copy gets its own transform.
    const prim = src.clone();
    compactPrimitive(prim);
    for (const sem of prim.listSemantics()) if (!/^(POSITION|NORMAL|TEXCOORD_\d)$/.test(sem)) prim.setAttribute(sem, null);
    transformPrimitive(prim, world.elements as unknown as Parameters<typeof transformPrimitive>[1]);
    let mat = prim.getMaterial();
    if (HEAD?.test(path)) mat = named(doc, 'head');
    else if (BRAKE?.test(path)) mat = named(doc, 'brake');
    else if (mat && cfg.tyre?.includes(mat.getName())) mat.setName('tyre');
    prim.setMaterial(mat);
    parts.push({ path, prim, kind, box: boxOf(prim) });
  }
}

/** A plain material the loader swaps for its own (paint, head, brake …). */
function named(d: Document, name: string): Material {
  return d.getRoot().listMaterials().find((m) => m.getName() === name) ?? d.createMaterial(name).setRoughnessFactor(0.4).setMetallicFactor(0);
}

// Scale: fixed, or to the stated length.
const all = new THREE.Box3();
for (const p of parts) all.union(p.box);
const scale = cfg.scale ?? (cfg.length ? cfg.length / (all.max.z - all.min.z) : 1);

// Corners: left (+x) / right, front / rear around the middle of all wheel parts.
const wheelBox = new THREE.Box3();
for (const p of parts) if (p.kind === 'wheel') wheelBox.union(p.box);
const mid = wheelBox.getCenter(new THREE.Vector3());
const corner = (b: THREE.Box3) => {
  const c = b.getCenter(new THREE.Vector3());
  return (c.z > mid.z ? 0 : 2) + (c.x > mid.x ? 0 : 1); // 0 FL, 1 FR, 2 RL, 3 RR
};
const corners = [0, 1, 2, 3].map(() => new THREE.Box3());
for (const p of parts) if (p.kind === 'wheel') corners[corner(p.box)].union(p.box);
const centres = corners.map((b) => b.getCenter(new THREE.Vector3()));
if (corners.some((b) => b.isEmpty())) throw new Error('Räder: nicht an allen vier Ecken Teile gefunden');

// Car space: ground under the tyres, x centred on the track, z on the body.
const offset = new THREE.Vector3((centres[0].x + centres[1].x + centres[2].x + centres[3].x) / 4, wheelBox.min.y, (all.min.z + all.max.z) / 2);
const toCar = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z));
const toCarV = (v: THREE.Vector3) => v.clone().applyMatrix4(toCar);
const fl = toCarV(centres[0]), fr = toCarV(centres[1]), rl = toCarV(centres[2]), rr = toCarV(centres[3]);
// Size from a rear wheel: the front ones may be posed with steering lock.
const sz = corners[2].getSize(new THREE.Vector3()).multiplyScalar(scale);
const body = all.clone().applyMatrix4(toCar);
const geometry = {
  name: cfg.name,
  length: round(body.max.z - body.min.z),
  // Body without the mirrors: at most a hand's width past the tyres.
  width: round(Math.min(body.max.x - body.min.x, (fl.x - fr.x + rl.x - rr.x) / 2 + sz.x + 0.2)),
  wheel: {
    front: round((fl.z + fr.z) / 2),
    rear: round((rl.z + rr.z) / 2),
    track: round((fl.x - fr.x + rl.x - rr.x) / 2),
    radius: round(sz.y / 2),
    width: round(sz.x),
  },
  source: cfg.credit,
};
function round(v: number) {
  return Math.round(v * 1000) / 1000;
}
console.log(`${id}: ${parts.length} Teile, Maßstab ${scale.toFixed(4)}`, JSON.stringify(geometry));
if (INFO) {
  for (const [i, c] of [fl, fr, rl, rr].entries()) console.log(['FL', 'FR', 'RL', 'RR'][i], c.toArray().map((v) => v.toFixed(3)).join(' '));
  for (const p of parts.filter((q) => q.kind !== 'body')) console.log(p.kind, corner(p.box), p.path);
  const mats = new Map<string, number>();
  for (const p of parts) mats.set(p.prim.getMaterial()?.getName() ?? '-', (mats.get(p.prim.getMaterial()?.getName() ?? '-') ?? 0) + (p.prim.getIndices()?.getCount() ?? 0) / 3);
  console.log([...mats].map(([k, v]) => `${k}: ${v}`).join('\n'));
  process.exit(0);
}

for (const p of parts) {
  transformPrimitive(p.prim, toCar.elements as unknown as Parameters<typeof transformPrimitive>[1]);
  p.box.applyMatrix4(toCar);
}

// Paint: triangles whose base-texture colour is close to the body colour get the game's lacquer.
const paintMat = named(doc, 'paint');
/** Paint colour per source material: given, or the texel colour covering the most surface (the body). */
const paintKey = new Map<Material, number[]>();

const toSplit: { part: Part; mat: Material; s: NonNullable<Awaited<ReturnType<typeof sampleTriangles>>> }[] = [];
for (const p of parts.filter((q) => q.kind === 'body')) {
  const mat = p.prim.getMaterial();
  if (!mat || !cfg.paint.materials.includes(mat.getName())) continue;
  if (cfg.paint.whole || !mat.getBaseColorTexture()) {
    p.prim.setMaterial(paintMat);
    continue;
  }
  const s = await sampleTriangles(p.prim, mat);
  if (s) toSplit.push({ part: p, mat, s });
}
for (const mat of new Set(toSplit.map((t) => t.mat))) {
  const mine = toSplit.filter((t) => t.mat === mat);
  paintKey.set(mat, cfg.paint.key ? hex(cfg.paint.key) : commonest(mine.flatMap((t) => t.s.colours), mine.flatMap((t) => t.s.areas)));
  console.log(`Lack in ${mat.getName()}: rgb(${paintKey.get(mat)})`);
}
for (const { part: p, mat, s } of toSplit) {
  const key = paintKey.get(mat)!, tol = (cfg.paint.tolerance ?? 0.15) * 255;
  const { idx, colours } = s;
  const keep: number[] = [], paint: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const d = Math.hypot(colours[t] - key[0], colours[t + 1] - key[1], colours[t + 2] - key[2]);
    (d < tol ? paint : keep).push(idx[t], idx[t + 1], idx[t + 2]);
  }
  if (!paint.length) continue;
  if (!keep.length) {
    p.prim.setMaterial(paintMat);
    continue;
  }
  const painted = p.prim.clone().setMaterial(paintMat);
  painted.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(paint)).setBuffer(root.listBuffers()[0]));
  compactPrimitive(painted);
  p.prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(keep)).setBuffer(root.listBuffers()[0]));
  compactPrimitive(p.prim);
  parts.push({ ...p, prim: painted });
}

/** Joins the primitives by material (and vertex layout): one draw call per material. */
function joinAll(prims: Primitive[]) {
  const groups = new Map<string, Primitive[]>();
  for (const p of prims) {
    const sig = `${p.getMaterial()?.getName()}#${root.listMaterials().indexOf(p.getMaterial()!)}|${p.listSemantics().sort().join(',')}`;
    groups.set(sig, [...(groups.get(sig) ?? []), p]);
  }
  return [...groups.values()].map((g) => {
    const j = g.length > 1 ? joinPrimitives(g) : g[0];
    weldPrimitive(j);
    return j;
  });
}
function meshNode(name: string, prims: Primitive[]) {
  const mesh = doc.createMesh(name);
  for (const p of prims) mesh.addPrimitive(p);
  return doc.createNode(name).setMesh(mesh);
}
function simplified(prims: Primitive[], ratio: number) {
  return prims.map((p) => {
    const c = p.clone();
    compactPrimitive(c);
    return simplifyPrimitive(c, { simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false });
  });
}
const tris = (prims: Primitive[]) => prims.reduce((n, p) => n + p.getIndices()!.getCount() / 3, 0);

const [r1, r2] = cfg.lod ?? [0.3, 0.08];
const lod0 = joinAll(parts.filter((p) => p.kind === 'body').map((p) => p.prim));
const lod1 = simplified(lod0, r1);
const lod2 = simplified(lod0.filter((p) => !cfg.hidden?.includes(p.getMaterial()?.getName() ?? '')), r2);

// Rear left wheel (never posed with steering lock) and front left caliper, each moved to its wheel centre; the
// loader mirrors them for the right side. Car space: front +z, left +x.
const at = (v: THREE.Vector3) => new THREE.Matrix4().makeTranslation(-v.x, -v.y, -v.z).elements as unknown as Parameters<typeof transformPrimitive>[1];
const leftParts = (kind: Part['kind'], front: boolean) => parts.filter((p) => {
  if (p.kind !== kind) return false;
  const c = p.box.getCenter(new THREE.Vector3());
  return c.x > 0 && c.z > (fl.z + rl.z) / 2 === front;
});
const wheelPrims = joinAll(leftParts('wheel', false).map((p) => p.prim));
for (const p of wheelPrims) transformPrimitive(p, at(rl));
const caliperPrims = joinAll(leftParts('caliper', true).map((p) => p.prim));
for (const p of caliperPrims) transformPrimitive(p, at(fl));

// Effect anchors.
const anchor = (name: string, v: THREE.Vector3) => doc.createNode(name).setTranslation([v.x, v.y, v.z]);
const lights = parts.filter((p) => p.prim.getMaterial() === named(doc, 'head'));
const lightAt = (left: boolean) => {
  const b = new THREE.Box3();
  for (const p of lights) if (p.box.getCenter(new THREE.Vector3()).x > 0 === left) b.union(p.box);
  return b.isEmpty() ? new THREE.Vector3(left ? 0.6 : -0.6, 0.65, body.max.z - 0.15) : b.getCenter(new THREE.Vector3()).setZ(b.max.z);
};
let exhausts = cfg.exhausts?.map((e) => new THREE.Vector3(...e));
if (!exhausts && EXHAUST) {
  const b = new THREE.Box3();
  for (const p of parts) if (EXHAUST.test(p.path)) b.union(p.box);
  const c = b.getCenter(new THREE.Vector3()).setZ(b.min.z);
  exhausts = [c.clone().setX(c.x + 0.05), c.clone().setX(c.x - 0.05)];
}
exhausts ??= [new THREE.Vector3(0.45, 0.3, body.min.z), new THREE.Vector3(-0.45, 0.3, body.min.z)];

// New scene: only the car.
const scene = root.listScenes()[0];
for (const n of scene.listChildren()) scene.removeChild(n);
const car = doc.createNode('car').setExtras(geometry);
scene.addChild(car);
car.addChild(meshNode('lod0', lod0)).addChild(meshNode('lod1', lod1)).addChild(meshNode('lod2', lod2));
const wheel = doc.createNode('wheel');
wheel.addChild(meshNode('wheel_lod0', wheelPrims)).addChild(meshNode('wheel_lod1', simplified(wheelPrims, 0.3)));
car.addChild(wheel).addChild(caliperPrims.length ? meshNode('caliper', caliperPrims) : doc.createNode('caliper'));
car.addChild(anchor('exhaust_L', exhausts[0])).addChild(anchor('exhaust_R', exhausts[1]));
car.addChild(anchor('headlight_L', lightAt(true))).addChild(anchor('headlight_R', lightAt(false)));
for (const n of root.listNodes()) if (n !== car && !car.listChildren().includes(n) && !wheel.listChildren().includes(n)) n.dispose();
for (const s of root.listScenes()) if (s !== scene) s.dispose();

await doc.transform(
  prune({ keepLeaves: true }),
  // Not the materials: paint, head and brake look alike here (the loader tells them apart by name).
  dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }),
  // WebP, at most 1024 px (the sources ship 1K–2K maps).
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
  reorder({ encoder: MeshoptEncoder }),
);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
await io.write(OUT, doc);
console.log(`${OUT}: ${Math.round(statSync(OUT).size / 1024)} KB, LOD 0/1/2: ${tris(lod0)}/${tris(lod1)}/${tris(lod2)} Dreiecke, Rad ${tris(wheelPrims)}`);
