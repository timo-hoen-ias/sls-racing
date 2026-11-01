// Proves the SLSU export is lossless for driving: rebuilds the collision world from the SLSU files alone (as the
// Unreal side does: trimeshes per group, convex hulls, wheels-only roads), probes every reference cell with the
// same wheel and chassis rays and compares with the heights the web game's own colliders gave (r.* sections).
// Runs in Rapier, so it checks the export, not Unreal's physics: road.parity in the game checks that part.
//
//   node unreal/tools/verify-export.ts [--data=unreal/SlsRacing/WorldData] [--only=ix_iy,…] [--limit=<tiles>] [--tol=0.005] [--max=<allowed mismatches>] [--shard=i/n]
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tileKey } from '../../src/world/format.ts';
import { CAR_GROUPS, ROAD_GROUPS } from '../../src/vehicle/carPhysics.ts';
import { SURFACE_LIMITS } from '../../src/world/surfaceScan.ts';
import { readSlsu, REF_NONE, shardOf } from './slsu.ts';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const DATA = arg('data', 'unreal/SlsRacing/WorldData').replace(/\/?$/, '/');
const TOL = +arg('tol', '0.005');
const MAX = +arg('max', 'Infinity');
const LIMIT = +arg('limit', 'Infinity');
const ONLY = new Set(arg('only', '').split(',').filter(Boolean));

const index = JSON.parse(readFileSync(`${DATA}index.json`, 'utf8'));
type Slsu = ReturnType<typeof readSlsu>;
const cache = new Map<string, Slsu | null>();
function load(k: string): Slsu | null {
  if (!cache.has(k)) {
    let s: Slsu | null = null;
    try { s = readSlsu(gunzipSync(readFileSync(`${DATA}t/${k}.slsu`))); } catch { s = null; }
    cache.set(k, s);
  }
  return cache.get(k)!;
}

/** Unreal centimetres relative to the tile corner → three local metres. */
function fromUE(p: Float32Array, ox: number, oz: number): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) { out[i] = p[i] / 100 + ox; out[i + 1] = p[i + 2] / 100; out[i + 2] = p[i + 1] / 100 + oz; }
  return out;
}

function addColliders(world: RAPIER.World, s: Slsu): RAPIER.RigidBody {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const [ox, oz] = s.header.originLocal;
  s.header.colliders.forEach((g, n) => {
    if (g.shape !== 'tri') return;
    const d = RAPIER.ColliderDesc.trimesh(fromUE(s.f32(`c.${n}.pos`)!, ox, oz), s.u32(`c.${n}.idx`)!).setFriction(g.friction);
    if (g.wheelsOnly) d.setCollisionGroups(ROAD_GROUPS);
    world.createCollider(d, body);
  });
  const pts = s.f32('h.pos'), cnt = s.u32('h.cnt'), meta = s.f32('h.meta');
  if (pts && cnt && meta) {
    let o = 0;
    for (let h = 0; h < cnt.length; h++) {
      const p = fromUE(pts.subarray(o * 3, (o + cnt[h]) * 3), ox, oz);
      o += cnt[h];
      const g = s.header.colliders[meta[h]];
      const d = RAPIER.ColliderDesc.convexHull(p);
      if (!d) continue;
      if (g.wheelsOnly) d.setCollisionGroups(ROAD_GROUPS);
      world.createCollider(d.setFriction(g.friction), body);
    }
  }
  return body;
}

async function main() {
  await RAPIER.init();
  const t0 = Date.now();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const bodies = new Map<string, RAPIER.RigidBody>();
  const L = SURFACE_LIMITS;
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  let cells = 0, bad = 0, worst = 0;
  const examples: string[] = [];
  const keys = (index.tiles as [number, number][]).slice().sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .filter(([x, y]) => !ONLY.size || ONLY.has(tileKey(x, y)));
  const work = shardOf(keys, arg('shard', '')).slice(0, LIMIT);
  for (const [ix, iy] of work) {
    const s = load(tileKey(ix, iy));
    if (!s) throw new Error(`Kachel ${tileKey(ix, iy)} fehlt im Export`);
    for (const [bk, b] of bodies) {
      const [bx, by] = bk.split('_').map(Number);
      if (Math.abs(by - iy) > 1 || Math.abs(bx - ix) > 1) { world.removeRigidBody(b); bodies.delete(bk); }
    }
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const nk = tileKey(ix + dx, iy + dy), t = load(nk);
        if (t && !bodies.has(nk)) bodies.set(nk, addColliders(world, t));
      }
    for (const ck of [...cache.keys()]) if (+ck.split('_')[1] > iy + 1) cache.delete(ck);
    world.step();
    const rk = s.u32('r.key'), yd = s.f32('r.yd'), yw = s.i16('r.yw'), yc = s.i16('r.yc');
    if (!rk || !yd || !yw || !yc) continue;
    const [ox, oz] = s.header.originLocal, C = s.header.ref!.cell, N = s.header.ref!.n;
    for (let i = 0; i < rk.length; i++) {
      const cx = ox + ((rk[i] % N) + 0.5) * C, cz = oz + (Math.floor(rk[i] / N) + 0.5) * C;
      const x = cx + 0.013, z = cz + 0.007, d = yd[i];
      ray.origin = { x, y: d + L.above, z };
      let hw = world.castRay(ray, L.above + L.below, true);
      if (!hw || hw.timeOfImpact > L.above + L.dip) {
        ray.origin = { x: cx, y: d + L.above, z: cz };
        const h2 = world.castRay(ray, L.above + L.below, true);
        if (h2 && (!hw || h2.timeOfImpact < hw.timeOfImpact)) hw = h2;
        ray.origin = { x, y: d + L.above, z };
      }
      const hc = world.castRay(ray, L.above + L.below, true, undefined, CAR_GROUPS);
      const got = [hw ? L.above - hw.timeOfImpact : null, hc ? L.above - hc.timeOfImpact : null];
      const want = [yw[i] === REF_NONE ? null : yw[i] / 1000, yc[i] === REF_NONE ? null : yc[i] / 1000];
      cells++;
      for (let k = 0; k < 2; k++) {
        const a = got[k], b = want[k];
        const diff = a === null && b === null ? 0 : a === null || b === null ? Infinity : Math.abs(a - b);
        if (diff > TOL) {
          bad++;
          if (Number.isFinite(diff)) worst = Math.max(worst, diff);
          if (examples.length < 15) examples.push(`  ${k ? 'Chassis' : 'Rad'} bei x ${cx.toFixed(2)} z ${cz.toFixed(2)} (Kachel ${tileKey(ix, iy)}): Export ${a?.toFixed(3) ?? 'nichts'}, Web ${b?.toFixed(3) ?? 'nichts'}`);
        }
      }
    }
  }
  console.log(`Export-Prüfung: ${work.length} Kacheln, ${cells} Straßenzellen, ${bad} Abweichungen über ${TOL * 1000} mm (größte endliche ${(worst * 1000).toFixed(1)} mm) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const e of examples) console.log(e);
  if (bad > MAX) { console.log(`FAIL: ${bad} Abweichungen (erlaubt ${MAX})`); process.exit(1); }
}

main();
