// Drives an autopilot car along real roads through the built tiles and reports where it gets stuck.
// Uses the same physics and the same colliders as the game, without rendering.
//   node pipeline/drivetest.ts [region] [--routes=60] [--seed=1] [--way=<osm id>]
import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync } from 'node:fs';
import {
  TERRAIN_N, TERRAIN_STEP, Ground, decodeF32, decodeU32, decodeU8, tileKey, tileOfLocal, tileOriginLocal, utmToLocal,
  type TileData, type WorldIndex,
} from '../src/world/format.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { readOsm } from './lib/osm.ts';
import { loadWorld, paths } from './lib/region.ts';
import { densify, isDrivable, ROAD_CLASSES } from './lib/roads.ts';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const region = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'saarlouis';
const ROUTES = +arg('routes', '60');
const SEED = +arg('seed', '1');
const ONLY = arg('way', '');
const TRACE = process.argv.includes('--trace');
const STEP = 1 / 60;

const index: WorldIndex = JSON.parse(readFileSync(`${paths.out}index.json`, 'utf8'));
const W = index.world;
const tileCache = new Map<string, TileData | null>();
function tile(k: string): TileData | null {
  if (!tileCache.has(k)) {
    const f = `${paths.out}t/${k}.json`;
    tileCache.set(k, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
  }
  return tileCache.get(k)!;
}

/** What each collider is, for failure reports. */
const kinds = new Map<number, string>();

/** Same colliders as WorldStreamer.addTile. */
function addColliders(world: RAPIER.World, t: TileData) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const [ox, oz] = tileOriginLocal(W, t.ix, t.iy);
  const h = decodeF32(t.terrain);
  const g = decodeU8(t.ground);
  const N = TERRAIN_N;
  const pos = new Float32Array(N * N * 3);
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      pos.set([ox + c * TERRAIN_STEP, h[i] - (g[i] === Ground.water ? 0.6 : 0), oz + r * TERRAIN_STEP], i * 3);
    }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let k = 0;
  for (let r = 0; r < N - 1; r++)
    for (let c = 0; c < N - 1; c++) {
      const a = r * N + c, b = a + 1, d = a + N, e = d + 1;
      idx.set([a, d, b, b, d, e], k);
      k += 6;
    }
  kinds.set(world.createCollider(RAPIER.ColliderDesc.trimesh(pos, idx).setFriction(0.9), body).handle, 'terrain');
  for (const [kind, m] of [['building', t.buildings], ['bridge', t.collide]] as const) {
    if (m?.idx) kinds.set(world.createCollider(RAPIER.ColliderDesc.trimesh(decodeF32(m.pos), decodeU32(m.idx)).setFriction(0.6), body).handle, kind);
  }
  if (t.trees) {
    const tr = decodeF32(t.trees);
    for (let i = 0; i < tr.length; i += 4) {
      const [x, y, z, sc] = [tr[i], tr[i + 1], tr[i + 2], tr[i + 3]];
      kinds.set(world.createCollider(RAPIER.ColliderDesc.cylinder(1.6 * sc, 0.3 * sc).setTranslation(x, y + 1.4 * sc, z), body).handle, 'tree');
    }
  }
}

/** Ground height under (x, z), interpolated on the same triangles as the terrain mesh. */
function groundAt(x: number, z: number): number | undefined {
  const [ix, iy] = tileOfLocal(W, x, z);
  const t = tile(tileKey(ix, iy));
  if (!t) return undefined;
  const [ox, oz] = tileOriginLocal(W, ix, iy);
  const h = decodeF32(t.terrain);
  const fx = (x - ox) / TERRAIN_STEP, fz = (z - oz) / TERRAIN_STEP;
  const c = Math.min(TERRAIN_N - 2, Math.floor(fx)), r = Math.min(TERRAIN_N - 2, Math.floor(fz));
  const u = fx - c, v = fz - r;
  const a = h[r * TERRAIN_N + c], b = h[r * TERRAIN_N + c + 1], d = h[(r + 1) * TERRAIN_N + c], e = h[(r + 1) * TERRAIN_N + c + 1];
  // Triangles (a, d, b) and (b, d, e).
  return u + v <= 1 ? a + (b - a) * u + (d - a) * v : e + (d - e) * (1 - u) + (b - e) * (1 - v);
}

interface Result { ok: boolean; why?: string; at?: [number, number]; dist: number; len: number }

function driveRoute(id: number, name: string, pts: [number, number][]): Result {
  const route = densify(pts.map(([e, n]) => utmToLocal(W, e, n)), 4);
  const len = route.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - route[i - 1][0], p[1] - route[i - 1][1]) : 0), 0);
  // Load every tile within 64 m of the route.
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  const keys = new Set<string>();
  for (const [x, z] of route)
    for (const dx of [-64, 0, 64]) for (const dz of [-64, 0, 64]) keys.add(tileKey(...tileOfLocal(W, x + dx, z + dz)));
  for (const k of keys) { const t = tile(k); if (t) addColliders(world, t); }

  const [sx, sz] = route[0];
  const heading0 = Math.atan2(route[1][0] - sx, -(route[1][1] - sz));
  const car = new CarPhysics(RAPIER, world, { x: sx, y: (groundAt(sx, sz) ?? 0) + 1.2, z: sz }, heading0);
  let target = 1;
  let stuck = 0;
  let travelled = 0;
  const maxSteps = (len / 6 + 20) * 60;
  for (let step = 0; step < maxSteps; step++) {
    const p = car.body.translation();
    // Pure pursuit: nearest route point, then aim a little ahead of it.
    let best = target, bd = Infinity;
    for (let i = Math.max(0, target - 2); i < Math.min(route.length, target + 8); i++) {
      const d = Math.hypot(route[i][0] - p.x, route[i][1] - p.z);
      if (d < bd) { bd = d; best = i; }
    }
    target = best;
    const look = Math.min(route.length - 1, target + Math.max(1, Math.round((3 + Math.abs(car.speed) * 0.35) / 4)));
    const [tx, tz] = route[look];
    const want = Math.atan2(tx - p.x, -(tz - p.z));
    let d = want - car.heading();
    d = Math.atan2(Math.sin(d), Math.cos(d));
    // Slow down for bends in the next 40 m.
    let bend = 0;
    for (let i = target + 1; i < Math.min(route.length - 1, target + 10); i++) {
      const a1 = Math.atan2(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
      const a2 = Math.atan2(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]);
      bend = Math.max(bend, Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1))));
    }
    const speedGoal = bend > 0.5 ? 5 : bend > 0.25 ? 8 : 14;
    const input = {
      throttle: car.speed < speedGoal ? 1 : 0, brake: car.speed > speedGoal + 2 ? 1 : 0,
      steer: Math.max(-1, Math.min(1, d * 2.5)), nitro: false, handbrake: false,
    };
    car.update(input, STEP);
    world.step();
    const q = car.body.translation();
    travelled = Math.max(travelled, target * 4);
    if (Math.hypot(route[route.length - 1][0] - q.x, route[route.length - 1][1] - q.z) < 10) return { ok: true, dist: len, len };
    stuck = Math.abs(car.speed) < 1 ? stuck + 1 : 0;
    const r = car.body.rotation();
    const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
    const g = groundAt(q.x, q.z);
    if (TRACE && step % 15 === 0) console.log(`t=${(step * STEP).toFixed(2)} pos=${q.x.toFixed(1)},${q.y.toFixed(2)},${q.z.toFixed(1)} ground=${g?.toFixed(2)} v=${car.speed.toFixed(1)} up=${upY.toFixed(2)}`);
    const fail = (why: string): Result => ({ ok: false, why, at: [q.x, q.z], dist: travelled, len });
    if (stuck > 180) {
      const hit = new Set<string>();
      world.contactPairsWith(car.body.collider(0), (o) => { hit.add(kinds.get(o.handle) ?? '?'); });
      return fail(`stuck${hit.size ? ` on ${[...hit].join('+')}` : ''}`);
    }
    if (upY < 0.3) return fail('flipped');
    if (g !== undefined && q.y < g - 2) return fail('fell through');
    if (g === undefined) return fail('left the world');
    let off = Infinity;
    for (let i = Math.max(0, target - 3); i < Math.min(route.length, target + 3); i++) off = Math.min(off, Math.hypot(route[i][0] - q.x, route[i][1] - q.z));
    if (off > 25) return fail('off route');
  }
  return { ok: false, why: 'timeout', at: [car.body.translation().x, car.body.translation().z], dist: travelled, len };
}

async function main() {
  await RAPIER.init();
  const { project } = loadWorld();
  const osm = readOsm(JSON.parse(readFileSync(`${paths.raw(region)}osm.json`, 'utf8')), project);
  const T = W.tileSize;
  const inWorld = new Set(index.tiles.map(([x, y]) => tileKey(x, y)));
  let candidates = osm.ways.filter((w) =>
    isDrivable(w.tags) && ROAD_CLASSES[w.tags.highway].rank >= 2 && w.tags.highway !== 'pedestrian' &&
    w.pts.every(([e, n]) => inWorld.has(tileKey(Math.floor(e / T), Math.floor(n / T)))));
  if (ONLY) candidates = candidates.filter((w) => String(w.id) === ONLY);
  // Long enough to mean something; deterministic sample.
  const length = (pts: [number, number][]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  let s = SEED;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pool = candidates.filter((w) => ONLY || length(w.pts) > 120).map((w) => ({ w, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, ROUTES);

  let ok = 0;
  const fails: string[] = [];
  for (const { w } of pool) {
    const res = driveRoute(w.id, w.tags.name ?? '', w.pts);
    if (res.ok) ok++;
    else {
      const [e, n] = [res.at![0] + W.originE, -res.at![1] + W.originN];
      fails.push(`  way ${w.id} ${w.tags.highway} "${w.tags.name ?? ''}": ${res.why} after ${res.dist.toFixed(0)}/${res.len.toFixed(0)} m at UTM ${e.toFixed(0)} ${n.toFixed(0)}`);
    }
  }
  console.log(`Drive test: ${ok}/${pool.length} routes completed`);
  for (const f of fails) console.log(f);
  if (ok < pool.length * 0.9) process.exitCode = 1;
}

main();
