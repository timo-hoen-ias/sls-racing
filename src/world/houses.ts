import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, runCommand } from '../debug/registry.ts';
import { patchPbr } from '../render/pbr/pbrShader.ts';
import { BUILDING, NATURE, STREET, cellIndex } from '../render/pbr/textureSets.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import type { HouseSet } from './houseGlb.ts';
import {
  DOOR_COLOURS, GARDEN_LINEAR, GARDEN_PARTS, GARDEN_STRIDE, HOUSE_MODELS, HOUSE_STRIDE, HOUSE_STYLES, ROOF_SHADES, SHUTTER_COLOURS, SURFACE,
  TINT, TINTS, type HouseStyle,
} from './houseKinds.ts';
import { registerTileLayer } from './tileHooks.ts';

// Freely designed houses and their front gardens (pipeline/lib/houses.ts) as a tile layer, drawn with the Blender
// models of houses.glb. Every model and LOD is one instanced mesh for the whole loaded world; instances move
// between LOD 0 and 1 by distance when the camera has moved. Walls, roofs and paving get photo detail from the PBR
// atlases by their surface code; window glass lights up at night, a random share of windows per house. Each house
// varies its wall colour, roof shade and the colours of shutters and doors by its tint and seed.
// The colliders come with the tile physics (houseColliders.ts).

interface HouseTile {
  key: string;
  houses: Float32Array;
  gardens: Float32Array;
  /** Instance matrices (16 per record), built once when the tile arrives. */
  hm: Float32Array;
  gm: Float32Array;
}

/** Camera distance (m) up to which houses use LOD 0. */
const LOD_DISTANCE = 140;
/** Garden parts: LOD 0 up to here, LOD 1 up to GARDEN_DRAW, beyond that none. */
const GARDEN_LOD = 60;
const GARDEN_DRAW = 320;
/** Rebuild the instance lists when the camera moved this far (m). */
const REBUILD_MOVE = 12;

const B = (n: string) => `${cellIndex(BUILDING, n)}.0`;
const N = (n: string) => `${cellIndex(NATURE, n)}.0`;
const S = (n: string) => `${cellIndex(STREET, n)}.0`;

/** Surface detail by the uv.x code: photo luminance on the vertex colour; tints per house by the uv.y code. */
const BODY = /* glsl */ `
  float code = floor(vPbrUv.x + 0.5);
  vec3 n = normalize(vPbrNrm);
  vec3 p = vPbrPos;
  vec2 tw = normalize(vec2(-n.z, n.x) + 1e-5);
  vec3 t3 = vec3(tw.x, 0.0, tw.y);
  // Along the face: horizontal u, v up the wall or down the roof slope; flat faces top-down.
  vec2 uv = abs(n.y) > 0.97 ? p.xz : vec2(dot(p, t3), dot(p, normalize(cross(n, t3))));
  // The glTF export flips v (v = 1 - code), so the tint code is read back as 1 - uv.y.
  float tint = floor(1.5 - vPbrUv.y);
  if (tint == ${TINT.wall}.0) diffuseColor.rgb *= vHouseTint;
  else if (tint == ${TINT.roof}.0) diffuseColor.rgb *= HOUSE_ROOF[int(fract(vHouseSeed * 7.13) * ${ROOF_SHADES.length}.0)];
  else if (tint == ${TINT.shutter}.0 || tint == ${TINT.door}.0) {
    // Replace the model's colour (applied after this hook as vColor) with the house's accent colour.
    vec3 accent = tint == ${TINT.shutter}.0 ? HOUSE_SHUTTER[int(fract(vHouseSeed * 3.71) * ${SHUTTER_COLOURS.length}.0)]
      : HOUSE_DOOR[int(fract(vHouseSeed * 5.37) * ${DOOR_COLOURS.length}.0)];
#ifdef USE_COLOR
    if (accent.r >= 0.0) diffuseColor.rgb *= accent / max(vColor.rgb, vec3(0.005));
#endif
  }
  float cell = -1.0;
  int atlas = 0;
  if (code == ${SURFACE.plaster}.0) cell = ${B('plaster')};
  else if (code == ${SURFACE.rough}.0) cell = ${B('plaster_rough')};
  else if (code == ${SURFACE.stone}.0) cell = ${B('sandstone')};
  else if (code == ${SURFACE.wood}.0) cell = ${B('wood_cladding')};
  else if (code == ${SURFACE.timber}.0) cell = ${B('timber')};
  else if (code == ${SURFACE.seam}.0) cell = ${B('roof_seam')};
  else if (code == ${SURFACE.brick}.0) cell = ${B('brick')};
  else if (code == ${SURFACE.concrete}.0) cell = ${B('concrete')};
  else if (code == ${SURFACE.clay}.0) cell = ${B('roof_clay')};
  else if (code == ${SURFACE.slate}.0) cell = ${B('roof_slate')};
  else if (code == ${SURFACE.gravel}.0) cell = ${B('roof_gravel')};
  else if (code == ${SURFACE.metal}.0) cell = ${B('painted_metal')};
  else if (code == ${SURFACE.lawn}.0) { cell = ${N('grass')}; atlas = 1; }
  else if (code == ${SURFACE.foliage}.0) { cell = ${N('meadow')}; atlas = 1; }
  else if (code == ${SURFACE.paving}.0) { cell = ${S('pavement')}; atlas = 2; }
  else if (code == ${SURFACE.kies}.0) { cell = ${S('gravel')}; atlas = 2; }
  float l = 1.0;
  pbrRough = 0.85;
  if (cell >= 0.0 && uPbrOn > 0.5) {
    if (atlas == 1 && code == ${SURFACE.foliage}.0) {
      pbrNormalK = 1.4;
      PBR_TRIPLANAR(pbrNatureFetch, cell, p, n, 0.9)
      vec3 mean = pbrNatureMean(cell);
      l = dot(pbrAlbedo, vec3(0.3, 0.59, 0.11)) / max(dot(mean, vec3(0.3, 0.59, 0.11)), 0.01);
    } else {
      float m = atlas == 0 ? pbrBuildingMetres[int(cell)] : atlas == 1 ? pbrNatureMetres[int(cell)] : pbrStreetMetres[int(cell)];
      vec2 tuv = uv / m;
      vec2 gx = dFdx(tuv), gy = dFdy(tuv);
      PbrTexel t;
      if (atlas == 0) t = pbrBuilding(cell, tuv, gx, gy);
      else if (atlas == 1) t = pbrNature(cell, tuv, gx, gy);
      else t = pbrStreet(cell, tuv, gx, gy);
      pbrUse(t);
      pbrUv = tuv;
      vec3 mean = atlas == 0 ? pbrBuildingMean(cell) : atlas == 1 ? pbrNatureMean(cell) : pbrStreetMean(cell);
      l = dot(t.a, vec3(0.2126, 0.7152, 0.0722)) / max(dot(mean, vec3(0.2126, 0.7152, 0.0722)), 0.01);
    }
    pbrCell = cell;
  }
  // Sandstone, cladding boards, beams and standing seams come from the PATINA cells of the building atlas.
  if (code == ${SURFACE.paint}.0) {
    pbrRough = 0.45;
  }
  if (uPbrOn < 0.5) l = 1.0;
  diffuseColor.rgb *= clamp(mix(1.0, l, 0.8), 0.45, 1.6);
`;

const glslColours = (list: (number | null)[]) =>
  list.map((h) => {
    if (h === null) return 'vec3(-1.0)';
    const c = new THREE.Color().setHex(h).convertSRGBToLinear();
    return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
  }).join(', ');

const BODY_FUNCTIONS = /* glsl */ `
varying vec3 vHouseTint;
varying float vHouseSeed;
const vec3 HOUSE_ROOF[${ROOF_SHADES.length}] = vec3[](${ROOF_SHADES.map((v) => `vec3(${v.map((x) => x.toFixed(3)).join(', ')})`).join(', ')});
const vec3 HOUSE_SHUTTER[${SHUTTER_COLOURS.length}] = vec3[](${glslColours(SHUTTER_COLOURS)});
const vec3 HOUSE_DOOR[${DOOR_COLOURS.length}] = vec3[](${glslColours(DOOR_COLOURS)});
`;

/** Lit windows: warm light behind a random share of the panes, per pane cell and house. */
const GLASS_FRAG = /* glsl */ `
  {
    vec3 cellId = floor(vHousePos / vec3(1.7, 2.9, 1.7));
    float h = fract(sin(dot(cellId, vec3(12.9898, 78.233, 37.719)) + vHouseSeed * 91.7) * 43758.5453);
    float on = step(h, uHouseLit) * uHouseNight;
    vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.85, fract(h * 7.3)));
    totalEmissiveRadiance += warm * on * (0.9 + 0.4 * fract(h * 13.1)) * 1.4;
  }
`;

export class HouseLayer {
  visible = true;
  gardensVisible = true;
  /** Window light: 'auto' follows the time of day, otherwise fixed 0..1. */
  night: 'auto' | number = 'auto';
  /** Share of lit windows after dark. */
  lit = 0.45;
  /** Forced LOD (0 or 1) or 'auto'. */
  lod: 'auto' | 0 | 1 = 'auto';
  /** Show every house as models of one style (debug), or undefined for the planned models. */
  forceStyle?: HouseStyle;
  readonly root = new THREE.Group();
  set?: HouseSet;
  private tiles = new Map<string, HouseTile>();
  private dirty = true;
  private last = new THREE.Vector3(1e9, 0, 1e9);
  private lastBuild = 0;
  private meshes: THREE.InstancedMesh[] = [];
  private pool = new Map<string, THREE.InstancedMesh>();
  readonly body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  readonly glass = new THREE.MeshStandardMaterial({ color: 0x3a4652, roughness: 0.06, metalness: 0.4, emissive: 0x000000 });
  private glassUniforms = { uHouseNight: { value: 0 }, uHouseLit: { value: 0.45 } };
  private shadows: boolean;

  constructor(opts: { shadows: boolean }) {
    this.shadows = opts.shadows;
    this.root.name = 'houses';
    // Per-instance wall colour and seed into varyings, before the PBR hooks wrap this.
    this.body.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 houseTint;\nvarying vec3 vHouseTint;\nattribute float houseSeed;\nvarying float vHouseSeed;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vHouseTint = houseTint;\n  vHouseSeed = houseSeed;');
    };
    patchPbr(this.body, { key: 'house', atlases: ['building', 'nature', 'street'], body: BODY, functions: BODY_FUNCTIONS });
    patchMaterial(this.body, { wet: 0.5, snow: 0.8 });
    const u = this.glassUniforms;
    this.glass.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float houseSeed;\nvarying float vHouseSeed;\nvarying vec3 vHousePos;')
        .replace('#include <project_vertex>', `#include <project_vertex>
  vHouseSeed = houseSeed;
  vHousePos = transformed;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uHouseNight;\nuniform float uHouseLit;\nvarying float vHouseSeed;\nvarying vec3 vHousePos;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLASS_FRAG}`);
    };
    this.glass.customProgramCacheKey = () => 'house-glass';
    patchMaterial(this.glass, { wet: 0.2, snow: 0.1 });
  }

  register() {
    registerTileLayer({
      name: 'houses',
      visual: (t) => {
        const houses = t.has('houses') ? t.f32('houses')!.slice() : new Float32Array(0);
        const gardens = t.has('gardens') ? t.f32('gardens')!.slice() : new Float32Array(0);
        if (!houses.length && !gardens.length) return;
        this.tiles.set(t.key, { key: t.key, houses, gardens, hm: houseMatrices(houses), gm: gardenMatrices(gardens) });
        this.dirty = true;
      },
      removed: (key) => {
        if (this.tiles.delete(key)) this.dirty = true;
      },
    });
  }

  setHouseSet(set: HouseSet) {
    this.set = set;
    this.dirty = true;
  }

  /** Model index drawn for a record (the planned one, or the closest model of the forced style). */
  private shown(model: number) {
    const m = HOUSE_MODELS[model];
    if (!this.forceStyle || !m || m.style === this.forceStyle) return model;
    let best = model, bd = Infinity;
    HOUSE_MODELS.forEach((x, i) => {
      if (x.style !== this.forceStyle) return;
      const d = Math.abs(Math.log(x.w / m.w)) + Math.abs(Math.log(x.d / m.d));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  private rebuild(cam: THREE.Vector3) {
    for (const im of this.meshes) im.count = 0;
    const set = this.set;
    if (!set) return;
    // Instances per mesh: (tile, record index) pairs.
    const lists = new Map<string, { t: HouseTile; i: number; garden: boolean; model: number }[]>();
    const add = (key: string, v: { t: HouseTile; i: number; garden: boolean; model: number }) => {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.push(v);
    };
    for (const t of this.tiles.values()) {
      if (this.visible)
        for (let i = 0; i * HOUSE_STRIDE < t.houses.length; i++) {
          const o = i * HOUSE_STRIDE;
          const model = this.shown(t.houses[o]);
          const d = Math.hypot(t.houses[o + 1] - cam.x, t.houses[o + 3] - cam.z);
          const lod = this.lod === 'auto' ? (d < LOD_DISTANCE ? 0 : 1) : this.lod;
          add(`h:${model}:${lod}`, { t, i, garden: false, model });
        }
      if (this.gardensVisible)
        for (let i = 0; i * GARDEN_STRIDE < t.gardens.length; i++) {
          const o = i * GARDEN_STRIDE;
          const d = Math.hypot(t.gardens[o + 1] - cam.x, t.gardens[o + 3] - cam.z);
          if (d > GARDEN_DRAW) continue;
          const lod = this.lod === 'auto' ? (d < GARDEN_LOD ? 0 : 1) : this.lod;
          add(`g:${t.gardens[o]}:${lod}`, { t, i, garden: true, model: t.gardens[o] });
        }
    }
    const c = new THREE.Color();
    for (const [key, list] of lists) {
      const [kind, idx, lodS] = key.split(':');
      const lod = Number(lodS);
      const geos: [THREE.BufferGeometry, THREE.Material][] = [];
      if (kind === 'h') {
        const lods = set.houses[HOUSE_MODELS[Number(idx)]?.id];
        if (!lods) continue;
        geos.push([lod ? lods.lod1 : lods.lod0, this.body], [lod ? lods.glass1 : lods.glass0, this.glass]);
      } else {
        const lods = set.gardens[GARDEN_PARTS[Number(idx)]];
        if (!lods) continue;
        geos.push([lod ? lods.lod1 : lods.lod0, this.body]);
      }
      geos.forEach(([g0, mat], gi) => {
        if (!g0.getAttribute('position')) return;
        const im = this.mesh(`${key}:${gi}`, g0, mat, list.length);
        const tint = im.geometry.getAttribute('houseTint') as THREE.InstancedBufferAttribute;
        const seed = im.geometry.getAttribute('houseSeed') as THREE.InstancedBufferAttribute;
        list.forEach((v, n) => {
          const src = v.garden ? v.t.gm : v.t.hm;
          (im.instanceMatrix.array as Float32Array).set(src.subarray(v.i * 16, v.i * 16 + 16), n * 16);
          if (!v.garden) {
            const o = v.i * HOUSE_STRIDE;
            const tints = TINTS[HOUSE_MODELS[v.model].style];
            c.setHex(tints[v.t.houses[o + 7] % tints.length] ?? 0xffffff).convertSRGBToLinear();
            tint.setXYZ(n, c.r, c.g, c.b);
            seed.setX(n, v.t.houses[o + 8]);
          } else tint.setXYZ(n, 1, 1, 1);
        });
        im.count = list.length;
        im.instanceMatrix.needsUpdate = true;
        tint.needsUpdate = true;
        seed.needsUpdate = true;
        im.castShadow = this.shadows && (kind === 'h' || lod === 0);
        im.receiveShadow = this.shadows;
        im.computeBoundingSphere();
      });
    }
  }

  /** The pooled instanced mesh for a model, LOD and part, grown when it needs more room. */
  private mesh(key: string, g0: THREE.BufferGeometry, mat: THREE.Material, n: number) {
    let im = this.pool.get(key);
    if (im && (im.instanceMatrix.array.length / 16) >= n) return im;
    const cap = Math.max(16, Math.ceil(n * 1.5));
    let g: THREE.BufferGeometry;
    if (im) {
      g = im.geometry;
      this.root.remove(im);
      im.dispose();
      this.meshes.splice(this.meshes.indexOf(im), 1);
    } else {
      // A light wrapper sharing the model's buffers, plus this mesh's instance attributes.
      g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(g0.attributes)) g.setAttribute(name, attr);
      g.setIndex(g0.index);
      g.boundingSphere = g0.boundingSphere;
    }
    g.setAttribute('houseTint', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute('houseSeed', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    im = new THREE.InstancedMesh(g, mat, cap);
    im.name = key;
    im.frustumCulled = true;
    this.pool.set(key, im);
    this.meshes.push(im);
    this.root.add(im);
    return im;
  }

  update(camera: THREE.Camera, daylight = 1) {
    const night = this.night === 'auto' ? THREE.MathUtils.smoothstep(1 - daylight, 0.3, 0.75) : this.night;
    this.glassUniforms.uHouseNight.value = night;
    this.glassUniforms.uHouseLit.value = this.lit;
    const p = camera.position;
    const now = performance.now();
    // Tiles arrive in bursts while streaming: rebuild at most twice a second.
    if ((this.dirty || Math.hypot(p.x - this.last.x, p.z - this.last.z) > REBUILD_MOVE) && now - this.lastBuild > 500) {
      this.dirty = false;
      this.lastBuild = now;
      this.last.copy(p);
      this.rebuild(p);
    }
  }

  /** Loaded houses: all records with their position and model. */
  private all() {
    const out: { model: number; x: number; y: number; z: number; heading: number; sx: number; sz: number }[] = [];
    for (const t of this.tiles.values())
      for (let o = 0; o + HOUSE_STRIDE <= t.houses.length; o += HOUSE_STRIDE)
        out.push({ model: t.houses[o], x: t.houses[o + 1], y: t.houses[o + 2], z: t.houses[o + 3], heading: t.houses[o + 4], sx: t.houses[o + 5], sz: t.houses[o + 6] });
    return out;
  }

  registerCommands(player: () => { x: number; z: number }) {
    const ids = HOUSE_MODELS.map((m) => m.id);
    registerToggle('houses', 'Frei gestaltete Häuser, Villen und Verwaltungsgebäude zeigen', () => this.visible, (v) => { this.visible = v; this.dirty = true; });
    registerToggle('houses.gardens', 'Vorgärten der gestalteten Häuser zeigen', () => this.gardensVisible, (v) => { this.gardensVisible = v; this.dirty = true; });
    registerCommand({
      name: 'houses.info', help: 'Geladene gestaltete Häuser nach Baustil und Modell, Vorgartenteile',
      run: () => {
        const all = this.all();
        const byStyle = new Map<string, number>(), byModel = new Map<string, number>();
        for (const h of all) {
          const m = HOUSE_MODELS[h.model];
          byStyle.set(m.style, (byStyle.get(m.style) ?? 0) + 1);
          byModel.set(m.id, (byModel.get(m.id) ?? 0) + 1);
        }
        let garden = 0;
        for (const t of this.tiles.values()) garden += t.gardens.length / GARDEN_STRIDE;
        return `${all.length} Häuser: ${[...byStyle].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${HOUSE_STYLES[k as HouseStyle]} ${n}`).join(', ') || '-'}\n` +
          `${byModel.size}/${HOUSE_MODELS.length} Modelle im Einsatz · ${garden} Gartenteile · Modelle ${this.set ? 'geladen' : 'fehlen (houses.glb)'} · ${this.meshes.filter((m) => m.count > 0).length} Instanz-Meshes in Gebrauch`;
      },
    });
    registerCommand({
      name: 'houses.catalog', help: 'Alle Hausmodelle mit Baustil und Grundfläche', args: '[stil]',
      complete: () => Object.keys(HOUSE_STYLES),
      run: ([style]) => HOUSE_MODELS.filter((m) => !style || m.style === style).map((m) => `${m.id}: ${m.name} (${HOUSE_STYLES[m.style]}, ${m.w} × ${m.d} m, Garten ${m.garden})`).join('\n'),
    });
    registerCommand({
      name: 'houses.near', help: 'Die nächsten gestalteten Häuser mit Modell, Abstand und Streckung', args: '[anzahl]',
      run: ([n = '5']) => {
        const p = player();
        return this.all().map((h) => ({ ...h, d: Math.hypot(h.x - p.x, h.z - p.z) })).sort((a, b) => a.d - b.d).slice(0, parseNum(n, 'Anzahl', 1, 50))
          .map((h) => `${HOUSE_MODELS[h.model].name} (${HOUSE_MODELS[h.model].id}) ${h.d.toFixed(0)} m · ${(h.sx * 100).toFixed(0)} × ${(h.sz * 100).toFixed(0)} %`).join('\n') || 'keine gestalteten Häuser geladen';
      },
    });
    registerCommand({
      name: 'houses.tp', help: 'Vor das n-nächste gestaltete Haus stellen, oder vor das nächste eines Modells oder Stils', args: '[n|modell|stil] [abstand m]',
      complete: () => [...ids, ...Object.keys(HOUSE_STYLES)],
      run: ([what = '1', dist = '18']) => {
        const p = player();
        let list = this.all().map((h) => ({ ...h, d: Math.hypot(h.x - p.x, h.z - p.z) })).sort((a, b) => a.d - b.d);
        let h;
        if (/^\d+$/.test(what)) h = list[parseNum(what, 'n', 1, 500) - 1];
        else {
          list = list.filter((x) => HOUSE_MODELS[x.model].id === what || HOUSE_MODELS[x.model].style === what);
          h = list[0];
        }
        if (!h) throw new Error(`kein passendes Haus geladen (${what})`);
        const m = HOUSE_MODELS[h.model];
        const d = parseNum(dist, 'Abstand', 3, 80) + (m.d * h.sz) / 2;
        // The car stands in front of the house and faces it.
        runCommand(`tp ${(h.x + Math.sin(h.heading) * d).toFixed(1)} ${(h.z + Math.cos(h.heading) * d).toFixed(1)} ${Math.round((-h.heading * 180) / Math.PI)}`);
        return `${m.name} (${HOUSE_STYLES[m.style]}) · ${h.d.toFixed(0)} m entfernt`;
      },
    });
    registerCommand({
      name: 'houses.style', help: 'Alle gestalteten Häuser in einem Baustil zeigen (zum Vergleichen) oder auto', args: '<stil|auto>',
      complete: () => ['auto', ...Object.keys(HOUSE_STYLES)],
      run: ([s = 'auto']) => {
        if (s !== 'auto' && !(s in HOUSE_STYLES)) throw new Error(`unbekannter Stil, bekannt: ${Object.keys(HOUSE_STYLES).join(', ')}`);
        this.forceStyle = s === 'auto' ? undefined : (s as HouseStyle);
        this.dirty = true;
        return s === 'auto' ? 'geplante Modelle' : `alle Häuser als ${HOUSE_STYLES[s as HouseStyle]}`;
      },
    });
    registerCommand({
      name: 'houses.lod', help: 'Detailstufe der Häuser und Gärten: auto (nach Abstand), 0 oder 1', args: '[auto|0|1]',
      complete: () => ['auto', '0', '1'],
      run: ([v]) => {
        if (v === 'auto') this.lod = 'auto';
        else if (v === '0' || v === '1') this.lod = Number(v) as 0 | 1;
        this.dirty = true;
        return `Detailstufe ${this.lod} (LOD 0 bis ${LOD_DISTANCE} m, Gärten bis ${GARDEN_DRAW} m)`;
      },
    });
    registerCommand({
      name: 'houses.night', help: 'Fensterlicht der Häuser: auto (nach Tageszeit) oder fest 0..1, dazu der Anteil heller Fenster', args: '[auto|0..1] [anteil 0..1]',
      complete: () => ['auto', '0', '1'],
      run: ([v, share]) => {
        if (v === 'auto') this.night = 'auto';
        else if (v !== undefined) this.night = parseNum(v, 'Fensterlicht', 0, 1);
        if (share !== undefined) this.lit = parseNum(share, 'Anteil', 0, 1);
        return `Fensterlicht ${this.night} (jetzt ${this.glassUniforms.uHouseNight.value.toFixed(2)}), ${Math.round(this.lit * 100)} % der Fenster hell`;
      },
    });
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Instance matrices of house records: position, heading, stretch along the front and the depth. */
export function houseMatrices(d: Float32Array) {
  const out = new Float32Array((d.length / HOUSE_STRIDE) * 16);
  for (let i = 0, o = 0; o + HOUSE_STRIDE <= d.length; i++, o += HOUSE_STRIDE) {
    tmpQ.setFromAxisAngle(UP, d[o + 4]);
    tmpM.compose(tmpP.set(d[o + 1], d[o + 2], d[o + 3]), tmpQ, tmpS.set(d[o + 5], 1, d[o + 6]));
    tmpM.toArray(out, i * 16);
  }
  return out;
}

/** Instance matrices of garden records: linear parts scaled along their heading by the length. */
export function gardenMatrices(d: Float32Array) {
  const out = new Float32Array((d.length / GARDEN_STRIDE) * 16);
  for (let i = 0, o = 0; o + GARDEN_STRIDE <= d.length; i++, o += GARDEN_STRIDE) {
    tmpQ.setFromAxisAngle(UP, d[o + 4]);
    const linear = GARDEN_LINEAR.has(GARDEN_PARTS[d[o]]);
    tmpM.compose(tmpP.set(d[o + 1], d[o + 2], d[o + 3]), tmpQ, tmpS.set(1, 1, linear ? d[o + 5] : 1));
    tmpM.toArray(out, i * 16);
  }
  return out;
}
