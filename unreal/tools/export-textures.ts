// Decodes the web game's PBR atlases (public/textures/pbr/*-1024-*.ktx2, built by tools/textures/build-textures.ts)
// into PNG files Unreal can import, plus the water normals and the atlas manifest. The Unreal setup script
// (unreal/SlsRacing/Content/Python/sls_setup.py) imports them; the materials sample them with the same cell layout,
// gutter and packing as the web shaders (albedo sRGB with AO, normal X in R / Y in A, roughness in G / height in A).
//   node unreal/tools/export-textures.ts [--quality=hoch|mittel|niedrig] [--out=unreal/SlsRacing/Data/textures]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { PNG } from 'pngjs';
import { ATLASES, TEX_QUALITY, type TexQuality } from '../../src/render/pbr/textureSets.ts';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const quality = arg('quality', 'hoch') as TexQuality;
const px = TEX_QUALITY[quality];
const OUT = arg('out', 'unreal/SlsRacing/Data/textures');
const SRC = 'public/textures/pbr';

interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => {
    isValid(): boolean; getWidth(): number; getHeight(): number; startTranscoding(): boolean;
    getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
    transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, getAlphaForOpaque: number, channel0: number, channel1: number): boolean;
    close(): void; delete(): void;
  };
}

const require = createRequire(import.meta.url);
// three ships the transcoder as a classic script inside an ES-module package: run it in its own context.
const mod = { exports: {} as unknown };
vm.runInNewContext(readFileSync(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js'), 'utf8'), { module: mod, exports: mod.exports, WebAssembly, console, performance, TextDecoder, setTimeout });
const BASIS = mod.exports as (o: object) => Promise<BasisModule>;
const wasmBinary = readFileSync(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.wasm'));
const basis = await BASIS({ wasmBinary });
basis.initializeBasis();
const RGBA32 = 13; // cTFRGBA32 in basisu's transcoder_texture_format

function decode(file: string) {
  const k = new basis.KTX2File(new Uint8Array(readFileSync(file)));
  try {
    if (!k.isValid() || !k.startTranscoding()) throw new Error(`${file}: kein gültiges KTX2`);
    const w = k.getWidth(), h = k.getHeight();
    const out = new Uint8Array(k.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
    if (!k.transcodeImage(out, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error(`${file}: Dekodieren fehlgeschlagen`);
    return { w, h, data: out };
  } finally {
    k.close();
    k.delete();
  }
}

mkdirSync(OUT, { recursive: true });
for (const a of ATLASES) {
  for (const map of ['albedo', 'normal', 'rh'] as const) {
    const img = decode(join(SRC, `${a.name}-${px}-${map}.ktx2`));
    if (img.w !== a.cols * px || img.h !== a.rows * px) throw new Error(`${a.name}-${map}: ${img.w}×${img.h}, erwartet ${a.cols * px}×${a.rows * px}`);
    const png = new PNG({ width: img.w, height: img.h });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    const name = `T_Sls_${a.name}_${map}.png`;
    writeFileSync(join(OUT, name), PNG.sync.write(png));
    console.log(`${name}: ${img.w}×${img.h}`);
  }
}
copyFileSync('public/textures/waternormals.jpg', join(OUT, 'T_Sls_waternormals.jpg'));
copyFileSync(join(SRC, 'manifest.json'), join(OUT, 'manifest.json'));
console.log(`Fertig: ${OUT} (${quality}, ${px} px je Zelle)`);
