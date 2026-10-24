import type { EngineSound } from '../audio/engineSound.ts';
import { registerCommand } from '../debug/registry.ts';
import type { ChaseCamera } from '../render/chaseCamera.ts';
import { type CarPhysics, maxSteerAngle } from './carPhysics.ts';
import type { CarView } from './carView.ts';
import { CAR, ENGINE } from './tuning.ts';

// Debug commands for the car: gearbox, steering, engine braking, tuning, camera and sound.

export interface VehicleDebugContext {
  car: CarPhysics;
  view: CarView;
  cam: ChaseCamera;
  sound: () => EngineSound | undefined;
  setManual(on: boolean): void;
  reset(): void;
}

const num = (s: string | undefined, name: string) => {
  const v = Number(s);
  if (s === undefined || !Number.isFinite(v)) throw new Error(`${name} muss eine Zahl sein`);
  return v;
};

/** Reads or writes a nested tuning value such as "steer.highSpeed". */
function tuneValue(root: Record<string, unknown>, path: string, value?: number) {
  const keys = path.split('.');
  let obj = root;
  for (const k of keys.slice(0, -1)) {
    if (typeof obj[k] !== 'object' || obj[k] === null) throw new Error(`unbekannt: ${path}`);
    obj = obj[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (typeof obj[last] !== 'number') throw new Error(`kein Zahlenwert: ${path}`);
  if (value !== undefined) obj[last] = value;
  return obj[last] as number;
}

export function registerVehicleCommands(c: VehicleDebugContext) {
  const { car } = c;
  let infiniteNitro = false;
  const engineBrakeBase = ENGINE.engineBrake;

  registerCommand({
    name: 'car.info',
    help: 'Tempo, Drehzahl, Gang, Schlupf, Nitro',
    run: () => {
      const d = car.drivetrain;
      return `${(car.speed * 3.6).toFixed(1)} km/h · ${d.rpm.toFixed(0)}/min · Gang ${d.gear === -1 ? 'R' : d.gear} (${d.manual ? 'manuell' : 'automatik'}) · Kraft ${d.force.toFixed(0)} N · Schlupf ${car.slip.toFixed(2)} · Nitro ${(car.nitro * 100).toFixed(0)} %`;
    },
  });
  registerCommand({ name: 'car.reset', help: 'Auto auf den letzten sicheren Punkt setzen', run: () => c.reset() });
  registerCommand({
    name: 'car.nitro',
    help: 'Nitro auffüllen oder unendlich schalten',
    args: '[full|infinite|off]',
    run: ([m = 'full']) => {
      if (m === 'infinite') infiniteNitro = true;
      if (m === 'off') infiniteNitro = false;
      car.nitro = 1;
      return `Nitro voll${infiniteNitro ? ', unendlich' : ''}`;
    },
  });
  registerCommand({
    name: 'car.color',
    help: 'Lackfarbe setzen',
    args: '<#rrggbb>',
    run: ([col]) => {
      if (!col) throw new Error('Farbe fehlt');
      c.view.setColor(col);
    },
  });
  registerCommand({
    name: 'car.tune',
    help: 'Fahrwerts-/Physikwert lesen oder setzen, z. B. car.tune grip.rear 3',
    args: '<pfad> [wert]',
    run: ([path, v]) => {
      if (!path) return Object.keys(CAR).join(', ');
      return `${path} = ${tuneValue(CAR as unknown as Record<string, unknown>, path, v === undefined ? undefined : num(v, 'wert'))}`;
    },
  });
  registerCommand({
    name: 'engine.tune',
    help: 'Motor-/Getriebewert lesen oder setzen, z. B. engine.tune shiftRpm 8000',
    args: '<pfad> [wert]',
    run: ([path, v]) => {
      if (!path) return Object.keys(ENGINE).join(', ');
      return `${path} = ${tuneValue(ENGINE as unknown as Record<string, unknown>, path, v === undefined ? undefined : num(v, 'wert'))}`;
    },
  });
  registerCommand({
    name: 'engine.brake',
    help: 'Motorbremse an/aus oder Faktor (1 = normal)',
    args: '<on|off|faktor>',
    run: ([m = 'on']) => {
      const k = m === 'on' ? 1 : m === 'off' ? 0 : num(m, 'faktor');
      (ENGINE as { engineBrake: { base: number; perRpm: number } }).engineBrake = { base: engineBrakeBase.base * k, perRpm: engineBrakeBase.perRpm * k };
      return `Motorbremse × ${k}`;
    },
  });
  registerCommand({
    name: 'gear.mode',
    help: 'Getriebe: Automatik oder manuell (E/Q bzw. rechter Stick)',
    args: '<auto|manual>',
    run: ([m]) => {
      if (m !== 'auto' && m !== 'manual') throw new Error('auto oder manual');
      c.setManual(m === 'manual');
    },
  });
  registerCommand({
    name: 'gear.set',
    help: 'Gang direkt einlegen (schaltet auf manuell)',
    args: '<1..7>',
    run: ([g]) => {
      const n = Math.round(num(g, 'gang'));
      if (n < 1 || n > ENGINE.gears.length) throw new Error(`1 bis ${ENGINE.gears.length}`);
      c.setManual(true);
      car.drivetrain.gear = n;
      return `Gang ${n}`;
    },
  });
  registerCommand({
    name: 'steer.info',
    help: 'Maximaler Lenkeinschlag je Tempo',
    run: () => [0, 30, 50, 100, 150, 200, 250].map((k) => `${k} km/h: ${((maxSteerAngle(k / 3.6) * 180) / Math.PI).toFixed(1)}°`).join('\n'),
  });
  registerCommand({
    name: 'steer.tune',
    help: 'Lenkung: lowSpeed, highSpeed (rad), fadeSpeed (m/s), rate, rateSpeed, drift',
    args: '<wert> <zahl>',
    run: ([k, v]) => `steer.${k} = ${tuneValue(CAR as unknown as Record<string, unknown>, `steer.${k}`, v === undefined ? undefined : num(v, 'zahl'))}`,
  });
  registerCommand({
    name: 'cam.mode',
    help: 'Kamera wechseln',
    args: '<chase|far|hood>',
    run: ([m]) => {
      if (m !== 'chase' && m !== 'far' && m !== 'hood') throw new Error('chase, far oder hood');
      c.cam.mode = m;
    },
  });
  registerCommand({
    name: 'sound.mute',
    help: 'Ton an/aus',
    run: () => {
      const s = c.sound();
      if (!s) return 'Ton noch nicht gestartet';
      s.toggleMute();
      return s.muted ? 'stumm' : 'Ton an';
    },
  });

  return {
    /** Call every frame: keeps debug overrides active. */
    update() {
      if (infiniteNitro) car.nitro = 1;
    },
  };
}
