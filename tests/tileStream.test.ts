import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { Ground, TERRAIN_N, TileContent, encode, encodeTile, tileOriginLocal, type TileData, type WorldInfo } from '../src/world/format.ts';
import { buildTile, gridIndex, terrainHeights, transferList } from '../src/world/tileBuild.ts';
import { addTileColliders, splitMesh } from '../src/world/tileColliders.ts';

const W: WorldInfo = { zone: 32, originE: 337000, originN: 5465000, tileSize: 256 };
const IX = 1316, IY = 21347;

function sampleTile(): TileData {
  const N = TERRAIN_N;
  const h = new Float32Array(N * N);
  const g = new Uint8Array(N * N).fill(Ground.grass);
  // Bumpy ground with a saddle in every cell, so the triangle diagonal matters.
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) h[r * N + c] = 180 + 3 * Math.sin(r * 0.9) * Math.cos(c * 1.3) + ((r + c) % 2) * 1.5;
  for (let i = 0; i < 40; i++) g[i] = Ground.water;
  const [ox, oz] = tileOriginLocal(W, IX, IY);
  const pos = new Float32Array([ox + 10, 181, oz + 10, ox + 20, 181, oz + 10, ox + 10, 181, oz + 20]);
  return {
    v: 1, ix: IX, iy: IY, terrain: encode(h), ground: encode(g),
    roads: { pos: encode(pos), col: encode(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255])), idx: encode(new Uint32Array([0, 2, 1])) },
    trees: encode(new Float32Array([ox + 50, 180, oz + 50, 1])),
    // A field the client does not know yet passes through as raw bytes.
    ...({ props: encode(new Float32Array([1, 2, 3])) } as object),
  };
}

const content = () => { const b = encodeTile(sampleTile()); return new TileContent(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); };

describe('binary tile format', () => {
  it('round-trips sections as aligned typed arrays', () => {
    const t = content();
    expect([t.ix, t.iy, t.key]).toEqual([IX, IY, `${IX}_${IY}`]);
    expect(t.f32('terrain')).toHaveLength(TERRAIN_N * TERRAIN_N);
    expect(t.u8('ground')![0]).toBe(Ground.water);
    expect([...t.u32('roads.idx')!]).toEqual([0, 2, 1]);
    expect(t.has('roads.nrm')).toBe(false);
    expect(new Float32Array(t.u8('props')!.slice().buffer)).toEqual(new Float32Array([1, 2, 3]));
    for (const n of t.names()) expect(t.u8(n)!.byteOffset % 4).toBe(0);
  });

  it('is smaller than the JSON tile', () => {
    expect(encodeTile(sampleTile()).byteLength).toBeLessThan(JSON.stringify(sampleTile()).length * 0.8);
  });
});

describe('tile vertex build', () => {
  it('matches three.js normals and colour conversion', () => {
    const t = content();
    const b = buildTile(t, W);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.terrain.pos, 3));
    g.setIndex(new THREE.BufferAttribute(b.terrain.idx!, 1));
    g.computeVertexNormals();
    const ref = g.getAttribute('normal').array as Float32Array;
    for (let i = 0; i < ref.length; i++) expect(b.terrain.nrm[i]).toBeCloseTo(ref[i], 5);
    // Road without normals gets them computed, facing up for a counter-clockwise-from-above triangle.
    expect(b.meshes.roads.nrm[1]).toBeCloseTo(1, 5);
    expect(b.meshes.roads.col![0]).toBeCloseTo(1, 5);
    expect(b.water).toBeDefined();
    expect(b.meshes.collide).toBeUndefined();
    // Every buffer is transferable and owned by the result, not the download.
    expect(transferList(b)).not.toContain(t.buffer);
  });
});

describe('tile colliders', () => {
  beforeAll(() => RAPIER.init());

  it('heightfield matches the rendered terrain triangles', () => {
    const t = content();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addTileColliders(RAPIER, world, t, W);
    // Reference: the old trimesh terrain in its own world.
    const ref = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const b = buildTile(t, W);
    ref.createCollider(RAPIER.ColliderDesc.trimesh(b.terrain.pos, gridIndex(TERRAIN_N)), ref.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
    world.step(); ref.step();
    const [ox, oz] = tileOriginLocal(W, IX, IY);
    const at = (wld: RAPIER.World, x: number, z: number) => {
      // Terrain only: road surfaces (their own group) lie above it.
      const hit = wld.castRay(new RAPIER.Ray({ x, y: 1000, z }, { x: 0, y: -1, z: 0 }), 2000, true, undefined, (0xffff << 16) | 0xfffb);
      return hit ? 1000 - hit.timeOfImpact : NaN;
    };
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) {
      const x = ox + 1 + rnd() * 254, z = oz + 1 + rnd() * 254;
      // Skip the tree trunk.
      if (Math.hypot(x - ox - 50, z - oz - 50) < 2) continue;
      expect(at(world, x, z)).toBeCloseTo(at(ref, x, z), 3);
    }
    // Water cells are lowered like the mesh.
    expect(terrainHeights(t)[0]).toBeCloseTo(t.f32('terrain')![0] - 0.6, 4);
  });
});

describe('collider mesh split', () => {
  it('keeps every triangle with compact vertices', () => {
    const pos = new Float32Array(Array.from({ length: 30 }, (_, i) => i));
    const idx = Uint32Array.from([0, 1, 2, 2, 3, 4, 5, 6, 7, 7, 8, 9, 0, 9, 5]);
    const parts = splitMesh(pos, idx, 2);
    expect(parts).toHaveLength(3);
    const tris = parts.flatMap(([v, i]) => [...i].map((k) => v[k * 3]));
    expect(tris).toEqual([...idx].map((k) => pos[k * 3]));
    expect(parts[0][0]).toHaveLength(5 * 3);
  });
});
