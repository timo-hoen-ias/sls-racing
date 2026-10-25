import type { EngineSoundProfile } from '../audio/engineSound.ts';
import type { EngineSpec } from './drivetrain.ts';
import type { CarGeometry } from './sportsCarModel.ts';
import { CAR, ENGINE, ENGINE_SOUND, scaleCar, VEHICLE } from './tuning.ts';

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
  {
    id: 'muscle',
    label: 'Muscle-Car',
    info: '7,0-l-V8 mit Drehmoment ab Standgas, schwer, Heckantrieb, quer aus jeder Kurve',
    url: `${MODELS}cars/muscle.glb`,
    tuning: {
      mass: 1720,
      arb: { front: 32000, rear: 15000 },
      diff: { rear: 3.4 },
      frontDrive: 0,
      aero: { drag: 0.56, downforce: 0.55, balance: 0.45 },
      brake: { force: 19000 },
      steer: { rate: 3.5 },
    },
    engine: {
      idleRpm: 700,
      shiftRpm: 6200,
      maxRpm: 6600,
      // ~720 Nm from 3 000/min, ~420 kW at 5 600/min.
      torque: [[700, 460], [1800, 620], [3000, 720], [4500, 710], [5600, 640], [6600, 520]],
      gears: [2.97, 1.95, 1.4, 1.08, 0.86, 0.7],
      final: 3.42,
      stallRpm: 2600,
      engineBrake: { base: 46, perRpm: 0.017 },
    },
    sound: {
      voice: { cylinders: 8, lumpy: 0.28, irregular: 0.2, pulse: { noise: 0.3, tone: 0.8, toneHz: 180, decay: 0.84, color: 1 } },
      resonances: [{ freq: 90, q: 2, gain: 7 }, { freq: 520, q: 2, gain: 4 }, { freq: 2000, q: 3, gain: 2 }],
      drive: 0.6,
      lpIdle: 900,
      lpFull: 5600,
      intake: 0.1,
      pops: 0.8,
      shiftPop: 0.6,
    },
  },
  {
    id: 'rally',
    label: 'Rallye-Kompakter',
    info: '2,0-l-Turbo mit Antilag, Allrad, weiches langes Fahrwerk, fliegt über Kuppen und Schotter',
    url: `${MODELS}cars/rally.glb`,
    tuning: {
      mass: 1260,
      wheel: { travel: 0.24 },
      suspension: { stiffness: 40, compression: 3.6, relaxation: 4.2 },
      arb: { front: 20000, rear: 19000 },
      diff: { front: 2, rear: 2.4 },
      frontDrive: 0.5,
      aero: { drag: 0.5, downforce: 0.6, balance: 0.48 },
      brake: { force: 16500, bias: 0.6 },
      steer: { rate: 4.6, lowSpeed: 0.65 },
    },
    engine: {
      idleRpm: 950,
      shiftRpm: 7200,
      maxRpm: 7500,
      // Antilag turbo: ~480 Nm flat from 3 000/min, ~285 kW.
      torque: [[950, 280], [2000, 420], [3000, 480], [5500, 480], [6500, 430], [7500, 340]],
      gears: [3.3, 2.15, 1.6, 1.25, 1.02, 0.85],
      final: 4.6,
      stallRpm: 3200,
      shiftTime: 0.06,
      engineBrake: { base: 26, perRpm: 0.012 },
    },
    sound: {
      voice: { cylinders: 4, lumpy: 0.08, irregular: 0.12, pulse: { noise: 0.45, tone: 0.55, toneHz: 290, decay: 0.7, color: 0.8 } },
      resonances: [{ freq: 160, q: 2, gain: 5 }, { freq: 1000, q: 2.2, gain: 5 }, { freq: 2800, q: 3, gain: 4 }],
      drive: 0.8,
      lpIdle: 1200,
      lpFull: 7500,
      turbo: { ratio: 44, gain: 0.05 },
      intake: 0.08,
      pops: 1,
      shiftPop: 1,
    },
  },
  {
    id: 'hyper',
    label: 'Hypercar',
    info: 'V12-Mittelmotor, 9 000/min, viel Abtrieb, das schnellste Auto im Spiel',
    url: `${MODELS}cars/hyper.glb`,
    tuning: {
      mass: 1320,
      arb: { front: 30000, rear: 24000 },
      diff: { front: 1.4, rear: 2.4 },
      frontDrive: 0.25,
      aero: { drag: 0.42, downforce: 1.9, balance: 0.44 },
      brake: { force: 22000, bias: 0.6 },
      steer: { rate: 4.2 },
    },
    engine: {
      idleRpm: 1000,
      shiftRpm: 8700,
      maxRpm: 9000,
      // ~720 Nm at 6 000/min, ~600 kW at 8 500/min.
      torque: [[1000, 340], [3000, 560], [6000, 720], [7500, 710], [8500, 670], [9000, 600]],
      gears: [3.3, 2.35, 1.8, 1.45, 1.2, 1.0, 0.84],
      final: 3.5,
      stallRpm: 3800,
      shiftTime: 0.05,
      engineBrake: { base: 36, perRpm: 0.013 },
    },
    sound: {
      voice: { cylinders: 12, lumpy: 0.04, irregular: 0.06, pulse: { noise: 0.2, tone: 0.8, toneHz: 340, decay: 0.7, color: 0.9 } },
      resonances: [{ freq: 180, q: 2, gain: 4 }, { freq: 1200, q: 2.2, gain: 5 }, { freq: 3200, q: 3, gain: 4 }],
      drive: 0.5,
      lpIdle: 1300,
      lpFull: 9000,
      intake: 0.1,
      pops: 0.5,
      shiftPop: 0.6,
    },
  },
  // Imported CC-BY models (tools/import-car.ts, credits in CREDITS.md): real textures and interiors.
  {
    id: 'coupe',
    label: 'Sportcoupé RS',
    info: '4,4-l-V8-Biturbo vorn, Heckantrieb, breite Spur, Innenraum und echte Texturen',
    url: `${MODELS}cars/coupe.glb`,
    tuning: {
      mass: 1520,
      arb: { front: 30000, rear: 20000 },
      diff: { rear: 2.8 },
      frontDrive: 0,
      aero: { drag: 0.46, downforce: 0.9, balance: 0.45 },
      brake: { force: 19000 },
      steer: { rate: 3.8 },
    },
    engine: {
      idleRpm: 750,
      shiftRpm: 6900,
      maxRpm: 7200,
      // Twin-turbo plateau: ~650 Nm from 2 000/min, ~440 kW at 6 500/min.
      torque: [[750, 380], [2000, 650], [5000, 650], [6000, 620], [6800, 560], [7200, 500]],
      gears: [3.9, 2.5, 1.75, 1.35, 1.08, 0.88, 0.72],
      final: 3.2,
      stallRpm: 3000,
      shiftTime: 0.07,
      engineBrake: { base: 38, perRpm: 0.015 },
    },
    sound: {
      voice: { cylinders: 8, layout: 'v8', lumpy: 0.12, irregular: 0.12, pulse: { noise: 0.28, tone: 0.75, toneHz: 210, decay: 0.8, color: 0.95 } },
      resonances: [{ freq: 105, q: 2, gain: 6 }, { freq: 680, q: 2, gain: 4 }, { freq: 2300, q: 3, gain: 3 }],
      drive: 0.6,
      lpIdle: 1000,
      lpFull: 6800,
      turbo: { ratio: 36, gain: 0.03 },
      intake: 0.08,
      pops: 0.7,
      shiftPop: 0.6,
    },
  },
  {
    id: 'sedan',
    label: 'Limousine',
    info: '3,0-l-Reihensechser-Turbo, Allrad, lang und ruhig, Innenraum und echte Texturen',
    url: `${MODELS}cars/sedan.glb`,
    tuning: {
      mass: 1720,
      arb: { front: 26000, rear: 20000 },
      diff: { front: 1.6, rear: 2.2 },
      frontDrive: 0.4,
      aero: { drag: 0.44, downforce: 0.4, balance: 0.5 },
      brake: { force: 18500, bias: 0.64 },
      steer: { rate: 3.6 },
    },
    engine: {
      idleRpm: 700,
      shiftRpm: 6600,
      maxRpm: 7000,
      // ~550 Nm from 1 800/min, ~300 kW at 6 000/min.
      torque: [[700, 320], [1800, 550], [4800, 550], [6000, 480], [7000, 380]],
      gears: [4.7, 3.1, 2.1, 1.67, 1.29, 1.0, 0.84, 0.67],
      final: 3.0,
      stallRpm: 2800,
      shiftTime: 0.1,
      engineBrake: { base: 30, perRpm: 0.013 },
    },
    sound: {
      voice: { cylinders: 6, layout: 'i6', lumpy: 0.05, irregular: 0.06, pulse: { noise: 0.25, tone: 0.7, toneHz: 260, decay: 0.76, color: 0.85 } },
      resonances: [{ freq: 130, q: 2, gain: 4 }, { freq: 850, q: 2.2, gain: 3 }, { freq: 2500, q: 3, gain: 2 }],
      drive: 0.5,
      lpIdle: 900,
      lpFull: 6000,
      turbo: { ratio: 38, gain: 0.03 },
      intake: 0.06,
      pops: 0.3,
      shiftPop: 0.3,
    },
  },
  {
    id: 'goblin',
    label: 'V12 Goblin',
    info: 'Supersportler mit V12-Mittelmotor, Heckantrieb, breite Hinterachse, eigenes Design',
    url: `${MODELS}cars/goblin.glb`,
    tuning: {
      mass: 1420,
      arb: { front: 30000, rear: 22000 },
      diff: { rear: 2.6 },
      frontDrive: 0,
      aero: { drag: 0.44, downforce: 1.6, balance: 0.42 },
      brake: { force: 21500, bias: 0.6 },
      steer: { rate: 4.1 },
    },
    engine: {
      idleRpm: 1000,
      shiftRpm: 8500,
      maxRpm: 8800,
      // ~690 Nm at 6 000/min, ~560 kW at 8 200/min.
      torque: [[1000, 330], [3000, 540], [6000, 690], [7500, 680], [8200, 650], [8800, 580]],
      gears: [3.2, 2.3, 1.78, 1.43, 1.18, 0.99, 0.83],
      final: 3.6,
      stallRpm: 3800,
      shiftTime: 0.05,
      engineBrake: { base: 36, perRpm: 0.013 },
    },
    sound: {
      voice: { cylinders: 12, layout: 'v12', lumpy: 0.04, irregular: 0.07, pulse: { noise: 0.22, tone: 0.8, toneHz: 320, decay: 0.72, color: 0.92 } },
      resonances: [{ freq: 170, q: 2, gain: 4 }, { freq: 1150, q: 2.2, gain: 5 }, { freq: 3300, q: 3, gain: 4 }],
      drive: 0.55,
      lpIdle: 1300,
      lpFull: 8800,
      intake: 0.1,
      pops: 0.6,
      shiftPop: 0.7,
    },
  },
  {
    id: 'offroad',
    label: 'Geländewagen',
    info: '3,6-l-V6 (230 kW), Allrad mit Sperren, viel Federweg und Bodenfreiheit, Geländereifen: für Feldwege, Wiesen und Wald',
    url: `${MODELS}cars/offroad.glb`,
    tuning: {
      mass: 1750,
      com: { y: -0.32 },
      wheel: { rest: 0.36, travel: 0.32 },
      suspension: { stiffness: 30, compression: 3.4, relaxation: 4.4 },
      arb: { front: 26000, rear: 18000 },
      tyre: { mu: 1.3, rearMu: 1.08, slide: 0.9, loose: 0.55 },
      diff: { front: 3, rear: 4 },
      frontDrive: 0.45,
      aero: { drag: 0.75, downforce: 0.15, balance: 0.45, rolling: 0.016 },
      brake: { force: 17000, bias: 0.62 },
      steer: { lowSpeed: 0.66, rate: 3.4 },
    },
    engine: {
      idleRpm: 750,
      shiftRpm: 6000,
      maxRpm: 6400,
      // ~420 Nm from 2 500/min, ~230 kW at 6 000/min.
      torque: [[750, 260], [1500, 340], [2500, 415], [4500, 420], [6000, 365], [6400, 320]],
      gears: [4.7, 3.1, 2.1, 1.65, 1.29, 1.0, 0.84, 0.66],
      final: 3.7,
      stallRpm: 2400,
      shiftTime: 0.18,
      engineBrake: { base: 30, perRpm: 0.011 },
    },
    sound: {
      voice: { cylinders: 6, layout: 'v6', lumpy: 0.12, irregular: 0.1, pulse: { noise: 0.4, tone: 0.6, toneHz: 200, decay: 0.8, color: 0.6 }, header: 0.6, pipe: 3.2, cross: 0.5, intakeLen: 0.5, mech: 0.35 },
      resonances: [{ freq: 110, q: 1.8, gain: 6 }, { freq: 650, q: 2, gain: 4 }, { freq: 2200, q: 3, gain: 2 }],
      drive: 0.6,
      lpIdle: 900,
      lpFull: 5200,
      intake: 0.12,
      pops: 0,
      shiftPop: 0,
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
 * then the car's own values, then the dimensions of its model, all at VEHICLE.scale. Debug changes (car.tune …) are reset.
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
  // Real size above, then everything at the game's vehicle scale (the drivetrain keeps the real wheel radius).
  scaleCar(VEHICLE.scale);
  const v = ENGINE_SOUND.voice as { idleRpm: number; maxRpm: number };
  v.idleRpm = ENGINE.idleRpm;
  v.maxRpm = ENGINE.maxRpm;
}

/** A car's engine sound and gearbox without touching the player's car (the other players' cars online). */
export function carSound(spec: CarSpec) {
  const engine = structuredClone(BASE.engine), sound = structuredClone(BASE.sound);
  delete sound.turbo;
  if (spec.engine) deepAssign(engine, spec.engine as Overrides);
  if (spec.sound) deepAssign(sound, spec.sound);
  const e = engine as unknown as typeof ENGINE;
  const profile = sound as unknown as typeof ENGINE_SOUND;
  profile.voice = { ...profile.voice, idleRpm: e.idleRpm, maxRpm: e.maxRpm };
  return { profile, engine: e };
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
