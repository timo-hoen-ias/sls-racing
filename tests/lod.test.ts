import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DrawStats, formatDrawStats, layerOf, trianglesOf } from '../src/debug/drawStats.ts';
import { carBox } from '../src/world/props.ts';
import { rectDistances, tierOf } from '../src/world/vegetation.ts';

describe('draw-call breakdown (perf.scene)', () => {
  it('names a layer by its ancestors, without the tile groups', () => {
    const scene = new THREE.Scene();
    const world = new THREE.Group();
    world.name = 'world';
    const tile = new THREE.Group();
    tile.name = 'tile 1312_21344';
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    mesh.name = 'vegetation/laubbaum lod0';
    scene.add(world);
    world.add(tile);
    tile.add(mesh);
    expect(layerOf(mesh)).toBe('world/vegetation/laubbaum lod0');
  });

  it('counts triangles of every drawn instance', () => {
    const g = new THREE.BoxGeometry();
    const im = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial(), 10);
    im.count = 4;
    expect(trianglesOf(g, im, null)).toBe(12 * 4);
    expect(trianglesOf(g, new THREE.Mesh(g), { start: 0, count: 6 })).toBe(2);
  });

  it('sums the draws of one frame by pass and restores the renderer', () => {
    const calls: unknown[] = [];
    const renderer = { renderBufferDirect: (...a: unknown[]) => calls.push(a) } as unknown as THREE.WebGLRenderer;
    const orig = renderer.renderBufferDirect;
    const stats = new DrawStats(renderer);
    const cam = new THREE.PerspectiveCamera();
    stats.camera = cam;
    const g = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh(g);
    mesh.name = 'props';
    stats.begin();
    renderer.renderBufferDirect(cam, new THREE.Scene(), g, mesh.material as THREE.Material, mesh, null as unknown as THREE.GeometryGroup);
    renderer.renderBufferDirect(new THREE.OrthographicCamera(), null as unknown as THREE.Scene, g, new THREE.MeshDepthMaterial(), mesh, null as unknown as THREE.GeometryGroup);
    renderer.renderBufferDirect(new THREE.PerspectiveCamera(), new THREE.Scene(), g, mesh.material as THREE.Material, mesh, null as unknown as THREE.GeometryGroup);
    const masked = new THREE.Scene();
    masked.overrideMaterial = new THREE.MeshBasicMaterial();
    renderer.renderBufferDirect(cam, masked, g, masked.overrideMaterial, mesh, null as unknown as THREE.GeometryGroup);
    const rows = stats.end();
    expect(renderer.renderBufferDirect).toBe(orig);
    expect(calls).toHaveLength(4);
    expect(rows.map((r) => r.pass).sort()).toEqual(['main', 'other', 'shadow']);
    expect(formatDrawStats(rows)).toMatch(/^4 Draw-Calls · 0k Dreiecke \(Bild 1/);
  });
});

describe('detail tiers', () => {
  it('picks the first band a distance is under, none beyond the last', () => {
    const bands = [140, 450, Infinity];
    expect(tierOf(0, bands)).toBe(0);
    expect(tierOf(140, bands)).toBe(1);
    expect(tierOf(5000, bands)).toBe(2);
    expect(tierOf(130, [30, 120])).toBe(-1);
  });

  it('measures the nearest and farthest point of a tile', () => {
    expect(rectDistances(0, 0, 256, 128, 128)).toEqual([0, Math.hypot(128, 128)]);
    const [near, far] = rectDistances(0, 0, 256, -100, 0);
    expect(near).toBe(100);
    expect(far).toBeCloseTo(Math.hypot(356, 256));
  });

  it('draws a far parked car as a couple of boxes inside the model bounds', () => {
    const model = new THREE.BoxGeometry(1.8, 1.45, 4.4, 8, 8, 8).translate(0, 0.725, 0);
    const box = carBox(model);
    expect(box.index!.count / 3).toBeLessThanOrEqual(22);
    box.computeBoundingBox();
    expect(model.boundingBox!.containsBox(box.boundingBox!)).toBe(true);
  });
});
