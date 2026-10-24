import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { EngineSound } from './audio/engineSound.ts';
import { DebugConsole } from './debug/debugConsole.ts';
import { registerGameCommands, type DebugState } from './debug/gameCommands.ts';
import { Input } from './input/input.ts';
import { isTouchDevice, pickQuality } from './quality.ts';
import { CarEffects } from './render/carEffects.ts';
import { ChaseCamera } from './render/chaseCamera.ts';
import { createMaterials } from './render/materials.ts';
import { createScene } from './render/scene.ts';
import { CarPhysics } from './vehicle/carPhysics.ts';
import { CarView } from './vehicle/carView.ts';
import { Navigation } from './nav/navigation.ts';
import { RouteLine } from './render/routeLine.ts';
import { BigMap } from './ui/bigMap.ts';
import { Minimap } from './ui/minimap.ts';
import { NavHud } from './ui/navHud.ts';
import { Tacho } from './ui/tacho.ts';
import { CAR, ENGINE, ENGINE_SOUND } from './vehicle/tuning.ts';
import { runCommand } from './debug/registry.ts';
import { registerVehicleCommands } from './vehicle/debugCommands.ts';
import { localToUtm, type RoadGraphData, type WorldIndex } from './world/format.ts';
import { RoadGraph } from './world/roadGraph.ts';
import { registerTrafficCommands } from './traffic/debugCommands.ts';
import { Traffic } from './traffic/traffic.ts';
import { WorldAudio } from './audio/worldAudio.ts';
import { Pedestrians } from './peds/peds.ts';
import { WorldStreamer } from './world/streamer.ts';

const TILES_URL: string = import.meta.env.VITE_TILES_URL ?? '/tiles';

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  const quality = pickQuality();
  const STEP = 1 / quality.physicsHz;
  const [index] = await Promise.all([
    fetch(`${TILES_URL}/index.json`).then((r) => {
      if (!r.ok) throw new Error(`Weltindex nicht gefunden (${r.status}). Erst "npm run world:build" oder "npm run world:fixture" ausführen.`);
      return r.json() as Promise<WorldIndex>;
    }),
    RAPIER.init(),
  ]);

  const graphData: RoadGraphData = index.graph
    ? await fetch(`${TILES_URL}/${index.graph}`).then((r) => r.json())
    : { v: 1, names: [], nodes: [], edges: [] };
  const graph = new RoadGraph(graphData);

  const view = createScene($('game') as HTMLCanvasElement, quality);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  const mats = createMaterials();
  const streamer = new WorldStreamer(RAPIER, world, TILES_URL, index, mats, quality);
  view.scene.add(streamer.root);

  const spawn = index.spawn;
  const car = new CarPhysics(RAPIER, world, spawn, spawn.heading);
  const carView = new CarView();
  view.scene.add(carView.root);
  const effects = new CarEffects(quality, carView.exhausts);
  view.scene.add(effects.root);
  const tacho = new Tacho($('tacho'), ENGINE.maxRpm, ENGINE.shiftRpm);
  const cam = new ChaseCamera(view.camera);
  const input = new Input();
  if (isTouchDevice()) input.enableTouch();
  $('attribution').textContent = index.attribution.join(' · ');

  const nav = new Navigation(graph);
  const navHud = new NavHud();
  const minimap = new Minimap($('minimap') as HTMLCanvasElement, graph, nav);
  const bigMap = new BigMap($('bigmap'), graph, nav);
  bigMap.onClose = () => (input.mapOpen = false);
  $('minimap').addEventListener('click', () => { bigMap.toggle(true); input.mapOpen = true; });
  const routeLine = new RouteLine(RAPIER, world, nav, car.body);
  view.scene.add(routeLine.mesh);
  const traffic = new Traffic(RAPIER, world, graph, { maxAgents: quality.traffic, shadows: quality.shadows > 0 });
  view.scene.add(traffic.view.root);
  const peds = new Pedestrians(graph, { maxPeds: quality.peds, shadows: quality.shadows > 0, traffic: traffic.sim });
  view.scene.add(peds.view.root);
  peds.sim.events.knocked = (_, v) => {
    sound?.impact(Math.min(0.5, v / 30));
    input.rumble(0.5, 150);
  };
  const worldAudio = new WorldAudio({
    R: RAPIER, world, graph, car: car.body, scene: view.scene,
    ignore: (c) => traffic.isSolid(c.parent()),
    waterMeshes: () => {
      const out: THREE.Mesh[] = [];
      streamer.root.traverse((o) => { if ((o as THREE.Mesh).material === mats.water) out.push(o as THREE.Mesh); });
      return out;
    },
  });
  let streetTimer = 0;
  let mapTimer = 0;

  let sound: EngineSound | undefined;
  const startBtn = $('start') as HTMLButtonElement;
  startBtn.addEventListener('click', async () => {
    startBtn.hidden = true;
    sound ??= await EngineSound.create(ENGINE_SOUND, quality.reverb);
    sound.onBackfire = () => effects.backfire(ip, iq, car.body.linvel());
    traffic.attachAudio(sound.context, sound.world);
    worldAudio.attach(sound);
    await sound.resume().catch(() => {});
    if (isTouchDevice()) document.documentElement.requestFullscreen?.().then(() => (screen.orientation as any)?.lock?.('landscape')).catch(() => {});
  });

  // Last place the car stood on all four wheels, for resets.
  let safe = { x: spawn.x, y: spawn.y, z: spawn.z, heading: spawn.heading };
  let safeTimer = 0;
  let worldReady = false;
  // The car waits here until the ground under it exists (start and teleports). Without y, it drops onto the ground.
  let hold: { x: number; y?: number; z: number; heading: number; frames: number } | null = { ...spawn, frames: 0 };
  const groundRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const groundAt = (x: number, z: number) => {
    groundRay.origin = { x, y: 2000, z };
    const hit = world.castRay(groundRay, 4000, true, undefined, undefined, undefined, car.body, (c) => !traffic.isSolid(c.parent()));
    return hit ? 2000 - hit.timeOfImpact : undefined;
  };

  const prev = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const curr = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const capture = (o: typeof curr) => {
    const t = car.body.translation();
    const r = car.body.rotation();
    o.p.set(t.x, t.y, t.z);
    o.q.set(r.x, r.y, r.z, r.w);
  };
  capture(curr);
  prev.p.copy(curr.p);
  prev.q.copy(curr.q);

  // Hits: a velocity jump within one physics step that driving alone cannot cause.
  const prevVel = { x: 0, y: 0, z: 0 };
  let hit = 0;
  let hitDir = { x: 0, y: 0, z: 0 };
  let hitCooldown = 0;

  const setManual = (on: boolean) => {
    car.drivetrain.manual = on;
    navHud.toast(on ? 'Manuell schalten' : 'Automatik', 1.2);
    try { localStorage.setItem('sls.gearbox', on ? 'manual' : 'auto'); } catch { /* storage blocked */ }
  };
  try { car.drivetrain.manual = localStorage.getItem('sls.gearbox') === 'manual'; } catch { /* storage blocked */ }

  const resetCar = () => {
    car.reset({ x: safe.x, y: safe.y + 1.2, z: safe.z }, safe.heading);
    prevVel.x = prevVel.y = prevVel.z = 0;
    hitCooldown = 0.6;
  };

  registerTrafficCommands(traffic, () => ({ x: ip.x, z: ip.z, heading: car.heading() }));
  peds.registerCommands(() => ({ x: ip.x, z: ip.z }));
  const vehicleDebug = registerVehicleCommands({ car, view: carView, cam, sound: () => sound, setManual, reset: () => resetCar() });

  let acc = 0;
  let last = performance.now();
  let fpsT = 0, frames = 0, fps = 0;
  const ip = new THREE.Vector3();
  const iq = new THREE.Quaternion();

  const debugState: DebugState = { timeScale: 1, infiniteNitro: false, frozen: false };
  let frozenAt: { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number } } | null = null;
  const debug = new DebugConsole();
  debug.onToggle = () => input.releaseAll();
  registerGameCommands({
    R: RAPIER, world, view, quality, index, graph, nav, car, pos: ip, resetCar,
    teleport: (x, z, heading = car.heading()) => {
      if (!streamer.hasTileAt(x, z)) throw new Error(`${x.toFixed(0)} / ${z.toFixed(0)} liegt außerhalb der Karte`);
      hold = { x, z, heading, frames: 0 };
      worldReady = false;
    },
  }, debugState);
  // ?cmd=day;nitro.infinite runs commands at startup.
  const bootCmd = new URLSearchParams(location.search).get('cmd');
  if (bootCmd) debug.exec(bootCmd);

  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.update(dt);
    for (const e of input.takeEvents()) {
      if (e === 'reset') resetCar();
      if (e === 'camera') cam.next();
      if (e === 'mute') sound?.toggleMute();
      if (e === 'map') { bigMap.toggle(); input.mapOpen = bigMap.open; }
      if (e === 'gearbox') setManual(!car.drivetrain.manual);
      if (e === 'shiftUp' || e === 'shiftDown') {
        // A shift paddle in automatic mode switches to manual, like a tiptronic.
        if (!car.drivetrain.manual) setManual(true);
        car.drivetrain.shift(e === 'shiftUp' ? 1 : -1);
      }
    }

    // Hold the car until the ground under it exists.
    if (hold) {
      const h = hold;
      streamer.update(h.x, h.z);
      // Give fresh colliders a couple of physics steps before casting against them.
      if (streamer.isLoadedAround(h.x, h.z)) h.frames++;
      if (h.frames > 2 && h.y === undefined) h.y = (groundAt(h.x, h.z) ?? graph.snap(h.x, h.z, 200)?.y ?? car.body.translation().y) + 1;
      car.reset({ x: h.x, y: h.y ?? car.body.translation().y, z: h.z }, h.heading);
      if (h.frames > 2 && h.y !== undefined) {
        hold = null;
        worldReady = true;
        safe = { x: h.x, y: h.y, z: h.z, heading: h.heading };
        prevVel.x = prevVel.y = prevVel.z = 0;
        capture(curr);
        prev.p.copy(curr.p);
        prev.q.copy(curr.q);
      }
      $('loading').hidden = worldReady;
    } else {
      const t = car.body.translation();
      streamer.update(t.x, t.z);
    }

    vehicleDebug.update();
    const drive = startBtn.hidden && worldReady && !bigMap.open && !debug.open ? input.state : { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
    if (debugState.frozen) frozenAt ??= { p: car.body.translation(), q: car.body.rotation() };
    else frozenAt = null;
    acc += dt * debugState.timeScale;
    while (acc >= STEP) {
      prev.p.copy(curr.p);
      prev.q.copy(curr.q);
      if (frozenAt) {
        car.body.setTranslation(frozenAt.p, true);
        car.body.setRotation(frozenAt.q, true);
        car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      car.update(drive, STEP);
      world.step();
      capture(curr);
      const lv = car.body.linvel();
      const dvx = lv.x - prevVel.x, dvy = lv.y - prevVel.y, dvz = lv.z - prevVel.z;
      const dv = Math.hypot(dvx, dvy, dvz);
      if (dv > 3.5 && dv > hit) { hit = dv; hitDir = { x: dvx / dv, y: dvy / dv, z: dvz / dv }; }
      prevVel.x = lv.x; prevVel.y = lv.y; prevVel.z = lv.z;
      acc -= STEP;
    }
    if (debugState.infiniteNitro) car.nitro = 1;
    const alpha = acc / STEP;
    ip.lerpVectors(prev.p, curr.p, alpha);
    iq.slerpQuaternions(prev.q, curr.q, alpha);

    // Safety net: off the map or fallen through.
    const contacts = [0, 1, 2, 3].every((i) => car.controller.wheelIsInContact(i));
    safeTimer += dt;
    if (contacts && safeTimer > 1.5 && Math.abs(car.speed) < 40 && streamer.hasTileAt(ip.x, ip.z)) {
      safe = { x: ip.x, y: ip.y, z: ip.z, heading: car.heading() };
      safeTimer = 0;
    }
    if (worldReady && (ip.y < spawn.y - 150 || !streamer.hasTileAt(ip.x, ip.z))) resetCar();

    carView.sync(car, ip, iq, drive.brake > 0 && car.speed > 1, now / 1000);
    hitCooldown -= dt;
    if (hit > 0 && worldReady && hitCooldown <= 0) {
      const strength = Math.min(1, (hit - 3.5) / 12);
      effects.impact({ x: ip.x - hitDir.x * 2, y: ip.y - Math.max(0, hitDir.y) * 0.3, z: ip.z - hitDir.z * 2 }, strength);
      sound?.impact(strength);
      worldAudio.impact(ip, car.heading(), strength);
      input.rumble(0.4 + 0.6 * strength, 120 + 200 * strength);
      hitCooldown = 0.25;
    }
    hit = 0;
    const lvel = car.body.linvel();
    const simDt = debugState.frozen ? 0 : dt * debugState.timeScale;
    traffic.update(simDt, worldReady ? { x: ip.x, z: ip.z, vx: lvel.x, vz: lvel.z, halfLength: CAR.halfExtents.z, halfWidth: CAR.halfExtents.x } : undefined, view.camera);
    peds.update(simDt, worldReady ? ip : undefined, worldReady ? { x: ip.x, z: ip.z, vx: lvel.x, vz: lvel.z, halfWidth: CAR.halfExtents.x } : undefined, view.camera);
    if (worldReady) worldAudio.update(dt, ip, car.heading());
    effects.update(car, ip, iq, dt, now / 1000, view.camera, view.renderer.domElement.height);
    cam.update(ip, iq, car.speed, car.boosting, dt, car.gear === -1 && car.speed < -1, drive.lookBack);
    view.follow(ip);
    // Navigation, street name and maps.
    const heading = car.heading();
    navHud.update(nav.update(ip.x, ip.z, dt), dt);
    if ((streetTimer -= dt) <= 0) {
      streetTimer = 0.25;
      navHud.showStreet(graph.snap(ip.x, ip.z, 25)?.edge.name ?? '');
    }
    minimap.draw(ip.x, ip.z, heading, car.speed);
    bigMap.setCar(ip.x, ip.z, heading);
    if (bigMap.open && (mapTimer -= dt) <= 0) { mapTimer = 0.5; bigMap.draw(); }
    routeLine.update(dt);

    view.render();

    const dtr = car.drivetrain;
    sound?.update({
      rpm: dtr.rpm, load: dtr.load, cut: dtr.cut, blip: dtr.blip, limiter: dtr.limiter, shifted: shiftedSince(dtr),
      speed: Math.abs(car.speed), boosting: car.boosting, slip: car.slip, airborne: car.airborne,
    });
    if (car.boosting) input.rumble(0.25, 60);
    else if (car.slip > 0.4) input.rumble(0.12 * car.slip, 60);

    tacho.update({ rpm: dtr.rpm, gear: dtr.gear, manual: dtr.manual, kmh: Math.abs(car.speed) * 3.6, nitro: car.nitro, boosting: car.boosting, limiter: dtr.limiter }, dt, now / 1000);
    frames++;
    fpsT += dt;
    if (fpsT > 0.5) {
      fps = Math.round(frames / fpsT);
      frames = 0;
      fpsT = 0;
      const [e, n] = localToUtm(index.world, ip.x, ip.z);
      $('info').textContent = `${fps} fps · Qualität ${quality.name} · ${input.lastDevice}\nUTM 32N ${e.toFixed(0)} / ${n.toFixed(0)} · Kacheln ${streamer.loadedCount}`;
    }
    (window as any).__sls = {
      fps, speed: car.speed, rpm: car.rpm, gear: car.gear, slip: car.slip, pos: { x: ip.x, y: ip.y, z: ip.z }, tiles: streamer.loadedCount, ready: worldReady,
      route: nav.route ? { length: nav.route.length, progress: nav.progress } : null,
      traffic: traffic.sim,
      peds: peds.sim,
      setDestination: (x: number, z: number) => nav.setDestination(x, z, ip.x, ip.z),
      debug: (line: string) => runCommand(line),
      run: (line: string) => debug.exec(line),
    };
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Gear changes happen in fixed physics steps; report each one once per rendered frame. */
let lastGear = 1;
function shiftedSince(d: { gear: number }): 'up' | 'down' | null {
  const g = d.gear;
  const r = g === lastGear ? null : g > lastGear || lastGear === -1 ? 'up' : 'down';
  lastGear = g;
  return r;
}

boot().catch((e) => {
  console.error(e);
  $('loading').textContent = String(e.message ?? e);
});
