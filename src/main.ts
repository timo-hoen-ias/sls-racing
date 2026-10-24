import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { EngineSound } from './audio/engineSound.ts';
import { Input } from './input/input.ts';
import { isTouchDevice, pickQuality } from './quality.ts';
import { ChaseCamera } from './render/chaseCamera.ts';
import { createMaterials } from './render/materials.ts';
import { createScene } from './render/scene.ts';
import { CarPhysics } from './vehicle/carPhysics.ts';
import { CarView } from './vehicle/carView.ts';
import { localToUtm, type WorldIndex } from './world/format.ts';
import { WorldStreamer } from './world/streamer.ts';

const TILES_URL: string = import.meta.env.VITE_TILES_URL ?? '/tiles';
const STEP = 1 / 60;

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  const quality = pickQuality();
  const [index] = await Promise.all([
    fetch(`${TILES_URL}/index.json`).then((r) => {
      if (!r.ok) throw new Error(`Weltindex nicht gefunden (${r.status}). Erst "npm run world:build" oder "npm run world:fixture" ausführen.`);
      return r.json() as Promise<WorldIndex>;
    }),
    RAPIER.init(),
  ]);

  const view = createScene($('game') as HTMLCanvasElement, quality);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  const streamer = new WorldStreamer(RAPIER, world, TILES_URL, index, createMaterials(), quality);
  view.scene.add(streamer.root);

  const spawn = index.spawn;
  const car = new CarPhysics(RAPIER, world, spawn, spawn.heading);
  const carView = new CarView();
  view.scene.add(carView.root);
  const cam = new ChaseCamera(view.camera);
  const input = new Input();
  if (isTouchDevice()) input.enableTouch();
  $('attribution').textContent = index.attribution.join(' · ');

  let sound: EngineSound | undefined;
  const startBtn = $('start') as HTMLButtonElement;
  startBtn.addEventListener('click', async () => {
    startBtn.hidden = true;
    sound ??= new EngineSound();
    await sound.resume().catch(() => {});
    if (isTouchDevice()) document.documentElement.requestFullscreen?.().then(() => (screen.orientation as any)?.lock?.('landscape')).catch(() => {});
  });

  // Last place the car stood on all four wheels, for resets.
  let safe = { x: spawn.x, y: spawn.y, z: spawn.z, heading: spawn.heading };
  let safeTimer = 0;
  let worldReady = false;

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

  let acc = 0;
  let last = performance.now();
  let fpsT = 0, frames = 0, fps = 0;
  const ip = new THREE.Vector3();
  const iq = new THREE.Quaternion();

  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.update(dt);
    for (const e of input.takeEvents()) {
      if (e === 'reset') car.reset({ x: safe.x, y: safe.y + 1.2, z: safe.z }, safe.heading);
      if (e === 'camera') cam.next();
      if (e === 'mute') sound?.toggleMute();
    }

    const t = car.body.translation();
    streamer.update(t.x, t.z);
    // Hold the car until the ground under it exists.
    if (!worldReady) {
      worldReady = streamer.isLoadedAround(spawn.x, spawn.z);
      car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      car.body.setTranslation(spawn, true);
      $('loading').hidden = worldReady;
    }

    const drive = startBtn.hidden && worldReady ? input.state : { throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false };
    acc += dt;
    while (acc >= STEP) {
      prev.p.copy(curr.p);
      prev.q.copy(curr.q);
      car.update(drive, STEP);
      world.step();
      capture(curr);
      acc -= STEP;
    }
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
    if (worldReady && (ip.y < spawn.y - 150 || !streamer.hasTileAt(ip.x, ip.z))) car.reset({ x: safe.x, y: safe.y + 1.2, z: safe.z }, safe.heading);

    carView.sync(car, ip, iq, drive.brake > 0 && car.speed > 1, now / 1000);
    cam.update(ip, iq, car.speed, car.boosting, dt);
    view.follow(ip);
    view.renderer.render(view.scene, view.camera);

    const slip = car.drifting ? 1 : drive.brake > 0.5 && Math.abs(car.speed) > 12 ? 0.6 : 0;
    sound?.update({ rpm: car.rpm, throttle: drive.throttle, speed: Math.abs(car.speed), boosting: car.boosting, slip });
    if (car.boosting) input.rumble(0.25, 60);

    $('speed').textContent = String(Math.round(Math.abs(car.speed) * 3.6));
    $('gear').textContent = car.gear === -1 ? 'R' : String(car.gear);
    ($('nitro-fill') as HTMLElement).style.transform = `scaleX(${car.nitro.toFixed(3)})`;
    frames++;
    fpsT += dt;
    if (fpsT > 0.5) {
      fps = Math.round(frames / fpsT);
      frames = 0;
      fpsT = 0;
      const [e, n] = localToUtm(index.world, ip.x, ip.z);
      $('info').textContent = `${fps} fps · Qualität ${quality.name} · ${input.lastDevice}\nUTM 32N ${e.toFixed(0)} / ${n.toFixed(0)} · Kacheln ${streamer.loadedCount}`;
    }
    (window as any).__sls = { fps, speed: car.speed, pos: { x: ip.x, y: ip.y, z: ip.z }, tiles: streamer.loadedCount, ready: worldReady };
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  $('loading').textContent = String(e.message ?? e);
});
