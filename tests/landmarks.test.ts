import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';

interface Landmark { id: string; glb: string; e: number; n: number; heading: number; footprint: [number, number][]; y?: number; bridge?: number }
const manifest: Landmark[] = JSON.parse(readFileSync(new URL('../pipeline/landmarks.json', import.meta.url), 'utf8'));
const MATERIAL = /^(stone|plaster|roof|slate|copper|glass|wood)/;

async function load(l: Landmark) {
  const buf = readFileSync(new URL(`../public/${l.glb}`, import.meta.url));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  return gltf.scene;
}

const tris = (o: THREE.Object3D) => {
  let n = 0;
  o.traverse((m) => { const g = (m as THREE.Mesh).geometry; if ((m as THREE.Mesh).isMesh) n += (g.index ? g.index.count : g.getAttribute('position').count) / 3; });
  return n;
};

describe('landmarks', () => {
  it('lists every landmark with a GLB and a UTM footprint around its origin', () => {
    expect(manifest.map((l) => l.id)).toEqual(expect.arrayContaining(['ludwigskirche', 'rathaus']));
    for (const l of manifest) {
      expect(existsSync(new URL(`../public/${l.glb}`, import.meta.url))).toBe(true);
      expect(l.e).toBeGreaterThan(330000);
      expect(l.n).toBeGreaterThan(5450000);
      // (e, n) is the area centroid of the footprint (bridges: a point on the deck centreline, with y on the deck top).
      if (l.bridge !== undefined) { expect(l.y).toBeDefined(); continue; }
      let a = 0, cx = 0, cy = 0;
      const [ox, oy] = l.footprint[0];
      const rel = l.footprint.map(([x, y]) => [x - ox, y - oy]);
      rel.forEach(([x0, y0], i) => {
        const [x1, y1] = rel[(i + 1) % rel.length];
        const c = x0 * y1 - x1 * y0;
        a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
      });
      expect(Math.hypot(ox + cx / (3 * a) - l.e, oy + cy / (3 * a) - l.n)).toBeLessThan(0.05);
    }
  });

  for (const l of manifest)
    it(`${l.id}: two LODs and a small collider that fit the footprint`, async () => {
      const scene = await load(l);
      const lod0 = scene.getObjectByName(`${l.id}_lod0`)!;
      const lod1 = scene.getObjectByName(`${l.id}_lod1`)!;
      const col = scene.getObjectByName(`${l.id}_collider`)!;
      expect(lod0 && lod1 && col).toBeTruthy();
      expect(tris(lod1)).toBeLessThan(tris(lod0));
      expect(tris(col)).toBeLessThan(400);
      lod0.traverse((m) => {
        const mat = (m as THREE.Mesh).material as THREE.Material | undefined;
        if (mat) expect(mat.name).toMatch(MATERIAL);
      });
      // glTF: +X east, -Z north. The model stays within the footprint (plus eaves) and reaches below ground.
      const box = new THREE.Box3().setFromObject(lod0);
      const es = l.footprint.map((p) => p[0] - l.e), ns = l.footprint.map((p) => p[1] - l.n);
      expect(box.min.x).toBeGreaterThan(Math.min(...es) - 1.5);
      expect(box.max.x).toBeLessThan(Math.max(...es) + 1.5);
      expect(-box.max.z).toBeGreaterThan(Math.min(...ns) - 1.5);
      expect(-box.min.z).toBeLessThan(Math.max(...ns) + 1.5);
      expect(box.min.y).toBeLessThanOrEqual(-0.9);
    });
});
