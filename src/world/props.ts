import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { parseBool, parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import { CAR_PALETTE } from '../traffic/trafficSim.ts';
import { buildVehicleParts } from '../traffic/vehicleModels.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { PROP_GROUPS, PROP_NAMES, PROP_STRIDE, Prop, type PropKind } from './propKinds.ts';
import { LINEAR, addPropColliders } from './propColliders.ts';
import { buildPropGeometries } from './propModels.ts';
import { type WorldInfo, utmToLocal } from './format.ts';
import { registerTileLayer } from './tileHooks.ts';

// Street furniture and parked cars (W1) as a tile layer. Tiles hand over their prop records; everything within
// `radius` of the camera is drawn with one instanced mesh per model, rebuilt when the set of nearby tiles changes.
// Colliders come with the tile physics (near the car only). Breakable props are registered by collider so
// damage code (F3) can look up what it hit and remove it.

/** What a collider belongs to (props.lookup). */
export interface PropHit {
  kind: PropKind;
  /** German name, see PROP_NAMES; parked cars are 'parker'. */
  name: string;
  tileKey: string;
  /** Record number within the tile. */
  index: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  size: number;
  /** Light enough to knock over (signs, bollards, bins …); walls, columns and parked cars are not. */
  breakable: boolean;
}

const BREAKABLE = new Set<PropKind>([Prop.busStop, Prop.sign, Prop.stopSign, Prop.giveWay, Prop.cityLimit, Prop.bollard, Prop.bench, Prop.bin, Prop.postBox, Prop.hydrant, Prop.bikeStand, Prop.fence, Prop.hedge]);

interface TileProps { key: string; cx: number; cz: number; data: Float32Array }

type ModelKey = PropKind | 'busShelter' | 'car' | 'van';

export class PropLayer {
  readonly root = new THREE.Group();
  visible = true;
  /** Props are drawn within this distance of the camera (m). */
  radius: number;
  /** Groups switched off with props.toggle. */
  readonly hiddenKinds = new Set<PropKind>();
  private tiles = new Map<string, TileProps>();
  private removedProps = new Set<string>();
  private byCollider = new Map<number, PropHit>();
  private collidersByTile = new Map<string, number[]>();
  private meshes = new Map<ModelKey, THREE.InstancedMesh[]>();
  private shownKey = '';
  private dirty = true;
  private world?: RAPIER_NS.World;
  /** Instances drawn per model in the last rebuild. */
  readonly drawn = new Map<ModelKey, number>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(opts: { shadows: boolean; radius: number; world: WorldInfo }) {
    this.root.name = 'props';
    this.radius = opts.radius;
    this.info = opts.world;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
    patchMaterial(mat, { wet: 0.5, snow: 0.8 });
    const paint = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.45, envMapIntensity: 1.2 });
    patchMaterial(paint, { wet: 0.3, snow: 0.9, upFrom: 0.7 });
    const detail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 });
    const add = (key: ModelKey, parts: [THREE.BufferGeometry, THREE.Material][]) => {
      const list = parts.map(([g, mt]) => {
        const im = new THREE.InstancedMesh(g, mt, 1);
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = opts.shadows;
        im.receiveShadow = opts.shadows;
        this.root.add(im);
        return im;
      });
      this.meshes.set(key, list);
    };
    for (const [k, g] of Object.entries(buildPropGeometries())) add((k === 'busShelter' ? k : Number(k)) as ModelKey, [[g, mat]]);
    const cars = buildVehicleParts();
    for (const v of ['car', 'van'] as const) add(v, [[cars[v].paint, paint], [cars[v].detail, detail], [cars[v].lights, detail]]);
  }
  private info: WorldInfo;

  /** Hooks into the tile streamer; call once at startup. */
  register(world: RAPIER_NS.World) {
    this.world = world;
    registerTileLayer({
      name: 'props',
      visual: (t) => {
        const d = t.has('props') ? t.f32('props') : undefined;
        if (!d?.length) return;
        const T = this.info.tileSize;
        const [cx, cz] = utmToLocal(this.info, (t.ix + 0.5) * T, (t.iy + 0.5) * T);
        this.tiles.set(t.key, { key: t.key, cx, cz, data: d.slice() });
        this.dirty = true;
      },
      physics: (t, body, R, w) => this.addColliders(t.key, t.has('props') ? t.f32('props') : undefined, body, R, w),
      removed: (key) => {
        this.tiles.delete(key);
        this.forgetColliders(key);
        this.dirty = true;
      },
    });
  }

  update(camera: THREE.Camera) {
    this.root.visible = this.visible;
    if (!this.visible) return;
    const r = this.radius + this.info.tileSize * 0.75;
    const near: TileProps[] = [];
    for (const t of this.tiles.values()) if (Math.hypot(t.cx - camera.position.x, t.cz - camera.position.z) < r) near.push(t);
    const key = near.map((t) => t.key).sort().join(',');
    if (key === this.shownKey && !this.dirty) return;
    this.shownKey = key;
    this.dirty = false;
    this.rebuild(near);
  }

  private rebuild(tiles: TileProps[]) {
    const lists = new Map<ModelKey, { t: TileProps; i: number }[]>();
    for (const t of tiles)
      for (let i = 0; i * PROP_STRIDE < t.data.length; i++) {
        const kind = t.data[i * PROP_STRIDE] as PropKind;
        if (this.hiddenKinds.has(kind) || this.removedProps.has(`${t.key}:${i}`)) continue;
        const size = t.data[i * PROP_STRIDE + 5];
        const model: ModelKey = kind === Prop.parkedCar ? (size % 2 ? 'van' : 'car') : kind === Prop.busStop && size ? 'busShelter' : kind;
        if (!lists.has(model)) lists.set(model, []);
        lists.get(model)!.push({ t, i });
      }
    for (const [model, meshes] of this.meshes) {
      const list = lists.get(model) ?? [];
      this.drawn.set(model, list.length);
      for (let mi = 0; mi < meshes.length; mi++) {
        let im = meshes[mi];
        if (im.instanceMatrix.count < list.length) {
          // Grow in steps so a few more props don't reallocate every time.
          const grown = new THREE.InstancedMesh(im.geometry, im.material, Math.ceil(list.length * 1.5));
          grown.frustumCulled = false;
          grown.castShadow = im.castShadow;
          grown.receiveShadow = im.receiveShadow;
          this.root.remove(im);
          im.dispose();
          this.root.add(grown);
          meshes[mi] = im = grown;
        }
        im.count = list.length;
      }
      for (let n = 0; n < list.length; n++) {
        const { t, i } = list[n];
        const o = i * PROP_STRIDE;
        const kind = t.data[o] as PropKind;
        this.q.setFromAxisAngle(this.up, t.data[o + 4]);
        this.s.set(1, 1, LINEAR.has(kind) ? Math.max(0.2, t.data[o + 5]) : 1);
        this.m.compose(this.p.set(t.data[o + 1], t.data[o + 2], t.data[o + 3]), this.q, this.s);
        for (const im of meshes) im.setMatrixAt(n, this.m);
        if (model === 'car' || model === 'van') meshes[0].setColorAt(n, this.c.setHex(CAR_PALETTE[Math.floor(t.data[o + 5] / 2) % CAR_PALETTE.length]));
      }
      for (const im of meshes) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }

  private addColliders(key: string, d: Float32Array | undefined, body: RAPIER_NS.RigidBody, R: typeof RAPIER_NS, world: RAPIER_NS.World) {
    this.forgetColliders(key);
    if (!d) return;
    const handles: number[] = [];
    addPropColliders(R, world, body, d, (col, i) => {
      const o = i * PROP_STRIDE;
      const kind = d[o] as PropKind;
      handles.push(col.handle);
      this.byCollider.set(col.handle, { kind, name: PROP_NAMES[kind], tileKey: key, index: i, x: d[o + 1], y: d[o + 2], z: d[o + 3], heading: d[o + 4], size: d[o + 5], breakable: BREAKABLE.has(kind) });
    }, (i) => this.removedProps.has(`${key}:${i}`));
    this.collidersByTile.set(key, handles);
  }

  private forgetColliders(key: string) {
    for (const h of this.collidersByTile.get(key) ?? []) this.byCollider.delete(h);
    this.collidersByTile.delete(key);
  }

  /** The prop a collider belongs to, if any. */
  lookup(collider: RAPIER_NS.Collider): PropHit | undefined {
    const hit = this.byCollider.get(collider.handle);
    // Tile bodies come and go with the physics radius; a stale handle no longer resolves to the same collider.
    if (hit && this.world?.getCollider(collider.handle) !== undefined) return hit;
    return undefined;
  }

  /** True for colliders of breakable props. */
  breakable(collider: RAPIER_NS.Collider) { return this.lookup(collider)?.breakable ?? false; }

  /** Takes a prop out of the world (drawing and collider) until props.reset; returns what it was. */
  remove(collider: RAPIER_NS.Collider): PropHit | undefined {
    const hit = this.lookup(collider);
    if (!hit) return undefined;
    this.removedProps.add(`${hit.tileKey}:${hit.index}`);
    this.byCollider.delete(collider.handle);
    this.world?.removeCollider(collider, false);
    this.dirty = true;
    return hit;
  }

  /** Props within `r` metres of (x, z), nearest first. */
  near(x: number, z: number, r: number) {
    const out: { name: string; d: number; size: number; kind: PropKind }[] = [];
    for (const t of this.tiles.values())
      for (let i = 0; i * PROP_STRIDE < t.data.length; i++) {
        const o = i * PROP_STRIDE;
        const d = Math.hypot(t.data[o + 1] - x, t.data[o + 3] - z);
        if (d < r && !this.removedProps.has(`${t.key}:${i}`)) out.push({ kind: t.data[o] as PropKind, name: PROP_NAMES[t.data[o] as PropKind], d, size: t.data[o + 5] });
      }
    return out.sort((a, b) => a.d - b.d);
  }

  /** Counts per kind in all loaded tiles and in the drawn area. */
  counts() {
    const loaded = new Map<PropKind, number>();
    for (const t of this.tiles.values())
      for (let i = 0; i < t.data.length; i += PROP_STRIDE) loaded.set(t.data[i] as PropKind, (loaded.get(t.data[i] as PropKind) ?? 0) + 1);
    return loaded;
  }

  get colliderCount() { return this.byCollider.size; }
  get removedCount() { return this.removedProps.size; }

  /** Brings back every removed prop (colliders return when their tile's physics is rebuilt). */
  reset() {
    this.removedProps.clear();
    this.dirty = true;
  }

  registerCommands(player: () => { x: number; z: number }) {
    registerToggle('props', 'Straßenmöbel und parkende Autos anzeigen', () => this.visible, (v) => (this.visible = v));
    registerValue('props.radius', 'Sichtweite der Straßenmöbel und Parker in Metern', () => this.radius, (v) => { this.radius = v; this.dirty = true; }, [30, 1500]);
    registerCommand({
      name: 'props.toggle', help: `Gruppe ein/aus: ${Object.keys(PROP_GROUPS).join(', ')} oder ein einzelner Typ (${Object.values(PROP_NAMES).join(', ')})`, args: '<gruppe> [on|off]',
      complete: () => [...Object.keys(PROP_GROUPS), ...Object.values(PROP_NAMES)],
      run: ([name, v]) => {
        const kinds = PROP_GROUPS[name ?? ''] ?? (Object.entries(PROP_NAMES).filter(([, n]) => n === name).map(([k]) => Number(k) as PropKind));
        if (!kinds.length) throw new Error(`unbekannte Gruppe "${name ?? ''}"`);
        const on = parseBool(v, kinds.some((k) => this.hiddenKinds.has(k)));
        for (const k of kinds) if (on) this.hiddenKinds.delete(k); else this.hiddenKinds.add(k);
        this.dirty = true;
        return `${name} ${on ? 'an' : 'aus'}`;
      },
    });
    registerCommand({
      name: 'props.count', help: 'Requisiten nach Typ: geladen und gerade gezeichnet',
      run: () => {
        const loaded = this.counts();
        const drawn = (k: PropKind) => k === Prop.parkedCar ? (this.drawn.get('car') ?? 0) + (this.drawn.get('van') ?? 0) : k === Prop.busStop ? (this.drawn.get(k) ?? 0) + (this.drawn.get('busShelter') ?? 0) : this.drawn.get(k) ?? 0;
        const rows = [...loaded.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${PROP_NAMES[k]} ${drawn(k)}/${n}`);
        return `${rows.join(', ') || 'keine Requisiten geladen'} · ${this.colliderCount} Kollider · ${this.removedCount} entfernt`;
      },
    });
    registerCommand({
      name: 'props.near', help: 'Die nächsten Requisiten um das Auto', args: '[radius]',
      run: ([r = '30']) => {
        const p = player();
        const list = this.near(p.x, p.z, parseNum(r, 'Radius', 1, 500)).slice(0, 12);
        return list.length ? list.map((e) => `${e.name} ${e.d.toFixed(1)} m${LINEAR.has(e.kind) ? ` (${e.size.toFixed(1)} m lang)` : ''}`).join('\n') : 'keine Requisiten in der Nähe';
      },
    });
    registerCommand({ name: 'props.reset', help: 'Umgefahrene Requisiten wieder aufstellen', run: () => { const n = this.removedCount; this.reset(); return `${n} Requisiten wieder aufgestellt`; } });
  }
}
