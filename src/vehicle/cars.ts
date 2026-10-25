import type { EngineSoundProfile } from '../audio/engineSound.ts';
import type { EngineSpec } from './drivetrain.ts';
import type { CarGeometry } from './sportsCarModel.ts';
import { CAR, ENGINE, ENGINE_SOUND } from './tuning.ts';

// The cars the player can pick (car.select, options menu → Fahren). Each one is a Blender GLB with the same
// node layout as sportscar.glb, plus its own engine, sound and handling written over the base tuning in
// tuning.ts. Newer GLBs state their dimensions in the extras of the "car" node; wheelbase, track, wheel size
// and the chassis box follow them. No real makes or models.

type Overrides = { [key: string]: unknown };

export interface CarSpec {
  id: string;
  label: string;
  /** Short description for the menu and car.list. */
  info: string;
  url: string;
  /** Written over CAR (tuning.ts), nested like it. */
  tuning?: Overrides;
  engine?: Partial<EngineSpec>;
  sound?: Overrides;
}

const MODELS = `${import.meta.env.BASE_URL}models/`;

export const CARS: CarSpec[] = [
  {
    id: 'sportscar',
    label: 'Sportcoupé',
    info: '4,0-l-Sechszylinder-Sauger, 9 000/min, Heckantrieb mit etwas Vorderachse',
    url: `${MODELS}sportscar.glb`,
  },
  {
    id: 'hothatch',
    label: 'Kompaktsportler',
    info: '2,0-l-Vierzylinder-Turbo, Allrad mit Frontbetonung, leicht und wendig',
    url: `${MODELS}cars/hothatch.glb`,
    tuning: {
      mass: 1350,
      arb: { front: 24000, rear: 21000 },
      diff: { front: 1.8, rear: 2 },
      frontDrive: 0.6,
      aero: { drag: 0.42, downforce: 0.45, balance: 0.5 },
      brake: { force: 16000, bias: 0.66 },
      steer: { rate: 4.3 },
    },
    engine: {
      idleRpm: 850,
      shiftRpm: 6700,
      maxRpm: 7000,
      // Turbo plateau: ~420 Nm from 2 500/min, ~245 kW at 6 000/min.
      torque: [[850, 230], [1800, 360], [2500, 420], [4500, 420], [5500, 405], [6500, 340], [7000, 300]],
      gears: [3.6, 2.2, 1.55, 1.18, 0.95, 0.79],
      final: 4.4,
      stallRpm: 3000,
      shiftTime: 0.09,
      engineBrake: { base: 24, perRpm: 0.011 },
    },
    sound: {
      // Inline four, 4-into-1 manifold into the turbo, one big pipe: raspy, flutters when lifting off boost.
      voice: { cylinders: 4, layout: 'i4', lumpy: 0.05, irregular: 0.08, pulse: { noise: 0.35, tone: 0.6, toneHz: 270, decay: 0.74, color: 0.85 }, header: 0.45, pipe: 2.8, cross: 1, intakeLen: 0.5, mech: 0.4 },
      resonances: [{ freq: 140, q: 2, gain: 5 }, { freq: 900, q: 2.2, gain: 4 }, { freq: 2600, q: 3, gain: 4 }],
      drive: 0.7,
      lpIdle: 1100,
      lpFull: 7000,
      turbo: { ratio: 40, gain: 0.035, flutter: 0.6 },
      intake: 0.06,
      pops: 0.7,
      shiftPop: 0.7,
    },
  },
  {
    id: 'gt',
    label: 'Gran Turismo',
    info: 'V8 mit Drehmoment satt, langer Radstand, Heckantrieb, ruhig bei hohem Tempo',
    url: `${MODELS}cars/gt.glb`,
    tuning: {
      mass: 1650,
      arb: { front: 34000, rear: 18000 },
      diff: { rear: 3 },
      frontDrive: 0,
      aero: { drag: 0.5, downforce: 1.1, balance: 0.42 },
      brake: { force: 19500 },
      steer: { rate: 3.4 },
    },
    engine: {
      idleRpm: 750,
      shiftRpm: 7500,
      maxRpm: 7800,
      // ~650 Nm in the middle, ~460 kW at 7 000/min.
      torque: [[750, 380], [2000, 560], [3500, 640], [5000, 650], [6500, 610], [7500, 530], [7800, 480]],
      gears: [3.9, 2.5, 1.75, 1.35, 1.08, 0.88, 0.72],
      final: 3.3,
      stallRpm: 3200,
      engineBrake: { base: 40, perRpm: 0.016 },
    },
    sound: {
      // Cross-plane V8 with separate banks and a long twin exhaust: the uneven burble of each bank.
      voice: { cylinders: 8, layout: 'v8', lumpy: 0.14, irregular: 0.14, pulse: { noise: 0.25, tone: 0.75, toneHz: 220, decay: 0.8, color: 0.95 }, header: 0.85, pipe: 3.4, cross: 0.12, intakeLen: 0.55, mech: 0.25 },
      resonances: [{ freq: 110, q: 2, gain: 6 }, { freq: 700, q: 2, gain: 4 }, { freq: 2400, q: 3, gain: 3 }],
      drive: 0.55,
      lpIdle: 1000,
      lpFull: 6500,
      intake: 0.08,
      pops: 0.6,
      shiftPop: 0.5,
      whine: 0.015,
    },
  },
];

export const DEFAULT_CAR = 'sportscar';

export function findCar(id: string) {
  return CARS.find((c) => c.id === id.toLowerCase());
}

const BASE = structuredClone({ car: CAR, engine: ENGINE, sound: ENGINE_SOUND }) as unknown as { car: Overrides; engine: Overrides; sound: Overrides };

/** Writes src into target: objects merge, numbers and arrays replace. */
function deepAssign(target: Overrides, src: Overrides) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepAssign(target[k] as Overrides, v as Overrides);
    else target[k] = structuredClone(v);
  }
}

/**
 * Makes CAR, ENGINE and ENGINE_SOUND describe this car (in place, so every holder sees it): the base tuning,
 * then the car's own values, then the dimensions of its model. Debug changes (car.tune …) are reset.
 * The physics takes it over with CarPhysics.rebuild(), the sound with EngineSound.setProfile().
 */
export function applyCar(spec: CarSpec, geometry?: CarGeometry) {
  const car = CAR as unknown as Overrides, engine = ENGINE as unknown as Overrides, sound = ENGINE_SOUND as unknown as Overrides;
  deepAssign(car, structuredClone(BASE.car));
  deepAssign(engine, structuredClone(BASE.engine));
  deepAssign(sound, structuredClone(BASE.sound));
  delete sound.turbo;
  if (spec.tuning) deepAssign(car, spec.tuning);
  if (spec.engine) deepAssign(engine, spec.engine as Overrides);
  if (spec.sound) deepAssign(sound, spec.sound);
  if (geometry) {
    const base = BASE.car as unknown as typeof CAR;
    const w = CAR.wheel as { -readonly [K in keyof typeof CAR.wheel]: number };
    w.front = geometry.wheel.front;
    w.rear = geometry.wheel.rear;
    // Track is centre to centre; the first models state half of it (the wheel's x), no real car is under 1.2 m.
    w.x = geometry.wheel.track < 1.2 ? geometry.wheel.track : geometry.wheel.track / 2;
    w.radius = geometry.wheel.radius;
    w.width = geometry.wheel.width;
    // Same ride height: a smaller wheel hangs its centre lower in the body.
    w.y = base.wheel.y + (geometry.wheel.radius - base.wheel.radius);
    (ENGINE as { wheelRadius: number }).wheelRadius = geometry.wheel.radius;
    // The chassis box sits a little inside the body, as on the coupé (4.65 × 1.94 m body, 4.5 × 1.88 m box).
    const h = CAR.halfExtents as { x: number; y: number; z: number };
    h.z = geometry.length / 2 - 0.075;
    h.x = geometry.width / 2 - 0.03;
  }
  const v = ENGINE_SOUND.voice as { idleRpm: number; maxRpm: number };
  v.idleRpm = ENGINE.idleRpm;
  v.maxRpm = ENGINE.maxRpm;
}

/** Peak power (kW) and torque (Nm) of the current ENGINE, for car.info. */
export function enginePeak() {
  let kw = 0, nm = 0;
  for (const [rpm, t] of ENGINE.torque) {
    kw = Math.max(kw, (t * rpm * 2 * Math.PI) / 60 / 1000);
    nm = Math.max(nm, t);
  }
  return { kw, nm };
}
