import type { EngineSound } from '../audio/engineSound.ts';
import { registerChoice, registerCommand } from '../debug/registry.ts';
import type { CarPhysics } from './carPhysics.ts';
import { applyCar, CARS, type CarSpec, DEFAULT_CAR, enginePeak, findCar } from './cars.ts';
import type { CarView } from './carView.ts';
import { loadSportsCar } from './sportsCarGlb.ts';
import type { CarGeometry } from './sportsCarModel.ts';
import { CAR, ENGINE, ENGINE_SOUND } from './tuning.ts';

// Switches the player car at runtime: loads the GLB, retunes physics, engine and sound, swaps the body.

export interface GarageContext {
  car: CarPhysics;
  view: CarView;
  sound: () => EngineSound | undefined;
  /** Message for the player (toast). */
  notify?(text: string): void;
  /** After a switch (rev counter range …). */
  onChange?(spec: CarSpec): void;
  /** After a new body is in place: paint, rims … (vehicle/looks.ts). */
  onModel?(spec: CarSpec): void;
  /** Right after applyCar, before the physics takes the tuning over: fitted parts (game/workshop.ts). */
  afterApply?(spec: CarSpec): void;
}

export class Garage {
  current: CarSpec = findCar(DEFAULT_CAR)!;
  /** Cars whose GLB answered the probe (the coupé is always there). */
  readonly available = new Set<string>([DEFAULT_CAR]);
  private c: GarageContext;
  private pending = 0;
  private geometry?: CarGeometry;

  constructor(c: GarageContext) {
    this.c = c;
  }

  /** Looks which car models are deployed (the dev server answers missing files with the HTML page). */
  async probe() {
    await Promise.all(CARS.map(async (spec) => {
      try {
        const r = await fetch(spec.url, { method: 'HEAD' });
        if (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')) this.available.add(spec.id);
      } catch { /* offline: keep what is known */ }
    }));
    return [...this.available];
  }

  /** Loads and switches to a car; keeps the current one when its model is missing. */
  async select(id: string): Promise<string> {
    const spec = findCar(id);
    if (!spec) throw new Error(`unbekanntes Auto: ${id}`);
    const ticket = ++this.pending;
    const { car, view } = this.c;
    const model = await loadSportsCar('#' + view.paintColor.getHexString(), spec.url).catch((e) => {
      console.warn(`[car] ${spec.url} nicht geladen`, e);
      return undefined;
    });
    if (ticket !== this.pending) return 'überholt';
    if (!model) {
      const msg = `${spec.label}: Modell noch nicht verfügbar`;
      this.c.notify?.(msg);
      return msg;
    }
    this.available.add(spec.id);
    this.geometry = model.geometry;
    applyCar(spec, model.geometry);
    this.c.afterApply?.(spec);
    car.rebuild();
    // A bigger wheel must not start inside the road.
    const p = car.body.translation();
    car.body.setTranslation({ x: p.x, y: p.y + 0.15, z: p.z }, true);
    view.setModel(model, 'glb');
    this.c.onModel?.(spec);
    this.c.sound()?.setProfile(ENGINE_SOUND);
    this.current = spec;
    this.c.onChange?.(spec);
    this.c.notify?.(spec.label);
    return `${spec.label} · ${describe()}`;
  }

  /** Runs fn with another car's tuning (and parts) in CAR/ENGINE, for its key figures; the current car comes back. */
  measure<T>(spec: CarSpec, fn: () => T): T {
    applyCar(spec);
    this.c.afterApply?.(spec);
    try {
      return fn();
    } finally {
      applyCar(this.current, this.geometry);
      this.c.afterApply?.(this.current);
    }
  }

  /** Applies the current car's tuning again (fitted parts changed), keeping body and position. */
  retune() {
    applyCar(this.current, this.geometry);
    this.c.afterApply?.(this.current);
    this.c.car.rebuild();
    this.c.sound()?.setProfile(ENGINE_SOUND);
    this.c.onChange?.(this.current);
  }
}

/** Key figures of the current CAR/ENGINE. */
function describe() {
  const { kw, nm } = enginePeak();
  const w = CAR.wheel;
  const drive = CAR.frontDrive <= 0 ? 'Heck' : CAR.frontDrive >= 1 ? 'Front' : `Allrad ${Math.round(CAR.frontDrive * 100)}/${Math.round((1 - CAR.frontDrive) * 100)}`;
  return `${CAR.mass} kg · ${Math.round(kw)} kW (${Math.round(kw * 1.36)} PS) · ${Math.round(nm)} Nm · ${ENGINE.gears.length} Gänge · ${drive} · Radstand ${(w.front - w.rear).toFixed(2)} m · Spur ${(2 * w.x).toFixed(2)} m · Rad ${(w.radius * 2).toFixed(2)} m`;
}

export function registerGarageCommands(g: Garage) {
  const labels = Object.fromEntries(CARS.map((c) => [c.id, c.label]));
  registerChoice('car.select', 'Auto wählen (lädt Modell, Motor, Klang und Fahrwerk)', CARS.map((c) => c.id), () => g.current.id, (v) => {
    g.select(v).then((m) => console.info(`[car] ${m}`), (e) => console.warn('[car]', e));
  }, labels);
  registerCommand({
    name: 'car.list',
    help: 'Alle Autos, mit Kennung, Beschreibung und ob das Modell schon da ist',
    run: () => {
      void g.probe();
      return CARS.map((c) => `${c.id === g.current.id ? '▶' : ' '} ${c.id.padEnd(10)} ${c.label} · ${c.info}${g.available.has(c.id) ? '' : ' (Modell nicht gefunden)'}`).join('\n');
    },
  });
  registerCommand({
    name: 'car.specs',
    help: 'Daten des aktuellen Autos: Gewicht, Leistung, Antrieb, Radstand',
    run: () => `${g.current.label} · ${describe()}`,
  });
}
