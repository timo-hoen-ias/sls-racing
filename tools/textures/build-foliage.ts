// Builds the foliage and bark atlases for the trees (public/textures/foliage/) from CC0 materials on ambientCG.
// Leaves: single leaves are cut out of ambientCG "LeafSet" photos (colour + opacity) and laid onto twigs, one
// cluster card per species (512 px cells, 4 × 4 in leaves.webp, colour with alpha). The tree generator
// (src/world/treeGen.ts) puts these cards at the branch tips, the card's bottom edge at the twig, up along it.
// Bark: one 256 × 512 strip per bark type side by side in bark.webp (tiles vertically), plus barkn.webp with the
// matching normal map (OpenGL convention).
// Writes manifest.json with the cell of each species and the mean leaf colour (impostor bake background).
// Needs ImageMagick (`convert`) and `unzip`. Run: node tools/textures/build-foliage.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BARKS, FOLIAGE_CELL, FOLIAGE_GRID, LEAF_CARDS, type LeafCard } from '../../src/world/treeSpecies.ts';

const RAW = 'data/raw/textures';
const OUT = 'public/textures/foliage';
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

async function fetchSet(asset: string) {
  const dir = join(RAW, asset);
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.includes('_Color.'))) {
    const url = `https://ambientcg.com/get?file=${asset}_1K-JPG.zip`;
    console.log(`lade ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const zip = join(RAW, `${asset}.zip`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir, '*_Color.jpg', '*_Opacity.jpg', '*_NormalGL.jpg']);
  }
  const files = readdirSync(dir);
  const pick = (kind: string) => { const f = files.find((n) => n.includes(`_${kind}.`)); return f ? join(dir, f) : undefined; };
  return { color: pick('Color')!, opacity: pick('Opacity'), normal: pick('NormalGL') };
}

/** RGBA float image, straight (not premultiplied) colour in 0..1 sRGB. */
interface Img { w: number; h: number; d: Float32Array }

const newImg = (w: number, h: number): Img => ({ w, h, d: new Float32Array(w * h * 4) });

function readImg(path: string, size?: string): Img {
  const info = execFileSync('convert', [path, ...(size ? ['-resize', size] : []), '-format', '%w %h', 'info:']).toString().split(' ').map(Number);
  const raw = execFileSync('convert', [path, ...(size ? ['-resize', size] : []), '-depth', '8', 'rgba:-'], { maxBuffer: 1 << 28 });
  const img = newImg(info[0], info[1]);
  for (let i = 0; i < raw.length; i++) img.d[i] = raw[i] / 255;
  return img;
}

function writeImg(img: Img, path: string, args: string[] = []) {
  const raw = Buffer.alloc(img.w * img.h * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.max(0, Math.min(255, Math.round(img.d[i] * 255)));
  execFileSync('convert', ['-size', `${img.w}x${img.h}`, '-depth', '8', 'rgba:-', ...args, path], { input: raw });
}

function sample(img: Img, x: number, y: number, out: number[]) {
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out.fill(0);
  for (let k = 0; k < 4; k++) {
    const xi = x0 + (k & 1), yi = y0 + (k >> 1);
    if (xi < 0 || yi < 0 || xi >= img.w || yi >= img.h) continue;
    const wgt = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
    const o = (yi * img.w + xi) * 4;
    const a = img.d[o + 3] * wgt;
    out[0] += img.d[o] * a; out[1] += img.d[o + 1] * a; out[2] += img.d[o + 2] * a; out[3] += a;
  }
  if (out[3] > 0) { out[0] /= out[3]; out[1] /= out[3]; out[2] /= out[3]; }
}

/** Alpha "over" of one pixel. */
function over(dst: Img, o: number, r: number, g: number, b: number, a: number) {
  const da = dst.d[o + 3], oa = a + da * (1 - a);
  if (oa <= 0) return;
  dst.d[o] = (r * a + dst.d[o] * da * (1 - a)) / oa;
  dst.d[o + 1] = (g * a + dst.d[o + 1] * da * (1 - a)) / oa;
  dst.d[o + 2] = (b * a + dst.d[o + 2] * da * (1 - a)) / oa;
  dst.d[o + 3] = oa;
}

/** Draws a sprite with its anchor (sx, sy in sprite pixels) at (x, y), rotated (rad, 0 = sprite up stays up), scaled. */
function drawSprite(dst: Img, spr: Img, ax: number, ay: number, x: number, y: number, rot: number, scale: number, tint: [number, number, number]) {
  const c = Math.cos(rot), s = Math.sin(rot);
  // Bounding box of the transformed sprite.
  const corners = [[0, 0], [spr.w, 0], [0, spr.h], [spr.w, spr.h]].map(([u, v]) => {
    const dx = (u - ax) * scale, dy = (v - ay) * scale;
    return [x + dx * c - dy * s, y + dx * s + dy * c];
  });
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0])))), x1 = Math.min(dst.w - 1, Math.ceil(Math.max(...corners.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1])))), y1 = Math.min(dst.h - 1, Math.ceil(Math.max(...corners.map((p) => p[1]))));
  const px = [0, 0, 0, 0];
  for (let j = y0; j <= y1; j++)
    for (let i = x0; i <= x1; i++) {
      const dx = i + 0.5 - x, dy = j + 0.5 - y;
      // Inverse rotation, then scale back into sprite pixels.
      const u = (dx * c + dy * s) / scale + ax, v = (-dx * s + dy * c) / scale + ay;
      if (u < 0 || v < 0 || u >= spr.w || v >= spr.h) continue;
      sample(spr, u, v, px);
      if (px[3] < 0.004) continue;
      over(dst, (j * dst.w + i) * 4, px[0] * tint[0], px[1] * tint[1], px[2] * tint[2], px[3]);
    }
}

/** Anti-aliased tapered stroke from a to b (twigs and needles). */
function drawStroke(dst: Img, ax: number, ay: number, bx: number, by: number, w0: number, w1: number, col: [number, number, number]) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - w0 - 1)), x1 = Math.min(dst.w - 1, Math.ceil(Math.max(ax, bx) + w0 + 1));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - w0 - 1)), y1 = Math.min(dst.h - 1, Math.ceil(Math.max(ay, by) + w0 + 1));
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  for (let j = y0; j <= y1; j++)
    for (let i = x0; i <= x1; i++) {
      const px = i + 0.5, py = j + 0.5;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      const d = Math.hypot(ax + dx * t - px, ay + dy * t - py);
      const w = (w0 + (w1 - w0) * t) / 2;
      const a = Math.max(0, Math.min(1, w + 0.5 - d));
      if (a > 0) over(dst, (j * dst.w + i) * 4, col[0], col[1], col[2], a);
    }
}

/** Cuts the single leaves out of a LeafSet photo: connected opacity regions, each with its stem end at the bottom. */
function cutLeaves(set: { color: string; opacity?: string }): Img[] {
  const col = readImg(set.color), op = readImg(set.opacity!);
  const { w, h } = col;
  for (let i = 0; i < w * h; i++) col.d[i * 4 + 3] = op.d[i * 4];
  const seen = new Uint8Array(w * h);
  const out: Img[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || op.d[start * 4] < 0.5) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0, n = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      n++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || seen[q] || op.d[q * 4] < 0.5) continue;
        if (Math.abs((q % w) - x) > 1) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (n < 400) continue;
    const pad = 2;
    const sw = maxX - minX + 1 + pad * 2, sh = maxY - minY + 1 + pad * 2;
    const spr = newImg(sw, sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const X = minX - pad + x, Y = minY - pad + y;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        spr.d.set(col.d.subarray((Y * w + X) * 4, (Y * w + X) * 4 + 4), (y * sw + x) * 4);
      }
    out.push(spr);
  }
  if (!out.length) throw new Error(`${set.color}: keine Blätter gefunden`);
  return out;
}

/** Deterministic random numbers per card. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/**
 * One cluster card: a twig from the bottom centre up with side twigs, leaves along and at the end of them.
 * Leaves further inside and lower down are darker (self shading within the clump).
 */
function leafCard(card: LeafCard, leaves: Img[], px: number): Img {
  const img = newImg(px, px);
  const r = rng(card.seed);
  const twig: [number, number, number] = card.twig;
  const S = px / 512;
  const bx = px / 2, by = px - 8 * S;
  const top = 125 * S;
  // Main stem with a slight bend.
  const bend = (r() - 0.5) * 60 * S;
  const stem = (t: number): [number, number] => [bx + bend * Math.sin(t * Math.PI), by + (top - by) * t];
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const [x0, y0] = stem(i / segs), [x1, y1] = stem((i + 1) / segs);
    drawStroke(img, x0, y0, x1, y1, card.stem * S * (1 - i / segs * 0.6), card.stem * S * (1 - (i + 1) / segs * 0.6), twig);
  }
  // Attachment points: side twigs alternating left and right, each carrying leaves.
  const spots: { x: number; y: number; ang: number; depth: number }[] = [];
  for (let k = 0; k < card.sides; k++) {
    const t = 0.18 + (k / card.sides) * 0.78;
    const [sx, sy] = stem(t);
    const side = k % 2 ? 1 : -1;
    const ang = side * (card.spread * (0.75 + r() * 0.5)) * (1 - t * 0.35);
    const len = (card.sideLen * (1 - t * 0.5) * (0.75 + r() * 0.5)) * S;
    const ex = sx + Math.sin(ang) * len, ey = sy - Math.cos(ang) * len;
    drawStroke(img, sx, sy, ex, ey, card.stem * 0.55 * S, card.stem * 0.25 * S, twig);
    const n = card.perSide;
    for (let j = 0; j < n; j++) {
      const f = (j + 1) / n;
      const lx = sx + (ex - sx) * f, ly = sy + (ey - sy) * f;
      const a = ang + (j % 2 ? 1 : -1) * card.leafAngle * (0.6 + r() * 0.6) * (j === n - 1 ? 0.2 : 1);
      spots.push({ x: lx, y: ly, ang: a, depth: f });
    }
  }
  // A crown of leaves at the stem tip.
  const [tx, ty] = stem(1);
  for (let j = 0; j < 3; j++) spots.push({ x: tx, y: ty, ang: (j - 1) * 0.6, depth: 1 });
  // Draw back to front: inner (low depth) leaves first and darker.
  spots.sort((a, b) => a.depth - b.depth);
  for (const s of spots) {
    const leaf = leaves[Math.floor(r() * leaves.length)];
    const size = card.leafPx * S * (0.8 + r() * 0.4);
    const scale = size / Math.max(leaf.w, leaf.h);
    const shade = card.shade[0] + (card.shade[1] - card.shade[0]) * (0.35 * s.depth + 0.65 * r());
    const hue = 1 + (r() - 0.5) * 0.12;
    const tint: [number, number, number] = [card.tint[0] * shade * hue, card.tint[1] * shade, card.tint[2] * shade / hue];
    drawSprite(img, leaf, leaf.w / 2, leaf.h, s.x, s.y, s.ang, scale, tint);
  }
  return img;
}

/** Needle card (pine): tufts of long needles at the end of short twigs along the stem. */
function needleCard(card: LeafCard, px: number): Img {
  const img = newImg(px, px);
  const r = rng(card.seed);
  const S = px / 512;
  const bx = px / 2, by = px - 8 * S, top = 110 * S;
  drawStroke(img, bx, by, bx, top, card.stem * S, card.stem * 0.4 * S, card.twig);
  for (let k = 0; k < card.sides; k++) {
    const t = 0.15 + (k / card.sides) * 0.85;
    const sx = bx, sy = by + (top - by) * t;
    const side = k % 2 ? 1 : -1;
    const ang = side * card.spread * (0.6 + r() * 0.6);
    const len = card.sideLen * S * (1 - t * 0.4);
    const ex = sx + Math.sin(ang) * len, ey = sy - Math.cos(ang) * len;
    drawStroke(img, sx, sy, ex, ey, card.stem * 0.5 * S, card.stem * 0.3 * S, card.twig);
    for (const [cx, cy] of [[ex, ey], [(sx + ex) / 2, (sy + ey) / 2]]) {
      for (let j = 0; j < card.perSide; j++) {
        const a = ang + (r() - 0.5) * 2.6;
        const l = card.leafPx * S * (0.6 + r() * 0.5);
        const shade = card.shade[0] + (card.shade[1] - card.shade[0]) * r();
        drawStroke(img, cx, cy, cx + Math.sin(a) * l, cy - Math.cos(a) * l, 3.2 * S, 1.2 * S, [card.tint[0] * shade, card.tint[1] * shade, card.tint[2] * shade]);
      }
    }
  }
  return img;
}

/** Sprig card (spruce): the photographed sprigs laid along both sides of a twig. */
function sprigCard(card: LeafCard, sprigs: Img[], px: number): Img {
  const img = newImg(px, px);
  const r = rng(card.seed);
  const S = px / 512;
  const bx = px / 2, by = px - 8 * S, top = 120 * S;
  drawStroke(img, bx, by, bx, top, card.stem * S, card.stem * 0.4 * S, card.twig);
  const spots: { x: number; y: number; ang: number; d: number }[] = [];
  for (let k = 0; k < card.sides; k++) {
    const t = 0.1 + (k / card.sides) * 0.9;
    spots.push({ x: bx, y: by + (top - by) * t, ang: (k % 2 ? 1 : -1) * card.spread * (0.7 + r() * 0.5), d: t });
  }
  spots.push({ x: bx, y: top + 20 * S, ang: 0, d: 1 });
  for (const s of spots) {
    const sp = sprigs[Math.floor(r() * sprigs.length)];
    // The photographed sprigs lie horizontally: their long side becomes "up" along the twig.
    const horizontal = sp.w > sp.h;
    const size = card.leafPx * S * (1.1 - s.d * 0.4) * (0.85 + r() * 0.3);
    const scale = size / Math.max(sp.w, sp.h);
    const shade = card.shade[0] + (card.shade[1] - card.shade[0]) * r();
    const tint: [number, number, number] = [card.tint[0] * shade, card.tint[1] * shade, card.tint[2] * shade];
    if (horizontal) drawSprite(img, sp, 0, sp.h / 2, s.x, s.y, s.ang - Math.PI / 2, scale, tint);
    else drawSprite(img, sp, sp.w / 2, sp.h, s.x, s.y, s.ang, scale, tint);
  }
  return img;
}

/** Fills transparent pixels with the colour of the nearest leaf so mipmaps do not darken the edges. */
function bleed(img: Img, passes = 12) {
  const { w, h, d } = img;
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = d[i * 4 + 3] > 0.02 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = filled.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + ox, Y = y + oy;
          if (X < 0 || Y < 0 || X >= w || Y >= h || !filled[Y * w + X]) continue;
          const o = (Y * w + X) * 4;
          r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
        }
        if (!n) continue;
        d[i * 4] = r / n; d[i * 4 + 1] = g / n; d[i * 4 + 2] = b / n;
        next[i] = 1;
      }
    filled.set(next);
  }
  // Whatever is still empty gets the mean colour.
  const m = meanColour(img);
  for (let i = 0; i < w * h; i++) if (!filled[i]) { d[i * 4] = m[0]; d[i * 4 + 1] = m[1]; d[i * 4 + 2] = m[2]; }
}

function meanColour(img: Img): [number, number, number] {
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const w = img.d[i * 4 + 3];
    r += img.d[i * 4] * w; g += img.d[i * 4 + 1] * w; b += img.d[i * 4 + 2] * w; a += w;
  }
  return a ? [r / a, g / a, b / a] : [0.3, 0.4, 0.2];
}

function blit(dst: Img, src: Img, x0: number, y0: number) {
  for (let y = 0; y < src.h; y++) dst.d.set(src.d.subarray(y * src.w * 4, (y + 1) * src.w * 4), ((y0 + y) * dst.w + x0) * 4);
}

const px = FOLIAGE_CELL;
const atlas = newImg(px * FOLIAGE_GRID, px * FOLIAGE_GRID);
const manifest: { cells: Record<string, { cell: number; mean: [number, number, number] }>; barks: string[] } = { cells: {}, barks: BARKS.map((b) => b.id) };
const leafCache = new Map<string, Img[]>();
for (const [i, card] of LEAF_CARDS.entries()) {
  let img: Img;
  if (card.style === 'needles') img = needleCard(card, px);
  else {
    if (!leafCache.has(card.set!)) leafCache.set(card.set!, cutLeaves(await fetchSet(card.set!)));
    const leaves = leafCache.get(card.set!)!;
    img = card.style === 'sprigs' ? sprigCard(card, leaves, px) : leafCard(card, leaves, px);
  }
  const mean = meanColour(img);
  bleed(img);
  blit(atlas, img, (i % FOLIAGE_GRID) * px, Math.floor(i / FOLIAGE_GRID) * px);
  manifest.cells[card.id] = { cell: i, mean: mean.map((v) => Math.round(v * 1000) / 1000) as [number, number, number] };
  console.log(`Blattkarte ${card.id}: Zelle ${i}`);
}
writeImg(atlas, join(OUT, 'leaves.webp'), ['-define', 'webp:alpha-quality=100', '-define', 'webp:exact=true', '-quality', '88']);

// Bark strips 256 × 512: the 1K texture at 256 × 256, twice on top of each other (tiles vertically).
const BW = 256, BH = 512;
const bark = newImg(BW * BARKS.length, BH), barkN = newImg(BW * BARKS.length, BH);
for (const [i, b] of BARKS.entries()) {
  const set = await fetchSet(b.set);
  const col = readImg(set.color, `${BW}x${BW}!`), nor = readImg(set.normal!, `${BW}x${BW}!`);
  // Tint towards the species' bark colour by luminance, keeping the photo's detail.
  for (let p = 0; p < BW * BW; p++) {
    const o = p * 4;
    const l = 0.3 * col.d[o] + 0.59 * col.d[o + 1] + 0.11 * col.d[o + 2];
    for (let c = 0; c < 3; c++) col.d[o + c] = col.d[o + c] * (1 - b.tint[3]) + b.tint[c] * (l / 0.45) * b.tint[3];
  }
  if (b.lenticels) {
    // Birch: dark horizontal dashes.
    const r = rng(77);
    for (let k = 0; k < 45; k++) {
      const x = r() * BW, y = r() * BW, l = 8 + r() * 30;
      drawStroke(col, x, y, x + l, y + (r() - 0.5) * 3, 1.5 + r() * 3, 1 + r() * 1.5, [0.16, 0.14, 0.12]);
    }
  }
  for (const y0 of [0, BW]) { blit(bark, col, i * BW, y0); blit(barkN, nor, i * BW, y0); }
  console.log(`Rinde ${b.id}: ${b.set}`);
}
writeImg(bark, join(OUT, 'bark.webp'), ['-quality', '85']);
writeImg(barkN, join(OUT, 'barkn.webp'), ['-quality', '90']);
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`→ ${OUT}`);
