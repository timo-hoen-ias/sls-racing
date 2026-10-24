import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Materials } from '../render/materials.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { Ground, TERRAIN_N, TERRAIN_STEP, type WorldInfo, tileOriginLocal } from './format.ts';
import type { RoadGraph } from './roadGraph.ts';
import { registerTileLayer } from './tileHooks.ts';
import { BUSH_STRIDE, TREE_NAMES, Tree, type TreeKind } from './vegKinds.ts';
import { buildBushGeometries, buildGrassGeometry, buildTreeGeometries } from './vegModels.ts';

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

interface VegTile {
  key: string;
  cx: number;
  cz: number;
  /** Per kind: [lod0, lod1] meshes and the full instance count. */
  trees: { kind: TreeKind; lod: [THREE.InstancedMesh, THREE.InstancedMesh]; n: number }[];
  bushes: { mesh: THREE.InstancedMesh; n: number }[];
  heights: Float32Array;
  ground: Uint8Array;
  ox: number;
  oz: number;
}

export class Vegetation {
  /** Grass clumps around the camera (the trees and bushes live in the tile groups). */
  readonly root = new THREE.Group();
  /** Share of trees and bushes drawn, 0..1. */
  density = 1;
  /** Detailed trees within this distance (m) of the tile centre. */
  lodDistance = 260;
  /** "auto" follows the weather, a number fixes the wind strength 0..1. */
  wind: 'auto' | number = 'auto';
  windNow = 0.3;
  /** Forces one LOD for all tiles (veg.lod 0|1), undefined = by distance. */
  forcedLod?: 0 | 1;
  grassOn: boolean;
  grassRadius = 32;
  readonly groundUniforms = { uVegFields: { value: 1 } };
  private tiles = new Map<string, VegTile>();
  private treeGeo = buildTreeGeometries();
  private bushGeo = buildBushGeometries();
  private treeMat: THREE.MeshStandardMaterial;
  private bushMat: THREE.MeshStandardMaterial;
  private grass: THREE.InstancedMesh;
  private grassAt = new THREE.Vector3(Infinity, 0, 0);
  private info: WorldInfo;
  private graph: RoadGraph;
  private time = 0;

  constructor(opts: { world: WorldInfo; graph: RoadGraph; mats: Materials; grass: number }) {
    this.info = opts.world;
    this.graph = opts.graph;
    this.treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    patchWind(this.treeMat, 0.35, 'tree');
    this.bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    patchWind(this.bushMat, 0.08, 'bush');
    const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    patchWind(grassMat, 0.12, 'grass');
    this.grass = new THREE.InstancedMesh(buildGrassGeometry(), grassMat, Math.max(1, opts.grass));
    this.grass.count = 0;
    this.grass.frustumCulled = false;
    this.grass.receiveShadow = true;
    this.grassOn = opts.grass > 0;
    this.root.name = 'vegetation';
    this.root.add(this.grass);
    patchGroundDetail(opts.mats.ground, this.groundUniforms);
  }

  /** Hooks into the tile streamer; call once at startup, before tiles load. */
  register(trees: boolean) {
    registerTileLayer({
      name: 'vegetation',
      visual: (t, ctx) => {
        const [ox, oz] = tileOriginLocal(this.info, t.ix, t.iy);
        const tile: VegTile = {
          key: t.key, cx: ox + this.info.tileSize / 2, cz: oz + this.info.tileSize / 2, trees: [], bushes: [],
          heights: t.f32('terrain')!.slice(), ground: t.u8('ground')!.slice(), ox, oz,
        };
        const tr = trees ? t.f32('trees') : undefined;
        if (tr?.length) {
          const kinds = t.has('treeKinds') ? t.u8('treeKinds') : undefined;
          const byKind = new Map<TreeKind, number[]>();
          for (let i = 0; i < tr.length / 4; i++) {
            const k = (kinds?.[i] ?? Tree.broadleaf) as TreeKind;
            if (!byKind.has(k)) byKind.set(k, []);
            byKind.get(k)!.push(i);
          }
          for (const [kind, list] of byKind) {
            const lod = this.treeGeo[kind].map((g) => this.instances(g, this.treeMat, list.length, ctx.shadows)) as [THREE.InstancedMesh, THREE.InstancedMesh];
            this.fill(lod, shuffled(list), (i) => [tr[i * 4], tr[i * 4 + 1] - 0.15, tr[i * 4 + 2], tr[i * 4 + 3]], kind === Tree.conifer ? 0.03 : 0.07);
            ctx.group.add(...lod);
            tile.trees.push({ kind, lod, n: list.length });
          }
        }
        const bu = trees && t.has('bushes') ? t.f32('bushes') : undefined;
        if (bu?.length) {
          const byKind = new Map<number, number[]>();
          for (let i = 0; i < bu.length / BUSH_STRIDE; i++) {
            const k = bu[i * BUSH_STRIDE + 4];
            if (!byKind.has(k)) byKind.set(k, []);
            byKind.get(k)!.push(i);
          }
          for (const [kind, list] of byKind) {
            const mesh = this.instances(this.bushGeo[kind as 0 | 1], this.bushMat, list.length, ctx.shadows);
            const o = (i: number) => i * BUSH_STRIDE;
            this.fill([mesh], shuffled(list), (i) => [bu[o(i)], bu[o(i) + 1] - 0.1, bu[o(i) + 2], bu[o(i) + 3]], 0.08);
            ctx.group.add(mesh);
            tile.bushes.push({ mesh, n: list.length });
          }
        }
        this.tiles.set(t.key, tile);
        this.grassAt.x = Infinity;
      },
      removed: (key) => {
        this.tiles.delete(key);
        this.grassAt.x = Infinity;
      },
    });
  }

  private instances(g: THREE.BufferGeometry, mat: THREE.Material, n: number, shadows: boolean) {
    const im = new THREE.InstancedMesh(g, mat, n);
    im.userData.sharedGeometry = true;
    im.castShadow = shadows;
    im.receiveShadow = shadows;
    return im;
  }

  private fill(meshes: THREE.InstancedMesh[], order: number[], at: (i: number) => [number, number, number, number], tint: number) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    order.forEach((i, n) => {
      const [x, y, z, sc] = at(i);
      const h = fract(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, h * Math.PI * 2);
      s.set(sc, sc * (0.9 + 0.2 * fract(h * 7.1)), sc);
      m.compose(p.set(x, y, z), q, s);
      // Each tree a little lighter or darker, warmer or cooler.
      c.setRGB(1 + (fract(h * 3.7) - 0.5) * tint * 2, 1 + (fract(h * 5.3) - 0.5) * tint * 2, 1 - tint);
      for (const im of meshes) {
        im.setMatrixAt(n, m);
        im.setColorAt(n, c);
      }
    });
    for (const im of meshes) im.computeBoundingSphere();
  }

  update(dt: number, camera: THREE.Camera, weather?: { rain: number; snow: number; overcast: number }) {
    this.time += dt;
    const target = this.wind === 'auto' ? 0.2 + 0.35 * (weather?.overcast ?? 0) + 0.45 * Math.max(weather?.rain ?? 0, weather?.snow ?? 0) : this.wind;
    this.windNow += (target - this.windNow) * Math.min(1, dt * 0.3);
    vegUniforms.uVegTime.value = this.time;
    vegUniforms.uVegWind.value = this.windNow;
    const cx = camera.position.x, cz = camera.position.z;
    for (const t of this.tiles.values()) {
      const near = this.forcedLod !== undefined ? this.forcedLod === 0 : Math.hypot(t.cx - cx, t.cz - cz) < this.lodDistance;
      for (const tr of t.trees) {
        tr.lod[0].visible = near;
        tr.lod[1].visible = !near;
        tr.lod[0].count = tr.lod[1].count = Math.round(tr.n * this.density);
      }
      for (const b of t.bushes) {
        b.mesh.visible = near || this.forcedLod === 1;
        b.mesh.count = Math.round(b.n * this.density);
      }
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
    let bushes = 0, near = 0;
    for (const t of this.tiles.values()) {
      t.trees.forEach((tr) => {
        const name = TREE_NAMES[tr.kind];
        trees.set(name, (trees.get(name) ?? 0) + tr.n);
        if (tr.lod[0].visible) near += tr.n;
      });
      for (const b of t.bushes) bushes += b.n;
    }
    return { trees, bushes, near, grass: this.grass.count };
  }

  registerCommands() {
    registerValue('veg.density', 'Anteil der gezeichneten Bäume und Büsche 0..1', () => this.density, (v) => (this.density = v), [0, 1]);
    registerValue('veg.lod', 'Entfernung (m), bis zu der Bäume detailliert gezeichnet werden', () => this.lodDistance, (v) => { this.lodDistance = v; this.forcedLod = undefined; }, [0, 3000]);
    registerCommand({
      name: 'veg.lod.force', help: 'Alle Bäume in einer Detailstufe zeigen (0 = detailliert, 1 = einfach) oder auto', args: '0|1|auto',
      complete: () => ['0', '1', 'auto'],
      run: ([v = 'auto']) => {
        this.forcedLod = v === 'auto' ? undefined : v === '0' ? 0 : v === '1' ? 1 : (() => { throw new Error('0, 1 oder auto'); })();
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
    registerToggle('veg.grass', 'Grasbüschel um die Kamera', () => this.grassOn, (v) => { this.grassOn = v; this.grassAt.x = Infinity; });
    registerValue('veg.grass.radius', 'Radius der Grasbüschel in Metern', () => this.grassRadius, (v) => { this.grassRadius = v; this.grassAt.x = Infinity; }, [5, 120]);
    registerValue('veg.fields', 'Ackerfurchen und Grasflecken im Boden 0..1', () => this.groundUniforms.uVegFields.value, (v) => (this.groundUniforms.uVegFields.value = v), [0, 1]);
    registerCommand({
      name: 'veg.info', help: 'Bäume nach Art, Büsche und Grasbüschel in den geladenen Kacheln',
      run: () => {
        const c = this.counts();
        return `${[...c.trees].map(([k, n]) => `${k} ${n}`).join(', ') || 'keine Bäume'} · ${c.near} detailliert · ${c.bushes} Büsche · ${c.grass} Grasbüschel · Wind ${this.windNow.toFixed(2)}`;
      },
    });
  }
}

const fract = (v: number) => v - Math.floor(v);

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
