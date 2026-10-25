// Reads a material's base texture under mesh triangles (tools/import-car.ts, tools/import-traffic.ts): the texel
// colour at each triangle's centre and the triangle's area, and the colour that covers the most surface.
import type { Material, Primitive, Texture } from '@gltf-transform/core';
import { KHRTextureTransform, type Transform as UVTransform } from '@gltf-transform/extensions';
import sharp from 'sharp';
import * as THREE from 'three';

const pixels = new Map<Texture, { w: number; h: number; data: Buffer }>();
async function texels(t: Texture) {
  let px = pixels.get(t);
  if (!px) {
    const { data, info } = await sharp(Buffer.from(t.getImage()!)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    px = { w: info.width, h: info.height, data };
    pixels.set(t, px);
  }
  return px;
}
export const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
/** The colour (rgb 0..255) covering the most area, quantised to 16 steps per channel. */
export function commonest(rgb: number[], area: number[]) {
  const count = new Map<number, number>();
  let best = 0, bestN = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const q = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
    const n = (count.get(q) ?? 0) + area[i / 3];
    count.set(q, n);
    if (n > bestN) [best, bestN] = [q, n];
  }
  return [((best >> 8) << 4) + 8, (((best >> 4) & 15) << 4) + 8, ((best & 15) << 4) + 8];
}
/** Texel colour under the centre of each triangle, and the triangle's area. */
export async function sampleTriangles(prim: Primitive, mat: Material) {
  const info = mat.getBaseColorTextureInfo()!;
  const uv = prim.getAttribute(`TEXCOORD_${info.getTexCoord()}`);
  if (!uv) return null;
  const tr = info.getExtension<UVTransform>(KHRTextureTransform.EXTENSION_NAME);
  const [ou, ov] = tr?.getOffset() ?? [0, 0], [su, sv] = tr?.getScale() ?? [1, 1], rot = tr?.getRotation() ?? 0;
  const px = await texels(mat.getBaseColorTexture()!);
  const idx = prim.getIndices()!.getArray()!;
  const pos = prim.getAttribute('POSITION')!;
  const a: number[] = [];
  const corners3 = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const colours: number[] = [], areas: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    let u = 0, v = 0;
    for (let k = 0; k < 3; k++) {
      uv.getElement(idx[t + k], a);
      u += a[0] / 3;
      v += a[1] / 3;
      corners3[k].fromArray(pos.getElement(idx[t + k], a));
    }
    areas.push(new THREE.Triangle(...corners3).getArea());
    const uu = ou + Math.cos(rot) * su * u + Math.sin(rot) * sv * v, vv = ov - Math.sin(rot) * su * u + Math.cos(rot) * sv * v;
    // Repeat, but a centre just past an edge (colour strips laid on the border) reads the edge texel.
    const wrap = (c: number) => (c > -0.02 && c < 0 ? 0 : c >= 1 && c < 1.02 ? 0.9999 : ((c % 1) + 1) % 1);
    const x = Math.floor(wrap(uu) * px.w), y = Math.floor(wrap(vv) * px.h);
    const o = (y * px.w + x) * 4;
    colours.push(px.data[o], px.data[o + 1], px.data[o + 2]);
  }
  return { idx, colours, areas };
}
