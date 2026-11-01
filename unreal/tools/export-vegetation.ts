// Exports the web game's generated tree and bush species for Unreal: both detail levels of every species as glTF
// (positions, normals, uv into the foliage atlases, vertex colour with the wind weight in alpha; one primitive for
// the bark, one for the leaf cards), the foliage textures as PNG, and vegetation.json with the species list. The
// Unreal setup (sls_setup.py) imports them as static meshes with LOD1 and builds bark and leaf materials; the tiles
// carry the instances (export-tiles.ts, v.sp / v.inst from vegPlacement.ts) for the HISM foliage.
//   node unreal/tools/export-vegetation.ts [--out=unreal/SlsRacing/Data/vegetation]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as THREE from 'three';
import { isBush, species, SPECIES_IDS } from './vegSpecies.ts';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const OUT = arg('out', 'unreal/SlsRacing/Data/vegetation');
mkdirSync(OUT, { recursive: true });

/** Minimal glTF 2.0 writer: one mesh, one primitive per geometry group (bark, leaves). */
function writeGltf(g: THREE.BufferGeometry, name: string) {
  const pos = g.getAttribute('position').array as Float32Array;
  const nrm = g.getAttribute('normal').array as Float32Array;
  const uv = g.getAttribute('uv').array as Float32Array;
  const col = g.getAttribute('color').array as Float32Array;
  const wind = g.getAttribute('wind').array as Float32Array;
  const idx = g.getIndex()!.array;
  const n = pos.length / 3;
  let windMax = 1e-6;
  for (const w of wind) windMax = Math.max(windMax, w);
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { rgba[i * 4] = col[i * 3]; rgba[i * 4 + 1] = col[i * 3 + 1]; rgba[i * 4 + 2] = col[i * 3 + 2]; rgba[i * 4 + 3] = wind[i] / windMax; }
  const groups = g.groups.length ? g.groups : [{ start: 0, count: idx.length, materialIndex: 0 }];
  const parts: Buffer[] = [];
  let offset = 0;
  const views: object[] = [], accessors: object[] = [];
  const add = (arr: Float32Array | Uint32Array, type: string, comp: number, target: number, minmax = false) => {
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    parts.push(b);
    const pad = (4 - (b.byteLength % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.byteLength, target });
    offset += b.byteLength + pad;
    const count = arr.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[type];
    const acc: Record<string, unknown> = { bufferView: views.length - 1, componentType: comp, count, type };
    if (minmax) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]); }
      acc.min = mn; acc.max = mx;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };
  const aPos = add(pos, 'VEC3', 5126, 34962, true);
  const aNrm = add(nrm, 'VEC3', 5126, 34962);
  const aUv = add(uv, 'VEC2', 5126, 34962);
  const aCol = add(rgba, 'VEC4', 5126, 34962);
  const prims = groups.map((gr) => ({
    attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv, COLOR_0: aCol },
    indices: add(Uint32Array.from((idx as ArrayLike<number> & { slice(a: number, b: number): ArrayLike<number> }).slice(gr.start, gr.start + gr.count)), 'SCALAR', 5125, 34963),
    material: gr.materialIndex ?? 0,
  }));
  const bin = Buffer.concat(parts);
  const gltf = {
    asset: { version: '2.0', generator: 'sls-racing export-vegetation.ts' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: prims }],
    materials: [{ name: 'Bark' }, { name: 'Leaf', doubleSided: true, alphaMode: 'MASK' }],
    buffers: [{ uri: `${name}.bin`, byteLength: bin.byteLength }],
    bufferViews: views, accessors,
  };
  writeFileSync(join(OUT, `${name}.gltf`), JSON.stringify(gltf));
  writeFileSync(join(OUT, `${name}.bin`), bin);
  return { verts: n, tris: idx.length / 3 };
}

const geo = species();
const list = [];
for (const id of SPECIES_IDS) {
  const g = geo[id];
  const lods = g.lods.map((l, i) => writeGltf(l, `SM_Sls_${id}_LOD${i}`));
  list.push({ id, bush: isBush(id), height: g.height, crown: g.crown, lods });
  console.log(`${id}: ${lods.map((l) => `${l.tris} Dreiecke`).join(' / ')}`);
}
writeFileSync(join(OUT, 'vegetation.json'), JSON.stringify({ species: list }, null, 1));
// Foliage textures: WebP in the web build, PNG for Unreal's importer (ImageMagick).
for (const f of ['leaves', 'bark', 'barkn']) {
  try {
    execFileSync('convert', [`public/textures/foliage/${f}.webp`, join(OUT, `T_Sls_${f}.png`)], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    throw new Error('ImageMagick (convert) fehlt: wird zum Umwandeln der Laubtexturen gebraucht');
  }
}
console.log(`Fertig: ${OUT} (${list.length} Arten)`);
