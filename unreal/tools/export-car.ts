// Exports the web game's player car (public/models/sportscar.glb, built by tools/blender/make_sportscar.py) for
// Unreal: the meshopt-compressed GLB becomes plain GLBs Interchange can read, one static mesh per part and detail
// level, still in the web's model space (metres, ground at y = 0, +z forward, +x left; sportsCarGlb.ts):
//   SM_SlsCar_Body_LOD0..2  shell + details + mirrors, plate, splitter, wing (the parts ride on every level)
//   SM_SlsCar_Wheel_LOD0..1 one wheel facing +x (the left side; the right wheels are mirrored)
//   SM_SlsCar_Caliper       the brake caliper (steers with the wheel, does not spin)
// car.json lists the materials (glTF base colour, metal, roughness, emission) and the hooks (exhausts, headlights).
// The Unreal setup (sls_setup.py, car part) imports them into /Game/Cars and builds the materials; ASlsCarPawn
// scales them by VEHICLE.scale (0.8) and puts them on the physics body like carView.ts.
//   node unreal/tools/export-car.ts [--src=public/models/sportscar.glb] [--out=unreal/SlsRacing/Data/car]
import { Document, NodeIO, type Material, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, joinPrimitives, prune } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const SRC = arg('src', 'public/models/sportscar.glb');
const OUT = arg('out', 'unreal/SlsRacing/Data/car');
mkdirSync(OUT, { recursive: true });

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const PARTS = ['mirrorL', 'mirrorR', 'plate', 'splitter', 'wing'];
const OUTPUTS: Record<string, string[]> = {
  SM_SlsCar_Body_LOD0: ['shell_lod0', 'details', ...PARTS],
  SM_SlsCar_Body_LOD1: ['shell_lod1', 'details_lod1', ...PARTS],
  SM_SlsCar_Body_LOD2: ['shell_lod2', ...PARTS],
  SM_SlsCar_Wheel_LOD0: ['wheel_lod0'],
  SM_SlsCar_Wheel_LOD1: ['wheel_lod1'],
  SM_SlsCar_Caliper: ['caliper'],
};

/** World matrix of a node is identity for every mesh node of the car (checked here, so a changed GLB fails loudly). */
function assertIdentity(n: Node) {
  for (let p: Node | null = n; p; p = p.getParentNode()) {
    const m = p.getMatrix();
    if (m.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-6)) throw new Error(`sportscar.glb: Knoten "${p.getName()}" ist verschoben/gedreht – export-car.ts erwartet Modellraum`);
  }
}

const materials = new Map<string, object>();
const describe = (m: Material | null) => {
  if (!m || materials.has(m.getName())) return;
  const c = m.getBaseColorFactor();
  const e = m.getEmissiveFactor();
  materials.set(m.getName(), {
    name: m.getName(), color: c.slice(0, 3), alpha: c[3], metal: m.getMetallicFactor(), rough: m.getRoughnessFactor(),
    emissive: e, blend: m.getAlphaMode(), doubleSided: m.getDoubleSided(),
  });
};

for (const [name, nodes] of Object.entries(OUTPUTS)) {
  const doc: Document = await io.read(SRC);
  const root = doc.getRoot();
  const all = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const mesh = doc.createMesh(name);
  for (const nn of nodes) {
    const n = all.get(nn);
    const m = n?.getMesh();
    if (!n || !m) throw new Error(`sportscar.glb: Mesh-Knoten "${nn}" fehlt`);
    assertIdentity(n);
    for (const p of m.listPrimitives()) describe(p.getMaterial());
  }
  // One primitive per material (Interchange reported a bad mesh description for the split primitives) …
  const byMat = new Map<Material | null, ReturnType<Document['createPrimitive']>[]>();
  for (const nn of nodes) for (const p of all.get(nn)!.getMesh()!.listPrimitives()) byMat.set(p.getMaterial(), [...(byMat.get(p.getMaterial()) ?? []), p]);
  for (const prims of byMat.values()) mesh.addPrimitive(prims.length > 1 ? joinPrimitives(prims) : prims[0]);
  // One node with all primitives: Interchange makes one static mesh with one slot per material.
  const scene = doc.createScene(name).addChild(doc.createNode(name).setMesh(mesh));
  for (const s of root.listScenes()) if (s !== scene) s.dispose();
  root.setDefaultScene(scene);
  for (const n of root.listNodes()) if (n.getName() !== name) n.dispose();
  for (const e of root.listExtensionsUsed()) e.dispose();
  // … and float normals instead of meshopt's quantized bytes.
  await doc.transform(prune(), dequantize());
  const tris = mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);
  await io.write(join(OUT, `${name}.glb`), doc);
  console.log(`${name}: ${tris} Dreiecke, ${mesh.listPrimitives().length} Materialien`);
}

// Hooks in model space (web: exhausts and headlights for flames and lights).
const doc = await io.read(SRC);
const hook = (n: string) => doc.getRoot().listNodes().find((x) => x.getName() === n)?.getTranslation();
const info = {
  note: 'public/models/sportscar.glb, model space: metres, ground y = 0, +z forward, +x left (unreal/tools/export-car.ts)',
  hooks: Object.fromEntries(['exhaust_L', 'exhaust_R', 'headlight_L', 'headlight_R'].map((n) => [n, hook(n)])),
  materials: [...materials.values()],
};
writeFileSync(join(OUT, 'car.json'), JSON.stringify(info, null, 1));
console.log(`Fertig: ${OUT} (${materials.size} Materialien)`);
