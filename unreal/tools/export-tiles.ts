// Exports the finished web tiles (public/tiles, or a downloaded world-tiles release) into SLSU tiles for the
// Unreal port. Nothing is rebuilt or re-interpreted: the drawn meshes are the arrays the web client uploads
// (tileBuild.ts buildTile), the collision is exactly what the web game hands Rapier (tileColliders.ts, recorded
// as it is created), so roads are as drivable in Unreal as they are in the browser. On top, every 0.5 m cell of
// every carriageway is probed in Rapier like pipeline/surfacecheck.ts does, and the results go into the tile as
// the reference the Unreal surface test (road.parity) must reproduce.
//
//   node unreal/tools/export-tiles.ts [--tiles=public/tiles] [--out=unreal/SlsRacing/WorldData] [--only=ix_iy,…]
//     [--at=x,z (local metres: only the tile there)] [--no-ref] [--limit=<tiles>] [--shard=i/n]
import RAPIER from '@dimforge/rapier3d-compat';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { TileContent, isGzip, tileKey, tileOfLocal, tileOriginLocal, type WorldIndex, type WorldInfo } from '../../src/world/format.ts';
import { buildTile, type MeshArrays } from '../../src/world/tileBuild.ts';
import { addTileColliders, type ColliderKind } from '../../src/world/tileColliders.ts';
import { CAR_GROUPS } from '../../src/vehicle/carPhysics.ts';
import { mergeLevels, SURFACE_LIMITS } from '../../src/world/surfaceScan.ts';
import { placeVegetation, vegLook } from '../../src/world/vegPlacement.ts';
import { species, SPECIES_IDS } from './vegSpecies.ts';
import { bytesOf, packSlsu, shardOf, REF_CELL, REF_N, REF_NONE, type ColliderGroup, type LayerInfo, type Section } from './slsu.ts';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const TILES = arg('tiles', 'public/tiles').replace(/\/?$/, '/');
const OUT = arg('out', 'unreal/SlsRacing/WorldData').replace(/\/?$/, '/');
const REF = !process.argv.includes('--no-ref');
const LIMIT = +arg('limit', 'Infinity');

const index: WorldIndex = JSON.parse(readFileSync(`${TILES}index.json`, 'utf8'));
const W = index.world;
const AT = arg('at', '') ? arg('at', '').split(',').map(Number) : undefined;
const ONLY = new Set(arg('only', '').split(',').filter(Boolean));
if (AT) ONLY.add(tileKey(...tileOfLocal(W, AT[0], AT[1])));

const cache = new Map<string, TileContent | null>();
function tile(k: string): TileContent | null {
  if (!cache.has(k)) {
    const f = `${TILES}t/${k}.bin`;
    const raw = existsSync(f) ? readFileSync(f) : null;
    const buf = raw && isGzip(raw) ? gunzipSync(raw) : raw;
    cache.set(k, buf ? new TileContent(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) : null);
  }
  return cache.get(k)!;
}

// --- frame conversion -------------------------------------------------------------------------------------

/** three local metres → Unreal centimetres relative to the tile corner (ox, oz). */
function toUE(pos: ArrayLike<number>, ox: number, oz: number): Float32Array {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = (pos[i] - ox) * 100;
    out[i + 1] = (pos[i + 2] - oz) * 100;
    out[i + 2] = pos[i + 1] * 100;
  }
  return out;
}
/** Directions (normals): swap y and z. */
function dirToUE(n: ArrayLike<number>): Float32Array {
  const out = new Float32Array(n.length);
  for (let i = 0; i < n.length; i += 3) { out[i] = n[i]; out[i + 1] = n[i + 2]; out[i + 2] = n[i + 1]; }
  return out;
}
const linearToSrgbByte = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)));

// --- recorded colliders -----------------------------------------------------------------------------------

type Quat = { x: number; y: number; z: number; w: number };
type V3 = { x: number; y: number; z: number };
interface Recorded { desc: RAPIER.ColliderDesc; kind: ColliderKind }

const rotate = (q: Quat, x: number, y: number, z: number): [number, number, number] => {
  // v + 2w(q×v) + 2q×(q×v)
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
};
const place = (q: Quat, t: V3, pts: number[]) => {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 3) { const [x, y, z] = rotate(q, pts[i], pts[i + 1], pts[i + 2]); out.push(x + t.x, y + t.y, z + t.z); }
  return out;
};
/** Segments of the cylinders turned into hulls (trees, lamps, garden posts): the inscribed 24-gon. */
const CYL_SEGMENTS = 24;

/** World-space geometry of a recorded collider: a trimesh or one convex point cloud (three local metres). */
function geometry(d: RAPIER.ColliderDesc): { tri?: { pos: number[]; idx: number[] }; hull?: number[] } {
  const s = d.shape as RAPIER.Shape & Record<string, unknown>, q = d.rotation as Quat, t = d.translation as V3;
  switch (s.type) {
    case RAPIER.ShapeType.TriMesh: {
      const m = s as unknown as RAPIER.TriMesh;
      return { tri: { pos: place(q, t, Array.from(m.vertices)), idx: Array.from(m.indices) } };
    }
    case RAPIER.ShapeType.HeightField: {
      // Rapier: centred on the translation, scale.x across columns (x), scale.z across rows (z), heights column-major;
      // triangles as tileBuild.ts gridIndex (the same diagonal).
      const h = s as unknown as RAPIER.Heightfield;
      const rows = h.nrows + 1, cols = h.ncols + 1, sc = h.scale as V3;
      const pos: number[] = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) pos.push(-sc.x / 2 + (c * sc.x) / h.ncols, h.heights[r + c * rows] * sc.y, -sc.z / 2 + (r * sc.z) / h.nrows);
      const idx: number[] = [];
      for (let r = 0; r < rows - 1; r++)
        for (let c = 0; c < cols - 1; c++) {
          const a = r * cols + c, b = a + 1, dd = a + cols, e = dd + 1;
          idx.push(a, dd, b, b, dd, e);
        }
      return { tri: { pos: place(q, t, pos), idx } };
    }
    case RAPIER.ShapeType.Cuboid: {
      const { x, y, z } = (s as unknown as RAPIER.Cuboid).halfExtents;
      const p: number[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) p.push(sx * x, sy * y, sz * z);
      return { hull: place(q, t, p) };
    }
    case RAPIER.ShapeType.Cylinder: {
      const c = s as unknown as RAPIER.Cylinder;
      const p: number[] = [];
      for (let k = 0; k < CYL_SEGMENTS; k++) {
        const a = (k / CYL_SEGMENTS) * Math.PI * 2;
        for (const sy of [-1, 1]) p.push(Math.cos(a) * c.radius, sy * c.halfHeight, Math.sin(a) * c.radius);
      }
      return { hull: place(q, t, p) };
    }
    case RAPIER.ShapeType.ConvexPolyhedron:
      return { hull: place(q, t, Array.from((s as unknown as RAPIER.ConvexPolyhedron).vertices)) };
    default:
      throw new Error(`Kollisionsform ${RAPIER.ShapeType[s.type]} hat noch keinen Export`);
  }
}

const isWheelsOnly = (groups: number) => (groups >>> 16) === 0x0004;

// --- reference probe --------------------------------------------------------------------------------------

/** Drawn road heights at the centres of a REF_CELL grid aligned to the tile corner (like surfaceScan rasterizeMesh). */
function rasterizeRef(pos: Float32Array, idx: Uint32Array | undefined, ox: number, oz: number, out: Map<number, number[]>) {
  const C = REF_CELL, n = idx ? idx.length : pos.length / 3;
  for (let k = 0; k + 2 < n; k += 3) {
    const a = idx ? idx[k] : k, b = idx ? idx[k + 1] : k + 1, c = idx ? idx[k + 2] : k + 2;
    const ax = pos[a * 3] - ox, ay = pos[a * 3 + 1], az = pos[a * 3 + 2] - oz;
    const bx = pos[b * 3] - ox, by = pos[b * 3 + 1], bz = pos[b * 3 + 2] - oz;
    const cx = pos[c * 3] - ox, cy = pos[c * 3 + 1], cz = pos[c * 3 + 2] - oz;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / C - 0.5)), i1 = Math.min(REF_N - 1, Math.ceil(Math.max(ax, bx, cx) / C - 0.5));
    const j0 = Math.max(0, Math.floor(Math.min(az, bz, cz) / C - 0.5)), j1 = Math.min(REF_N - 1, Math.ceil(Math.max(az, bz, cz) / C - 0.5));
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const x = (i + 0.5) * C, z = (j + 0.5) * C;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const key = j * REF_N + i;
        let ys = out.get(key);
        if (!ys) out.set(key, (ys = []));
        ys.push(l1 * ay + l2 * by + l3 * cy);
      }
  }
}

/** Wheel and chassis ray per drawn level, exactly like surfaceScan.ts probeCells. */
function probeRef(world: RAPIER.World, levels: Map<number, number[]>, ox: number, oz: number) {
  const L = SURFACE_LIMITS, C = REF_CELL;
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const keys: number[] = [], yd: number[] = [], yw: number[] = [], yc: number[] = [];
  const mm = (y: number | null, d: number) => (y === null ? REF_NONE : Math.max(-32767, Math.min(32767, Math.round((y - d) * 1000))));
  for (const key of [...levels.keys()].sort((a, b) => a - b)) {
    const cx = ox + ((key % REF_N) + 0.5) * C, cz = oz + (Math.floor(key / REF_N) + 0.5) * C;
    const x = cx + 0.013, z = cz + 0.007;
    for (const d of mergeLevels(levels.get(key)!)) {
      ray.origin = { x, y: d + L.above, z };
      let hw = world.castRay(ray, L.above + L.below, true);
      if (!hw || hw.timeOfImpact > L.above + L.dip) {
        ray.origin = { x: cx, y: d + L.above, z: cz };
        const h2 = world.castRay(ray, L.above + L.below, true);
        if (h2 && (!hw || h2.timeOfImpact < hw.timeOfImpact)) hw = h2;
        ray.origin = { x, y: d + L.above, z };
      }
      const hc = world.castRay(ray, L.above + L.below, true, undefined, CAR_GROUPS);
      keys.push(key); yd.push(d);
      yw.push(mm(hw ? d + L.above - hw.timeOfImpact : null, d));
      yc.push(mm(hc ? d + L.above - hc.timeOfImpact : null, d));
    }
  }
  return { keys: Uint32Array.from(keys), yd: Float32Array.from(yd), yw: Int16Array.from(yw), yc: Int16Array.from(yc) };
}

// --- one tile ---------------------------------------------------------------------------------------------

function meshSections(name: string, m: MeshArrays, ox: number, oz: number, out: Section[]): LayerInfo {
  const p = `m.${name}`;
  out.push({ name: `${p}.pos`, type: 'f32', bytes: bytesOf(toUE(m.pos, ox, oz)) });
  out.push({ name: `${p}.nrm`, type: 'f32', bytes: bytesOf(dirToUE(m.nrm)) });
  if (m.uv) out.push({ name: `${p}.uv`, type: 'f32', bytes: bytesOf(m.uv) });
  if (m.col) {
    const n = m.col.length / 3, c = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { for (let k = 0; k < 3; k++) c[i * 4 + k] = linearToSrgbByte(m.col[i * 3 + k]); c[i * 4 + 3] = 255; }
    out.push({ name: `${p}.col`, type: 'u8', bytes: c });
  }
  // Non-indexed meshes (tunnel tubes) get a plain index list, so every layer reads the same way.
  const idx = m.idx ?? Uint32Array.from({ length: m.pos.length / 3 }, (_, i) => i);
  out.push({ name: `${p}.idx`, type: 'u32', bytes: bytesOf(idx) });
  const splat = !!m.attrs?.splatA;
  if (m.attrs) for (const [k, a] of Object.entries(m.attrs)) out.push({ name: `${p}.${k}`, type: 'u8', bytes: a.array });
  return { name, verts: m.pos.length / 3, tris: idx.length / 3, uv: !!m.uv, col: !!m.col, splat };
}

/**
 * Trees and bushes as the web game plants them (vegPlacement.ts with the generated species' sizes): v.sp = species
 * index (SPECIES order, see index.json vegetation), v.inst = 9 floats per instance: X, Y, Z (cm from the tile corner),
 * yaw (Unreal degrees), crown scale, height scale, colour factors r, g, b.
 */
function vegetationSections(t: TileContent, ox: number, oz: number, out: Section[]) {
  if (!t.has('ground')) return 0;
  const geo = species();
  const placed = placeVegetation({
    ox, oz, ground: t.u8('ground')!,
    trees: t.has('trees') ? t.f32('trees') : undefined,
    kinds: t.has('treeKinds') ? t.u8('treeKinds') : undefined,
    crowns: t.has('treeCrowns') ? t.u8('treeCrowns') : undefined,
    bushes: t.has('bushes') ? t.f32('bushes') : undefined,
  }, geo, true);
  const sp: number[] = [], inst: number[] = [];
  for (const [id, recs] of placed) {
    const k = SPECIES_IDS.indexOf(id);
    for (const r of recs) {
      const look = vegLook(r);
      sp.push(k);
      // Web yaw turns about +y in a right-handed frame; Unreal's frame is mirrored (y/z swapped): negate.
      inst.push((r[0] - ox) * 100, (r[2] - oz) * 100, r[1] * 100, -look.yaw * 180 / Math.PI, r[3], r[4], ...look.col);
    }
  }
  if (!sp.length) return 0;
  out.push({ name: 'v.sp', type: 'u8', bytes: bytesOf(Uint8Array.from(sp)) });
  out.push({ name: 'v.inst', type: 'f32', bytes: bytesOf(Float32Array.from(inst)) });
  return sp.length;
}

function exportTile(t: TileContent, w: WorldInfo, recorded: Recorded[], ref?: ReturnType<typeof probeRef>) {
  const [ox, oz] = tileOriginLocal(w, t.ix, t.iy);
  const sections: Section[] = [];
  const built = buildTile(t, w);
  const layers: LayerInfo[] = [meshSections('terrain', built.terrain, ox, oz, sections)];
  if (built.water) layers.push(meshSections('water', built.water, ox, oz, sections));
  for (const [name, m] of Object.entries(built.meshes)) layers.push(meshSections(name, m, ox, oz, sections));

  // One group per kind, wheels-only flag and friction; trimeshes merged per group, hulls listed.
  const groups: ColliderGroup[] = [];
  const triOf = new Map<number, { pos: number[]; idx: number[] }>();
  const hullPts: number[] = [], hullCnt: number[] = [], hullMeta: number[] = [];
  for (const { desc, kind } of recorded) {
    const geo = geometry(desc);
    const wheelsOnly = isWheelsOnly(desc.collisionGroups);
    const shape = geo.tri ? 'tri' : 'hull';
    const friction = Math.round(desc.friction * 1000) / 1000;
    let g = groups.findIndex((x) => x.kind === kind && x.wheelsOnly === wheelsOnly && x.friction === friction && x.shape === shape);
    if (g < 0) { g = groups.length; groups.push({ kind, wheelsOnly, friction, shape }); }
    if (geo.tri) {
      let m = triOf.get(g);
      if (!m) triOf.set(g, (m = { pos: [], idx: [] }));
      const base = m.pos.length / 3;
      for (const v of geo.tri.pos) m.pos.push(v);
      for (const i of geo.tri.idx) m.idx.push(base + i);
    } else {
      const pts = toUE(geo.hull!, ox, oz);
      for (const v of pts) hullPts.push(v);
      hullCnt.push(pts.length / 3);
      hullMeta.push(g);
      groups[g].hulls = (groups[g].hulls ?? 0) + 1;
    }
  }
  for (const [g, m] of triOf) {
    sections.push({ name: `c.${g}.pos`, type: 'f32', bytes: bytesOf(toUE(m.pos, ox, oz)) });
    sections.push({ name: `c.${g}.idx`, type: 'u32', bytes: bytesOf(Uint32Array.from(m.idx)) });
    groups[g].tris = m.idx.length / 3;
  }
  if (hullCnt.length) {
    sections.push({ name: 'h.pos', type: 'f32', bytes: bytesOf(Float32Array.from(hullPts)) });
    sections.push({ name: 'h.cnt', type: 'u32', bytes: bytesOf(Uint32Array.from(hullCnt)) });
    sections.push({ name: 'h.meta', type: 'f32', bytes: bytesOf(Float32Array.from(hullMeta)) });
  }
  if (ref && ref.keys.length) {
    sections.push({ name: 'r.key', type: 'u32', bytes: bytesOf(ref.keys) });
    sections.push({ name: 'r.yd', type: 'f32', bytes: bytesOf(ref.yd) });
    sections.push({ name: 'r.yw', type: 'u8', bytes: bytesOf(ref.yw) });
    sections.push({ name: 'r.yc', type: 'u8', bytes: bytesOf(ref.yc) });
  }
  const veg = vegetationSections(t, ox, oz, sections);
  const file = packSlsu({
    ix: t.ix, iy: t.iy, v: 1, veg, originLocal: [ox, oz], originUE: [ox * 100, oz * 100], layers, colliders: groups,
    ...(ref ? { ref: { cell: REF_CELL, n: REF_N, count: ref.keys.length } } : {}),
  }, sections);
  writeFileSync(`${OUT}t/${tileKey(t.ix, t.iy)}.slsu`, gzipSync(file, { level: 6 }));
  return { bytes: file.byteLength, layers: layers.length, groups: groups.length, ref: ref?.keys.length ?? 0 };
}

// --- main -------------------------------------------------------------------------------------------------

async function main() {
  await RAPIER.init();
  const t0 = Date.now();
  mkdirSync(`${OUT}t`, { recursive: true });
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const bodies = new Map<string, RAPIER.RigidBody>();
  const records = new Map<string, Recorded[]>();

  // Records every collider the web game creates for a tile (desc + kind), while creating it for the probe.
  function addBody(k: string, t: TileContent) {
    const rec: Recorded[] = [];
    const pending = new Map<number, RAPIER.ColliderDesc>();
    const spy = new Proxy(world, {
      get(target, p) {
        if (p === 'createCollider') return (d: RAPIER.ColliderDesc, b: RAPIER.RigidBody) => { const c = target.createCollider(d, b); pending.set(c.handle, d); return c; };
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const body = addTileColliders(RAPIER, spy, t, W, (c, kind) => { const d = pending.get(c.handle); if (d) rec.push({ desc: d, kind }); pending.delete(c.handle); });
    if (pending.size) throw new Error(`${pending.size} Collider in ${k} ohne Art`);
    bodies.set(k, body);
    records.set(k, rec);
  }

  const keys = index.tiles.map(([x, y]) => [x, y] as [number, number]).sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .filter(([x, y]) => !ONLY.size || ONLY.has(tileKey(x, y)));
  // A shard also writes the tile rows just beyond its own, so its verify job has every neighbour's colliders.
  const own = shardOf(keys, arg('shard', ''));
  const lo = Math.min(...own.map((k) => k[1])) - 1, hi = Math.max(...own.map((k) => k[1])) + 1;
  const work = (arg('shard', '') ? keys.filter(([, y]) => y >= lo && y <= hi) : own).slice(0, LIMIT);
  let bytes = 0, refCells = 0, n = 0;
  for (const [ix, iy] of work) {
    const k = tileKey(ix, iy);
    const self = tile(k);
    if (!self) continue;
    for (const [bk, b] of bodies) {
      const [bx, by] = bk.split('_').map(Number);
      if (Math.abs(by - iy) > 1 || Math.abs(bx - ix) > 1) { world.removeRigidBody(b); bodies.delete(bk); records.delete(bk); }
    }
    const near: TileContent[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const nk = tileKey(ix + dx, iy + dy);
        const t = (REF || nk === k) ? tile(nk) : null;
        if (!t) continue;
        near.push(t);
        if (!bodies.has(nk)) addBody(nk, t);
      }
    for (const ck of [...cache.keys()]) if (+ck.split('_')[1] > iy + 1) cache.delete(ck);
    world.step();
    let ref: ReturnType<typeof probeRef> | undefined;
    if (REF) {
      const [ox, oz] = tileOriginLocal(W, ix, iy);
      const levels = new Map<number, number[]>();
      for (const t of near) { const pos = t.f32('roads.pos'); if (pos) rasterizeRef(pos, t.u32('roads.idx'), ox, oz, levels); }
      ref = probeRef(world, levels, ox, oz);
    }
    const r = exportTile(self, W, records.get(k)!, ref);
    bytes += r.bytes; refCells += r.ref; n++;
    if (n % 100 === 0) console.log(`  ${n}/${work.length} Kacheln, ${(bytes / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  // World manifest and the shared JSON layers (road graph, signs, events …) as they are.
  writeFileSync(`${OUT}index.json`, JSON.stringify({ ...index, format: 'slsu', slsu: { version: 1, refCell: REF_CELL, refN: REF_N, tiles: index.tiles.length }, vegetation: { species: SPECIES_IDS } }));
  for (const f of readdirSync(TILES)) if (f.endsWith('.json') && f !== 'index.json') copyFileSync(`${TILES}${f}`, `${OUT}${f}`);
  console.log(`Unreal-Export: ${n} Kacheln, ${(bytes / 1e6).toFixed(0)} MB unkomprimiert, ${refCells} Referenzzellen in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${OUT}`);
}

main();
