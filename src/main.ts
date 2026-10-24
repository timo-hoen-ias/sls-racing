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
import { CarLights, LampLights } from './render/lights.ts';
import { markCar } from './render/post/postFx.ts';
import { createScene } from './render/scene.ts';
import { CarPhysics } from './vehicle/carPhysics.ts';
import { CarView } from './vehicle/carView.ts';
import { loadSportsCar } from './vehicle/sportsCarGlb.ts';
import { Navigation } from './nav/navigation.ts';
import { RouteLine } from './render/routeLine.ts';
import { BigMap } from './ui/bigMap.ts';
import { Minimap } from './ui/minimap.ts';
import { NavHud } from './ui/navHud.ts';
import { Tacho } from './ui/tacho.ts';
import { CAR, ENGINE, ENGINE_SOUND } from './vehicle/tuning.ts';
import { registerCommand, runCommand } from './debug/registry.ts';
import { PerfMonitor, registerPerfCommands } from './debug/perf.ts';
import { registerVehicleCommands } from './vehicle/debugCommands.ts';
import { loadAssists, registerDamageCommands, registerPhysicsCommands, registerSurfaceCommands } from './vehicle/physicsCommands.ts';
import { RoadSurface } from './vehicle/roadSurface.ts';
import { registerReplayCommands } from './replay/commands.ts';
import { Recorder } from './replay/recorder.ts';
import { ReplayPlayer } from './replay/replayPlayer.ts';
import { Telemetry } from './ui/telemetry.ts';
import { Debris } from './render/debris.ts';
import { registerRenderCommands } from './render/debugCommands.ts';
import { localToUtm, type RoadGraphData, type WorldIndex } from './world/format.ts';
import { RoadGraph } from './world/roadGraph.ts';
import { registerTrafficCommands } from './traffic/debugCommands.ts';
import { Traffic } from './traffic/traffic.ts';
import { WorldAudio } from './audio/worldAudio.ts';
import { Pedestrians } from './peds/peds.ts';
import { WorldStreamer } from './world/streamer.ts';
import { registerStreamCommands } from './world/streamCommands.ts';
import { FarField } from './world/farField.ts';
import { FAR_DIST, createViewDistance } from './world/farCommands.ts';
import { PhysicsDebugView } from './debug/physicsDebug.ts';
import { weatherCommands } from './weather/commands.ts';
import { patchWorldMaterials } from './weather/weatherMaterials.ts';
import { FacadeControl } from './render/facades.ts';
import { WeatherSystem } from './weather/weatherSystem.ts';

const TILES_URL: string = import.meta.env.VITE_TILES_URL ?? '/tiles';

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  const quality = pickQuality();
  const STEP = 1 / quality.physicsHz;
  // The Blender car; ?car=procedural or a failed load keeps the procedural one.
  const carModel = new URLSearchParams(location.search).get('car') === 'procedural'
    ? Promise.resolve(undefined)
    : loadSportsCar().catch((e) => { console.warn('[car] GLB nicht geladen, nehme das prozedurale Auto', e); return undefined; });
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

  const view = createScene($('game') as HTMLCanvasElement, quality, index.spawn.y);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  const mats = createMaterials();
  patchWorldMaterials(mats);
  const facades = new FacadeControl(mats.building);
  const streamer = new WorldStreamer(RAPIER, world, TILES_URL, index, mats, quality);
  view.scene.add(streamer.root);
  const far = new FarField(TILES_URL, index, streamer, FAR_DIST[quality.name]);
  view.scene.add(far.root);

  const spawn = index.spawn;
  const car = new CarPhysics(RAPIER, world, spawn, spawn.heading);
  const carView = new CarView(undefined, await carModel);
  view.scene.add(carView.root);
  if (view.post) markCar(carView.root);
  const carLights = new CarLights(carView.root, carView.headlights, carView.exhausts);
  const lampLights = new LampLights(quality, mats.lampHead);
  view.scene.add(lampLights.root);
  const forEachLamp = streamer.forEachLamp.bind(streamer);
  let boostFx = 0;
    const effects = new CarEffects(quality, carView.exhausts);
  view.scene.add(effects.root);
  // Car damage: dents, dull paint, parts breaking off as debris, optional power loss.
  const debris = new Debris(RAPIER, world);
  view.scene.add(debris.root);
  carView.damage.onDetach = (parts) => {
    carView.model.updateMatrixWorld(true);
    const lv = car.body.linvel();
    const side = new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 2, (Math.random() - 0.5) * 4);
    debris.spawn(parts, carView.model.matrixWorld, new THREE.Vector3(lv.x, lv.y, lv.z).multiplyScalar(0.8).add(side), new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4));
  };
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
  const weather = new WeatherSystem(quality, view);
  weather.onChange = (text) => navHud.toast(text);
  for (const c of weatherCommands(weather)) registerCommand(c);
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
    sound.onBackfire = () => { effects.backfire(ip, iq, car.body.linvel()); carLights.backfire(); };
    traffic.attachAudio(sound.context, sound.world);
    worldAudio.attach(sound);
    await sound.resume().catch(() => {});
    await weather.startSound();
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

  loadAssists(car);
  registerPhysicsCommands(car);
  const roadSurface = new RoadSurface(graph, (x, z) => streamer.groundAt(x, z));
  registerSurfaceCommands(roadSurface, car, input);
  const recorder = new Recorder(30);
  const telemetry = new Telemetry(recorder);
  const replay = new ReplayPlayer(recorder, view.camera, cam, view.renderer.domElement);
  registerReplayCommands(recorder, replay, telemetry);
  registerDamageCommands(carView.damage, debris);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F6') { e.preventDefault(); if (replay.active) replay.stop(); else try { navHud.toast(replay.start().split(' · ')[0], 1.5); } catch (err) { navHud.toast((err as Error).message, 1.5); } }
    if (e.code === 'F7') { e.preventDefault(); telemetry.visible = !telemetry.visible; }
  });
  const replayLengths = [0, 0, 0, 0];
  const replayRot = [0, 0, 0, 0];
  const motion = { ax: 0, az: 0 };
  registerRenderCommands(view);
  registerTrafficCommands(traffic, () => ({ x: ip.x, z: ip.z, heading: car.heading() }));
  peds.registerCommands(() => ({ x: ip.x, z: ip.z }));
  const vehicleDebug = registerVehicleCommands({ car, view: carView, cam, sound: () => sound, setManual, reset: () => resetCar() });

  let acc = 0;
  let last = performance.now();
  let fpsT = 0, frames = 0, fps = 0;
  const ip = new THREE.Vector3();
  const iq = new THREE.Quaternion();
  const fwd = new THREE.Vector3();

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
  // Post-processing renders several passes; count draw calls for the whole frame, not the last pass.
  view.renderer.info.autoReset = false;
  const perf = new PerfMonitor($('perf'), view.renderer);
  perf.addSource('Kacheln', () => streamer.statsLine());
  perf.addSource('Physik', () => `${world.colliders.len()} Kollider · ${quality.physicsHz} Hz`);
  const physDebug = new PhysicsDebugView(world);
  view.scene.add(physDebug.lines);
  registerPerfCommands(perf, { streamer, colliders: () => world.colliders.len(), showColliders: (v) => physDebug.setVisible(v), print: (t) => debug.print(t, 'info') });
  registerStreamCommands(streamer, quality, () => (hold ?? ip));
  const viewDist = createViewDistance(view, quality, far);
  if (new URLSearchParams(location.search).has('perf')) perf.setVisible(true);
  // ?cmd=day;nitro.infinite runs commands at startup.
  const bootCmd = new URLSearchParams(location.search).get('cmd');
  if (bootCmd) debug.exec(bootCmd);

  const frame = (now: number) => {
    perf.tick(Math.max(0, now - last));
    // The first rAF timestamp can predate performance.now() at boot.
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    input.update(dt);
    for (const e of input.takeEvents()) {
      if (e === 'reset') resetCar();
      if (e === 'camera') cam.next();
      if (e === 'mute') { sound?.toggleMute(); weather.sound?.toggleMute(); }
      if (e === 'map') { bigMap.toggle(); input.mapOpen = bigMap.open; }
      if (e === 'gearbox') setManual(!car.drivetrain.manual);
      if (e === 'shiftUp' || e === 'shiftDown') {
        // A shift paddle in automatic mode switches to manual, like a tiptronic.
        if (!car.drivetrain.manual) setManual(true);
        car.drivetrain.shift(e === 'shiftUp' ? 1 : -1);
      }
      if (e === 'time') view.daylight.nextPreset();
    }

    // Hold the car until the ground under it exists.
    perf.begin('stream');
    if (hold) {
      const h = hold;
      streamer.update(h.x, h.z, true);
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
    perf.end('stream');

    vehicleDebug.update();
    weather.update(dt * debugState.timeScale, now / 1000, car, view.camera, view.renderer.domElement.height);
    roadSurface.update(car, weather.wheelAqua);
    const drive = startBtn.hidden && worldReady && !bigMap.open && !debug.open && !replay.active ? input.state : { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false };
    if (debugState.frozen) frozenAt ??= { p: car.body.translation(), q: car.body.rotation() };
    else frozenAt = null;
    // The physics holds still during a replay; the car carries on where it was afterwards.
    acc = replay.active ? 0 : acc + dt * debugState.timeScale;
    perf.begin('physik');
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
    perf.end('physik');
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

    facades.update(view.daylight.daylight);
    const night = 1 - view.daylight.daylight;
    const braking = drive.brake > 0 && car.speed > 1;
    carView.setNight(night);
    const rs = replay.active ? replay.update(dt) : null;
    if (rs) {
      for (let i = 0; i < 4; i++) {
        replayLengths[i] = CAR.wheel.rest - rs[`comp${i}` as 'comp0'];
        replayRot[i] = rs.wheelRot;
      }
      carView.pose(car, replay.pos, replay.quat, rs.steer, replayLengths, replayRot, rs.brake > 0 && rs.speed > 1, rs.boost > 0.5, now / 1000);
    } else carView.sync(car, ip, iq, braking, now / 1000);
    carLights.update(night, rs ? rs.brake > 0 && rs.speed > 1 : braking, rs ? rs.boost > 0.5 : car.boosting, dt);
    hitCooldown -= dt;
    if (hit > 0 && worldReady && hitCooldown <= 0) {
      const strength = Math.min(1, (hit - 3.5) / 12);
      effects.impact({ x: ip.x - hitDir.x * 2, y: ip.y - Math.max(0, hitDir.y) * 0.3, z: ip.z - hitDir.z * 2 }, strength);
      sound?.impact(strength);
      worldAudio.impact(ip, car.heading(), strength);
      input.rumble(0.4 + 0.6 * strength, 120 + 200 * strength);
      // Mostly sideways/longitudinal hits dent the body; hard landings do not.
      if (Math.abs(hitDir.y) < 0.75) {
        const from = new THREE.Vector3(-hitDir.x, 0, -hitDir.z).applyQuaternion(iq.clone().invert());
        carView.damage.hit(from, strength);
      }
      hitCooldown = 0.25;
    }
    hit = 0;
    car.power = carView.damage.power;
    car.steerPull = carView.damage.steerPull;
    debris.update(dt);
    effects.road.wet = weather.weather.wet;
    effects.road.snow = weather.weather.snowCover;
    effects.road.puddle = weather.puddle;
    const lvel = car.body.linvel();
    const simDt = debugState.frozen ? 0 : dt * debugState.timeScale;
    traffic.update(simDt, worldReady ? { x: ip.x, z: ip.z, vx: lvel.x, vz: lvel.z, halfLength: CAR.halfExtents.z, halfWidth: CAR.halfExtents.x } : undefined, view.camera);
    peds.update(simDt, worldReady ? ip : undefined, worldReady ? { x: ip.x, z: ip.z, vx: lvel.x, vz: lvel.z, halfWidth: CAR.halfExtents.x } : undefined, view.camera);
    if (worldReady) worldAudio.update(dt, ip, car.heading());
    effects.surface = roadSurface.kinds;
    if (rs) effects.tick(dt, view.camera, view.renderer.domElement.height);
    else effects.update(car, ip, iq, dt, now / 1000, view.camera, view.renderer.domElement.height);
    // Cockpit: smoothed g-forces move the driver's head; the interior shows only from the driver's seat.
    const ka = Math.min(1, dt * 10);
    motion.ax += ((rs ? rs.latG * 9.81 : car.accel.x) - motion.ax) * ka;
    motion.az += ((rs ? rs.longG * 9.81 : car.accel.z) - motion.az) * ka;
    cam.motion.ax = motion.ax;
    cam.motion.az = motion.az;
    cam.motion.steer = rs ? rs.steer : car.steer;
    if (!rs) cam.update(ip, iq, car.speed, car.boosting, dt, car.gear === -1 && car.speed < -1, drive.lookBack);
    viewDist.afterCamera();
    carView.cockpit.group.visible = cam.mode === 'cockpit' && (!rs || replay.cam === 'chase');
    carView.cockpit.update({
      steer: rs ? rs.steer : car.steer, rpm: rs ? rs.rpm : car.rpm, maxRpm: ENGINE.maxRpm, shiftRpm: ENGINE.shiftRpm,
      kmh: Math.abs(rs ? rs.speed : car.speed) * 3.6, gear: rs ? rs.gear : car.gear, manual: car.drivetrain.manual, nitro: rs ? rs.nitro : car.nitro,
    });
    if (!rs && worldReady) {
      const w = car.wheels;
      recorder.push({
        t: now / 1000, x: ip.x, y: ip.y, z: ip.z, qx: iq.x, qy: iq.y, qz: iq.z, qw: iq.w,
        speed: car.speed, rpm: car.rpm, gear: car.gear, load: car.drivetrain.load, throttle: drive.throttle, brake: drive.brake, steer: car.steer,
        slip0: w[0].slip, slip1: w[1].slip, slip2: w[2].slip, slip3: w[3].slip,
        comp0: w[0].compression, comp1: w[1].compression, comp2: w[2].compression, comp3: w[3].compression,
        latG: motion.ax / 9.81, longG: motion.az / 9.81, boost: car.boosting ? 1 : 0, nitro: car.nitro, wheelRot: car.controller.wheelRotation(0) ?? 0,
      });
    }
    telemetry.update(dt, rs ? replay.t : undefined);
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
    physDebug.update(dt);
    far.update(ip.x, ip.z, dt);

    // Lamp lights gather around a point ahead of the car, where the driver looks.
    const ahead = fwd.set(0, 0, 25).applyQuaternion(iq);
    lampLights.update(night, ip.x + ahead.x, ip.z + ahead.z, forEachLamp, dt);
    boostFx += ((car.boosting ? 1 : 0) - boostFx) * (1 - Math.exp(-dt * 5));
    perf.begin('render');
    perf.gpuBegin();
    view.renderer.info.reset();
    view.render(dt, Math.min(1, Math.abs(car.speed) / 70), boostFx);
    perf.gpuEnd();
    perf.end('render');

    const dtr = car.drivetrain;
    if (rs) {
      sound?.update({
        rpm: rs.rpm, load: rs.load, cut: false, blip: false, limiter: false, shifted: null,
        speed: Math.abs(rs.speed), boosting: rs.boost > 0.5, slip: Math.max(rs.slip0, rs.slip1, rs.slip2, rs.slip3), airborne: false,
      });
    } else sound?.update({
      rpm: dtr.rpm, load: dtr.load, cut: dtr.cut, blip: dtr.blip, limiter: dtr.limiter, shifted: shiftedSince(dtr),
      speed: Math.abs(car.speed), boosting: car.boosting, slip: car.slip, airborne: car.airborne,
      rumble: roadSurface.rumble, crunch: roadSurface.crunch, squeal: roadSurface.squeal,
    });
    for (const k of roadSurface.kerbs) { sound?.kerb(k); input.rumble(0.35 + 0.4 * k, 90); }
    if (car.boosting) input.rumble(0.25, 60);
    else if (car.slip > 0.4) input.rumble(0.12 * car.slip, 60);
    else if (roadSurface.rumble > 0.05) input.rumble(0.3 * roadSurface.rumble, 60);

    if (rs) tacho.update({ rpm: rs.rpm, gear: rs.gear, manual: dtr.manual, kmh: Math.abs(rs.speed) * 3.6, nitro: rs.nitro, boosting: rs.boost > 0.5, limiter: false }, dt, now / 1000);
    else tacho.update({ rpm: dtr.rpm, gear: dtr.gear, manual: dtr.manual, kmh: Math.abs(car.speed) * 3.6, nitro: car.nitro, boosting: car.boosting, limiter: dtr.limiter }, dt, now / 1000);
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
      fps, speed: car.speed, time: view.daylight.hours, rpm: car.rpm, gear: car.gear, slip: car.slip, pos: { x: ip.x, y: ip.y, z: ip.z }, tiles: streamer.loadedCount, ready: worldReady,
      route: nav.route ? { length: nav.route.length, progress: nav.progress } : null,
      traffic: traffic.sim,
      peds: peds.sim,
      setDestination: (x: number, z: number) => nav.setDestination(x, z, ip.x, ip.z),
      debug: (line: string) => runCommand(line),
      run: (line: string) => debug.exec(line),
      weather: weather.weather,
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
