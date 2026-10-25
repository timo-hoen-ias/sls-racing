// Far view (P3): coarse terrain and building blocks out to the horizon, beyond the detailed tiles.
// Far tiles cover FAR_TILE_SIZE squares (see pipeline/lib/far.ts). Wherever a detailed tile is visible, the far
// meshes discard their fragments, using a small mask texture of visible tiles around the car.
import * as THREE from 'three';
import { FAR_BLOCK, Ground, TileContent, isGzip, tileKey, tileOfLocal, tileOriginLocal, utmToLocal, type WorldIndex } from './format.ts';
import { gridMesh, srgbToLinear } from './tileBuild.ts';
import { gunzip } from './tileLoad.ts';

/** Mask edge in near tiles (MASK × 256 m around the car). */
const MASK = 64;
const WATER_DROP = 1.5;

// sRGB wall tones like the detailed buildings, a little darker for distance.
const BLOCK_COLORS = ['#d8d0c0', '#e0d8c8', '#cbb79a', '#bfae94', '#d2c4a8', '#a8a49c', '#b07a62'].map((c) => new THREE.Color(c));

interface FarTile { key: string; fx: number; fy: number; group: THREE.Group }

export interface FarView {
  /** Is the mask cell at (ix, iy) covered by a visible detailed tile? */
  forEachVisible(fn: (ix: number, iy: number) => void): void;
  readonly visibleVersion: number;
}

/** How far the far ground moves from its class colour to the survey colour (0..1). */
const FAR_AERIAL = 0.85;

export class FarField {
  /** Far ground in the survey colours where the far tiles have them (lod.aerial). */
  aerial = true;
  readonly root = new THREE.Group();
  /** View distance of the far field in metres (lod.dist). */
  dist: number;
  private index: WorldIndex;
  private baseUrl: string;
  private near: FarView;
  private tiles = new Map<string, FarTile>();
  private loading = new Set<string>();
  private ready: TileContent[] = [];
  private available: Set<string>;
  private maskData = new Uint8Array(MASK * MASK);
  private mask = new THREE.DataTexture(this.maskData, MASK, MASK, THREE.RedFormat, THREE.UnsignedByteType);
  /** Mask placement: north-west corner (local x, z) and the tile indices of its first column / top row. */
  private maskInfo = new THREE.Vector3();
  private maskTile: [number, number] = [NaN, NaN];
  private maskVersion = -1;
  private timer = 0;
  private terrainMat: THREE.MeshLambertMaterial;
  private blockMat: THREE.MeshLambertMaterial;
  private blockGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  readonly stats = { blocks: 0, triangles: 0 };

  constructor(baseUrl: string, index: WorldIndex, near: FarView, dist: number) {
    this.baseUrl = baseUrl;
    this.index = index;
    this.near = near;
    this.dist = dist;
    this.available = new Set((index.far?.tiles ?? []).map(([x, y]) => tileKey(x, y)));
    this.root.name = 'far field';
    this.mask.magFilter = this.mask.minFilter = THREE.NearestFilter;
    this.terrainMat = this.masked(new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.blockMat = this.masked(new THREE.MeshLambertMaterial({ color: '#ffffff' }));
  }

  get enabled() { return this.root.visible; }
  set enabled(v: boolean) { this.root.visible = v; }
  get hasData() { return this.available.size > 0; }
  get loadedCount() { return this.tiles.size; }

  /** Adds the "hide under visible detailed tiles" test to a material. */
  private masked<T extends THREE.Material>(m: T): T {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uFarMask = { value: this.mask };
      sh.uniforms.uFarMaskInfo = { value: this.maskInfo };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 farWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            farWorld = instanceMatrix * farWorld;
          #endif
          vFarXZ = (modelMatrix * farWorld).xz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uFarMask;
          uniform vec3 uFarMaskInfo;
          varying vec2 vFarXZ;`)
        .replace('void main() {', `void main() {
          ivec2 farCell = ivec2(floor((vFarXZ - uFarMaskInfo.xy) / uFarMaskInfo.z));
          if (all(greaterThanEqual(farCell, ivec2(0))) && all(lessThan(farCell, ivec2(${MASK}))) && texelFetch(uFarMask, farCell, 0).r > 0.5) discard;`);
    };
    m.customProgramCacheKey = () => 'farMasked';
    return m;
  }

  /** Call every frame with the car position. */
  update(x: number, z: number, dt: number) {
    if (!this.root.visible || !this.index.far) return;
    this.updateMask(x, z);
    if ((this.timer -= dt) <= 0) {
      this.timer = 0.5;
      const S = this.index.far.size;
      const [e, n] = [x + this.index.world.originE, -z + this.index.world.originN];
      const r = Math.ceil(this.dist / S) + 1;
      const fx0 = Math.floor(e / S), fy0 = Math.floor(n / S);
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          const fx = fx0 + dx, fy = fy0 + dy, key = tileKey(fx, fy);
          if (!this.available.has(key) || this.tiles.has(key) || this.loading.has(key)) continue;
          if (this.tileDist(fx, fy, e, n) <= this.dist) this.fetchTile(fx, fy);
        }
      for (const t of this.tiles.values()) if (this.tileDist(t.fx, t.fy, e, n) > this.dist + S) this.removeTile(t);
    }
    // One far tile per frame: building thousands of block matrices takes a few milliseconds.
    const t = this.ready.shift();
    if (t) this.addTile(t);
  }

  /** Distance from (e, n) to the nearest point of a far tile. */
  private tileDist(fx: number, fy: number, e: number, n: number) {
    const S = this.index.far!.size;
    const dx = Math.max(fx * S - e, 0, e - (fx + 1) * S);
    const dy = Math.max(fy * S - n, 0, n - (fy + 1) * S);
    return Math.hypot(dx, dy);
  }

  private updateMask(x: number, z: number) {
    const w = this.index.world;
    const [ix, iy] = tileOfLocal(w, x, z);
    const [mx, my] = this.maskTile;
    // Re-centre when the car is a quarter of the mask away from the centre.
    const recentre = !(Math.abs(ix - (mx + MASK / 2)) < MASK / 4 && Math.abs(iy - (my - MASK / 2)) < MASK / 4);
    if (recentre) {
      this.maskTile = [ix - MASK / 2, iy + MASK / 2 - 1];
      const [ox, oz] = tileOriginLocal(w, this.maskTile[0], this.maskTile[1]);
      this.maskInfo.set(ox, oz, w.tileSize);
    }
    if (!recentre && this.maskVersion === this.near.visibleVersion) return;
    this.maskVersion = this.near.visibleVersion;
    this.maskData.fill(0);
    const [cx, top] = this.maskTile;
    this.near.forEachVisible((tx, ty) => {
      const col = tx - cx, row = top - ty;
      if (col >= 0 && col < MASK && row >= 0 && row < MASK) this.maskData[row * MASK + col] = 255;
    });
    this.mask.needsUpdate = true;
  }

  private async fetchTile(fx: number, fy: number) {
    const key = tileKey(fx, fy);
    this.loading.add(key);
    try {
      const res = await fetch(`${this.baseUrl}/far/${key}.bin`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let buf = await res.arrayBuffer();
      if (isGzip(new Uint8Array(buf, 0, 2))) buf = await gunzip(buf);
      this.ready.push(new TileContent(buf));
    } catch (e) {
      console.warn(`Far tile ${key} failed`, e);
      this.available.delete(key);
    } finally {
      this.loading.delete(key);
    }
  }

  private addTile(t: TileContent) {
    if (this.tiles.has(t.key) || !this.index.far) return;
    const { size: S, n: N } = this.index.far;
    const w = this.index.world;
    const [ox, oz] = utmToLocal(w, t.ix * S, (t.iy + 1) * S);
    const h = t.f32('terrain')!;
    const g = t.u8('ground')!;
    const y = new Float32Array(h.length);
    for (let i = 0; i < h.length; i++) y[i] = h[i] - (g[i] === Ground.water ? WATER_DROP : 0);
    const m = gridMesh(y, g, N, S / (N - 1), ox, oz);
    // Survey colour where the tile has it, so the far ground continues the tinted near ground.
    const tint = this.aerial ? t.u8('tint') : undefined;
    if (tint) {
      const lut = new Float32Array(256).map((_, i) => srgbToLinear(i / 255));
      const col = m.col!;
      for (let i = 0; i < N * N; i++) {
        if (!tint[i * 3] && !tint[i * 3 + 1] && !tint[i * 3 + 2]) continue;
        for (let ch = 0; ch < 3; ch++) col[i * 3 + ch] += (lut[tint[i * 3 + ch]] - col[i * 3 + ch]) * FAR_AERIAL;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(m.col!, 3));
    geo.setIndex(new THREE.BufferAttribute(m.idx!, 1));
    geo.computeBoundingSphere();
    const group = new THREE.Group();
    group.name = `far ${t.key}`;
    group.add(new THREE.Mesh(geo, this.terrainMat));

    const b = t.f32('blocks');
    const count = b ? b.length / FAR_BLOCK : 0;
    if (b && count) {
      const blocks = new THREE.InstancedMesh(this.blockGeo, this.blockMat, count);
      const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
      const up = THREE.Object3D.DEFAULT_UP;
      for (let i = 0; i < count; i++) {
        const o = i * FAR_BLOCK;
        const [x, z, hl, hw, a, base, top] = [b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6]];
        mat.compose(p.set(x, base, z), q.setFromAxisAngle(up, a), s.set(hl * 2, top - base, hw * 2));
        blocks.setMatrixAt(i, mat);
        blocks.setColorAt(i, BLOCK_COLORS[Math.abs(Math.floor(x * 7.1 + z * 3.3)) % BLOCK_COLORS.length]);
      }
      blocks.computeBoundingSphere();
      group.add(blocks);
      this.stats.blocks += count;
    }
    this.root.add(group);
    this.tiles.set(t.key, { key: t.key, fx: t.ix, fy: t.iy, group });
  }

  private removeTile(t: FarTile) {
    this.root.remove(t.group);
    t.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) { this.stats.blocks -= (o as THREE.InstancedMesh).count; (o as THREE.InstancedMesh).dispose(); }
      else if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.tiles.delete(t.key);
  }

  /** Drops every far tile (they reload on the next update). */
  reload() {
    for (const t of [...this.tiles.values()]) this.removeTile(t);
    this.ready = [];
  }
}
