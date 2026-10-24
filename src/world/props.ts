import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseBool, parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import { CAR_PALETTE } from '../traffic/trafficSim.ts';
import { VEHICLE_LOD_DISTANCE, type VehicleSet, proceduralVehicleSet } from '../traffic/vehicleGlb.ts';
import { patchPaintedMetal } from '../render/pbr/surfaces.ts';
import { patchMaterial } from '../weather/weatherMaterials.ts';
import { PROP_GROUPS, PROP_NAMES, PROP_STRIDE, Prop, type PropKind, isDetected, signTypeOf } from './propKinds.ts';
import { PROP_LOD_DISTANCE, type PropSet } from './propGlb.ts';
import { LINEAR, addPropColliders } from './propColliders.ts';
import { buildPropGeometries, buildReflectorGeometries } from './propModels.ts';
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

const BREAKABLE = new Set<PropKind>([Prop.busStop, Prop.sign, Prop.stopSign, Prop.giveWay, Prop.cityLimit, Prop.bollard, Prop.bench, Prop.bin, Prop.postBox, Prop.hydrant, Prop.bikeStand, Prop.fence, Prop.hedge, Prop.delineator, Prop.chevronLeft, Prop.chevronRight]);

interface TileProps { key: string; cx: number; cz: number; data: Float32Array }

/** A prop kind, 'busShelter', a parked car model "<car|van><variant>.<lod>", or a Blender model "glb:<name>.<lod>". */
type ModelKey = PropKind | string;

export class PropLayer {
  readonly root = new THREE.Group();
  visible = true;
  /** Props are drawn within this distance of the camera (m). */
  radius: number;
  /** Groups switched off with props.toggle. */
  readonly hiddenKinds = new Set<PropKind>();
  /** Props found on Mapillary photos (props.mapillary). */
  showDetected = true;
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
  /** Instances drawn per kind in the last rebuild. */
  readonly drawnKinds = new Map<PropKind, number>();
  /** Which models are in use (props.models). */
  models: 'glb' | 'procedural' = 'procedural';
  /** The Blender set once loaded. */
  glb?: PropSet;
  /** Model name per kind (PROP_NAMES, or a sign face) available from the Blender set. */
  private glbNames = new Set<string>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  /** Parked cars beyond this distance (m) are drawn as plain boxes without shadows. */
  carBoxDistance: number;

  constructor(opts: { shadows: boolean; radius: number; world: WorldInfo; carBoxes?: number }) {
    this.root.name = 'props';
    this.radius = opts.radius;
    this.carBoxDistance = opts.carBoxes ?? 160;
    this.info = opts.world;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
    // Chipped paint and grime as detail on the vertex colours (render/pbr), then the weather on top.
    patchPaintedMetal(mat, 'props');
    patchMaterial(mat, { wet: 0.5, snow: 0.8 });
    this.propMat = mat;
    const paint = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.45, envMapIntensity: 1.2 });
    patchMaterial(paint, { wet: 0.3, snow: 0.9, upFrom: 0.7 });
    const detail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 });
    this.shadows = opts.shadows;
    this.carMats = { paint, detail };
    // Retroreflectors glow a little at night as if caught by headlights (setNight).
    this.reflectorMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0, emissive: '#fff4d6', emissiveIntensity: 0.05 });
    const reflectors = buildReflectorGeometries();
    for (const [k, g] of Object.entries(buildPropGeometries())) {
      const key = (k === 'busShelter' ? k : Number(k)) as ModelKey;
      const r = typeof key === 'number' ? reflectors[key as PropKind] : undefined;
      this.addModel(key, r ? [[g, mat], [r, this.reflectorMat]] : [[g, mat]]);
    }
    this.setVehicles(proceduralVehicleSet());
  }
  private info: WorldInfo;
  private shadows: boolean;
  /** Reflectors on delineators: glow at night (0..1 from setNight, scaled by reflectorGlow). */
  readonly reflectorMat: THREE.MeshStandardMaterial;
  reflectorGlow = 1.2;
  private night = 0;
  get nightLevel() { return this.night; }
  private propMat: THREE.Material;
  private carMats: { paint: THREE.Material; detail: THREE.Material };
  private carVariants = { car: 1, van: 1 };
  private shownAt = new THREE.Vector3(Infinity, 0, 0);

  private addModel(key: ModelKey, parts: [THREE.BufferGeometry, THREE.Material][], castShadow = this.shadows) {
    const list = parts.map(([g, mt]) => {
      const im = new THREE.InstancedMesh(g, mt, 1);
      im.name = typeof key === 'number' ? PROP_NAMES[key] : key;
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = castShadow;
      im.receiveShadow = this.shadows;
      this.root.add(im);
      return im;
    });
    this.meshes.set(key, list);
  }

  /** Darkness 0 (day) … 1 (night): reflectors light up. */
  setNight(n: number) {
    this.night = n;
    this.reflectorMat.emissiveIntensity = 0.05 + this.reflectorGlow * n * n;
  }

  /** Replaces the geometry of a prop kind (e.g. the Blender hedge). */
  setModel(kind: PropKind, geo: THREE.BufferGeometry) {
    for (const im of this.meshes.get(kind) ?? []) im.geometry = geo;
  }

  /** Street furniture and signs from props.glb (two LODs, switched at PROP_LOD_DISTANCE). */
  setPropSet(set: PropSet) {
    this.glb = set;
    this.dropModels(/^glb:/);
    const mat = this.propMat;
    const add = (name: string, parts: (lod: 0 | 1) => [THREE.BufferGeometry, THREE.Material][]) => {
      for (const lod of [0, 1] as const) this.addModel(`glb:${name}.${lod}`, parts(lod));
      this.glbNames.add(name);
    };
    const lodOf = (name: string, lod: 0 | 1) => (lod ? set.props[name].lod1 : set.props[name].lod0);
    this.glbNames.clear();
    for (const kind of Object.values(Prop)) {
      const name = PROP_NAMES[kind];
      // Parked cars use the traffic models, hedges the vegetation, signs a mast and a face.
      if (kind === Prop.parkedCar || kind === Prop.hedge || signTypeOf(kind, 1) || !set.props[name]) continue;
      add(name, (lod) => [[lodOf(name, lod), mat]]);
    }
    if (set.props.bushaltestelle && set.props['bushaltestelle-dach']) add('busShelter', (lod) => [[lodOf('bushaltestelle', lod), mat], [lodOf('bushaltestelle-dach', lod), mat]]);
    const face = set.signMaterial ?? mat;
    if (set.props.schild_mast) for (const [type, g] of Object.entries(set.signs)) add(`schild-${type}`, (lod) => [[lodOf('schild_mast', lod), mat], [g, face]]);
    this.models = 'glb';
    this.dirty = true;
  }

  /** Back to the procedural props of propModels.ts. */
  setProcedural() {
    this.models = 'procedural';
    this.dirty = true;
  }

  private dropModels(re: RegExp) {
    for (const [key, list] of this.meshes) {
      if (typeof key !== 'string' || !re.test(key)) continue;
      for (const im of list) { this.root.remove(im); im.dispose(); }
      this.meshes.delete(key);
    }
  }

  /** Blender model name for a record, if there is one. */
  private glbName(kind: PropKind, size: number) {
    if (this.models !== 'glb') return undefined;
    const sign = signTypeOf(kind, size);
    const name = sign ? `schild-${sign}` : kind === Prop.busStop && size ? 'busShelter' : PROP_NAMES[kind];
    return this.glbNames.has(name) ? name : undefined;
  }

  /** Parked cars use the traffic models (variants, and the simpler LOD beyond VEHICLE_LOD_DISTANCE). */
  setVehicles(set: VehicleSet) {
    this.dropModels(/^(car|van)/);
    const { paint, detail } = this.carMats;
    for (const kind of ['car', 'van'] as const) {
      const variants = set[kind];
      this.carVariants[kind] = Math.max(1, variants.length);
      variants.forEach((v, n) => {
        this.addModel(`${kind}${n}.0`, [[v.lod0.paint, paint], [v.lod0.detail, detail], [v.lod0.lights, detail]]);
        // The light clusters are lod0 geometry; at a distance the paint and detail are enough.
        this.addModel(`${kind}${n}.1`, [[v.lod1.paint, paint], [v.lod1.detail, detail]]);
      });
      if (variants[0]) this.addModel(`${kind}.box`, [[carBox(variants[0].lod1.paint), paint]], false);
    }
    this.dirty = true;
  }

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
    // Parked cars switch LOD with distance, so also rebuild after the camera has moved a bit.
    if (key === this.shownKey && !this.dirty && this.shownAt.distanceTo(camera.position) < 15) return;
    this.shownKey = key;
    this.dirty = false;
    this.shownAt.copy(camera.position);
    this.rebuild(near, camera.position);
  }

  private rebuild(tiles: TileProps[], cam: THREE.Vector3) {
    const lists = new Map<ModelKey, { t: TileProps; i: number }[]>();
    this.drawn.clear();
    this.drawnKinds.clear();
    for (const t of tiles)
      for (let i = 0; i * PROP_STRIDE < t.data.length; i++) {
        const kind = t.data[i * PROP_STRIDE] as PropKind;
        if (this.hiddenKinds.has(kind) || this.removedProps.has(`${t.key}:${i}`)) continue;
        const size = t.data[i * PROP_STRIDE + 5];
        if (!this.showDetected && isDetected(kind, size)) continue;
        let model: ModelKey = kind === Prop.busStop && size ? 'busShelter' : kind;
        const o = i * PROP_STRIDE;
        const dist = Math.hypot(t.data[o + 1] - cam.x, t.data[o + 3] - cam.z);
        const glb = this.glbName(kind, size);
        if (kind === Prop.parkedCar) {
          const v = size % 2 ? 'van' : 'car';
          model = dist > this.carBoxDistance ? `${v}.box` : `${v}${(Math.floor(size / 2) + i) % this.carVariants[v]}.${dist > VEHICLE_LOD_DISTANCE ? 1 : 0}`;
        } else if (glb) model = `glb:${glb}.${dist > PROP_LOD_DISTANCE ? 1 : 0}`;
        this.drawnKinds.set(kind, (this.drawnKinds.get(kind) ?? 0) + 1);
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
          grown.name = im.name;
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
        if (typeof model === 'string' && /^(car|van)/.test(model)) meshes[0].setColorAt(n, this.c.setHex(CAR_PALETTE[Math.floor(t.data[o + 5] / 2) % CAR_PALETTE.length]));
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
    const out: { name: string; d: number; size: number; kind: PropKind; x: number; z: number }[] = [];
    for (const t of this.tiles.values())
      for (let i = 0; i * PROP_STRIDE < t.data.length; i++) {
        const o = i * PROP_STRIDE;
        const d = Math.hypot(t.data[o + 1] - x, t.data[o + 3] - z);
        if (d < r && !this.removedProps.has(`${t.key}:${i}`)) out.push({ kind: t.data[o] as PropKind, name: PROP_NAMES[t.data[o] as PropKind], d, size: t.data[o + 5], x: t.data[o + 1], z: t.data[o + 3] });
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

  /** Loaded props that come from Mapillary photos. */
  detectedCount() {
    let n = 0;
    for (const t of this.tiles.values())
      for (let i = 0; i < t.data.length; i += PROP_STRIDE) if (isDetected(t.data[i] as PropKind, t.data[i + 5])) n++;
    return n;
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
    registerToggle('props.mapillary', 'Schilder, Bänke und Hydranten aus Mapillary-Fotos zeigen (sonst nur OSM)', () => this.showDetected, (v) => { this.showDetected = v; this.dirty = true; });
    registerValue('props.carbox', 'Parkende Autos ab dieser Entfernung (m) als einfache Kästen ohne Schatten', () => this.carBoxDistance, (v) => { this.carBoxDistance = v; this.dirty = true; }, [0, 1500]);
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
        const drawn = (k: PropKind) => this.drawnKinds.get(k) ?? 0;
        const rows = [...loaded.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${PROP_NAMES[k]} ${drawn(k)}/${n}`);
        return `${rows.join(', ') || 'keine Requisiten geladen'} · davon ${this.detectedCount()} aus Mapillary · ${this.colliderCount} Kollider · ${this.removedCount} entfernt`;
      },
    });
    registerCommand({
      name: 'props.near', help: 'Die nächsten Requisiten um das Auto', args: '[radius]',
      run: ([r = '30']) => {
        const p = player();
        const list = this.near(p.x, p.z, parseNum(r, 'Radius', 1, 500)).slice(0, 12);
        return list.length ? list.map((e) => `${e.name} ${e.d.toFixed(1)} m${LINEAR.has(e.kind) ? ` (${e.size.toFixed(1)} m lang)` : isDetected(e.kind, e.size) ? ' (Mapillary)' : ''}`).join('\n') : 'keine Requisiten in der Nähe';
      },
    });
    registerCommand({
      name: 'props.models', help: 'Straßenmöbel und Schilder: glb (Blender) oder procedural', args: '[glb|procedural]',
      complete: () => ['glb', 'procedural'],
      run: ([m]) => {
        if (m === 'procedural') this.setProcedural();
        else if (m === 'glb') {
          if (!this.glb) throw new Error('props.glb ist nicht geladen');
          this.setPropSet(this.glb);
        } else if (m !== undefined) throw new Error('glb oder procedural');
        return `Modelle: ${this.models} · ${this.glbNames.size} Blender-Modelle`;
      },
    });
    registerCommand({ name: 'props.reset', help: 'Umgefahrene Requisiten wieder aufstellen', run: () => { const n = this.removedCount; this.reset(); return `${n} Requisiten wieder aufgestellt`; } });
  }
}

/** A parked car far away: body and cabin as two boxes (22 triangles) sized from the model's bounds. */
export function carBox(model: THREE.BufferGeometry): THREE.BufferGeometry {
  model.computeBoundingBox();
  const b = model.boundingBox!;
  const w = b.max.x - b.min.x, h = b.max.y - b.min.y, l = b.max.z - b.min.z;
  const cz = (b.min.z + b.max.z) / 2, cx = (b.min.x + b.max.x) / 2;
  const body = new THREE.BoxGeometry(w, h * 0.55, l).translate(cx, b.min.y + h * 0.275, cz);
  const cabin = new THREE.BoxGeometry(w * 0.86, h * 0.45, l * 0.5).translate(cx, b.min.y + h * 0.775, cz - l * 0.04);
  const out = mergeGeometries([body.deleteAttribute('uv'), cabin.deleteAttribute('uv')])!;
  // The bottom faces are never seen.
  const idx = out.index!.array;
  const keep: number[] = [];
  const pos = out.getAttribute('position');
  for (let i = 0; i < idx.length; i += 3) {
    const low = [0, 1, 2].every((k) => pos.getY(idx[i + k]) <= b.min.y + 1e-4);
    if (!low) keep.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  out.setIndex(keep);
  out.computeBoundingSphere();
  return out;
}
