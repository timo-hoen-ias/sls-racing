// Builds the PBR texture atlases (public/textures/pbr/) from CC0 materials on ambientCG and the Scenario PATINA
// sets in tools/textures/patina/. Downloads each set listed in src/render/pbr/textureSets.ts (1K JPG; local sets
// are read from their folder), packs it into atlas cells with a
// wrapped gutter (so mipmaps of a tiling texture do not bleed into neighbours), and encodes three KTX2
// files per atlas and quality step:
//   <atlas>-<px>-albedo.ktx2  sRGB colour with the ambient occlusion baked in
//   <atlas>-<px>-normal.ktx2  tangent-space normal (OpenGL convention): X in RGB, Y in alpha
//   <atlas>-<px>-rh.ktx2      roughness in RGB, height in alpha
// All ETC1S: small downloads, and the alpha slice keeps the second channel apart from the first, which
// transcodes to BC3/BC7 on desktop GPUs with good quality for normals (the usual "DXT5nm" layout).
// plus manifest.json with the grid and the mean colour of every cell.
// Needs ImageMagick (`convert`) and `unzip`. Run: node tools/textures/build-textures.ts [--only=street]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeToKTX2 } from 'ktx2-encoder';
import { PNG } from 'pngjs';
import { ATLASES, type AtlasSpec, GUTTER, TEX_QUALITY } from '../../src/render/pbr/textureSets.ts';

const RAW = 'data/raw/textures';
const WORK = 'data/raw/textures/work';
const OUT = 'public/textures/pbr';
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

const magick = (args: string[]) => execFileSync('convert', args, { stdio: ['ignore', 'ignore', 'inherit'] });

/** Downloads and unpacks one ambientCG material (or uses a local folder); returns its map files by kind. */
async function fetchSet(asset: string, local?: string) {
  const dir = local ?? join(RAW, asset);
  if (local && !existsSync(dir)) throw new Error(`${asset}: Ordner ${local} fehlt`);
  if (!existsSync(dir)) {
    const url = `https://ambientcg.com/get?file=${asset}_1K-JPG.zip`;
    console.log(`lade ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const zip = join(RAW, `${asset}.zip`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  const files = readdirSync(dir);
  const find = (kind: string) => files.find((f) => f.includes(`_${kind}.`) && /\.(jpg|png)$/i.test(f));
  const pick = (kind: string) => (find(kind) ? join(dir, find(kind)!) : undefined);
  const color = pick('Color'), normal = pick('NormalGL'), rough = pick('Roughness');
  if (!color || !normal || !rough) throw new Error(`${asset}: Color/NormalGL/Roughness fehlt (${files.join(', ')})`);
  return { color, normal, rough, ao: pick('AmbientOcclusion'), height: pick('Displacement') };
}

/** One cell: the texture squeezed into the inner part, the gutter filled with its own wrap-around. */
function cell(src: string, out: string, px: number, gray = false) {
  const g = Math.round(px * GUTTER);
  const inner = px - 2 * g;
  magick([src, ...(gray ? ['-colorspace', 'gray'] : []), '-resize', `${inner}x${inner}!`, '-virtual-pixel', 'tile',
    '-set', 'option:distort:viewport', `${px}x${px}-${g}-${g}`, '-distort', 'SRT', '0', '+repage', '-depth', '8', ...(gray ? [] : ['-type', 'TrueColor']), out]);
}

/** Mean colour of a texture in linear RGB (the shaders divide by it to use a photo as tint-free detail). */
function meanLinear(src: string): [number, number, number] {
  const out = execFileSync('convert', [src, '-resize', '64x64!', '-depth', '8', 'rgb:-']);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const sum = [0, 0, 0];
  for (let i = 0; i < out.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += lin(out[i + k] / 255);
  const n = out.length / 3;
  return sum.map((s) => +(s / n).toFixed(4)) as [number, number, number];
}

const decode = async (buf: Uint8Array) => {
  const png = PNG.sync.read(Buffer.from(buf));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
};

type Kind = 'albedo' | 'normal' | 'rh';

async function encode(png: string, out: string, kind: Kind) {
  const data = new Uint8Array(readFileSync(png));
  const srgb = kind === 'albedo';
  const ktx = await encodeToKTX2(data, {
    imageDecoder: decode,
    generateMipmap: true,
    isKTX2File: true,
    isUASTC: false,
    qualityLevel: kind === 'albedo' ? 200 : 255,
    compressionLevel: 3,
    isPerceptual: srgb,
    isSetKTX2SRGBTransferFunc: srgb,
    isNormalMap: kind === 'normal',
  });
  writeFileSync(out, ktx);
  return ktx.length;
}

async function buildAtlas(a: AtlasSpec, manifest: Record<string, unknown>) {
  const sets = [];
  for (const s of a.sets) sets.push({ ...s, files: await fetchSet(s.asset, s.local) });
  const means = sets.map((s) => meanLinear(s.files.color));
  const sizes: Record<string, number> = {};
  for (const px of Object.values(TEX_QUALITY)) {
    const W = a.cols * px, H = a.rows * px;
    const layers: Record<Kind, string[]> = { albedo: [], normal: [], rh: [] };
    sets.forEach((s, i) => {
      const base = join(WORK, `${a.name}-${px}-${i}`);
      cell(s.files.color, `${base}-c.png`, px);
      cell(s.files.normal, `${base}-n.png`, px);
      cell(s.files.rough, `${base}-r.png`, px, true);
      if (s.files.ao) cell(s.files.ao, `${base}-ao.png`, px, true);
      else magick(['-size', `${px}x${px}`, 'xc:white', '-colorspace', 'gray', `${base}-ao.png`]);
      if (s.files.height) cell(s.files.height, `${base}-h.png`, px, true);
      else magick(['-size', `${px}x${px}`, 'xc:gray50', '-colorspace', 'gray', `${base}-h.png`]);
      // AO into the colour at 70 %, X of the normal into RGB and Y into alpha, roughness with height as alpha.
      magick([`${base}-c.png`, '(', `${base}-ao.png`, '-level', '-43%,100%', ')', '-compose', 'multiply', '-composite', '-type', 'TrueColor', `${base}-albedo.png`]);
      magick([`${base}-n.png`, '-channel', 'R', '-separate', '+channel', '(', `${base}-n.png`, '-channel', 'R', '-separate', '+channel', ')',
        '(', `${base}-n.png`, '-channel', 'R', '-separate', '+channel', ')', '(', `${base}-n.png`, '-channel', 'G', '-separate', '+channel', ')',
        '-channel', 'RGBA', '-combine', '-depth', '8', `PNG32:${base}-normal.png`]);
      magick([`${base}-r.png`, `${base}-r.png`, `${base}-r.png`, `${base}-h.png`, '-channel', 'RGBA', '-combine', '-depth', '8', `PNG32:${base}-rh.png`]);
      layers.albedo.push(`${base}-albedo.png`);
      layers.normal.push(`${base}-normal.png`);
      layers.rh.push(`${base}-rh.png`);
    });
    for (const kind of ['albedo', 'normal', 'rh'] as const) {
      const args = ['-size', `${W}x${H}`, kind === 'albedo' ? 'xc:gray50' : 'xc:rgba(128,128,128,0.5)'];
      layers[kind].forEach((f, i) => args.push(f, '-geometry', `+${(i % a.cols) * px}+${Math.floor(i / a.cols) * px}`, '-composite'));
      const png = join(WORK, `${a.name}-${px}-${kind}.png`);
      magick([...args, '-depth', '8', kind === 'albedo' ? `PNG24:${png}` : `PNG32:${png}`]);
      const file = `${a.name}-${px}-${kind}.ktx2`;
      sizes[file] = await encode(png, join(OUT, file), kind);
      console.log(`${file}: ${(sizes[file] / 1024).toFixed(0)} KB`);
    }
  }
  manifest[a.name] = {
    cols: a.cols,
    rows: a.rows,
    gutter: GUTTER,
    cells: a.sets.map((s, i) => ({ name: s.name, asset: s.asset, metres: s.metres, mean: means[i] })),
  };
}

const manifestPath = join(OUT, 'manifest.json');
const manifest: Record<string, unknown> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).atlases : {};
for (const a of ATLASES) if (!only || only === a.name) await buildAtlas(a, manifest);
writeFileSync(manifestPath, JSON.stringify({ quality: TEX_QUALITY, atlases: manifest }, null, 1) + '\n');
const total = readdirSync(OUT).reduce((s, f) => s + statSync(join(OUT, f)).size, 0);
console.log(`fertig: ${(total / 1024 / 1024).toFixed(1)} MB in ${OUT}`);
