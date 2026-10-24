import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, runCommand } from '../debug/registry.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { type WorldInfo, tileOriginLocal } from './format.ts';
import type { ShopSet } from './shopGlb.ts';
import { AWNING_COLORS, SHOP_KINDS, SHOP_STRIDE, ShopFlag } from './shopKinds.ts';
import { registerTileLayer } from './tileHooks.ts';

// Shop fronts (awnings, fascia boards and signs, café tables, pavement signs) as a tile layer, built from the
// tile's "shops" records with the Blender parts of shops.glb. Each tile gets its own instanced meshes per part and
// LOD; without the GLB nothing is drawn.

interface ShopTile {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group;
  shadows: boolean;
  data: Float32Array;
  /** Meshes per LOD (sign faces belong to both). */
  lods: [THREE.InstancedMesh[], THREE.InstancedMesh[]];
  faces: THREE.InstancedMesh[];
}

/** Camera distance (m) to the tile centre from which the simpler parts are used. */
const LOD_DISTANCE = 120;
/** Fronts are drawn on tiles within this distance (m). */
const DRAW_DISTANCE = 450;
/** Emissive strength of the sign faces at full night. */
const SIGN_GLOW = 0.9;

export class ShopLayer {
  visible = true;
  /** Lit signs: 'auto' follows the time of day, otherwise fixed 0..1. */
  night: 'auto' | number = 'auto';
  /** Current sign light 0..1. */
  glow = 0;
  set?: ShopSet;
  private tiles = new Map<string, ShopTile>();
  private info: WorldInfo;
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0);
  private local = new THREE.Matrix4();

  constructor(world: WorldInfo) {
    this.info = world;
    patchMaterial(this.mat, { wet: 0.5, snow: 0.6 });
  }

  register() {
    registerTileLayer({
      name: 'shops',
      visual: (t, ctx) => {
        const d = t.has('shops') ? t.f32('shops') : undefined;
        if (!d?.length) return;
        const [ox, oz] = tileOriginLocal(this.info, t.ix, t.iy);
        const tile: ShopTile = { key: t.key, cx: ox + this.info.tileSize / 2, cz: oz + this.info.tileSize / 2, group: ctx.group, shadows: ctx.shadows, data: d.slice(), lods: [[], []], faces: [] };
        this.tiles.set(t.key, tile);
        this.build(tile);
      },
      removed: (key) => { this.tiles.delete(key); },
    });
  }

  setShopSet(set: ShopSet) {
    this.set = set;
    if (set.signMaterial) {
      patchMaterial(set.signMaterial, { wet: 0.4, snow: 0.6 });
      // The sign faces glow in their own colours after dark.
      set.signMaterial.emissive.set(0xffffff);
      set.signMaterial.emissiveMap = set.signMaterial.map;
      set.signMaterial.emissiveIntensity = 0;
      set.signMaterial.needsUpdate = true;
    }
    for (const t of this.tiles.values()) this.build(t);
  }

  private build(t: ShopTile) {
    for (const im of [...t.lods[0], ...t.lods[1], ...t.faces]) { t.group.remove(im); im.dispose(); }
    t.lods = [[], []];
    t.faces = [];
    const set = this.set;
    if (!set) return;
    // Instances per part: matrix and colour.
    type Inst = { m: THREE.Matrix4; c?: number };
    const parts = new Map<string, Inst[]>();
    const faces = new Map<string, Inst[]>();
    const push = (map: Map<string, Inst[]>, key: string, m: THREE.Matrix4, c?: number) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ m: m.clone(), c });
    };
    const d = t.data;
    for (let o = 0; o + SHOP_STRIDE <= d.length; o += SHOP_STRIDE) {
      const kind = SHOP_KINDS[d[o]] ?? 'laden';
      const width = d[o + 5], flags = d[o + 6];
      this.q.setFromAxisAngle(this.up, d[o + 4]);
      const base = new THREE.Matrix4().compose(this.p.set(d[o + 1], d[o + 2], d[o + 3]), this.q, this.s.set(1, 1, 1));
      /** Part at offset (x along the front, z out from the wall), scaled along x. */
      const at = (x: number, z: number, sx = 1) => this.m.multiplyMatrices(base, this.local.compose(this.p.set(x, 0, z), IDENTITY_Q, this.s.set(sx, 1, 1)));
      const face = set.faces[kind] ?? set.faces.laden;
      push(parts, 'ladenschild', at(0, 0, width));
      if (face) push(faces, `${kind}:fascia`, at(0, 0));
      if (flags & ShopFlag.awning) push(parts, 'markise', at(0, 0, width), AWNING_COLORS[d[o + 7]] ?? AWNING_COLORS[0]);
      else if (flags & ShopFlag.awningBox) push(parts, 'markise-kasten', at(0, 0, width), AWNING_COLORS[d[o + 7]] ?? AWNING_COLORS[0]);
      if (flags & ShopFlag.projecting) {
        push(parts, 'nasenschild', at(width / 2 + 0.35, 0));
        if (face) push(faces, `${kind}:projecting`, at(width / 2 + 0.35, 0));
      }
      if (flags & ShopFlag.tables) for (const x of [-width / 4, width / 4]) push(parts, 'cafe-tisch', at(x, 2.6));
      if (flags & ShopFlag.aufsteller) push(parts, 'aufsteller', at(-width / 2 + 0.6, 1.2));
    }
    const make = (g: THREE.BufferGeometry, mat: THREE.Material, list: Inst[]) => {
      const im = new THREE.InstancedMesh(g, mat, list.length);
      im.userData.sharedGeometry = true;
      im.castShadow = t.shadows;
      im.receiveShadow = t.shadows;
      list.forEach((it, i) => {
        im.setMatrixAt(i, it.m);
        // Untinted parts keep their vertex colours (instance colour white).
        im.setColorAt(i, this.c.setHex(it.c ?? 0xffffff));
      });
      im.computeBoundingSphere();
      t.group.add(im);
      return im;
    };
    for (const [name, list] of parts) {
      const lods = set.parts[name];
      if (!lods) continue;
      t.lods[0].push(make(lods.lod0, this.mat, list));
      t.lods[1].push(make(lods.lod1, this.mat, list));
    }
    for (const [key, list] of faces) {
      const [kind, side] = key.split(':') as [string, 'fascia' | 'projecting'];
      const g = (set.faces[kind] ?? set.faces.laden)?.[side];
      if (g) t.faces.push(make(g, set.signMaterial ?? this.mat, list));
    }
  }

  update(camera: THREE.Camera, daylight = 1) {
    this.glow = this.night === 'auto' ? THREE.MathUtils.smoothstep(1 - daylight, 0.35, 0.8) : this.night;
    if (this.set?.signMaterial) this.set.signMaterial.emissiveIntensity = this.glow * SIGN_GLOW;
    const cx = camera.position.x, cz = camera.position.z;
    for (const t of this.tiles.values()) {
      const dist = Math.hypot(t.cx - cx, t.cz - cz);
      const show = this.visible && dist < DRAW_DISTANCE;
      const lod = dist < LOD_DISTANCE ? 0 : 1;
      t.lods[0].forEach((im) => (im.visible = show && lod === 0));
      t.lods[1].forEach((im) => (im.visible = show && lod === 1));
      t.faces.forEach((im) => (im.visible = show));
    }
  }

  /** Loaded shop fronts by kind. */
  counts() {
    const c = new Map<string, number>();
    for (const t of this.tiles.values())
      for (let o = 0; o + SHOP_STRIDE <= t.data.length; o += SHOP_STRIDE) {
        const k = SHOP_KINDS[t.data[o]] ?? '?';
        c.set(k, (c.get(k) ?? 0) + 1);
      }
    return c;
  }

  /** Nearest fronts to a point. */
  near(x: number, z: number, n: number) {
    const out: { kind: string; d: number; width: number; flags: number; x: number; z: number; heading: number }[] = [];
    for (const t of this.tiles.values())
      for (let o = 0; o + SHOP_STRIDE <= t.data.length; o += SHOP_STRIDE)
        out.push({ kind: SHOP_KINDS[t.data[o]] ?? '?', d: Math.hypot(t.data[o + 1] - x, t.data[o + 3] - z), width: t.data[o + 5], flags: t.data[o + 6], x: t.data[o + 1], z: t.data[o + 3], heading: t.data[o + 4] });
    return out.sort((a, b) => a.d - b.d).slice(0, n);
  }

  registerCommands(player: () => { x: number; z: number }) {
    registerToggle('props.shops', 'Ladenfronten (Markisen, Laden- und Nasenschilder, Cafétische, Aufsteller) zeigen', () => this.visible, (v) => (this.visible = v));
    registerCommand({
      name: 'shops.info', help: 'Geladene Ladenfronten nach Art',
      run: () => {
        const c = [...this.counts()].sort((a, b) => b[1] - a[1]);
        return `${c.map(([k, n]) => `${k} ${n}`).join(', ') || 'keine Läden geladen'} · Modelle ${this.set ? 'geladen' : 'fehlen (shops.glb)'}`;
      },
    });
    registerCommand({
      name: 'shops.near', help: 'Die nächsten Ladenfronten mit Abstand, Breite und Ausstattung', args: '[anzahl]',
      run: ([n = '5']) => {
        const p = player();
        const names = Object.entries(ShopFlag);
        return this.near(p.x, p.z, parseNum(n, 'Anzahl', 1, 50)).map((s) => `${s.kind} ${s.d.toFixed(0)} m (${s.x.toFixed(0)} ${s.z.toFixed(0)}, blickt ${Math.round((s.heading * 180) / Math.PI)}°) · ${s.width.toFixed(1)} m breit · ${names.filter(([, b]) => s.flags & b).map(([k]) => k).join(', ') || 'schlicht'}`).join('\n') || 'keine Läden in der Nähe';
      },
    });
    registerCommand({
      name: 'shops.night', help: 'Leuchtende Ladenschilder: auto (nach Tageszeit) oder fest 0..1', args: '[auto|0..1]',
      complete: () => ['auto', '0', '1'],
      run: ([v]) => {
        if (v === 'auto') this.night = 'auto';
        else if (v !== undefined) this.night = parseNum(v, 'Schilderlicht', 0, 1);
        return `Schilderlicht ${this.night} (jetzt ${this.glow.toFixed(2)})`;
      },
    });
    registerCommand({
      name: 'shops.tp', help: 'Vor die n-nächste Ladenfront stellen, Blick auf den Laden', args: '[n] [abstand m]',
      run: ([n = '1', dist = '12']) => {
        const p = player();
        const s = this.near(p.x, p.z, parseNum(n, 'n', 1, 50)).at(-1);
        if (!s) throw new Error('keine Läden geladen');
        const d = parseNum(dist, 'Abstand', 2, 60);
        // The car stands out in the street and faces the front (car heading = -front heading).
        runCommand(`tp ${(s.x + Math.sin(s.heading) * d).toFixed(1)} ${(s.z + Math.cos(s.heading) * d).toFixed(1)} ${Math.round((-s.heading * 180) / Math.PI)}`);
        return `${s.kind} · ${s.width.toFixed(1)} m breit`;
      },
    });
  }
}

const IDENTITY_Q = new THREE.Quaternion();
