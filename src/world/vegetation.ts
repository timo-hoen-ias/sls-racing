import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Materials } from '../render/materials.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { Ground, TERRAIN_N, TERRAIN_STEP, type WorldInfo, tileOriginLocal } from './format.ts';
import type { RoadGraph } from './roadGraph.ts';
import { registerTileLayer } from './tileHooks.ts';
import type { TreeGeometry } from './treeGen.ts';
import { triangles } from './treeGen.ts';
import { type ImpostorAtlas, type TreeTextures, bakeImpostors, buildSpecies, impostorGeometry, impostorMaterial, loadTreeTextures, treeMaterials, vegUniforms } from './treeRender.ts';
import { SPECIES } from './treeSpecies.ts';
import { BUSH_STRIDE, Bush, TREE_HEIGHT, Tree, type TreeKind } from './vegKinds.ts';
import { buildGrassGeometry, grassTexture } from './vegModels.ts';

// Vegetation (W6) as a tile layer: generated trees of ten native species (treeGen.ts) with bark and leaf cards,
// in three detail tiers per tree (detailed, simple, impostor) that cross-fade with a dither pattern, bushes,
// grass clumps around the camera, wind that sways crowns and grass, and field rows on farmland in the ground
// shader.

/** Grass sways like before: the wind attribute (0 at the base, 1 at the top), phase from the instance position. */
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
    float gust = 0.55 + 0.45 * sin(t * 0.7 + ph * 0.3);
    float sway = uVegWind * (0.35 + gust * (0.6 * sin(t * 1.6 + ph) + 0.25 * sin(t * 3.7 + ph * 2.3)));
    transformed.xz += uVegDir * sway * wind * ${amp.toFixed(3)};
  }`,
      );
  };
  patchMaterial(mat, { wet: 0.3, snow: 0.7, upFrom: 0.05 });
  const wx = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `veg-${key}-${wx()}`;
}

/** Mottled grass: darker and lighter tufts on the lawn and meadow channels of the land cover (render/pbr/surfaces.ts). */
function patchGroundDetail(mat: THREE.MeshStandardMaterial, uniforms: { uVegFields: { value: number } }) {
  const prev = mat.onBeforeCompile;
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
    float isGrass = clamp((vSplatA.x + vSplatA.y) / max(1e-3, dot(vSplatA, vec4(1.0)) + dot(vSplatB, vec4(1.0))), 0.0, 1.0);
    vec2 wp = vVegPos.xz;
    float m = vgNoise(wp * 0.35) * 0.6 + vgNoise(wp * 1.7) * 0.4;
    diffuseColor.rgb *= mix(1.0, 0.78 + 0.4 * m, isGrass * uVegFields);
  }`);
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `vegground-${key()}`;
  mat.needsUpdate = true;
}

interface VegGroup {
  /** Species id (treeSpecies.ts) and whether it is a bush (two tiers, fades out) or a tree (three tiers). */
  sp: string;
  bush: boolean;
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
/** Tiles re-sorted per frame at most (each up to a few thousand trees). */
const SPLITS_PER_FRAME = 4;
/** Bushes use their detailed model this close (m). */
const BUSH_DETAIL = 30;

interface Split { g: VegGroup; ranges: [number, number][]; count: number; d: number; tile: string }

/** Species mix per tile tree kind: in woods mostly beech and oak, spruce and pine; in town lime, maple, plane. */
const MIX: Record<'town' | 'forest', Record<TreeKind, [string, number][]>> = {
  town: {
    [Tree.broadleaf]: [['linde', 0.3], ['ahorn', 0.24], ['platane', 0.14], ['eiche', 0.17], ['buche', 0.15]],
    [Tree.conifer]: [['fichte', 0.55], ['kiefer', 0.45]],
    [Tree.poplar]: [['pappel', 1]], [Tree.birch]: [['birke', 1]], [Tree.fruit]: [['obst', 1]],
  },
  forest: {
    [Tree.broadleaf]: [['buche', 0.55], ['eiche', 0.33], ['ahorn', 0.12]],
    [Tree.conifer]: [['fichte', 0.6], ['kiefer', 0.4]],
    [Tree.poplar]: [['pappel', 1]], [Tree.birch]: [['birke', 1]], [Tree.fruit]: [['obst', 1]],
  },
};

export function speciesOf(kind: TreeKind, forest: boolean, r: number): string {
  const mix = MIX[forest ? 'forest' : 'town'][kind] ?? MIX.town[Tree.broadleaf];
  let acc = 0;
  for (const [id, share] of mix) if (r < (acc += share)) return id;
  return mix[mix.length - 1][0];
}

const SHAPE = Object.fromEntries(SPECIES.map((s) => [s.id, s]));
const BUSH_SPECIES: Record<number, string> = { [Bush.round]: 'busch', [Bush.scrub]: 'gebuesch' };
const HIDDEN = () => new THREE.Vector4(1e9, 1e9 + 1, 1e9, 1e9 + 1);

export class Vegetation {
  /** Grass clumps around the camera (the trees and bushes live in the tile groups). */
  readonly root = new THREE.Group();
  /** Share of trees and bushes drawn, 0..1. */
  density = 1;
  /** Detailed trees within this distance (m) of the camera, per tree. */
  lodDistance: number;
  /** Simple trees up to this distance, impostors beyond (m). */
  billboardDistance: number;
  /** Bushes are drawn up to this distance (m). */
  bushDistance: number;
  /** Width of the dithered cross-fade between tiers as a share of the distance (veg.fade). */
  fade = 0.12;
  /** Detail tiers that cast shadows (0 = none, 1 = detailed, 2 = detailed and simple). */
  shadowTiers = 1;
  /** Tree and bush instances moved between tiers in the last frame (veg.info). */
  private splitCount = 0;
  /** "auto" follows the weather, a number fixes the wind strength 0..1. */
  wind: 'auto' | number = 'auto';
  windNow = 0.3;
  /** Forces one tier for all trees (veg.lod.force), undefined = by distance. */
  forcedLod?: 0 | 1 | 2;
  grassOn: boolean;
  grassRadius = 32;
  /** Draw the trees measured by the LiDAR survey (veg.lidar). */
  lidar = true;
  /** Seed of the generated trees (veg.regen) and impostor frame size (veg.impostor). */
  seed = 1;
  impostorRes = 128;
  readonly groundUniforms = { uVegFields: { value: 1 } };
  /** Distance bands of the tree tiers and the bush tiers (shared with their materials). */
  private treeBands = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  private bushBands = [new THREE.Vector4(), new THREE.Vector4()];
  private tiles = new Map<string, VegTile>();
  private geo: Record<string, TreeGeometry> = {};
  private impGeo: Record<string, THREE.BufferGeometry> = {};
  private treeMats: THREE.Material[][] = [];
  private bushMats: THREE.Material[][] = [];
  private impMats: Record<string, THREE.Material> = {};
  private atlas?: ImpostorAtlas;
  private tex?: TreeTextures;
  private renderer?: THREE.WebGLRenderer;
  private ready = false;
  private grass: THREE.InstancedMesh;
  private grassAt = new THREE.Vector3(Infinity, 0, 0);
  private info: WorldInfo;
  private graph: RoadGraph;
  private time = 0;

  constructor(opts: { world: WorldInfo; graph: RoadGraph; mats: Materials; grass: number; lod?: { trees: number; billboards: number; bushes: number }; impostor?: number }) {
    this.lodDistance = opts.lod?.trees ?? 140;
    this.billboardDistance = opts.lod?.billboards ?? 450;
    this.bushDistance = opts.lod?.bushes ?? 120;
    this.impostorRes = opts.impostor ?? 128;
    this.info = opts.world;
    this.graph = opts.graph;
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
    this.updateBands();
  }

  /** Hooks into the tile streamer; call once at startup, before tiles load. */
  register(trees: boolean) {
    registerTileLayer({
      name: 'vegetation',
      visual: (t, ctx) => {
        const [ox, oz] = tileOriginLocal(this.info, t.ix, t.iy);
        const tile: VegTile = {
          key: t.key, group: ctx.group, shadows: ctx.shadows, groups: [],
          heights: t.f32('terrain')!.slice(), ground: t.u8('ground')!.slice(), ox, oz,
          trees: trees ? t.f32('trees')?.slice() : undefined,
          kinds: trees && t.has('treeKinds') ? t.u8('treeKinds')?.slice() : undefined,
          crowns: trees && t.has('treeCrowns') ? t.u8('treeCrowns')?.slice() : undefined,
          bushes: trees && t.has('bushes') ? t.f32('bushes')?.slice() : undefined,
        };
        if (this.ready) this.buildTile(tile);
        this.tiles.set(t.key, tile);
        this.grassAt.x = Infinity;
      },
      removed: (key) => {
        const t = this.tiles.get(key);
        if (t) for (const g of t.groups) for (const im of g.meshes) im.dispose();
        this.tiles.delete(key);
        this.grassAt.x = Infinity;
      },
    });
  }

  /** Loads the foliage textures, grows the species and bakes their impostors; trees appear once this is done. */
  async init(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.tex = await loadTreeTextures();
    this.treeMats = [0, 1].map((tier) => treeMaterials(this.tex!, tier, this.treeBands[tier]));
    this.bushMats = [0, 1].map((tier) => treeMaterials(this.tex!, tier, this.bushBands[tier]));
    this.regenerate();
  }

  /** (Re)grows every species with the current seed, re-bakes the impostors and rebuilds the loaded tiles. */
  regenerate() {
    if (!this.tex || !this.renderer) return;
    for (const g of Object.values(this.geo)) for (const l of g.lods) l.dispose();
    for (const g of Object.values(this.impGeo)) g.dispose();
    for (const m of Object.values(this.impMats)) m.dispose();
    this.atlas?.albedo.dispose();
    this.atlas?.normal.dispose();
    this.geo = buildSpecies(this.seed);
    this.atlas = bakeImpostors(this.renderer, this.tex, this.geo, this.impostorRes);
    this.impGeo = {};
    this.impMats = {};
    for (const sp of SPECIES) {
      if (sp.form === 'bush') continue;
      this.impGeo[sp.id] = impostorGeometry(this.geo[sp.id]);
      this.impMats[sp.id] = impostorMaterial(this.atlas, sp.id, this.geo[sp.id], this.treeBands[2]);
    }
    this.ready = true;
    for (const t of this.tiles.values()) this.buildTile(t);
  }

  /** Writes the tier distance bands into the materials' uniforms. */
  private updateBands() {
    const half = (d: number) => Math.max(3, d * this.fade * 0.5);
    const d0 = this.lodDistance, d1 = this.billboardDistance;
    const [t0, t1, t2] = this.treeBands;
    t0.set(-2, -1, d0 - half(d0), d0 + half(d0));
    t1.set(d0 - half(d0), d0 + half(d0), d1 - half(d1), d1 + half(d1));
    t2.set(d1 - half(d1), d1 + half(d1), 1e9, 1e9 + 1);
    if (this.forcedLod !== undefined) this.treeBands.forEach((b, i) => (i === this.forcedLod ? b.set(-2, -1, 1e9, 1e9 + 1) : b.copy(HIDDEN())));
    const b0 = BUSH_DETAIL, b1 = Math.max(b0 + 10, this.bushDistance);
    this.bushBands[0].set(-2, -1, b0 - half(b0), b0 + half(b0));
    this.bushBands[1].set(b0 - half(b0), b0 + half(b0), b1 * 0.85, b1);
    for (const t of this.tiles.values()) for (const g of t.groups) g.state = '';
  }

  /** (Re)builds a tile's instanced meshes from its tree and bush records. */
  private buildTile(t: VegTile) {
    for (const g of t.groups) for (const im of g.meshes) { t.group.remove(im); im.dispose(); }
    t.groups = [];
    const bySpecies = new Map<string, Rec[]>();
    const push = (sp: string, r: Rec) => { if (!bySpecies.has(sp)) bySpecies.set(sp, []); bySpecies.get(sp)!.push(r); };
    const tr = t.trees;
    if (tr?.length) {
      for (let i = 0; i < tr.length / 4; i++) {
        const crown = (t.crowns?.[i] ?? 0) / 10;
        if (!this.lidar && crown) continue;
        const x = tr[i * 4], y = tr[i * 4 + 1] - 0.15, z = tr[i * 4 + 2], sc = tr[i * 4 + 3];
        const kind = (t.kinds?.[i] ?? Tree.broadleaf) as TreeKind;
        const forest = this.groundAt(t, x, z) === Ground.forest;
        const sp = speciesOf(kind, forest, hash(x, z, 1));
        const model = this.geo[sp];
        // Height from the tile's scale; crown from the survey, or in proportion (narrower in a closed wood).
        const h = (sc * TREE_HEIGHT[kind] * (crown ? 1 : 0.9 + 0.2 * hash(x, z, 2))) / model.height;
        let w = crown ? crown / model.crown : h * (forest ? 0.72 : 1) * (0.9 + 0.2 * hash(x, z, 3));
        w = Math.min(h * 1.8, Math.max(h * 0.55, w));
        push(sp, [x, y, z, w, h, kind === Tree.conifer ? 0.03 : 0.07]);
      }
    }
    const bu = t.bushes;
    if (bu?.length) {
      for (let i = 0; i < bu.length / BUSH_STRIDE; i++) {
        const o = i * BUSH_STRIDE;
        const sp = BUSH_SPECIES[bu[o + 4]] ?? 'busch';
        const s = (bu[o + 3] * 1.5) / this.geo[sp].height;
        push(sp, [bu[o], bu[o + 1] - 0.1, bu[o + 2], s * (0.9 + 0.3 * hash(bu[o], bu[o + 2], 4)), s, 0.08]);
      }
    }
    for (const [sp, recs] of bySpecies) {
      const bush = SHAPE[sp].form === 'bush';
      const g = this.geo[sp];
      const tiers = bush ? [g.lods[0], g.lods[1]] : [g.lods[0], g.lods[1], this.impGeo[sp]];
      const meshes = tiers.map((geo, l) => {
        const mat = bush ? this.bushMats[l] : l < 2 ? this.treeMats[l] : this.impMats[sp];
        const im = new THREE.InstancedMesh(geo, mat, recs.length);
        im.userData.sharedGeometry = true;
        im.castShadow = t.shadows && !bush && l < this.shadowTiers;
        im.receiveShadow = true;
        im.name = `vegetation/${sp} ${l === 2 ? 'impostor' : `lod${l}`}`;
        return im;
      });
      t.group.add(...meshes);
      t.groups.push({ sp, bush, meshes, n: recs.length, ...this.fill(meshes, shuffled(recs)), state: '', sx: 0, sz: 0 });
    }
  }

  /** Ground class of the terrain cell under (x, z) in a tile. */
  private groundAt(t: VegTile, x: number, z: number) {
    const c = Math.max(0, Math.min(TERRAIN_N - 1, Math.round((x - t.ox) / TERRAIN_STEP)));
    const r = Math.max(0, Math.min(TERRAIN_N - 1, Math.round((z - t.oz) / TERRAIN_STEP)));
    return t.ground[r * TERRAIN_N + c];
  }

  /** Instance data in thinning order; every tier mesh starts with all of it so its bounding sphere covers the tile. */
  private fill(meshes: THREE.InstancedMesh[], recs: Rec[]) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    const mats = new Float32Array(recs.length * 16), cols = new Float32Array(recs.length * 3), xz = new Float32Array(recs.length * 2);
    recs.forEach(([x, y, z, w, h, tint], n) => {
      const r = hash(x, z, 5);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r * Math.PI * 2);
      m.compose(p.set(x, y, z), q, s.set(w, h, w)).toArray(mats, n * 16);
      // Each tree a little lighter or darker, warmer or cooler.
      c.setRGB(1 + (fract(r * 3.7) - 0.5) * tint * 2, 1 + (fract(r * 5.3) - 0.5) * tint * 2, 1 - tint).toArray(cols, n * 3);
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

  /** Distance range (m) each tier of a group draws instances in, fades included. */
  private ranges(g: VegGroup): [number, number][] {
    return (g.bush ? this.bushBands : this.treeBands).map((b) => [b.x, b.w]);
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

  /** Sorts the first `count` instances into tiers by their own distance; in a cross-fade they go into both. */
  private assignSplit(g: VegGroup, ranges: [number, number][], count: number, cx: number, cz: number) {
    g.state = `s:${count}`;
    g.sx = cx;
    g.sz = cz;
    const n = g.meshes.map(() => 0);
    const mA = g.meshes.map((im) => im.instanceMatrix.array as Float32Array);
    const cA = g.meshes.map((im) => im.instanceColor!.array as Float32Array);
    // Margin for the camera moving until the next split.
    const M = RESPLIT;
    for (let i = 0; i < count; i++) {
      const d = Math.hypot(g.xz[i * 2] - cx, g.xz[i * 2 + 1] - cz);
      for (let tier = 0; tier < ranges.length; tier++) {
        if (d < ranges[tier][0] - M || d > ranges[tier][1] + M) continue;
        const k = n[tier]++;
        mA[tier].set(g.mats.subarray(i * 16, i * 16 + 16), k * 16);
        cA[tier].set(g.cols.subarray(i * 3, i * 3 + 3), k * 3);
      }
    }
    this.splitCount += count;
    g.meshes.forEach((im, l) => {
      im.count = n[l];
      im.visible = n[l] > 0;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
    });
  }

  /** Tier of every group in a tile; groups whose tile reaches into more than one tier are queued for a per-tree split. */
  private updateTile(t: VegTile, cx: number, cz: number, splits: Split[]) {
    const [near, far] = rectDistances(t.ox, t.oz, this.info.tileSize, cx, cz);
    for (const g of t.groups) {
      const count = Math.round(g.n * this.density);
      const ranges = this.ranges(g);
      const touching: number[] = [];
      ranges.forEach(([lo, hi], i) => { if (far >= lo - RESPLIT && near <= hi + RESPLIT) touching.push(i); });
      if (touching.length <= 1) this.assignWhole(g, touching[0] ?? -1, count);
      else if (g.state !== `s:${count}` || Math.hypot(g.sx - cx, g.sz - cz) > RESPLIT) splits.push({ g, ranges, count, d: near, tile: t.key });
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
      this.assignSplit(s.g, s.ranges, s.count, cx, cz);
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

  /** Counts of trees by species, bushes and drawn instances per tier in loaded tiles. */
  counts() {
    const trees = new Map<string, number>();
    let bushes = 0, lidar = 0;
    const drawn = [0, 0, 0];
    for (const t of this.tiles.values()) {
      if (this.lidar && t.crowns) for (const c of t.crowns) if (c) lidar++;
      for (const g of t.groups) {
        if (g.bush) bushes += g.n;
        else trees.set(g.sp, (trees.get(g.sp) ?? 0) + g.n);
        if (!g.bush) g.meshes.forEach((im, l) => (drawn[l] += im.visible ? im.count : 0));
      }
    }
    return { trees, bushes, lidar, drawn, near: drawn[0], grass: this.grass.count };
  }

  registerCommands() {
    const bands = () => this.updateBands();
    registerValue('veg.density', 'Anteil der gezeichneten Bäume und Büsche 0..1', () => this.density, (v) => (this.density = v), [0, 1]);
    registerValue('veg.lod', 'Entfernung (m), bis zu der Bäume detailliert gezeichnet werden (pro Baum)', () => this.lodDistance, (v) => { this.lodDistance = v; this.forcedLod = undefined; bands(); }, [0, 3000]);
    registerValue('veg.lod.billboard', 'Ab dieser Entfernung (m) werden Bäume als Impostor (gebackenes Bild aus 8 Richtungen) gezeichnet', () => this.billboardDistance, (v) => { this.billboardDistance = v; this.forcedLod = undefined; bands(); }, [0, 5000]);
    registerValue('veg.lod.bush', 'Büsche bis zu dieser Entfernung (m) zeichnen', () => this.bushDistance, (v) => { this.bushDistance = v; bands(); }, [0, 1000]);
    registerValue('veg.fade', 'Breite der geditherten Überblendung zwischen den Detailstufen, Anteil der Entfernung 0..0.5', () => this.fade, (v) => { this.fade = v; bands(); }, [0, 0.5]);
    registerValue('veg.shadows', 'Detailstufen, die Schatten werfen: 0 keine, 1 detailliert, 2 detailliert und einfach', () => this.shadowTiers, (v) => {
      this.shadowTiers = Math.round(v);
      for (const t of this.tiles.values()) for (const g of t.groups) g.meshes.forEach((im, l) => (im.castShadow = t.shadows && !g.bush && l < this.shadowTiers));
    }, [0, 2]);
    registerCommand({
      name: 'veg.lod.force', help: 'Alle Bäume in einer Detailstufe zeigen (0 = detailliert, 1 = einfach, 2 = Impostor) oder auto', args: '0|1|2|auto',
      complete: () => ['0', '1', '2', 'auto'],
      run: ([v = 'auto']) => {
        this.forcedLod = v === 'auto' ? undefined : v === '0' ? 0 : v === '1' ? 1 : v === '2' ? 2 : (() => { throw new Error('0, 1, 2 oder auto'); })();
        bands();
        return `Detailstufe: ${this.forcedLod ?? 'nach Entfernung'}`;
      },
    });
    registerToggle('veg.lod.debug', 'Detailstufen einfärben: rot detailliert, gelb einfach, blau Impostor', () => vegUniforms.uVegDebug.value > 0, (v) => (vegUniforms.uVegDebug.value = v ? 1 : 0));
    registerCommand({
      name: 'veg.wind', help: 'Wind in den Bäumen: auto (folgt dem Wetter) oder Stärke 0..1', args: '[auto|0..1]',
      complete: () => ['auto', '0', '0.5', '1'],
      run: ([v]) => {
        if (v !== undefined) this.wind = v === 'auto' ? 'auto' : parseNum(v, 'Wind', 0, 2);
        return `Wind ${this.wind === 'auto' ? 'auto' : this.wind} · gerade ${this.windNow.toFixed(2)}`;
      },
    });
    registerCommand({
      name: 'veg.regen', help: 'Baumarten mit neuem Zufallswert wachsen lassen und die Impostoren neu backen', args: '[seed]',
      run: ([v]) => {
        this.seed = v !== undefined ? Math.round(parseNum(v, 'Seed', 1, 1e6)) : this.seed + 1;
        this.regenerate();
        return `Bäume neu gewachsen (Seed ${this.seed})`;
      },
    });
    registerCommand({
      name: 'veg.impostor', help: 'Bildgröße eines Impostor-Blickwinkels in Pixeln (64, 128, 256); backt neu', args: '[64|128|256]',
      complete: () => ['64', '128', '256'],
      run: ([v]) => {
        if (v !== undefined) {
          const px = Number(v);
          if (![64, 128, 256].includes(px)) throw new Error('64, 128 oder 256');
          this.impostorRes = px;
          this.regenerate();
        }
        const a = this.atlas;
        return a ? `Impostoren: ${a.frame} px pro Blickwinkel, Atlas ${a.cols * a.frame}×${a.rows * a.frame}` : 'Impostoren noch nicht gebacken';
      },
    });
    registerCommand({
      name: 'veg.species', help: 'Baumarten: Dreiecke pro Detailstufe und Anzahl in den geladenen Kacheln',
      run: () => {
        if (!this.ready) return 'Bäume laden noch';
        const c = this.counts();
        return SPECIES.map((sp) => {
          const g = this.geo[sp.id];
          const n = sp.form === 'bush' ? '' : ` · ${c.trees.get(sp.id) ?? 0} Stück`;
          return `${sp.id.padEnd(9)} ${triangles(g.lods[0])} / ${triangles(g.lods[1])} Dreiecke${sp.form === 'bush' ? '' : ' / 2 (Impostor)'} · ${sp.height} m${n}`;
        }).join('\n');
      },
    });
    registerToggle('veg.lidar', 'Bäume aus der LiDAR-Befliegung (echte Position, Höhe und Krone) zeigen', () => this.lidar, (v) => { this.lidar = v; if (this.ready) for (const t of this.tiles.values()) this.buildTile(t); });
    registerToggle('veg.grass', 'Grasbüschel um die Kamera', () => this.grassOn, (v) => { this.grassOn = v; this.grassAt.x = Infinity; });
    registerValue('veg.grass.radius', 'Radius der Grasbüschel in Metern', () => this.grassRadius, (v) => { this.grassRadius = v; this.grassAt.x = Infinity; }, [5, 120]);
    registerValue('veg.fields', 'Grasflecken im Boden 0..1 (Ackerreihen: ground.rows)', () => this.groundUniforms.uVegFields.value, (v) => (this.groundUniforms.uVegFields.value = v), [0, 1]);
    registerCommand({
      name: 'veg.info', help: 'Bäume nach Art, Büsche, gezeichnete Bäume pro Detailstufe und Grasbüschel',
      run: () => {
        const c = this.counts();
        const total = [...c.trees.values()].reduce((a, b) => a + b, 0);
        return `${total} Bäume (${[...c.trees].map(([k, n]) => `${k} ${n}`).join(', ') || 'keine'}) · davon ${c.lidar} aus LiDAR · ${c.bushes} Büsche · ${c.grass} Grasbüschel · Wind ${this.windNow.toFixed(2)}\n`
          + `gezeichnet: ${c.drawn[0]} detailliert, ${c.drawn[1]} einfach, ${c.drawn[2]} Impostor · LOD: detailliert bis ${this.lodDistance} m, einfach bis ${this.billboardDistance} m, Überblendung ${Math.round(this.fade * 100)} % · Büsche bis ${this.bushDistance} m · ${this.splitCount} Instanzen im letzten Bild umsortiert`;
      },
    });
  }
}

const fract = (v: number) => v - Math.floor(v);
const hash = (x: number, z: number, salt: number) => fract(Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453);

/** One instance: x, y, z, crown width scale, height scale, colour variation. */
type Rec = [number, number, number, number, number, number];

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
function shuffled<T extends Rec>(list: T[]) {
  return list
    .map((r, i) => [r, fract(Math.sin(i * 91.7 + list.length) * 43758.5453)] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([r]) => r);
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
