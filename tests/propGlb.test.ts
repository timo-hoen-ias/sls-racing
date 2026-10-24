import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { propSetFromScene } from '../src/world/propGlb.ts';
import { PROP_NAMES } from '../src/world/propKinds.ts';
import { withoutTextures } from './glbWithoutTextures.ts';

async function load() {
  const buf = readFileSync(new URL('../public/models/props.glb', import.meta.url));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(withoutTextures(buf), '');
  return propSetFromScene(gltf.scene);
}

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const box = (g: THREE.BufferGeometry) => new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);

describe('props GLB', () => {
  it('has every furniture kind of propKinds (except hedge, parked cars and bridge railings) with two LODs', async () => {
    const set = await load();
    // Bridge railings, delineators and chevron boards are procedural only (propModels.ts) for now.
    const skip = new Set(['hecke', 'parker', 'schild', 'stoppschild', 'vorfahrt-achten', 'ortsschild', 'gelaender', 'leitpfosten', 'richtungstafel-links', 'richtungstafel-rechts']);
    for (const name of Object.values(PROP_NAMES)) {
      if (skip.has(name)) continue;
      const p = set.props[name];
      expect(p, name).toBeDefined();
      expect(tris(p.lod1), name).toBeLessThanOrEqual(150);
      expect(p.lod0.getAttribute('color'), name).toBeDefined();
      expect(box(p.lod0).min.y, name).toBeGreaterThan(-0.05);
    }
    for (const name of ['bushaltestelle-dach', 'ampel', 'schild_mast']) expect(set.props[name], name).toBeDefined();
  });

  it('traffic light lamps sit where signalView expects them', async () => {
    const set = await load();
    const ys = { green: 2.55, yellow: 2.85, red: 3.15 } as const;
    for (const c of ['red', 'yellow', 'green'] as const) {
      const b = box(set.lamps[c]);
      expect((b.min.y + b.max.y) / 2).toBeCloseTo(ys[c], 2);
      expect((b.min.z + b.max.z) / 2).toBeCloseTo(0.14, 2);
      expect(b.max.x - b.min.x).toBeCloseTo(0.2, 1);
    }
  });

  it('sign faces have uv and face +z', async () => {
    const set = await load();
    for (const t of ['vorfahrtstrasse', 'vorfahrt', 'vorfahrt-achten', 'stop', 'einfahrt-verboten', 'tempo-30', 'tempo-50', 'tempo-70', 'tempo-100', 'ortsschild', 'zusatz', 'fussgaenger']) {
      const g = set.signs[t];
      expect(g, t).toBeDefined();
      expect(g.getAttribute('uv'), t).toBeDefined();
      expect(box(g).max.z, t).toBeLessThan(0.05);
    }
  });

  it('pedestrians: four variants under 400 triangles with the pedView pivots', async () => {
    const set = await load();
    expect(set.peds.map((p) => p.variant)).toEqual(['mantel', 'rock', 'rucksack', 'kind']);
    for (const p of set.peds) {
      expect(tris(p.torso) + tris(p.head) + tris(p.hair) + 2 * (tris(p.leg) + tris(p.arm))).toBeLessThan(400);
      const leg = box(p.leg), arm = box(p.arm), head = box(p.head);
      expect(leg.max.y).toBeLessThan(0.05);
      expect(leg.min.y).toBeCloseTo(-0.92, 1);
      expect(arm.min.y).toBeCloseTo(-0.6, 1);
      expect(head.max.y).toBeGreaterThan(1.75);
      // Greyscale: the game tints them.
      const c = p.torso.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < c.count; i += 7) expect(Math.abs(c.getX(i) - c.getY(i)) + Math.abs(c.getY(i) - c.getZ(i))).toBeLessThan(0.02);
    }
    expect(set.peds.find((p) => p.variant === 'kind')!.scale).toBeCloseTo(0.67, 2);
  });
});
