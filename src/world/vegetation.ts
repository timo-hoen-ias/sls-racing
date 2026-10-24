import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Materials } from '../render/materials.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { Ground, TERRAIN_N, TERRAIN_STEP, type WorldInfo, tileOriginLocal } from './format.ts';
import type { RoadGraph } from './roadGraph.ts';
import { registerTileLayer } from './tileHooks.ts';
import { SPECIES_BY_KIND, type VegetationSet, loadVegetation } from './vegGlb.ts';
import { BUSH_STRIDE, Bush, TREE_HEIGHT, TREE_NAMES, Tree, type TreeKind } from './vegKinds.ts';
import { buildBushGeometries, buildGrassGeometry, buildTreeGeometries, grassTexture } from './vegModels.ts';

// Vegetation (W6) as a tile layer: trees by species with two levels of detail, bushes, grass clumps around the
// camera, wind that sways crowns and grass, and field rows on farmland in the ground shader.

/** Shared by every vegetation material; update() writes them. */
const vegUniforms = { uVegTime: { value: 0 }, uVegWind: { value: 0.3 }, uVegDir: { value: new THREE.Vector2(0.8, 0.6) } };

/** Sways vertices by their "wind" attribute (0 at the base, 1 at the top), with a phase from the instance position. */
function patchWind(mat: THREE.MeshStandardMaterial, amp: number, key: string) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wind;\nuniform float uVegTime;\nuniform float uVegWind;\nuniform vec2 uVegDir;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  {
    vec3 base = vec3(0.0);
    #ifdef USE_INSTANCING
    base = instanceMatrix[3].xyz;
    #endif
    float ph = dot(base.xz, vec2(0.21, 0.17));
    float t = uVegTime;
    // Steady lean downwind plus gusts and a faster flutter.
    float gust = 0.55 + 0.45 * sin(t * 0.7 + ph * 0.3);
    float sway = uVegWind * (0.35 + gust * (0.6 * sin(t * 1.6 + ph) + 0.25 * sin(t * 3.7 + ph * 2.3)));
    transformed.xz += uVegDir * sway * wind * ${amp.toFixed(3)};
  }`,
      );
  };
  // Then rain darkens and snow settles on them like on the rest of the world.
  patchMaterial(mat, { wet: 0.3, snow: 0.7, upFrom: 0.05 });
  const wx = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `veg-${key}-${wx()}`;
}

/** Field rows on farmland and mottled grass, recognised by the ground's vertex colour (see tileBuild.ts). */
function patchGroundDetail(mat: THREE.MeshStandardMaterial, uniforms: { uVegFields: { value: number } }) {
  const prev = mat.onBeforeCompile;
  const farm = new THREE.Color('#8f8a55');
  const grass = new THREE.Color('#5f7a3e');
  const chroma = (c: THREE.Color) => { const s = c.r + c.g + c.b; return `vec3(${(c.r / s).toFixed(4)}, ${(c.g / s).toFixed(4)}, ${(c.b / s).toFixed(4)})`; };
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVegPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vVegPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vVegPos;
uniform float uVegFields;
float vgHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vgNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vgHash(i), vgHash(i + vec2(1.0, 0.0)), u.x), mix(vgHash(i + vec2(0.0, 1.0)), vgHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (uVegFields > 0.0) {
    vec3 cc = vColor.rgb / max(1e-4, vColor.r + vColor.g + vColor.b);
    float isFarm = 1.0 - smoothstep(0.015, 0.05, distance(cc, ${chroma(farm)}));
    float isGrass = 1.0 - smoothstep(0.02, 0.07, distance(cc, ${chroma(grass)}));
    vec2 wp = vVegPos.xz;
    // Fields: patches of about 150 m with their own crop and row direction (warped so the borders are not a grid).
    vec2 cell = floor((wp + 40.0 * vec2(vgNoise(wp * 0.004), vgNoise(wp * 0.004 + 7.0))) / 150.0);
    float h = vgHash(cell);
    float ang = h * 3.14159;
    float rows = 0.5 + 0.5 * sin(dot(wp, vec2(cos(ang), sin(ang))) * 3.9);
    vec3 crop = h < 0.3 ? vec3(0.42, 0.33, 0.12) : h < 0.55 ? vec3(0.17, 0.11, 0.06) : h < 0.85 ? vec3(0.14, 0.22, 0.06) : vec3(0.45, 0.42, 0.06);
    vec3 fieldCol = crop * (0.78 + 0.3 * rows) * (0.9 + 0.2 * vgNoise(wp * 0.15));
    diffuseColor.rgb = mix(diffuseColor.rgb, fieldCol, isFarm * uVegFields);
    // Grass: darker and lighter tufts at two scales.
    float m = vgNoise(wp * 0.35) * 0.6 + vgNoise(wp * 1.7) * 0.4;
    diffuseColor.rgb *= mix(1.0, 0.78 + 0.4 * m, isGrass * uVegFields);
  }`);
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `vegground-${key()}`;
  mat.needsUpdate = true;
}

/** One way to draw a kind: geometries per detail tier (near, mid, far), their materials, and a size factor. */
interface VegModel {
  lods: THREE.BufferGeometry[];
  mats: THREE.Material[];
  /** Height factor and crown width factor on top of the tile's scale. */
  h: number;
  w: number;
  /** Crown radius (m) of the geometry, for trees with a measured crown. */
  crown: number;
}

interface VegGroup {
  kind: TreeKind | -1;
  /** One instanced mesh per detail tier. */
  meshes: THREE.InstancedMesh[];
  n: number;
  /** Every instance in thinning order: matrices, colours and ground position, copied into the tier meshes. */
  mats: Float32Array;
  cols: Float32Array;
  xz: Float32Array;
  /** What the meshes hold now ("w<tier>:<count>" whole tile in one tier, "s:<count>" split by distance). */
  state: string;
  /** Camera position of the last split. */
  sx: number;
  sz: number;
}

interface VegTile {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group;
  shadows: boolean;
  trees?: Float32Array;
  kinds?: Uint8Array;
  /** Measured crown radius in dm (LiDAR trees), 0 otherwise. */
  crowns?: Uint8Array;
  bushes?: Float32Array;
  groups: VegGroup[];
  heights: Float32Array;
  ground: Uint8Array;
  ox: number;
  oz: number;
}

/** Instances move between tiers per tree only within tiles that cross a tier boundary; re-sorted after this much camera movement (m). */
const RESPLIT = 6;
/** Tiles re-sorted per frame at most (each up to 2048 trees). */
const SPLITS_PER_FRAME = 4;
/** Bushes use their detailed model this close (m). */
const BUSH_DETAIL = 30;

interface Split { g: VegGroup; bands: number[]; count: number; d: number; tile: string }

/** Height of the Blender species (all 8 m) per kind, relative to a tree of scale 1. */
const KIND_HEIGHT = Object.fromEntries(Object.entries(TREE_HEIGHT).map(([k, h]) => [k, h / 8])) as Record<TreeKind, number>;
/** Crown radius (m) of the procedural models (vegModels.ts) at scale 1. */
const PROC_CROWN: Record<TreeKind, number> = { 0: 3.0, 1: 2.5, 2: 1.5, 3: 1.5, 4: 2.4 };

export class Vegetation {
  /** Grass clumps around the camera (the trees and bushes live in the tile groups). */
  readonly root = new THREE.Group();
  /** Share of trees and bushes drawn, 0..1. */
  density = 1;
  /** Detailed trees within this distance (m) of the camera, per tree. */
  lodDistance: number;
  /** Simple trees up to this distance, billboards beyond (m). */
  billboardDistance: number;
  /** Bushes are drawn up to this distance (m). */
  bushDistance: number;
  /** Tree and bush instances moved between tiers in the last frame (veg.info). */
  private splitCount = 0;
  /** "auto" follows the weather, a number fixes the wind strength 0..1. */
  wind: 'auto' | number = 'auto';
  windNow = 0.3;
  /** Forces one LOD for all tiles (veg.lod 0|1), undefined = by distance. */
  forcedLod?: 0 | 1 | 2;
  /** Which tree models are in use. */
  models: 'glb' | 'procedural' = 'procedural';
  grassOn: boolean;
  grassRadius = 32;
  /** Draw the trees measured by the LiDAR survey (veg.lidar). */
  lidar = true;
  readonly groundUniforms = { uVegFields: { value: 1 } };
  private tiles = new Map<string, VegTile>();
  private treeModels = {} as Record<TreeKind, VegModel[]>;
  private bushModels: Record<number, VegModel[]> = {};
  private billboardMat?: THREE.MeshStandardMaterial;
  private treeMat: THREE.MeshStandardMaterial;
  private bushMat: THREE.MeshStandardMaterial;
  private grass: THREE.InstancedMesh;
  private grassAt = new THREE.Vector3(Infinity, 0, 0);
  private info: WorldInfo;
  private graph: RoadGraph;
  private time = 0;

  constructor(opts: { world: WorldInfo; graph: RoadGraph; mats: Materials; grass: number; lod?: { trees: number; billboards: number; bushes: number } }) {
    this.lodDistance = opts.lod?.trees ?? 140;
    this.billboardDistance = opts.lod?.billboards ?? 450;
    this.bushDistance = opts.lod?.bushes ?? 120;
    this.info = opts.world;
    this.graph = opts.graph;
    this.treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    patchWind(this.treeMat, 0.35, 'tree');
    this.bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    patchWind(this.bushMat, 0.08, 'bush');
    const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grassTexture(), alphaTest: 0.5, roughness: 1, side: THREE.DoubleSide });
    patchWind(grassMat, 0.12, 'grass');
    this.grass = new THREE.InstancedMesh(buildGrassGeometry(), grassMat, Math.max(3000, opts.grass));
    this.grass.count = 0;
    this.grass.frustumCulled = false;
    this.grass.receiveShadow = true;
    this.grassOn = opts.grass > 0;
    this.root.name = 'vegetation';
    this.root.add(this.grass);
    patchGroundDetail(opts.mats.ground, this.groundUniforms);
    this.setProcedural();
  }

  /** Hooks into the tile streamer; call once at startup, before tiles load. */
  register(trees: boolean) {
    registerTileLayer({
      name: 'vegetation',
      visual: (t, ctx) => {
        const [ox, oz] = tileOriginLocal(this.info, t.ix, t.iy);
        const tile: VegTile = {
          key: t.key, cx: ox + this.info.tileSize / 2, cz: oz + this.info.tileSize / 2, group: ctx.group, shadows: ctx.shadows, groups: [],
          heights: t.f32('terrain')!.slice(), ground: t.u8('ground')!.slice(), ox, oz,
          trees: trees ? t.f32('trees')?.slice() : undefined,
          kinds: trees && t.has('treeKinds') ? t.u8('treeKinds')?.slice() : undefined,
          crowns: trees && t.has('treeCrowns') ? t.u8('treeCrowns')?.slice() : undefined,
          bushes: trees && t.has('bushes') ? t.f32('bushes')?.slice() : undefined,
        };
        this.buildTile(tile);
        this.tiles.set(t.key, tile);
        this.grassAt.x = Infinity;
      },
      removed: (key) => {
        this.tiles.delete(key);
        this.grassAt.x = Infinity;
      },
    });
  }

  /** Uses the Blender species (vegGlb.ts) instead of the procedural models, for loaded and future tiles. */
  setModels(set: VegetationSet) {
    if (set.billboardMaterial && !this.billboardMat) {
      this.billboardMat = set.billboardMaterial;
      patchWind(this.billboardMat, 0.35, 'billboard');
    }
    const pick = (name: string) => (SPECIES_BY_KIND[name] ?? []).map((id) => set.species[id]).filter((sp) => !!sp);
    const trees: Partial<Record<TreeKind, VegModel[]>> = {};
    for (const kind of Object.values(Tree)) {
      const list = pick(TREE_NAMES[kind]).map((sp): VegModel => {
        const lods = [sp.lod0, sp.lod1, ...(sp.billboard && this.billboardMat ? [sp.billboard] : [])];
        return { lods, mats: lods.map((_, i) => (i === 2 ? this.billboardMat! : this.treeMat)), h: KIND_HEIGHT[kind], w: KIND_HEIGHT[kind] ** 0.7, crown: sp.crown };
      });
      if (list.length) trees[kind] = list;
    }
    Object.assign(this.treeModels, trees);
    const bush = (name: string, k: number) => {
      const sp = pick(name)[0];
      if (sp) this.bushModels[k] = [{ lods: [sp.lod0, sp.lod1], mats: [this.bushMat, this.bushMat], h: 1, w: 1, crown: sp.crown }];
    };
    bush('busch', Bush.round);
    bush('gebuesch', Bush.scrub);
    this.models = 'glb';
    for (const t of this.tiles.values()) this.buildTile(t);
  }

  /** Back to the procedural models of vegModels.ts. */
  setProcedural() {
    const g = buildTreeGeometries(), b = buildBushGeometries();
    for (const kind of Object.values(Tree)) this.treeModels[kind] = [{ lods: g[kind], mats: [this.treeMat, this.treeMat], h: 1, w: 1, crown: PROC_CROWN[kind] }];
    for (const k of Object.values(Bush)) this.bushModels[k] = [{ lods: [b[k]], mats: [this.bushMat], h: 1, w: 1, crown: 1 }];
    this.models = 'procedural';
    for (const t of this.tiles.values()) this.buildTile(t);
  }

  /** (Re)builds a tile's instanced meshes from its tree and bush records. */
  private buildTile(t: VegTile) {
    for (const g of t.groups) for (const im of g.meshes) { t.group.remove(im); im.dispose(); }
    t.groups = [];
    const add = (kind: TreeKind | -1, models: VegModel[], list: number[], at: (i: number) => Rec, tint: number) => {
      // Spread the records over the model variants by position.
      const byModel = models.map(() => [] as number[]);
      for (const i of list) {
        const [x, , z] = at(i);
        byModel[Math.floor(fract(Math.sin(x * 3.17 + z * 7.31) * 9187.37) * models.length)].push(i);
      }
      models.forEach((model, v) => {
        const ids = byModel[v];
        if (!ids.length) return;
        // Only the detailed tier casts shadows: the shadow map covers about 110 m around the car anyway.
        const meshes = model.lods.map((g, l) => this.instances(g, model.mats[l], ids.length, t.shadows && l === 0));
        meshes.forEach((im, l) => (im.name = `vegetation/${kind === -1 ? 'bush' : TREE_NAMES[kind]} lod${l}`));
        t.group.add(...meshes);
        t.groups.push({ kind, meshes, n: ids.length, ...this.fill(meshes, shuffled(ids), at, tint, model), state: '', sx: 0, sz: 0 });
      });
    };
    const tr = t.trees;
    if (tr?.length) {
      const byKind = new Map<TreeKind, number[]>();
      for (let i = 0; i < tr.length / 4; i++) {
        if (!this.lidar && t.crowns?.[i]) continue;
        const k = (t.kinds?.[i] ?? Tree.broadleaf) as TreeKind;
        if (!byKind.has(k)) byKind.set(k, []);
        byKind.get(k)!.push(i);
      }
      for (const [kind, list] of byKind) add(kind, this.treeModels[kind], list, (i) => [tr[i * 4], tr[i * 4 + 1] - 0.15, tr[i * 4 + 2], tr[i * 4 + 3], (t.crowns?.[i] ?? 0) / 10], kind === Tree.conifer ? 0.03 : 0.07);
    }
    const bu = t.bushes;
    if (bu?.length) {
      const byKind = new Map<number, number[]>();
      for (let i = 0; i < bu.length / BUSH_STRIDE; i++) {
        const k = bu[i * BUSH_STRIDE + 4];
        if (!byKind.has(k)) byKind.set(k, []);
        byKind.get(k)!.push(i);
      }
      const o = (i: number) => i * BUSH_STRIDE;
      for (const [kind, list] of byKind) add(-1, this.bushModels[kind] ?? this.bushModels[Bush.round], list, (i) => [bu[o(i)], bu[o(i) + 1] - 0.1, bu[o(i) + 2], bu[o(i) + 3]], 0.08);
    }
  }

  private instances(g: THREE.BufferGeometry, mat: THREE.Material, n: number, castShadow: boolean) {
    const im = new THREE.InstancedMesh(g, mat, n);
    im.userData.sharedGeometry = true;
    im.castShadow = castShadow;
    im.receiveShadow = true;
    return im;
  }

  /** Instance data in thinning order; every tier mesh starts with all of it so its bounding sphere covers the tile. */
  private fill(meshes: THREE.InstancedMesh[], order: number[], at: (i: number) => Rec, tint: number, model: VegModel) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    const mats = new Float32Array(order.length * 16), cols = new Float32Array(order.length * 3), xz = new Float32Array(order.length * 2);
    order.forEach((i, n) => {
      const [x, y, z, sc, crown] = at(i);
      const h = fract(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, h * Math.PI * 2);
      // Measured trees keep their height and crown; the others vary a little.
      const w = crown ? crown / model.crown : sc * model.w;
      s.set(w, sc * model.h * (crown ? 1 : 0.9 + 0.2 * fract(h * 7.1)), w);
      m.compose(p.set(x, y, z), q, s).toArray(mats, n * 16);
      // Each tree a little lighter or darker, warmer or cooler.
      c.setRGB(1 + (fract(h * 3.7) - 0.5) * tint * 2, 1 + (fract(h * 5.3) - 0.5) * tint * 2, 1 - tint).toArray(cols, n * 3);
      xz[n * 2] = x;
      xz[n * 2 + 1] = z;
    });
    for (const im of meshes) {
      im.setColorAt(0, c);
      im.instanceMatrix.array.set(mats);
      im.instanceColor!.array.set(cols);
      im.computeBoundingSphere();
    }
    return { mats, cols, xz };
  }

  /** Upper distance of each tier of a group (Infinity = no limit); beyond the last one the group is hidden. */
  private bands(g: VegGroup): number[] {
    const n = g.meshes.length;
    if (g.kind === -1) return n > 1 ? [BUSH_DETAIL, this.bushDistance] : [this.bushDistance];
    return n > 2 ? [this.lodDistance, this.billboardDistance, Infinity] : n > 1 ? [this.lodDistance, Infinity] : [Infinity];
  }

  /** Puts the first `count` instances into one tier (-1 = none). */
  private assignWhole(g: VegGroup, tier: number, count: number) {
    const key = `w${tier}:${count}`;
    if (g.state === key) return;
    g.state = key;
    g.meshes.forEach((im, l) => {
      if (l !== tier) { im.count = 0; im.visible = false; return; }
      im.instanceMatrix.array.set(g.mats.subarray(0, count * 16));
      im.instanceColor!.array.set(g.cols.subarray(0, count * 3));
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
      im.count = count;
      im.visible = count > 0;
    });
  }

  /** Sorts the first `count` instances into tiers by their own distance to the camera. */
  private assignSplit(g: VegGroup, bands: number[], count: number, cx: number, cz: number) {
    g.state = `s:${count}`;
    g.sx = cx;
    g.sz = cz;
    const n = g.meshes.map(() => 0);
    const mA = g.meshes.map((im) => im.instanceMatrix.array as Float32Array);
    const cA = g.meshes.map((im) => im.instanceColor!.array as Float32Array);
    for (let i = 0; i < count; i++) {
      const tier = tierOf(Math.hypot(g.xz[i * 2] - cx, g.xz[i * 2 + 1] - cz), bands);
      if (tier < 0) continue;
      const k = n[tier]++;
      mA[tier].set(g.mats.subarray(i * 16, i * 16 + 16), k * 16);
      cA[tier].set(g.cols.subarray(i * 3, i * 3 + 3), k * 3);
    }
    this.splitCount += count;
    g.meshes.forEach((im, l) => {
      im.count = n[l];
      im.visible = n[l] > 0;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
    });
  }

  /** Tier of every group in a tile; groups whose tile crosses a tier boundary are queued for a per-tree split. */
  private updateTile(t: VegTile, cx: number, cz: number, splits: Split[]) {
    const [near, far] = rectDistances(t.ox, t.oz, this.info.tileSize, cx, cz);
    for (const g of t.groups) {
      const count = Math.round(g.n * this.density);
      if (this.forcedLod !== undefined) { this.assignWhole(g, Math.min(this.forcedLod, g.meshes.length - 1), count); continue; }
      const bands = this.bands(g);
      const a = tierOf(near, bands), b = tierOf(far, bands);
      if (a === b) this.assignWhole(g, a, count);
      else if (g.state !== `s:${count}` || Math.hypot(g.sx - cx, g.sz - cz) > RESPLIT) splits.push({ g, bands, count, d: near, tile: t.key });
    }
  }

  update(dt: number, camera: THREE.Camera, weather?: { rain: number; snow: number; overcast: number }) {
    this.time += dt;
    const target = this.wind === 'auto' ? 0.2 + 0.35 * (weather?.overcast ?? 0) + 0.45 * Math.max(weather?.rain ?? 0, weather?.snow ?? 0) : this.wind;
    this.windNow += (target - this.windNow) * Math.min(1, dt * 0.3);
    vegUniforms.uVegTime.value = this.time;
    vegUniforms.uVegWind.value = this.windNow;
    const cx = camera.position.x, cz = camera.position.z;
    const splits: Split[] = [];
    for (const t of this.tiles.values()) this.updateTile(t, cx, cz, splits);
    // Nearest first, a few tiles per frame; a group that has never been split goes first.
    this.splitCount = 0;
    splits.sort((a, b) => Number(a.g.state.startsWith('s')) - Number(b.g.state.startsWith('s')) || a.d - b.d);
    const tiles = new Set<string>();
    for (const s of splits) {
      if (tiles.size >= SPLITS_PER_FRAME && !tiles.has(s.tile)) break;
      tiles.add(s.tile);
      this.assignSplit(s.g, s.bands, s.count, cx, cz);
    }
    this.grass.visible = this.grassOn;
    if (this.grassOn && this.grassAt.distanceTo(camera.position) > 4) {
      this.grassAt.copy(camera.position);
      this.placeGrass(cx, cz);
    }
  }

  /** Terrain height and ground class at (x, z), or undefined without a loaded tile. */
  private sample(x: number, z: number): [number, number] | undefined {
    const T = this.info.tileSize;
    for (const t of this.tiles.values()) {
      if (x < t.ox || x >= t.ox + T || z < t.oz || z >= t.oz + T) continue;
      const fx = (x - t.ox) / TERRAIN_STEP, fz = (z - t.oz) / TERRAIN_STEP;
      const c = Math.min(TERRAIN_N - 2, Math.floor(fx)), r = Math.min(TERRAIN_N - 2, Math.floor(fz));
      const u = fx - c, v = fz - r;
      const N = TERRAIN_N, h = t.heights;
      const a = h[r * N + c], b = h[r * N + c + 1], d = h[(r + 1) * N + c], e = h[(r + 1) * N + c + 1];
      // Same triangles as the terrain mesh: (a, d, b) and (b, d, e).
      const y = u + v <= 1 ? a + (b - a) * u + (d - a) * v : e + (d - e) * (1 - u) + (b - e) * (1 - v);
      return [y, t.ground[Math.round(fz) * N + Math.round(fx)]];
    }
    return undefined;
  }

  private placeGrass(cx: number, cz: number) {
    const R = this.grassRadius;
    const cap = this.grass.instanceMatrix.count;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    // Roads near the camera, to keep the grass off them (the graph has no widths, so a width by rank).
    const roads: { p: Float32Array; half: number }[] = [];
    this.graph.forEachEdgeNear(cx, cz, R + 20, (e) => roads.push({ p: e.p, half: 2 + e.rank * 0.9 }));
    const onRoad = (x: number, z: number) => roads.some((r) => distToPolyline(r.p, x, z) < r.half + 1);
    let n = 0;
    const step = 2;
    const gx0 = Math.floor((cx - R) / step), gz0 = Math.floor((cz - R) / step);
    for (let gx = gx0; gx * step < cx + R && n < cap; gx++)
      for (let gz = gz0; gz * step < cz + R && n < cap; gz++) {
        const x0 = gx * step, z0 = gz * step;
        if (Math.hypot(x0 - cx, z0 - cz) > R) continue;
        const cell = this.sample(x0, z0);
        if (!cell || cell[1] !== Ground.grass || onRoad(x0, z0)) continue;
        // A few clumps per 2 m cell, at fixed spots so they don't jump as the camera moves.
        for (let k = 0; k < 3 && n < cap; k++) {
          const h = fract(Math.sin(gx * 127.1 + gz * 311.7 + k * 74.7) * 43758.5453);
          const x = x0 + h * step, z = z0 + fract(h * 13.7) * step;
          const at = this.sample(x, z);
          if (!at || at[1] !== Ground.grass) continue;
          const fade = 1 - Math.max(0, (Math.hypot(x - cx, z - cz) - R * 0.7) / (R * 0.3));
          q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, h * 6.28);
          s.set(0.8 + h * 0.6, (0.6 + fract(h * 5.1) * 0.8) * fade, 0.8 + h * 0.6);
          m.compose(p.set(x, at[0], z), q, s);
          this.grass.setMatrixAt(n, m);
          this.grass.setColorAt(n, col.setRGB(0.85 + fract(h * 3.3) * 0.3, 0.9 + fract(h * 9.1) * 0.2, 0.8));
          n++;
        }
      }
    this.grass.count = n;
    this.grass.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
  }

  /** Counts of trees by kind and bushes in loaded tiles. */
  counts() {
    const trees = new Map<string, number>();
    let bushes = 0, near = 0, lidar = 0;
    for (const t of this.tiles.values()) {
      if (this.lidar && t.crowns) for (const c of t.crowns) if (c) lidar++;
      for (const g of t.groups) {
        if (g.kind === -1) { bushes += g.n; continue; }
        const name = TREE_NAMES[g.kind];
        trees.set(name, (trees.get(name) ?? 0) + g.n);
        near += g.meshes[0].visible ? g.meshes[0].count : 0;
      }
    }
    return { trees, bushes, near, lidar, grass: this.grass.count };
  }

  registerCommands() {
    registerValue('veg.density', 'Anteil der gezeichneten Bäume und Büsche 0..1', () => this.density, (v) => (this.density = v), [0, 1]);
    registerValue('veg.lod', 'Entfernung (m), bis zu der Bäume detailliert gezeichnet werden (pro Baum)', () => this.lodDistance, (v) => { this.lodDistance = v; this.forcedLod = undefined; }, [0, 3000]);
    registerValue('veg.lod.billboard', 'Ab dieser Entfernung (m) werden Bäume als Billboard gezeichnet', () => this.billboardDistance, (v) => { this.billboardDistance = v; this.forcedLod = undefined; }, [0, 5000]);
    registerValue('veg.lod.bush', 'Büsche bis zu dieser Entfernung (m) zeichnen', () => this.bushDistance, (v) => (this.bushDistance = v), [0, 1000]);
    registerCommand({
      name: 'veg.lod.force', help: 'Alle Bäume in einer Detailstufe zeigen (0 = detailliert, 1 = einfach, 2 = Billboard) oder auto', args: '0|1|2|auto',
      complete: () => ['0', '1', '2', 'auto'],
      run: ([v = 'auto']) => {
        this.forcedLod = v === 'auto' ? undefined : v === '0' ? 0 : v === '1' ? 1 : v === '2' ? 2 : (() => { throw new Error('0, 1, 2 oder auto'); })();
        return `Detailstufe: ${this.forcedLod ?? 'nach Entfernung'}`;
      },
    });
    registerCommand({
      name: 'veg.wind', help: 'Wind in den Bäumen: auto (folgt dem Wetter) oder Stärke 0..1', args: '[auto|0..1]',
      complete: () => ['auto', '0', '0.5', '1'],
      run: ([v]) => {
        if (v !== undefined) this.wind = v === 'auto' ? 'auto' : parseNum(v, 'Wind', 0, 2);
        return `Wind ${this.wind === 'auto' ? 'auto' : this.wind} · gerade ${this.windNow.toFixed(2)}`;
      },
    });
    registerCommand({
      name: 'veg.models', help: 'Baummodelle: glb (Blender) oder procedural', args: '[glb|procedural]',
      complete: () => ['glb', 'procedural'],
      run: ([m]) => {
        if (m === 'procedural') this.setProcedural();
        else if (m === 'glb') loadVegetation().then((set) => this.setModels(set), (e) => console.warn('[veg] GLB nicht geladen', e));
        else if (m !== undefined) throw new Error('glb oder procedural');
        return `Baummodelle: ${m ?? this.models}`;
      },
    });
    registerToggle('veg.lidar', 'Bäume aus der LiDAR-Befliegung (echte Position, Höhe und Krone) zeigen', () => this.lidar, (v) => { this.lidar = v; for (const t of this.tiles.values()) this.buildTile(t); });
    registerToggle('veg.grass', 'Grasbüschel um die Kamera', () => this.grassOn, (v) => { this.grassOn = v; this.grassAt.x = Infinity; });
    registerValue('veg.grass.radius', 'Radius der Grasbüschel in Metern', () => this.grassRadius, (v) => { this.grassRadius = v; this.grassAt.x = Infinity; }, [5, 120]);
    registerValue('veg.fields', 'Ackerfurchen und Grasflecken im Boden 0..1', () => this.groundUniforms.uVegFields.value, (v) => (this.groundUniforms.uVegFields.value = v), [0, 1]);
    registerCommand({
      name: 'veg.info', help: 'Bäume nach Art, Büsche und Grasbüschel in den geladenen Kacheln',
      run: () => {
        const c = this.counts();
        return `${[...c.trees].map(([k, n]) => `${k} ${n}`).join(', ') || 'keine Bäume'} · davon ${c.lidar} aus LiDAR · ${c.near} detailliert · ${c.bushes} Büsche · ${c.grass} Grasbüschel · Wind ${this.windNow.toFixed(2)}\n`
          + `LOD: detailliert bis ${this.lodDistance} m, einfach bis ${this.billboardDistance} m, dann Billboard · Büsche bis ${this.bushDistance} m · ${this.splitCount} Instanzen im letzten Bild umsortiert`;
      },
    });
  }
}

const fract = (v: number) => v - Math.floor(v);

/** One instance: x, y, z, scale and the measured crown radius (m, 0 = model crown). */
type Rec = [number, number, number, number, number?];

/** Detail tier for a distance: the first band it is under, or -1 beyond the last. */
export function tierOf(d: number, bands: number[]) {
  let i = 0;
  while (i < bands.length && d >= bands[i]) i++;
  return i >= bands.length ? -1 : i;
}

/** Nearest and farthest distance from (x, z) to the square [ox, ox + size] × [oz, oz + size]. */
export function rectDistances(ox: number, oz: number, size: number, x: number, z: number): [number, number] {
  const dx = Math.max(ox - x, 0, x - (ox + size)), dz = Math.max(oz - z, 0, z - (oz + size));
  const fx = Math.max(Math.abs(ox - x), Math.abs(ox + size - x)), fz = Math.max(Math.abs(oz - z), Math.abs(oz + size - z));
  return [Math.hypot(dx, dz), Math.hypot(fx, fz)];
}

/** The same list in a fixed random order, so drawing only the first n gives an even thinning. */
function shuffled(list: number[]) {
  return list
    .map((i) => [i, fract(Math.sin(i * 91.7 + list.length) * 43758.5453)] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([i]) => i);
}

function distToPolyline(p: Float32Array, x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i + 5 < p.length; i += 3) {
    const ax = p[i], az = p[i + 2], bx = p[i + 3], bz = p[i + 5];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}
