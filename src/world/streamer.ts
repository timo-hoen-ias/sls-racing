import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { TileContent, tileKey, tileOfLocal, tileOriginLocal, type WorldIndex } from './format.ts';
import type { Quality } from '../quality.ts';
import type { Materials } from '../render/materials.ts';
import { Samples } from '../debug/perf.ts';
import type { MeshArrays } from './tileBuild.ts';
import { tileColliderSteps } from './tileColliders.ts';
import { tileLayers } from './tileHooks.ts';
import { loadTile, type LoadedTileData } from './tileLoad.ts';
import type { TileJob } from './tileWorker.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type R = typeof RAPIER_NS;

interface LoadedTile {
  key: string;
  ix: number;
  iy: number;
  content: TileContent;
  group: THREE.Group;
  /** Colliders exist only near the car (physRadius). */
  body?: RAPIER_NS.RigidBody;
  /** Collider steps still to run; the tile counts as solid when this is empty. */
  pending?: (() => void)[];
  /** World positions of the lamp heads (x, y, z), for the night lights. */
  lamps?: Float32Array;
}

interface ReadyTile { content: TileContent; built: LoadedTileData['built'] }

/** Small pool of tile workers; falls back to the main thread when workers are off or unavailable. */
class TileLoader {
  private workers: Worker[] = [];
  private next = 0;
  private jobs = new Map<number, { resolve: (r: LoadedTileData) => void; reject: (e: Error) => void }>();
  private seq = 0;
  useWorker: boolean;

  constructor(size: number) {
    this.useWorker = typeof Worker !== 'undefined' && size > 0;
    if (!this.useWorker) return;
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e) => {
          const job = this.jobs.get(e.data.id);
          if (!job) return;
          this.jobs.delete(e.data.id);
          if (e.data.ok) job.resolve(e.data);
          else job.reject(new Error(e.data.error));
        };
        this.workers.push(w);
      }
    } catch (e) {
      console.warn('Tile worker unavailable, building on the main thread', e);
      this.useWorker = false;
    }
  }

  get poolSize() { return this.workers.length; }

  load(url: string, world: TileJob['world']): Promise<LoadedTileData> {
    if (!this.useWorker || !this.workers.length) return loadTile(url, world);
    const id = ++this.seq;
    const w = this.workers[this.next++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      w.postMessage({ id, url, world } satisfies TileJob);
    });
  }
}

/**
 * Loads world tiles around a point and drops the ones far away.
 * Download, decoding and vertex building run in web workers; the main thread only wraps the arrays in meshes and
 * creates colliders, within a time budget per frame. Colliders exist only within physRadius of the car.
 */
export class WorldStreamer {
  readonly root = new THREE.Group();
  private loaded = new Map<string, LoadedTile>();
  private loading = new Set<string>();
  private available: Set<string>;
  private queue: string[] = [];
  private ready: ReadyTile[] = [];
  private readyKeys = new Set<string>();
  /** Tiles from this load generation; bumped by reload() so late downloads are dropped. */
  private generation = 0;
  private R: R;
  private world: RAPIER_NS.World;
  private baseUrl: string;
  private ext: string;
  private index: WorldIndex;
  private mats: Materials;
  private quality: Quality;
  private loader: TileLoader;
  private treeGeo: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry };
  private lampGeo: { pole: THREE.BufferGeometry; head: THREE.BufferGeometry };
  /** Colliders are built within this distance (m) and dropped beyond physRadius + 150. */
  physRadius = 420;
  /** Main-thread time per frame for building meshes and colliders (ms). At least one job runs per frame. */
  budgetMs = 4;
  /** Parallel downloads. */
  maxInflight = 6;
  /**
   * Timings for the performance overlay. fetchMs: download + decode + vertex build; decodeMs: the decode + vertex
   * build part when it ran on the main thread (stream.worker off); visualMs / physicsMs: main-thread jobs;
   * frameMs: all streaming jobs per frame.
   */
  readonly stats = { fetchMs: new Samples(64), decodeMs: new Samples(64), visualMs: new Samples(64), physicsMs: new Samples(64), frameMs: new Samples(120), bytes: 0, fetched: 0, failed: 0, built: 0, physics: 0, dropped: 0 };

  constructor(R: R, world: RAPIER_NS.World, baseUrl: string, index: WorldIndex, mats: Materials, quality: Quality) {
    this.R = R;
    this.world = world;
    this.baseUrl = baseUrl;
    this.ext = index.format === 'bin' ? 'bin' : 'json';
    this.index = index;
    this.mats = mats;
    this.quality = quality;
    this.loader = new TileLoader(Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2)));
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

  get loadedCount() { return this.loaded.size; }

  /** Calls fn with every street lamp head of the loaded tiles. */
  forEachLamp(fn: (x: number, y: number, z: number) => void) {
    for (const t of this.loaded.values()) {
      const l = t.lamps;
      if (l) for (let i = 0; i < l.length; i += 3) fn(l[i], l[i + 1], l[i + 2]);
    }
  }
  get physicsCount() { let n = 0; for (const t of this.loaded.values()) if (solid(t)) n++; return n; }
  get pendingCount() { return this.loading.size + this.ready.length; }
  get queuedCount() { return this.queue.length; }
  get workerCount() { return this.loader.useWorker ? this.loader.poolSize : 0; }
  get useWorker() { return this.loader.useWorker; }
  set useWorker(v: boolean) {
    if (v && !this.loader.poolSize) throw new Error('Web Worker sind in diesem Browser nicht verfügbar');
    this.loader.useWorker = v;
  }

  /** One line for the performance overlay. */
  statsLine() {
    const s = this.stats;
    return `${this.loaded.size} sichtbar · ${this.physicsCount} mit Physik · ${this.loading.size} laden · ${this.ready.length} bereit · ${this.queue.length} Warteschlange\n`
      + `  Worker ${this.workerCount || 'aus'} · Laden Ø ${s.fetchMs.avg().toFixed(0)} ms · Hauptthread Ø ${s.frameMs.avg().toFixed(1)} / max ${s.frameMs.max().toFixed(1)} ms pro Frame\n`
      + `  Meshes Ø ${s.visualMs.avg().toFixed(1)} / max ${s.visualMs.max().toFixed(1)} ms · Kollider Ø ${s.physicsMs.avg().toFixed(1)} / max ${s.physicsMs.max().toFixed(1)} ms`
      + (this.loader.useWorker ? '' : ` · Dekodieren im Hauptthread Ø ${s.decodeMs.avg().toFixed(1)} / max ${s.decodeMs.max().toFixed(1)} ms`);
  }

  /** True when the tile under (x, z) is part of the world. */
  hasTileAt(x: number, z: number) {
    const [ix, iy] = tileOfLocal(this.index.world, x, z);
    return this.available.has(tileKey(ix, iy));
  }

  /** True when the tile under (x, z) is drawn (for spawning traffic, pedestrians …). */
  isVisibleAt(x: number, z: number) {
    return this.loaded.has(tileKey(...tileOfLocal(this.index.world, x, z)));
  }

  /** True when the tile under (x, z) has its colliders. */
  hasPhysicsAt(x: number, z: number) {
    return solid(this.loaded.get(tileKey(...tileOfLocal(this.index.world, x, z))));
  }

  /** State of the 3 × 3 tiles around (x, z), north row first: P = physics, V = visible only, … = loading, - = no tile. */
  describeAround(x: number, z: number) {
    const [ix, iy] = tileOfLocal(this.index.world, x, z);
    const rows: string[] = [];
    for (let dy = 1; dy >= -1; dy--) {
      const row: string[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        const k = tileKey(ix + dx, iy + dy);
        const t = this.loaded.get(k);
        row.push(!this.available.has(k) ? '-' : solid(t) ? 'P' : t?.body ? 'p' : t ? 'V' : this.loading.has(k) || this.readyKeys.has(k) ? '…' : '?');
      }
      rows.push(row.join(' '));
    }
    return `Kachel ${ix}_${iy}:\n${rows.join('\n')}`;
  }

  /** True when the tile under (x, z) and its existing neighbours have colliders. */
  isLoadedAround(x: number, z: number) {
    const [ix, iy] = tileOfLocal(this.index.world, x, z);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const k = tileKey(ix + dx, iy + dy);
        if (this.available.has(k) && !solid(this.loaded.get(k))) return false;
      }
    return true;
  }

  /**
   * Call every frame with the focus position (the car). urgent (car held for a teleport) allows a large budget,
   * since nothing moves while the world appears.
   */
  update(x: number, z: number, urgent = false) {
    const w = this.index.world;
    const [cx, cy] = tileOfLocal(w, x, z);
    const radius = this.quality.radius;
    const r = Math.ceil(radius / w.tileSize);
    const wanted: { key: string; d: number }[] = [];
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const key = tileKey(cx + dx, cy + dy);
        if (!this.available.has(key) || this.loaded.has(key) || this.loading.has(key) || this.readyKeys.has(key)) continue;
        const d = this.dist(cx + dx, cy + dy, x, z);
        if (d <= radius + w.tileSize * 0.7) wanted.push({ key, d });
      }
    wanted.sort((a, b) => a.d - b.d);
    this.queue = wanted.map((t) => t.key);
    while (this.loading.size < this.maxInflight && this.queue.length) this.fetchTile(this.queue.shift()!);

    // Main-thread jobs within the budget: colliders right around the car first, then the nearest new tile, then
    // the remaining colliders.
    const t0 = performance.now();
    const deadline = t0 + (urgent ? 50 : this.budgetMs);
    // The car's tile and its eight neighbours always get colliders, whatever physRadius says.
    const around = (t: LoadedTile) => Math.abs(t.ix - cx) <= 1 && Math.abs(t.iy - cy) <= 1;
    do {
      const must = this.nearestWithoutPhysics(x, z, around);
      if (must) { this.addPhysics(must.t); continue; }
      if (this.ready.length) {
        let bi = 0, bd = Infinity;
        this.ready.forEach((t, i) => { const d = this.dist(t.content.ix, t.content.iy, x, z); if (d < bd) { bd = d; bi = i; } });
        const [t] = this.ready.splice(bi, 1);
        this.readyKeys.delete(t.content.key);
        this.addVisual(t);
        continue;
      }
      const phys = this.nearestWithoutPhysics(x, z);
      if (phys && phys.d < this.physRadius) { this.addPhysics(phys.t); continue; }
      break;
    } while (performance.now() < deadline);
    const ms = performance.now() - t0;
    this.stats.frameMs.push(ms);

    for (const t of this.loaded.values()) {
      const d = this.dist(t.ix, t.iy, x, z);
      if (d > radius + 300) this.removeTile(t);
      else if (t.body && d > this.physRadius + 150 && !around(t)) this.removePhysics(t);
    }
  }

  /** Drops every tile and loads again (after changing format, radius or worker mode). */
  reload() {
    for (const t of [...this.loaded.values()]) this.removeTile(t);
    this.ready = [];
    this.readyKeys.clear();
    this.loading.clear();
    this.generation++;
  }

  private nearestWithoutPhysics(x: number, z: number, filter?: (t: LoadedTile) => boolean) {
    let best: LoadedTile | undefined, bd = Infinity;
    for (const t of this.loaded.values()) {
      if (solid(t) || (filter && !filter(t))) continue;
      const d = this.dist(t.ix, t.iy, x, z);
      if (d < bd) { bd = d; best = t; }
    }
    return best && { t: best, d: bd };
  }

  private dist(ix: number, iy: number, x: number, z: number) {
    const w = this.index.world;
    const [ox, oz] = tileOriginLocal(w, ix, iy);
    return Math.hypot(ox + w.tileSize / 2 - x, oz + w.tileSize / 2 - z);
  }

  private async fetchTile(key: string) {
    this.loading.add(key);
    const gen = this.generation;
    try {
      const url = new URL(`${this.baseUrl}/t/${key}.${this.ext}`, location.href).href;
      const r = await this.loader.load(url, this.index.world);
      if (gen !== this.generation) return;
      this.stats.fetchMs.push(r.fetchMs + r.buildMs);
      if (!this.loader.useWorker) this.stats.decodeMs.push(r.buildMs);
      this.stats.bytes += r.bytes;
      this.stats.fetched++;
      this.ready.push({ content: new TileContent(r.buffer), built: r.built });
      this.readyKeys.add(key);
    } catch (e) {
      if (gen !== this.generation) return;
      console.warn(`Tile ${key} failed`, e);
      this.stats.failed++;
      this.available.delete(key);
    } finally {
      if (gen === this.generation) this.loading.delete(key);
    }
  }

  private addVisual({ content: t, built: b }: ReadyTile) {
    const key = t.key;
    if (this.loaded.has(key)) return;
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = `tile ${key}`;
    const shadows = this.quality.shadows > 0;

    const mesh = (m: MeshArrays | undefined, mat: THREE.Material, opts: { cast?: boolean; receive?: boolean } = {}) => {
      if (!m) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
      if (m.uv) geo.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
      if (m.col) geo.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
      if (m.idx) geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
      geo.computeBoundingSphere();
      const o = new THREE.Mesh(geo, mat);
      o.castShadow = shadows && !!opts.cast;
      o.receiveShadow = shadows && opts.receive !== false;
      group.add(o);
    };
    mesh(b.terrain, this.mats.ground);
    mesh(b.water, this.mats.water);
    mesh(b.meshes.roads, this.mats.road);
    mesh(b.meshes.sidewalks, this.mats.sidewalk);
    mesh(b.meshes.markings, this.mats.marking);
    mesh(b.meshes.buildings, this.mats.building, { cast: true });

    const tr = t.f32('trees');
    if (tr && this.quality.trees) {
      const n = tr.length / 4;
      const trunks = new THREE.InstancedMesh(this.treeGeo.trunk, this.mats.trunk, n);
      const crowns = new THREE.InstancedMesh(this.treeGeo.crown, this.mats.crown, n);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const [x, y, z, sc] = [tr[i * 4], tr[i * 4 + 1], tr[i * 4 + 2], tr[i * 4 + 3]];
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, (x * 7.3 + z * 3.1) % (Math.PI * 2));
        s.setScalar(sc);
        m.compose(p.set(x, y - 0.2, z), q, s);
        trunks.setMatrixAt(i, m);
        crowns.setMatrixAt(i, m);
        crowns.setColorAt(i, c.setHSL(0.24 + fract(x * 0.37) * 0.07, 0.42, 0.24 + fract(z * 0.53) * 0.08));
      }
      crowns.castShadow = trunks.castShadow = shadows;
      trunks.computeBoundingSphere();
      crowns.computeBoundingSphere();
      group.add(trunks, crowns);
    }

    const l = t.f32('lamps');
    let lampHeads: Float32Array | undefined;
    if (l) {
      const n = l.length / 4;
      const poles = new THREE.InstancedMesh(this.lampGeo.pole, this.mats.lampPole, n);
      const heads = new THREE.InstancedMesh(this.lampGeo.head, this.mats.lampHead, n);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const one = new THREE.Vector3(1, 1, 1);
      const head = new THREE.Vector3();
      lampHeads = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.PI - l[i * 4 + 3]);
        m.compose(p.set(l[i * 4], l[i * 4 + 1], l[i * 4 + 2]), q, one);
        head.set(0, 6.7, 1.55).applyMatrix4(m).toArray(lampHeads, i * 3);
        poles.setMatrixAt(i, m);
        heads.setMatrixAt(i, m);
      }
      poles.castShadow = shadows;
      poles.computeBoundingSphere();
      heads.computeBoundingSphere();
      group.add(poles, heads);
    }

    const origin = tileOriginLocal(this.index.world, t.ix, t.iy);
    for (const layer of tileLayers()) {
      try {
        layer.visual?.(t, { group, origin, shadows, quality: this.quality, mats: this.mats, mesh: (f) => b.meshes[f] });
      } catch (e) { console.warn(`Tile layer ${layer.name} failed on ${key}`, e); }
    }

    this.root.add(group);
    this.loaded.set(key, { key, ix: t.ix, iy: t.iy, content: t, group, lamps: lampHeads });
    this.stats.visualMs.push(performance.now() - t0);
    this.stats.built++;
  }

  /** Runs the next collider step of a tile (creating its body first). Layer physics runs with the last step. */
  private addPhysics(t: LoadedTile) {
    const t0 = performance.now();
    if (!t.body) {
      const { body, steps } = tileColliderSteps(this.R, this.world, t.content, this.index.world);
      t.body = body;
      t.pending = steps;
      for (const layer of tileLayers()) {
        if (layer.physics) steps.push(() => {
          try { layer.physics!(t.content, body, this.R, this.world); } catch (e) { console.warn(`Tile layer ${layer.name} physics failed on ${t.key}`, e); }
        });
      }
    }
    t.pending!.shift()?.();
    this.stats.physicsMs.push(performance.now() - t0);
    if (!t.pending!.length) {
      t.pending = undefined;
      this.stats.physics++;
    }
  }

  private removePhysics(t: LoadedTile) {
    if (!t.body) return;
    this.world.removeRigidBody(t.body);
    t.body = undefined;
    t.pending = undefined;
  }

  private removeTile(t: LoadedTile) {
    this.root.remove(t.group);
    t.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      else if (m.isMesh && !m.userData.sharedGeometry) m.geometry.dispose();
    });
    this.removePhysics(t);
    this.loaded.delete(t.key);
    this.stats.dropped++;
    for (const layer of tileLayers()) layer.removed?.(t.key);
  }
}

const fract = (v: number) => v - Math.floor(v);
/** All colliders of the tile exist. */
const solid = (t: LoadedTile | undefined) => !!t?.body && !t.pending;
