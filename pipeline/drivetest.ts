// Drives an autopilot car along real roads through the built tiles and reports where it gets stuck.
// Uses the same physics and the same colliders as the game, without rendering.
//   node pipeline/drivetest.ts [region] [--routes=60] [--seed=1] [--way=<osm id>] [--pace=1] [--trace]
// Autopilot tuning (to tell its mistakes from the car's): --lat=<m/s²> cornering grip it plans with,
// --brake=<m/s²> deceleration it plans with, --narrow=<factor> speed on narrow streets.
import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  TERRAIN_N, TERRAIN_STEP, TileContent, isGzip, tileKey, tileOfLocal, tileOriginLocal, utmToLocal, type WorldIndex,
} from '../src/world/format.ts';
import { addTileColliders } from '../src/world/tileColliders.ts';
import { addPropColliders } from '../src/world/propColliders.ts';
import { addFuelColliders } from '../src/world/fuelColliders.ts';
import { addSignColliders } from '../src/world/signColliders.ts';
import { GUIDE_SIGN_NAMES, type SignsFile } from '../src/world/signSpec.ts';
import { PROP_NAMES, PROP_STRIDE, type PropKind } from '../src/world/propKinds.ts';
import { terrainHeights } from '../src/world/tileBuild.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { scaleCar, VEHICLE } from '../src/vehicle/tuning.ts';
import { readOsm } from './lib/osm.ts';
import { applyMeasuredWidths, loadAlkisRoads } from './lib/alkis.ts';
import { roadHeights, terrainHeight } from './lib/heights.ts';
import { separateCarriageways } from './lib/carriageways.ts';
import { matchRampHeights, planRamps } from './lib/ramps.ts';
import { loadRegion, loadWorld, paths, unproject } from './lib/region.ts';
import { densify, isMotorRoad, roadSurfaceHeights, roadWidth, ROAD_CLASSES } from './lib/roads.ts';

// The test car at the game's vehicle scale (smaller wheels meet the same road steps).
scaleCar(VEHICLE.scale);

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const region = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'saarlouis';
const ROUTES = +arg('routes', '60');
const SEED = +arg('seed', '1');
const ONLY = arg('way', '');
const TRACE = process.argv.includes('--trace');
/** Speed factor on the autopilot's target speeds (1 = cautious 18–50 km/h). */
const PACE = +arg('pace', '1');
const STEP = 1 / 60;
/**
 * The autopilot plans its speed like a driver: cornering speed from the radius of each bend ahead
 * (v = √(lat·R)), braked down to in time (v² = v_c² + 2·brake·d). lat grows with the pace up to 1.2 g,
 * below the car's ~1.4 g, so it does not plan right at the limit.
 */
const LAT = Math.min(12, +arg('lat', '5') * PACE * PACE);
const BRAKE = +arg('brake', '6');
/** Speed factor on narrow streets (play streets, alleys, under 5 m): little room to correct a slide. */
const NARROW = +arg('narrow', '0.6');
/** Route points are densified to this spacing (m). */
const SPACING = 4;

const index: WorldIndex = JSON.parse(readFileSync(`${paths.out}index.json`, 'utf8'));
const W = index.world;
const tileCache = new Map<string, TileContent | null>();
function tile(k: string): TileContent | null {
  if (!tileCache.has(k)) {
    const f = `${paths.out}t/${k}.bin`;
    const raw = existsSync(f) ? readFileSync(f) : null;
    const buf = raw && isGzip(raw) ? gunzipSync(raw) : raw;
    tileCache.set(k, buf ? new TileContent(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) : null);
  }
  return tileCache.get(k)!;
}

/** Guide sign posts and gantry legs (signs.json), as in the game. */
const guideSigns: SignsFile['signs'] = existsSync(`${paths.out}signs.json`) ? (JSON.parse(readFileSync(`${paths.out}signs.json`, 'utf8')) as SignsFile).signs : [];

/** What each collider is, for failure reports. */
const kinds = new Map<number, string>();

/** Same colliders as the game (WorldStreamer → addTileColliders). */
function addColliders(world: RAPIER.World, t: TileContent) {
  const body = addTileColliders(RAPIER, world, t, W, (c, kind) => kinds.set(c.handle, kind));
  const props = t.has('props') ? t.f32('props') : undefined;
  if (props) addPropColliders(RAPIER, world, body, props, (c, i) => kinds.set(c.handle, PROP_NAMES[props[i * PROP_STRIDE] as PropKind]));
  const fuel = t.has('fuel') ? t.f32('fuel') : undefined;
  if (fuel) addFuelColliders(RAPIER, world, body, fuel, (c, part) => kinds.set(c.handle, `tankstelle-${part}`));
}

/** Ground height under (x, z), interpolated on the same triangles as the terrain mesh. */
function groundAt(x: number, z: number): number | undefined {
  const [ix, iy] = tileOfLocal(W, x, z);
  const t = tile(tileKey(ix, iy));
  if (!t) return undefined;
  const [ox, oz] = tileOriginLocal(W, ix, iy);
  const h = terrainHeights(t);
  const fx = (x - ox) / TERRAIN_STEP, fz = (z - oz) / TERRAIN_STEP;
  const c = Math.min(TERRAIN_N - 2, Math.floor(fx)), r = Math.min(TERRAIN_N - 2, Math.floor(fz));
  const u = fx - c, v = fz - r;
  const a = h[r * TERRAIN_N + c], b = h[r * TERRAIN_N + c + 1], d = h[(r + 1) * TERRAIN_N + c], e = h[(r + 1) * TERRAIN_N + c + 1];
  // Triangles (a, d, b) and (b, d, e).
  return u + v <= 1 ? a + (b - a) * u + (d - a) * v : e + (d - e) * (1 - u) + (b - e) * (1 - v);
}

interface Result { ok: boolean; why?: string; at?: [number, number]; dist: number; len: number }

/** Handling over all routes: largest drift angle (rad) and distance from the route (m), top speed (m/s). */
const handling = { drift: 0, driftWay: '', off: 0, offSum: 0, offN: 0, top: 0 };
let currentWay = '';

function driveRoute(pts: [number, number][], startY: number, tags: Record<string, string>): Result {
  const route = densify(pts.map(([e, n]) => utmToLocal(W, e, n)), SPACING);
  const narrow = tags.highway === 'living_street' || tags.highway === 'service' || (roadWidth(tags) ?? 6) < 5;
  const cruise = 14 * PACE * (narrow ? NARROW : 1);
  // Cornering speed at every route point, from the turn over the points 8 m either side (OSM corners are
  // kinks; a driver rounds them off over about that length).
  const cornerSpeed = route.map((_, i) => {
    const a = route[Math.max(0, i - 2)], b = route[i], c = route[Math.min(route.length - 1, i + 2)];
    if (a === b || b === c) return cruise;
    const a1 = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const a2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
    const radius = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2 / Math.max(turn, 1e-3);
    return Math.min(cruise, Math.sqrt(LAT * (narrow ? NARROW * NARROW : 1) * radius));
  });
  const len = route.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - route[i - 1][0], p[1] - route[i - 1][1]) : 0), 0);
  // Load every tile within 64 m of the route.
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  const keys = new Set<string>();
  for (const [x, z] of route)
    for (const dx of [-64, 0, 64]) for (const dz of [-64, 0, 64]) keys.add(tileKey(...tileOfLocal(W, x + dx, z + dz)));
  for (const k of keys) { const t = tile(k); if (t) addColliders(world, t); }
  const signBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const s of guideSigns) if (keys.has(tileKey(...tileOfLocal(W, s.x, s.z)))) addSignColliders(RAPIER, world, signBody, s, (c) => kinds.set(c.handle, GUIDE_SIGN_NAMES[s.t]));

  const [sx, sz] = route[0];
  const heading0 = Math.atan2(route[1][0] - sx, -(route[1][1] - sz));
  const car = new CarPhysics(RAPIER, world, { x: sx, y: startY + 1.2, z: sz }, heading0);
  let target = 1;
  let stuck = 0;
  let lastSpeed = 0;
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
    // Slowest speed any bend ahead allows from here, braking in time.
    let speedGoal = cruise;
    for (let i = target; i < Math.min(route.length, target + 30); i++) {
      const d = Math.max(0, (i - target) * SPACING - 2);
      speedGoal = Math.min(speedGoal, Math.sqrt(cornerSpeed[i] ** 2 + 2 * BRAKE * d));
    }
    const input = {
      throttle: car.speed < speedGoal ? 1 : 0, brake: car.speed > speedGoal + 2 ? 1 : 0,
      steer: Math.max(-1, Math.min(1, d * 2.5)), nitro: false, handbrake: false, lookBack: false,
    };
    car.update(input, STEP);
    world.step();
    const q = car.body.translation();
    travelled = Math.max(travelled, target * 4);
    if (Math.hypot(route[route.length - 1][0] - q.x, route[route.length - 1][1] - q.z) < 10) return { ok: true, dist: len, len };
    stuck = Math.abs(car.speed) < 1 ? stuck + 1 : 0;
    // A crash: what the body hit (trace only).
    if (TRACE && lastSpeed - car.speed > 6) {
      const hit = new Set<string>();
      // The body touched it within the last steps (the bounce may already have separated them).
      world.contactPairsWith(car.body.collider(0), (o) => hit.add(kinds.get(o.handle) ?? '?'));
      console.log(`crash t=${(step * STEP).toFixed(2)} at ${q.x.toFixed(1)},${q.z.toFixed(1)} ${(lastSpeed * 3.6).toFixed(0)} → ${(car.speed * 3.6).toFixed(0)} km/h, near: ${[...hit].join(', ') || 'nothing'}`);
    }
    lastSpeed = car.speed;
    const r = car.body.rotation();
    const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
    const g = groundAt(q.x, q.z);
    if (TRACE && step % 15 === 0) console.log(`t=${(step * STEP).toFixed(2)} goal=${speedGoal.toFixed(1)} pos=${q.x.toFixed(1)},${q.y.toFixed(2)},${q.z.toFixed(1)} ground=${g?.toFixed(2)} v=${car.speed.toFixed(1)} up=${upY.toFixed(2)}`);
    const fail = (why: string): Result => ({ ok: false, why, at: [q.x, q.z], dist: travelled, len });
    if (stuck > 180) {
      const hit = new Set<string>();
      world.contactPairsWith(car.body.collider(0), (o) => {
        hit.add(kinds.get(o.handle) ?? '?');
        if (TRACE) world.contactPair(car.body.collider(0), o, (m) => {
          for (let k = 0; k < m.numContacts(); k++) {
            const c = m.localContactPoint2(k)!;
            const nrm = m.normal();
            console.log(`contact ${kinds.get(o.handle)} at ${c.x.toFixed(1)},${c.y.toFixed(2)},${c.z.toFixed(1)} normal ${nrm.x.toFixed(2)},${nrm.y.toFixed(2)},${nrm.z.toFixed(2)} ground ${groundAt(c.x, c.z)?.toFixed(2)}`);
          }
        });
      });
      return fail(`stuck${hit.size ? ` on ${[...hit].join('+')}` : ''}`);
    }
    if (upY < 0.3) return fail('flipped');
    if (g !== undefined && q.y < g - 2) return fail('fell through');
    if (g === undefined) return fail('left the world');
    let off = Infinity;
    for (let i = Math.max(0, target - 3); i < Math.min(route.length, target + 3); i++) off = Math.min(off, Math.hypot(route[i][0] - q.x, route[i][1] - q.z));
    if (off > 25) return fail('off route');
    if (car.speed > 5) {
      const lv = car.body.linvel();
      const f = car.heading();
      const drift = Math.abs(Math.atan2(Math.sin(Math.atan2(lv.x, -lv.z) - f), Math.cos(Math.atan2(lv.x, -lv.z) - f)));
      if (drift > handling.drift) { handling.drift = drift; handling.driftWay = `${currentWay} at ${(step * STEP).toFixed(1)} s, ${(car.speed * 3.6).toFixed(0)} km/h`; }
      handling.off = Math.max(handling.off, off);
      handling.offSum += off;
      handling.offN++;
    }
    handling.top = Math.max(handling.top, car.speed);
  }
  return { ok: false, why: 'timeout', at: [car.body.translation().x, car.body.translation().z], dist: travelled, len };
}

async function main() {
  await RAPIER.init();
  const { cfg, project } = loadWorld();
  const osm = readOsm(JSON.parse(readFileSync(`${paths.raw(region)}osm.json`, 'utf8')), project);
  // Road heights as the build computes them, so the car starts on its road (which may be lifted).
  const regions = [loadRegion(region)];
  const height = terrainHeight(regions, unproject(cfg.zone), undefined, osm.polygons);
  applyMeasuredWidths(osm.ways, loadAlkisRoads(region));
  separateCarriageways(osm.ways);
  const ramps = planRamps(osm.ways);
  roadHeights(osm.ways, regions, height);
  matchRampHeights(ramps);
  const T = W.tileSize;
  const inWorld = new Set(index.tiles.map(([x, y]) => tileKey(x, y)));
  let candidates = osm.ways.filter((w) =>
    isMotorRoad(w.tags) && ROAD_CLASSES[w.tags.highway].rank >= 2 &&
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
    currentWay = `way ${w.id}`;
    const res = driveRoute(w.pts, roadSurfaceHeights(w, height)[0], w.tags);
    if (res.ok) ok++;
    else {
      const [e, n] = [res.at![0] + W.originE, -res.at![1] + W.originN];
      fails.push(`  way ${w.id} ${w.tags.highway} "${w.tags.name ?? ''}": ${res.why} after ${res.dist.toFixed(0)}/${res.len.toFixed(0)} m at UTM ${e.toFixed(0)} ${n.toFixed(0)}`);
    }
  }
  console.log(`Drive test: ${ok}/${pool.length} routes completed`);
  console.log(`Handling (pace ${PACE}): top ${(handling.top * 3.6).toFixed(0)} km/h · max drift ${((handling.drift * 180) / Math.PI).toFixed(1)}° (${handling.driftWay}) · off route Ø ${(handling.offSum / Math.max(1, handling.offN)).toFixed(2)} / max ${handling.off.toFixed(1)} m`);
  for (const f of fails) console.log(f);
  if (ok < pool.length * 0.9) process.exitCode = 1;
}

main();
