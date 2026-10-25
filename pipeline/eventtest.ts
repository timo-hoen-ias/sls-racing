// Drives every generated race, zone and slalom with the rival autopilot through the built tiles (G3):
// each checkpoint must be reached in order without falling through the world. Like the rivals in the game,
// a car stuck for 2.5 s (on a sign, a wall, its roof) is put back on the line a little further on; more
// than MAX_RESCUES of those fail the event. Uses the same physics and colliders as the game (drivetest.ts).
//   node pipeline/eventtest.ts [region] [--only=<event id>] [--level=mittel] [--max=<n>] [--trace]
//   --min=<share> events that must finish (default 0.85).
//   --write: saves the failed events as "drop" in events.json, so the game leaves them out.
import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TileContent, isGzip, tileKey, tileOfLocal, type RoadGraphData, type WorldIndex } from '../src/world/format.ts';
import { addTileColliders } from '../src/world/tileColliders.ts';
import { addPropColliders } from '../src/world/propColliders.ts';
import { addSignColliders } from '../src/world/signColliders.ts';
import { GUIDE_SIGN_NAMES, type SignsFile } from '../src/world/signSpec.ts';
import { PROP_NAMES, PROP_STRIDE, type PropKind } from '../src/world/propKinds.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';
import { CarPhysics } from '../src/vehicle/carPhysics.ts';
import { scaleCar, VEHICLE } from '../src/vehicle/tuning.ts';
import { generateEvents } from '../src/game/events/generate.ts';
import { crossed, type GameEvent, RACE_TYPES } from '../src/game/events/types.ts';
import { RaceLine, RIVAL_LEVELS, type RivalLevel, RivalDriver } from '../src/game/rivals.ts';
import { paths } from './lib/region.ts';

// The test car at the game's vehicle scale (smaller wheels meet the same road steps).
scaleCar(VEHICLE.scale);

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const ONLY = arg('only', '');
const LEVEL = arg('level', 'mittel') as RivalLevel;
const MAX = +arg('max', '999');
const STEP = 1 / 60;
const TRACE = process.argv.includes('--trace');
const WRITE = process.argv.includes('--write');
const MAX_RESCUES = +arg('rescues', '2');
/** Share of events that must finish (ratchet in CI). */
const MIN = +arg('min', '0.85');
/** What each collider is, for failure reports. */
const kinds = new Map<number, string>();

const index: WorldIndex = JSON.parse(readFileSync(`${paths.out}index.json`, 'utf8'));
const W = index.world;
const graph = new RoadGraph(JSON.parse(readFileSync(`${paths.out}${index.graph ?? 'graph.json'}`, 'utf8')) as RoadGraphData);
const signs: SignsFile['signs'] = existsSync(`${paths.out}signs.json`) ? (JSON.parse(readFileSync(`${paths.out}signs.json`, 'utf8')) as SignsFile).signs : [];
const cache = new Map<string, TileContent | null>();
function tile(k: string) {
  if (!cache.has(k)) {
    const f = `${paths.out}t/${k}.bin`;
    const raw = existsSync(f) ? readFileSync(f) : null;
    const buf = raw && isGzip(raw) ? gunzipSync(raw) : raw;
    cache.set(k, buf ? new TileContent(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) : null);
  }
  return cache.get(k)!;
}

interface Result { ok: boolean; why?: string; at?: [number, number]; gates: number; time: number; top: number; rescues: string[] }

function driveEvent(e: GameEvent): Result {
  const loop = !!e.laps;
  const line = new RaceLine(e.path!, loop);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  const keys = new Set<string>();
  for (let i = 0; i < line.count; i += 4)
    for (const dx of [-64, 0, 64]) for (const dz of [-64, 0, 64]) keys.add(tileKey(...tileOfLocal(W, line.x[i] + dx, line.z[i] + dz)));
  for (const k of keys) {
    const t = tile(k);
    if (!t) continue;
    const body = addTileColliders(RAPIER, world, t, W, (c, kind) => kinds.set(c.handle, kind));
    const props = t.has('props') ? t.f32('props') : undefined;
    if (props) addPropColliders(RAPIER, world, body, props, (c, i) => kinds.set(c.handle, PROP_NAMES[props[i * PROP_STRIDE] as PropKind]));
  }
  const signBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const s of signs) if (keys.has(tileKey(...tileOfLocal(W, s.x, s.z)))) addSignColliders(RAPIER, world, signBody, s, (c) => kinds.set(c.handle, GUIDE_SIGN_NAMES[s.t]));

  // Start 6 m behind the start gate on the gate's road height.
  const g0 = e.start;
  const x0 = g0.x - g0.dx * 6, z0 = g0.z - g0.dz * 6;
  const car = new CarPhysics(RAPIER, world, { x: x0, y: g0.y + 1.2, z: z0 }, Math.atan2(g0.dx, -g0.dz));
  for (let i = 0; i < 60; i++) { car.update({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: true, lookBack: false }, STEP); world.step(); }
  const driver = new RivalDriver(line);
  driver.level = RIVAL_LEVELS[LEVEL];
  driver.index = 0;
  const gates = e.gates;
  let next = 0, stuck = 0, top = 0;
  const rescues: string[] = [];
  let raced = 0;
  let prev = { x: x0, z: z0 };
  const limit = (line.length / 8 + 30) / STEP;
  for (let step = 0; step < limit; step++) {
    const p = car.body.translation();
    car.update(driver.drive({ x: p.x, z: p.z, heading: car.heading(), speed: car.speed }), STEP);
    world.step();
    const q = car.body.translation();
    top = Math.max(top, car.speed);
    const fail = (why: string): Result => ({ ok: false, why, at: [q.x, q.z], gates: next, time: step * STEP, top, rescues });
    if (crossed(gates[next], prev.x, prev.z, q.x, q.z, 3)) {
      next++;
      if (next >= gates.length) return { ok: true, gates: next, time: step * STEP, top, rescues };
    }
    prev = { x: q.x, z: q.z };
    const r = car.body.rotation();
    const flipped = 1 - 2 * (r.x * r.x + r.z * r.z) < 0.4;
    stuck = Math.abs(car.speed) < 2 || flipped ? stuck + 1 : 0;
    raced = Math.max(raced, line.cum[driver.index]);
    if (TRACE && step % 30 === 0) console.log(`    t=${(step * STEP).toFixed(1)} ${q.x.toFixed(0)},${q.y.toFixed(1)},${q.z.toFixed(0)} v=${(car.speed * 3.6).toFixed(0)} goal=${(driver.goal * 3.6).toFixed(0)} off=${line.nearest(q.x, q.z, driver.index).dist.toFixed(1)}`);
    if (stuck > 150) {
      const hit = new Set<string>();
      world.contactPairsWith(car.body.collider(0), (o) => {
        hit.add(kinds.get(o.handle) ?? '?');
        if (TRACE) world.contactPair(car.body.collider(0), o, (m) => {
          for (let k = 0; k < m.numContacts(); k++) {
            const c = m.localContactPoint2(k)!, n = m.normal();
            console.log(`    contact ${kinds.get(o.handle)} at ${c.x.toFixed(1)},${c.y.toFixed(2)},${c.z.toFixed(1)} normal ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`);
          }
        });
      });
      const why = `${flipped ? 'flipped' : 'stuck'}${hit.size ? ` on ${[...hit].join('+')}` : ''}`;
      rescues.push(`${why} at UTM ${(q.x + W.originE).toFixed(0)} ${(-q.z + W.originN).toFixed(0)}`);
      if (rescues.length > MAX_RESCUES) return fail(`${rescues.length} rescues, last ${why}`);
      // Back onto the line 25 m on, as the game does with rivals.
      stuck = 0;
      const p = line.pose(raced + 25);
      const s = graph.snap(p.x, p.z, 30);
      car.reset({ x: p.x, y: (s?.y ?? q.y) + 0.9, z: p.z }, p.heading);
      car.body.setLinvel({ x: p.dx * 8, y: 0, z: p.dz * 8 }, true);
      driver.index = line.nearest(p.x, p.z).index;
      prev = { x: p.x, z: p.z };
      continue;
    }
    const ground = graph.snap(q.x, q.z, 40);
    if (ground && q.y < ground.y - 6) return fail('fell through');
    if (line.nearest(q.x, q.z, driver.index).dist > 30) return fail('off the line');
  }
  return { ok: false, why: `timeout at gate ${next + 1}/${gates.length}`, at: [car.body.translation().x, car.body.translation().z], gates: next, time: limit * STEP, top, rescues };
}

async function main() {
  await RAPIER.init();
  const events = generateEvents(graph).filter((e) => e.path && e.gates.length && (RACE_TYPES.has(e.type) || e.type === 'speedzone' || e.type === 'slalom') && (!ONLY || e.id === ONLY));
  const list = events.slice(0, MAX);
  let ok = 0;
  const fails: string[] = [];
  const drop: string[] = [];
  const spots = new Map<string, number>();
  for (const e of list) {
    const r = driveEvent(e);
    const line = `${e.type} ${e.id} "${e.name}": ${r.ok ? 'ok' : r.why} · ${r.gates}/${e.gates.length} Tore · ${r.time.toFixed(0)} s · max ${(r.top * 3.6).toFixed(0)} km/h${r.rescues.length ? ` · ${r.rescues.length}× zurückgesetzt` : ''}`;
    console.log(`  ${line}`);
    for (const x of r.rescues) spots.set(x, (spots.get(x) ?? 0) + 1);
    if (r.ok) ok++;
    else {
      drop.push(e.id);
      fails.push(`  ${line} at UTM ${(r.at![0] + W.originE).toFixed(0)} ${(-r.at![1] + W.originN).toFixed(0)}`);
    }
  }
  console.log(`Event test (${LEVEL}): ${ok}/${list.length} events driven to the finish, ${[...spots.values()].reduce((a, b) => a + b, 0)} rescues`);
  for (const f of fails) console.log(f);
  if (spots.size) console.log('Where cars got stuck (fix the world there):');
  for (const [k] of spots) console.log(`  ${k}`);
  if (WRITE && !ONLY) {
    const file = `${paths.out}events.json`;
    const old = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { events?: unknown[] }) : {};
    writeFileSync(file, JSON.stringify({ events: old.events ?? [], drop }));
    console.log(`${drop.length} events left out in ${file}`);
  }
  // With --write the build goes on: the failed events are simply left out.
  if (!WRITE && ok < list.length * MIN) process.exitCode = 1;
}

main();
