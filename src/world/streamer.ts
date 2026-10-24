import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { waterAttributes } from '../render/water.ts';
import {
  Ground, TERRAIN_N, TERRAIN_STEP, decodeF32, decodeU32, decodeU8, tileKey, tileOfLocal, tileOriginLocal,
  type PackedMesh, type TileData, type WorldIndex,
} from './format.ts';
import type { Quality } from '../quality.ts';
import type { Materials } from '../render/materials.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type R = typeof RAPIER_NS;

const GROUND_COLORS: Record<number, THREE.Color> = {
  [Ground.urban]: new THREE.Color('#8d8a7f'),
  [Ground.grass]: new THREE.Color('#5f7a3e'),
  [Ground.forest]: new THREE.Color('#3d5229'),
  [Ground.water]: new THREE.Color('#2f5566'),
  [Ground.farmland]: new THREE.Color('#8f8a55'),
};

interface LoadedTile {
  key: string;
  group: THREE.Group;
  body: RAPIER_NS.RigidBody;
  /** Distance from the car when last checked, for unloading. */
  ix: number;
  iy: number;
  /** Ground class per terrain sample (for the tyre surface). */
  ground: Uint8Array;
  /** World positions of the lamp heads (x, y, z), for the night lights. */
  lamps?: Float32Array;
}

/** Loads world tiles around a point and drops the ones far away. */
export class WorldStreamer {
  readonly root = new THREE.Group();
  private loaded = new Map<string, LoadedTile>();
  private loading = new Set<string>();
  private available: Set<string>;
  private queue: string[] = [];
  private ready: TileData[] = [];
  private readyKeys = new Set<string>();
  private R: R;
  private world: RAPIER_NS.World;
  private baseUrl: string;
  private index: WorldIndex;
  private mats: Materials;
  private quality: Quality;
  private treeGeo: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry };
  private lampGeo: { pole: THREE.BufferGeometry; head: THREE.BufferGeometry };

  constructor(R: R, world: RAPIER_NS.World, baseUrl: string, index: WorldIndex, mats: Materials, quality: Quality) {
    this.R = R;
    this.world = world;
    this.baseUrl = baseUrl;
    this.index = index;
    this.mats = mats;
    this.quality = quality;
    this.available = new Set(index.tiles.map(([x, y]) => tileKey(x, y)));
    this.root.name = 'world';
    const crown = new THREE.IcosahedronGeometry(2.6, 1);
    crown.translate(0, 5.2, 0);
    crown.scale(1, 1.15, 1);
    const trunk = new THREE.CylinderGeometry(0.18, 0.26, 3.2, 6);
    trunk.translate(0, 1.6, 0);
    this.treeGeo = { trunk, crown };
    // Street lamp: 7 m pole with an arm reaching over the road (+z).
    const pole = mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.1, 7, 8).translate(0, 3.5, 0),
      new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6).rotateX(Math.PI / 2).translate(0, 6.9, 0.8),
    ])!;
    const head = new THREE.BoxGeometry(0.3, 0.12, 0.6).translate(0, 6.84, 1.55);
    this.lampGeo = { pole, head };
  }

  /** Water surfaces of the loaded tiles (the water mirror picks its plane from them). */
  readonly waterMeshes = new Set<THREE.Mesh>();

  get loadedCount() { return this.loaded.size; }

  /** Calls fn with every street lamp head of the loaded tiles. */
  forEachLamp(fn: (x: number, y: number, z: number) => void) {
    for (const t of this.loaded.values()) {
      const l = t.lamps;
      if (l) for (let i = 0; i < l.length; i += 3) fn(l[i], l[i + 1], l[i + 2]);
    }
  }
  get pendingCount() { return this.loading.size + this.ready.length; }

  /** Ground class (see Ground) at the nearest terrain sample, or undefined where no tile is loaded. */
  groundAt(x: number, z: number): number | undefined {
    const w = this.index.world;
    const [ix, iy] = tileOfLocal(w, x, z);
    const t = this.loaded.get(tileKey(ix, iy));
    if (!t) return undefined;
    const [ox, oz] = tileOriginLocal(w, ix, iy);
    const c = Math.min(TERRAIN_N - 1, Math.max(0, Math.round((x - ox) / TERRAIN_STEP)));
    const r = Math.min(TERRAIN_N - 1, Math.max(0, Math.round((z - oz) / TERRAIN_STEP)));
    return t.ground[r * TERRAIN_N + c];
  }

  /** True when the tile under (x, z) is part of the world. */
  hasTileAt(x: number, z: number) {
    const [ix, iy] = tileOfLocal(this.index.world, x, z);
    return this.available.has(tileKey(ix, iy));
  }

  /** True when the tile under (x, z) and its existing neighbours are built. */
  isLoadedAround(x: number, z: number) {
    const [ix, iy] = tileOfLocal(this.index.world, x, z);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const k = tileKey(ix + dx, iy + dy);
        if (this.available.has(k) && !this.loaded.has(k)) return false;
      }
    return true;
  }

  /** Call every frame with the focus position (the car). */
  update(x: number, z: number) {
    const w = this.index.world;
    const [cx, cy] = tileOfLocal(w, x, z);
    const r = Math.ceil(this.quality.radius / w.tileSize);
    const wanted: { key: string; d: number }[] = [];
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const key = tileKey(cx + dx, cy + dy);
        if (!this.available.has(key) || this.loaded.has(key) || this.loading.has(key) || this.readyKeys.has(key)) continue;
        const [ox, oz] = tileOriginLocal(w, cx + dx, cy + dy);
        const d = Math.hypot(ox + w.tileSize / 2 - x, oz + w.tileSize / 2 - z);
        if (d <= this.quality.radius + w.tileSize * 0.7) wanted.push({ key, d });
      }
    wanted.sort((a, b) => a.d - b.d);
    this.queue = wanted.map((t) => t.key);
    while (this.loading.size < 4 && this.queue.length) this.fetchTile(this.queue.shift()!);

    // Build at most one tile per frame to avoid hitches; the nearest first.
    if (this.ready.length) {
      this.ready.sort((a, b) => this.dist(a.ix, a.iy, x, z) - this.dist(b.ix, b.iy, x, z));
      const t = this.ready.shift()!;
      this.readyKeys.delete(tileKey(t.ix, t.iy));
      this.addTile(t);
    }

    for (const t of this.loaded.values()) {
      if (this.dist(t.ix, t.iy, x, z) > this.quality.radius + 300) this.removeTile(t);
    }
  }

  private dist(ix: number, iy: number, x: number, z: number) {
    const w = this.index.world;
    const [ox, oz] = tileOriginLocal(w, ix, iy);
    return Math.hypot(ox + w.tileSize / 2 - x, oz + w.tileSize / 2 - z);
  }

  private async fetchTile(key: string) {
    this.loading.add(key);
    try {
      const res = await fetch(`${this.baseUrl}/t/${key}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tile: TileData = await res.json();
      this.ready.push(tile);
      this.readyKeys.add(key);
    } catch (e) {
      console.warn(`Tile ${key} failed`, e);
      this.available.delete(key);
    } finally {
      this.loading.delete(key);
    }
  }

  private addTile(t: TileData) {
    const key = tileKey(t.ix, t.iy);
    if (this.loaded.has(key)) return;
    const w = this.index.world;
    const [ox, oz] = tileOriginLocal(w, t.ix, t.iy);
    const group = new THREE.Group();
    group.name = `tile ${key}`;
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const shadows = this.quality.shadows > 0;

    // Terrain grid.
    const h = decodeF32(t.terrain);
    const g = decodeU8(t.ground);
    const N = TERRAIN_N;
    const pos = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 3);
    const uv = new Float32Array(N * N * 2);
    const tmp = new THREE.Color();
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        const water = g[i] === Ground.water;
        pos.set([ox + c * TERRAIN_STEP, h[i] - (water ? 0.6 : 0), oz + r * TERRAIN_STEP], i * 3);
        tmp.copy(GROUND_COLORS[g[i]] ?? GROUND_COLORS[Ground.grass]);
        const n = 0.92 + 0.16 * fract(Math.sin((ox + c * 8) * 12.9898 + (oz + r * 8) * 78.233) * 43758.5453);
        tmp.multiplyScalar(n);
        col.set([tmp.r, tmp.g, tmp.b], i * 3);
        uv.set([(ox + c * TERRAIN_STEP) / 6, (oz + r * TERRAIN_STEP) / 6], i * 2);
      }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let k = 0;
    for (let r = 0; r < N - 1; r++)
      for (let c = 0; c < N - 1; c++) {
        const a = r * N + c, b = a + 1, d = a + N, e = d + 1;
        idx.set([a, d, b, b, d, e], k);
        k += 6;
      }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tg.setIndex(new THREE.BufferAttribute(idx, 1));
    tg.computeVertexNormals();
    const terrain = new THREE.Mesh(tg, this.mats.ground);
    terrain.receiveShadow = shadows;
    group.add(terrain);
    this.world.createCollider(this.R.ColliderDesc.trimesh(pos, idx).setFriction(0.9), body);

    // Water surface where the ground is water, with bank distance and flow for the water shader.
    if (g.some((v) => v === Ground.water)) {
      const wg = tg.clone();
      const wp = wg.getAttribute('position') as THREE.BufferAttribute;
      let level = 0, cells = 0;
      for (let i = 0; i < N * N; i++) {
        wp.setY(i, h[i] - 0.15);
        if (g[i] === Ground.water) { level += h[i] - 0.15; cells++; }
      }
      const wi: number[] = [];
      for (let r = 0; r < N - 1; r++)
        for (let c = 0; c < N - 1; c++) {
          const a = r * N + c;
          if ([a, a + 1, a + N, a + N + 1].some((v) => g[v] === Ground.water)) wi.push(a, a + N, a + 1, a + 1, a + N, a + N + 1);
        }
      wg.setIndex(wi);
      wg.deleteAttribute('color');
      wg.deleteAttribute('normal');
      const { shore, flow } = waterAttributes((i) => g[i] === Ground.water, N, TERRAIN_STEP, ox, oz, t.waterways ? decodeF32(t.waterways) : undefined);
      wg.setAttribute('shore', new THREE.BufferAttribute(shore, 1));
      wg.setAttribute('flow', new THREE.BufferAttribute(flow, 2));
      const wm = new THREE.Mesh(wg, this.mats.water);
      wm.userData.level = level / Math.max(1, cells);
      wm.renderOrder = 1;
      group.add(wm);
      this.waterMeshes.add(wm);
    }

    const mesh = (p: PackedMesh | undefined, mat: THREE.Material, opts: { collide?: boolean; cast?: boolean; receive?: boolean; flatNormals?: boolean } = {}) => {
      if (!p) return;
      const geo = unpack(p);
      if (!p.nrm) geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadows && !!opts.cast;
      m.receiveShadow = shadows && opts.receive !== false;
      group.add(m);
      if (opts.collide) {
        const v = geo.getAttribute('position').array as Float32Array;
        const i = geo.index ? (geo.index.array as Uint32Array) : Uint32Array.from({ length: v.length / 3 }, (_, n) => n);
        this.world.createCollider(this.R.ColliderDesc.trimesh(v, i).setFriction(0.6), body);
      }
    };
    mesh(t.roads, this.mats.road);
    mesh(t.sidewalks, this.mats.sidewalk);
    mesh(t.markings, this.mats.marking, { receive: true });
    mesh(t.buildings, this.mats.building, { collide: true, cast: true });
    if (t.collide) {
      const v = decodeF32(t.collide.pos);
      this.world.createCollider(this.R.ColliderDesc.trimesh(v, decodeU32(t.collide.idx!)).setFriction(0.9), body);
    }

    if (t.trees && this.quality.trees) {
      const tr = decodeF32(t.trees);
      const n = tr.length / 4;
      const trunks = new THREE.InstancedMesh(this.treeGeo.trunk, this.mats.trunk, n);
      const crowns = new THREE.InstancedMesh(this.treeGeo.crown, this.mats.crown, n);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const [x, y, z, sc] = [tr[i * 4], tr[i * 4 + 1], tr[i * 4 + 2], tr[i * 4 + 3]];
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, (x * 7.3 + z * 3.1) % (Math.PI * 2));
        s.setScalar(sc);
        m.compose(new THREE.Vector3(x, y - 0.2, z), q, s);
        trunks.setMatrixAt(i, m);
        crowns.setMatrixAt(i, m);
        crowns.setColorAt(i, c.setHSL(0.24 + fract(x * 0.37) * 0.07, 0.42, 0.24 + fract(z * 0.53) * 0.08));
        this.world.createCollider(this.R.ColliderDesc.cylinder(1.6 * sc, 0.3 * sc).setTranslation(x, y + 1.4 * sc, z), body);
      }
      crowns.castShadow = trunks.castShadow = shadows;
      group.add(trunks, crowns);
    }

    let lampHeads: Float32Array | undefined;
    if (t.lamps) {
      const l = decodeF32(t.lamps);
      const n = l.length / 4;
      const poles = new THREE.InstancedMesh(this.lampGeo.pole, this.mats.lampPole, n);
      const heads = new THREE.InstancedMesh(this.lampGeo.head, this.mats.lampHead, n);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const one = new THREE.Vector3(1, 1, 1);
      const head = new THREE.Vector3();
      lampHeads = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.PI - l[i * 4 + 3]);
        m.compose(new THREE.Vector3(l[i * 4], l[i * 4 + 1], l[i * 4 + 2]), q, one);
        head.set(0, 6.7, 1.55).applyMatrix4(m).toArray(lampHeads, i * 3);
        poles.setMatrixAt(i, m);
        heads.setMatrixAt(i, m);
        this.world.createCollider(this.R.ColliderDesc.cylinder(3.5, 0.12).setTranslation(l[i * 4], l[i * 4 + 1] + 3.5, l[i * 4 + 2]), body);
      }
      poles.castShadow = shadows;
      group.add(poles, heads);
    }

    this.root.add(group);
    this.loaded.set(key, { key, group, body, ix: t.ix, iy: t.iy, ground: g, lamps: lampHeads });
  }

  private removeTile(t: LoadedTile) {
    this.root.remove(t.group);
    t.group.traverse((o) => {
      this.waterMeshes.delete(o as THREE.Mesh);
      if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.Mesh).geometry.dispose();
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    this.world.removeRigidBody(t.body);
    this.loaded.delete(t.key);
  }
}

const fract = (v: number) => v - Math.floor(v);

function unpack(p: PackedMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(decodeF32(p.pos), 3));
  if (p.nrm) g.setAttribute('normal', new THREE.BufferAttribute(decodeF32(p.nrm), 3));
  if (p.uv) g.setAttribute('uv', new THREE.BufferAttribute(decodeF32(p.uv), 2));
  if (p.col) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(decodeU8(p.col)).map((v) => srgbToLinear(v / 255)), 3));
  if (p.idx) g.setIndex(new THREE.BufferAttribute(decodeU32(p.idx), 1));
  return g;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
