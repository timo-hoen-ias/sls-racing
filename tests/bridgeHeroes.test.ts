import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';

interface Hero { id: number; type: string; halfWidth: number; pts: [number, number, number, number, number][] }
interface Landmark { id: string; e: number; n: number; y?: number; bridge?: number }
const heroes: Hero[] = JSON.parse(readFileSync(new URL('../pipeline/bridge-heroes.json', import.meta.url), 'utf8'));
const manifest: Landmark[] = JSON.parse(readFileSync(new URL('../pipeline/landmarks.json', import.meta.url), 'utf8'));

async function load(id: string) {
  const buf = readFileSync(new URL(`../public/models/landmarks/${id}.glb`, import.meta.url));
  return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')).scene;
}

/** Lateral distance from the deck centreline and height above the deck top at the nearest centreline point. */
function relative(h: Hero, l: Landmark, x: number, y: number, north: number) {
  let best = { d: Infinity, up: 0 };
  for (let i = 0; i + 1 < h.pts.length; i++) {
    const [e0, n0, y0] = h.pts[i], [e1, n1, y1] = h.pts[i + 1];
    const ax = e0 - l.e, an = n0 - l.n, bx = e1 - l.e, bn = n1 - l.n;
    const dx = bx - ax, dn = bn - an, len2 = dx * dx + dn * dn;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (north - an) * dn) / len2));
    const d = Math.hypot(x - (ax + dx * t), north - (an + dn * t));
    if (d < best.d) best = { d, up: y - (y0 + (y1 - y0) * t - l.y!) };
  }
  return best;
}

describe('hero bridges', () => {
  for (const h of heroes) {
    const l = manifest.find((m) => m.bridge === h.id)!;
    it(`bruecke-${h.id} (${h.type}) keeps the carriageway clear, railing outside, collides only outside it`, async () => {
      expect(l).toBeDefined();
      const scene = await load(l.id);
      expect(scene.getObjectByName(l.id)?.userData.hero).toBe(h.type);
      for (const part of ['lod0', 'collider']) {
        const obj = scene.getObjectByName(`${l.id}_${part}`)!;
        obj.updateWorldMatrix(true, true);
        const v = new THREE.Vector3();
        obj.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const pos = m.geometry.getAttribute('position');
          for (let i = 0; i < pos.count; i += 3) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
            const r = relative(h, l, v.x, v.y, -v.z);
            // Inside the collision deck nothing may stand above the deck, and the collider stays out entirely
            // (piers and abutments below the deck are fine).
            if (r.d < h.halfWidth - 0.05) expect(r.up, `${part} at ${r.d.toFixed(2)} m`).toBeLessThan(part === 'collider' ? -1.0 : -0.25);
            // The pedestrian railing (everything higher than the parapet) stands at least halfWidth + 0.5 m out.
            if (part === 'lod0' && r.up > 0.5) expect(r.d, 'Geländer').toBeGreaterThan(h.halfWidth + 0.5);
          }
        });
      }
    });
  }
});
