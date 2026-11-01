// Street furniture, parked cars, signs and guard rails for the Unreal tiles, with the same models and the same
// placement as the web game's prop and rail layers (src/world/props.ts rebuild, src/world/rails.ts):
//   - a model library (models.slsu, written once): every model part the web game instances, in Unreal's frame
//     (cm, X = model x, Y = model z, Z = up, like the tiles), with lod0/lod1 and a material tag. The C++ side
//     builds UStaticMeshes from it at runtime (no Interchange import, so no axis guessing) and one HISM per part.
//       props.glb (Blender, props.models glb) where the web game has a model, else propModels.ts; parked cars
//       from the traffic pack (traffic.glb + traffic-cars.glb), paint tinted per instance; sign faces textured
//       from the sign atlas (T_Sls_signs, export-textures.ts)
//   - per tile: instances (part index, position, yaw, scale, tint) and the guard rails as a baked layer
// Records hidden by the web game's default filters stay hidden (none at the defaults).
(globalThis as Record<string, unknown>).self ??= globalThis;
// GLTFLoader decodes embedded images through createImageBitmap; only geometry is needed here.
(globalThis as Record<string, unknown>).createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { TileContent } from '../../src/world/format.ts';
import type { MeshArrays } from '../../src/world/tileBuild.ts';
import { PROP_NAMES, PROP_STRIDE, Prop, type PropKind, linearLength, signTypeOf } from '../../src/world/propKinds.ts';
import { LINEAR } from '../../src/world/propColliders.ts';
import { buildPropGeometries, buildReflectorGeometries, variantKey } from '../../src/world/propModels.ts';
import { type PropSet, propSetFromScene } from '../../src/world/propGlb.ts';
import { type VehicleSet, vehicleSetFromScene, withPack } from '../../src/traffic/vehicleGlb.ts';
import { CAR_PALETTE } from '../../src/traffic/trafficSim.ts';
import { VEHICLE } from '../../src/vehicle/tuning.ts';
import { railGeometry } from '../../src/world/rails.ts';
import { railRuns } from '../../src/world/guardRail.ts';

export interface PropModels { glb: PropSet; vehicles: VehicleSet; procedural: Record<string, THREE.BufferGeometry>; reflectors: Partial<Record<PropKind, THREE.BufferGeometry>> }

async function parseGlb(file: string) {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return new Promise<THREE.Object3D>((ok, fail) => loader.parse(ab, '', (g) => ok(g.scene), fail));
}

export async function loadPropModels(dir = 'public/models'): Promise<PropModels> {
  await MeshoptDecoder.ready;
  const glb = propSetFromScene(await parseGlb(`${dir}/props.glb`));
  const vehicles = withPack(vehicleSetFromScene(await parseGlb(`${dir}/traffic.glb`)), vehicleSetFromScene(await parseGlb(`${dir}/traffic-cars.glb`), false));
  return { glb, vehicles, procedural: buildPropGeometries(), reflectors: buildReflectorGeometries() };
}

/** Material tags of model parts (ASlsWorldSubsystem picks the Unreal material by tag). */
export const PART_MATERIALS = ['vcol', 'paint', 'sign', 'light'] as const;
export type PartMaterial = (typeof PART_MATERIALS)[number];

export interface ModelPart { name: string; mat: PartMaterial; lods: THREE.BufferGeometry[] }

/** Instance stride in v.inst-like float records: X, Y, Z (cm, tile corner), yaw (UE deg), SX, SY, SZ, r, g, b. */
export const PART_STRIDE = 10;

export class PropLibrary {
  readonly parts: ModelPart[] = [];
  private byName = new Map<string, number>();
  readonly M: PropModels;
  /** Every part is registered up front in a fixed order, so all export shards write the same library. */
  constructor(M: PropModels) {
    this.M = M;
    const glb = M.glb.props;
    for (const v of ['car', 'van'] as const)
      for (const x of M.vehicles[v]) {
        this.part(`${x.name}.paint`, 'paint', () => [x.lod0.paint, x.lod1.paint]);
        this.part(`${x.name}.detail`, 'vcol', () => [x.lod0.detail, x.lod1.detail]);
        this.part(`${x.name}.lights`, 'light', () => [x.lod0.lights]);
      }
    for (const n of Object.keys(glb).sort()) this.part(`glb:${n}`, 'vcol', () => [glb[n].lod0, glb[n].lod1]);
    for (const n of Object.keys(M.glb.signs).sort()) this.part(`sign:${n}`, 'sign', () => [M.glb.signs[n]]);
    for (const k of Object.keys(M.procedural).sort()) this.part(`proc:${k}`, 'vcol', () => [M.procedural[k]]);
    for (const k of Object.keys(M.reflectors).sort()) this.part(`refl:${k}`, 'light', () => [M.reflectors[Number(k) as PropKind]!]);
    this.frozen = true;
  }
  private frozen = false;

  part(name: string, mat: PartMaterial, lods: () => THREE.BufferGeometry[]) {
    let k = this.byName.get(name);
    if (k === undefined) {
      if (this.frozen) throw new Error(`Modellteil ${name} fehlt in der Bibliothek`);
      k = this.parts.length; this.parts.push({ name, mat, lods: lods() }); this.byName.set(name, k);
    }
    return k;
  }

  /** Model parts for one prop record, as props.ts draws it with the Blender set loaded. */
  partsFor(kind: PropKind, size: number, i: number): { k: number; tint?: THREE.Color }[] {
    const M = this.M, glb = M.glb.props;
    const g2 = (n: string) => () => [glb[n].lod0, glb[n].lod1];
    if (kind === Prop.parkedCar) {
      const v = size % 2 ? 'van' : 'car';
      const list = M.vehicles[v];
      const variant = list[(Math.floor(size / 2) + i) % Math.max(1, list.length)];
      if (!variant) return [];
      const tint = new THREE.Color().setHex(CAR_PALETTE[Math.floor(size / 2) % CAR_PALETTE.length]);
      return [
        { k: this.part(`${variant.name}.paint`, 'paint', () => [variant.lod0.paint, variant.lod1.paint]), tint },
        { k: this.part(`${variant.name}.detail`, 'vcol', () => [variant.lod0.detail, variant.lod1.detail]) },
        { k: this.part(`${variant.name}.lights`, 'light', () => [variant.lod0.lights]) },
      ];
    }
    const sign = signTypeOf(kind, size);
    if (sign && glb.schild_mast && M.glb.signs[sign])
      return [{ k: this.part('glb:schild_mast', 'vcol', g2('schild_mast')) }, { k: this.part(`sign:${sign}`, 'sign', () => [M.glb.signs[sign]]) }];
    if (kind === Prop.busStop && size && glb.bushaltestelle && glb['bushaltestelle-dach'])
      return [{ k: this.part('glb:bushaltestelle', 'vcol', g2('bushaltestelle')) }, { k: this.part('glb:bushaltestelle-dach', 'vcol', g2('bushaltestelle-dach')) }];
    const name = PROP_NAMES[kind];
    if (kind !== Prop.hedge && !sign && glb[name]) return [{ k: this.part(`glb:${name}`, 'vcol', g2(name)) }];
    const key = kind === Prop.busStop && size ? 'busShelter' : variantKey(kind, size) ?? String(kind);
    const g = M.procedural[key];
    if (!g) return [];
    const out = [{ k: this.part(`proc:${key}`, 'vcol', () => [g]) }];
    const r = M.reflectors[kind];
    if (r) out.push({ k: this.part(`refl:${kind}`, 'light', () => [r]) });
    return out;
  }
}

export interface TileProps { part: Uint16Array; inst: Float32Array; rails?: MeshArrays; counts: Record<string, number> }

/** Prop instances of one tile (tile corner ox, oz in local metres) and its guard rails (local metres). */
export function tileProps(t: TileContent, lib: PropLibrary, ox: number, oz: number): TileProps {
  const part: number[] = [], inst: number[] = [], counts: Record<string, number> = {};
  const d = t.has('props') ? t.f32('props')! : undefined;
  if (d)
    for (let i = 0; i * PROP_STRIDE < d.length; i++) {
      const o = i * PROP_STRIDE;
      const kind = d[o] as PropKind, size = d[o + 5];
      const sc = kind === Prop.parkedCar ? [VEHICLE.scale, VEHICLE.scale, VEHICLE.scale] : [1, 1, LINEAR.has(kind) ? linearLength(size) : 1];
      counts[PROP_NAMES[kind]] = (counts[PROP_NAMES[kind]] ?? 0) + 1;
      for (const { k, tint } of lib.partsFor(kind, size, i)) {
        part.push(k);
        // web scale (x, y, z) → Unreal (X = x, Y = z, Z = y); yaw negated like the tiles' mirrored frame.
        inst.push((d[o + 1] - ox) * 100, (d[o + 3] - oz) * 100, d[o + 2] * 100, -d[o + 4] * 180 / Math.PI, sc[0], sc[2], sc[1], tint?.r ?? 1, tint?.g ?? 1, tint?.b ?? 1);
      }
    }
  let rails: MeshArrays | undefined;
  if (t.has('rails')) {
    const runs = railRuns(t.f32('rails')!.slice());
    if (runs.length) rails = meshOf(railGeometry(runs), RAIL_STEEL);
  }
  return { part: Uint16Array.from(part), inst: Float32Array.from(inst), rails, counts };
}

const RAIL_STEEL = new THREE.Color('#b9bfc4');

/** Plain arrays of a geometry (local metres), colour = vertex colour × `colour`. */
export function meshOf(g: THREE.BufferGeometry, colour?: THREE.Color): MeshArrays {
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), c = g.getAttribute('color'), t = g.getAttribute('uv');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    col[i * 3] = (c ? c.getX(i) : 1) * (colour?.r ?? 1);
    col[i * 3 + 1] = (c ? c.getY(i) : 1) * (colour?.g ?? 1);
    col[i * 3 + 2] = (c ? c.getZ(i) : 1) * (colour?.b ?? 1);
  }
  if (!n) g.computeVertexNormals();
  const nn = g.getAttribute('normal');
  // Attributes may be interleaved (meshopt): read through the accessors.
  const flat = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number) => {
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(i, k);
    return out;
  };
  return {
    pos: flat(p, 3), nrm: flat(nn, 3), col,
    ...(t ? { uv: flat(t, 2) } : {}),
    idx: g.index ? Uint32Array.from(g.index.array as ArrayLike<number>) : Uint32Array.from({ length: p.count }, (_, i) => i),
  };
}

/** The sign atlas PNG embedded in props.glb (for export-textures.ts). */
export function signAtlasPng(file = 'public/models/props.glb'): Buffer {
  const b = readFileSync(file);
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  const img = j.images.find((x: { name?: string }) => x.name === 'signs') ?? j.images[0];
  const view = j.bufferViews[img.bufferView];
  const binStart = 20 + len + 8;
  return b.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength);
}
