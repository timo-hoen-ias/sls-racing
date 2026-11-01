// Driving reference of the web car (CarPhysics with the fun and real feel, scaled like in the game) on a flat plane:
// the numbers the Unreal car (Chaos Vehicles, car.bench) is tuned against. Writes unreal/reference/car.json.
//   node unreal/tools/car-reference.ts
import RAPIER from '@dimforge/rapier3d-compat';
import { writeFileSync } from 'node:fs';
import type { DriveInput } from '../../src/input/input.ts';
import { CarPhysics } from '../../src/vehicle/carPhysics.ts';
import { FEEL } from '../../src/game/feel.ts';
import { scaleCar, VEHICLE } from '../../src/vehicle/tuning.ts';

scaleCar(VEHICLE.scale);
const DT = 1 / 120;

function setup(feel: 'fun' | 'real') {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const s = 6000;
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]), new Uint32Array([0, 2, 1, 1, 2, 3])), ground);
  const car = new CarPhysics(RAPIER, world, { x: 0, y: 1, z: 0 }, 0);
  Object.assign(car.feel, FEEL[feel].car);
  car.burst.enabled = FEEL[feel].burst;
  const step = (input: Partial<DriveInput>) => {
    car.update({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, lookBack: false, ...input }, DT);
    world.step();
  };
  for (let i = 0; i < 120; i++) step({});
  return { car, step };
}

function measure(feel: 'fun' | 'real') {
  // Acceleration and top speed.
  let { car, step } = setup(feel);
  let t = 0, t100 = 0, t200 = 0;
  while (t < 60) {
    step({ throttle: 1 });
    t += DT;
    if (!t100 && car.speed >= 100 / 3.6) t100 = t;
    if (!t200 && car.speed >= 200 / 3.6) t200 = t;
  }
  const top = car.speed * 3.6;
  // Braking from 100 km/h.
  ({ car, step } = setup(feel));
  while (car.speed < 100 / 3.6) step({ throttle: 1 });
  const p0 = car.body.translation();
  let tb = 0;
  while (car.speed > 0.5 && tb < 10) { step({ brake: 1 }); tb += DT; }
  const p1 = car.body.translation();
  const brake = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  // Steady cornering: hold 80 km/h with a simple speed controller at full stick, mean lateral acceleration over 4 s.
  ({ car, step } = setup(feel));
  while (car.speed < 80 / 3.6) step({ throttle: 1 });
  let lat = 0, n = 0;
  for (let i = 0; i < 6 * 120; i++) {
    const err = 80 / 3.6 - car.speed;
    step({ throttle: Math.max(0, Math.min(1, err * 0.5)), brake: Math.max(0, Math.min(1, -err * 0.5)), steer: 1 });
    if (i >= 2 * 120) { lat += Math.abs(car.accel.x); n++; }
  }
  return { t0_100: +t100.toFixed(2), t0_200: +t200.toFixed(2), topKmh: +top.toFixed(1), brake100m: +brake.toFixed(1), brake100s: +tb.toFixed(2), latG80: +(lat / n / 9.81).toFixed(2) };
}

await RAPIER.init();
const out = { note: 'Web car (src/vehicle/carPhysics.ts) on a flat plane, 120 Hz, VEHICLE.scale applied; unreal/tools/car-reference.ts', fun: measure('fun'), real: measure('real') };
writeFileSync('unreal/reference/car.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
