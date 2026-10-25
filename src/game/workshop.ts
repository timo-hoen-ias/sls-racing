import { parseNum, registerCommand, registerToggle } from '../debug/registry.ts';
import { CARS, findCar } from '../vehicle/cars.ts';
import { CAR, ENGINE } from '../vehicle/tuning.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import type { GameEvent } from './events/types.ts';
import type { Progress } from './progress.ts';
import type { Medal, SaveGame } from './save.ts';

// Parts and performance level (P3), the car dealer and the home garage (P4). Medals win parts for six slots;
// fitted parts raise the car's performance level ("Leistungsstufe", LS) and are written over the car's
// tuning after applyCar (cars.ts), so every car keeps its own character. Events name a recommended LS.
// The dealer sells the other cars; the home garage is where the parts are fitted, with fast travel to it.

export const SLOTS = ['motor', 'getriebe', 'reifen', 'bremsen', 'fahrwerk', 'nitro'] as const;
export type Slot = (typeof SLOTS)[number];
export const SLOT_LABELS: Record<Slot, string> = { motor: 'Motor', getriebe: 'Getriebe', reifen: 'Reifen', bremsen: 'Bremsen', fahrwerk: 'Fahrwerk', nitro: 'Nitro' };
/** Part levels: 0 is the stock part. */
export const PART_NAMES = ['Serie', 'Straße', 'Sport', 'Renn', 'Elite', 'Ikone'] as const;
export const MAX_PART = PART_NAMES.length - 1;
/** LS points per part level, by slot. */
const WEIGHT: Record<Slot, number> = { motor: 12, getriebe: 6, reifen: 9, bremsen: 5, fahrwerk: 8, nitro: 5 };

export type PartLevels = Partial<Record<Slot, number>>;

/** Dealer list: price and level from which a car is sold, base performance level. */
export const CAR_SHOP: Record<string, { price: number; level: number; ls: number }> = {
  sportscar: { price: 30000, level: 1, ls: 130 },
  hothatch: { price: 18000, level: 3, ls: 110 },
  gt: { price: 45000, level: 6, ls: 150 },
  rally: { price: 26000, level: 4, ls: 125 },
  muscle: { price: 34000, level: 5, ls: 135 },
  hyper: { price: 120000, level: 12, ls: 185 },
};

/** Performance level of a car with its parts. */
export function ratingOf(carId: string, parts: PartLevels = {}) {
  const base = CAR_SHOP[carId]?.ls ?? 120;
  return Math.round(base + SLOTS.reduce((s, k) => s + (parts[k] ?? 0) * WEIGHT[k], 0));
}

/** Recommended performance level for an event. */
export const recommendedLs = (e: GameEvent) => 100 + e.level * 20;

/**
 * Writes the parts over CAR and ENGINE, which applyCar has just set for the car (in place, like it).
 * Motor: torque; gearbox: faster shifts, a little shorter final drive; tyres: grip; brakes: force;
 * suspension: anti-roll bars, downforce, steering speed; nitro: more push, slower drain.
 */
export function applyParts(parts: PartLevels) {
  const L = (s: Slot) => Math.max(0, Math.min(MAX_PART, parts[s] ?? 0));
  const car = CAR as unknown as {
    tyre: { mu: number }; brake: { force: number }; arb: { front: number; rear: number }; aero: { downforce: number };
    steer: { rate: number }; nitro: { torque: number; drain: number; push: number };
  };
  const engine = ENGINE as unknown as { torque: [number, number][]; shiftTime: number; final: number };
  const m = 1 + 0.06 * L('motor');
  engine.torque = engine.torque.map(([r, t]) => [r, t * m]);
  engine.shiftTime = Math.max(0.03, engine.shiftTime * (1 - 0.1 * L('getriebe')));
  engine.final *= 1 + 0.015 * L('getriebe');
  car.tyre.mu *= 1 + 0.025 * L('reifen');
  car.brake.force *= 1 + 0.07 * L('bremsen');
  const f = L('fahrwerk');
  car.arb.front *= 1 + 0.06 * f;
  car.arb.rear *= 1 + 0.06 * f;
  car.aero.downforce *= 1 + 0.06 * f;
  car.steer.rate *= 1 + 0.03 * f;
  car.nitro.torque *= 1 + 0.04 * L('nitro');
  car.nitro.push *= 1 + 0.06 * L('nitro');
  car.nitro.drain *= 1 - 0.06 * L('nitro');
}

/** The part a medal wins, or undefined (bronze and silver do not always pay one). */
export function partFor(e: GameEvent, medal: Medal, roll = Math.random(), pick = Math.random()): { slot: Slot; level: number } | undefined {
  if (!medal) return undefined;
  const chance = [0, 0.35, 0.6, 1, 1][medal];
  if (roll >= chance) return undefined;
  const level = Math.max(1, Math.min(MAX_PART, Math.round(e.level / 2) + (medal >= 3 ? 1 : 0) + (medal === 4 ? 1 : 0)));
  return { slot: SLOTS[Math.min(SLOTS.length - 1, Math.floor(pick * SLOTS.length))], level };
}

/** Bars 0..1 for the car choice (A3): top speed, acceleration, handling, braking, from the tuning in place. */
export function carStats() {
  let peak = 0;
  for (const [rpm, t] of ENGINE.torque) peak = Math.max(peak, (t * rpm * 2 * Math.PI) / 60);
  const kw = peak / 1000;
  const c = CAR as unknown as { mass: number; aero: { drag: number; downforce: number }; tyre: { mu: number }; brake: { force: number }; arb: { front: number } };
  const top = Math.cbrt(peak / c.aero.drag) * 3.6;
  const clamp = (v: number) => Math.max(0.05, Math.min(1, v));
  return {
    top: clamp((top - 180) / 180),
    accel: clamp((kw / c.mass) * 1000 / 400),
    handling: clamp(((c.tyre.mu - 1.2) / 0.7) * 0.7 + (c.aero.downforce / 2) * 0.3),
    braking: clamp(c.brake.force / c.mass / 18),
    kw, topSpeed: top,
  };
}

/** A spot in town the player drives to: the dealer or the home garage. */
export interface Place { id: 'dealer' | 'home'; name: string; x: number; z: number; heading: number; color: string }

/** Finds the dealer (by the Ford plant's street, else a big road far from home) and the home garage beside the start. */
export function findPlaces(graph: RoadGraph, home: { x: number; z: number }): Place[] {
  const side = (e: RoadGraph['edges'][number], d: number) => {
    const at = Math.min(e.p.length / 3 - 2, Math.max(0, Math.floor(e.p.length / 6)));
    const [x0, z0, x1, z1] = [e.p[at * 3], e.p[at * 3 + 2], e.p[at * 3 + 3], e.p[at * 3 + 5]];
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1;
    // Right of the road, looking along it (x east, z south: right is (-dz, dx)).
    return { x: x0 - (dz / l) * d, z: z0 + (dx / l) * d, heading: Math.atan2(dx / l, -dz / l) };
  };
  const named = graph.edges.filter((e) => !e.noCars && /Henry-Ford-Straße/.test(e.name) && e.length > 60).sort((a, b) => b.length - a.length)[0]
    ?? graph.edges.filter((e) => !e.noCars && e.rank >= 5 && e.length > 80)
      .sort((a, b) => Math.hypot(b.p[0] - home.x, b.p[2] - home.z) - Math.hypot(a.p[0] - home.x, a.p[2] - home.z))[0];
  const out: Place[] = [];
  if (named) out.push({ id: 'dealer', name: 'Autohändler', color: '#ffb000', ...side(named, named.width / 2 + 4) });
  const s = graph.snap(home.x, home.z, 400, (e) => !e.noCars && e.rank >= 2 && e.rank <= 4 && e.length > 30);
  const homeEdge = s?.edge;
  if (homeEdge) out.push({ id: 'home', name: 'Heimatgarage', color: '#3aa0ff', ...side(homeEdge, homeEdge.width / 2 + 4) });
  return out;
}

export interface WorkshopDeps {
  save: SaveGame;
  progress: Progress;
  /** Car in use and switching (vehicle/garage.ts). */
  current(): string;
  select(id: string): Promise<unknown>;
  /** Re-applies the current car's tuning with its parts (after fitting). */
  retune(): void;
  toast(text: string, seconds?: number): void;
}

export class Workshop {
  /** Better parts won are fitted at once. */
  autofit = true;
  private d: WorkshopDeps;

  constructor(d: WorkshopDeps) {
    this.d = d;
    const s = d.save.data;
    if (!s.cars.includes(s.car)) s.cars.push(s.car);
  }

  parts(carId = this.d.current()): PartLevels {
    return (this.d.save.data.parts[carId] ??= {}) as PartLevels;
  }

  rating(carId = this.d.current()) { return ratingOf(carId, this.parts(carId)); }
  owned(carId: string) { return this.d.save.data.cars.includes(carId); }
  spare(slot: Slot, level: number) { return this.d.save.data.inventory[`${slot}:${level}`] ?? 0; }

  /** Spare parts as [slot, level, count], best first. */
  inventory(): [Slot, number, number][] {
    return Object.entries(this.d.save.data.inventory)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => { const [s, l] = k.split(':'); return [s as Slot, +l, n] as [Slot, number, number]; })
      .sort((a, b) => b[1] - a[1] || SLOTS.indexOf(a[0]) - SLOTS.indexOf(b[0]));
  }

  /** Called with each event result: a medal may win a part. */
  reward(e: GameEvent, medal: Medal): string | undefined {
    const p = partFor(e, medal);
    if (!p) return undefined;
    this.give(p.slot, p.level);
    const name = `${SLOT_LABELS[p.slot]} ${PART_NAMES[p.level]}`;
    if (this.autofit && (this.parts()[p.slot] ?? 0) < p.level) { this.fit(p.slot, p.level); return `${name} eingebaut`; }
    return name;
  }

  give(slot: Slot, level: number, n = 1) {
    const inv = this.d.save.data.inventory, k = `${slot}:${level}`;
    inv[k] = (inv[k] ?? 0) + n;
    this.d.save.touch();
  }

  /** Fits a spare part (the old one goes back to the spares); level 0 puts the stock part back. */
  fit(slot: Slot, level: number, carId = this.d.current()) {
    const parts = this.parts(carId);
    const old = parts[slot] ?? 0;
    if (old === level) return;
    if (level > 0 && this.spare(slot, level) <= 0) throw new Error(`kein ${SLOT_LABELS[slot]} ${PART_NAMES[level]} im Lager`);
    const inv = this.d.save.data.inventory;
    if (level > 0) inv[`${slot}:${level}`]--;
    if (old > 0) inv[`${slot}:${old}`] = (inv[`${slot}:${old}`] ?? 0) + 1;
    parts[slot] = level;
    this.d.save.touch();
    if (carId === this.d.current()) this.d.retune();
  }

  /** Fits the best spare part in every slot. */
  fitBest(carId = this.d.current()) {
    let n = 0;
    for (const s of SLOTS) {
      const best = this.inventory().find(([slot]) => slot === s)?.[1] ?? 0;
      if (best > (this.parts(carId)[s] ?? 0)) { this.fit(s, best, carId); n++; }
    }
    return n;
  }

  /** Buys a car at the dealer. */
  buy(carId: string): string {
    const spec = findCar(carId);
    const shop = CAR_SHOP[carId];
    if (!spec || !shop) throw new Error(`unbekanntes Auto: ${carId}`);
    if (this.owned(carId)) return `${spec.label}: schon in der Garage`;
    if (this.d.progress.level < shop.level) return `${spec.label}: ab Stufe ${shop.level}`;
    if (!this.d.progress.spend(shop.price)) return `${spec.label}: ${shop.price.toLocaleString('de-DE')} Credits nötig`;
    this.d.save.data.cars.push(carId);
    this.d.save.touch();
    return `${spec.label} gekauft`;
  }

  /** Drives an owned car from now on. */
  async use(carId: string) {
    if (!this.owned(carId)) throw new Error(`${findCar(carId)?.label ?? carId}: nicht in der Garage`);
    this.d.save.data.car = carId;
    this.d.save.touch();
    await this.d.select(carId);
  }

  registerCommands(goTo: (id: Place['id']) => string) {
    registerCommand({ name: 'parts.list', help: 'Eingebaute Teile des Autos, Lager und Leistungsstufe', run: () => {
      const p = this.parts();
      return [`${findCar(this.d.current())?.label ?? this.d.current()} · LS ${this.rating()}`,
        ...SLOTS.map((s) => `${SLOT_LABELS[s].padEnd(9)} ${PART_NAMES[p[s] ?? 0]}`),
        `Lager: ${this.inventory().map(([s, l, n]) => `${n}× ${SLOT_LABELS[s]} ${PART_NAMES[l]}`).join(', ') || 'leer'}`].join('\n');
    } });
    const slotOf = (v: string) => {
      const s = SLOTS.find((x) => x === v?.toLowerCase() || SLOT_LABELS[x].toLowerCase() === v?.toLowerCase());
      if (!s) throw new Error(`Slot: ${SLOTS.join(', ')}`);
      return s;
    };
    registerCommand({ name: 'parts.give', help: 'Ein Teil ins Lager legen (Slot, Stufe 1–5)', args: '<slot> [stufe]', complete: () => [...SLOTS], run: ([s, l]) => {
      const slot = slotOf(s), level = parseNum(l ?? '3', 'Stufe', 1, MAX_PART);
      this.give(slot, level);
      return `${SLOT_LABELS[slot]} ${PART_NAMES[level]} im Lager`;
    } });
    registerCommand({ name: 'parts.fit', help: 'Teil aus dem Lager einbauen (Stufe 0: Serienteil)', args: '<slot> <stufe>', complete: () => [...SLOTS], run: ([s, l]) => {
      const slot = slotOf(s), level = parseNum(l ?? '0', 'Stufe', 0, MAX_PART);
      this.fit(slot, level);
      return `${SLOT_LABELS[slot]} ${PART_NAMES[level]} · LS ${this.rating()}`;
    } });
    registerCommand({ name: 'parts.best', help: 'Die besten Teile aus dem Lager einbauen', run: () => `${this.fitBest()} Teile eingebaut · LS ${this.rating()}` });
    registerCommand({ name: 'parts.max', help: 'Alle Slots mit dem besten Teil (Ikone) bestücken', run: () => {
      for (const s of SLOTS) { this.give(s, MAX_PART); this.fit(s, MAX_PART); }
      return `LS ${this.rating()}`;
    } });
    registerCommand({ name: 'parts.clear', help: 'Alle Teile ausbauen (zurück ins Lager)', run: () => { for (const s of SLOTS) this.fit(s, 0); return `LS ${this.rating()}`; } });
    registerToggle('parts.autofit', 'Gewonnene bessere Teile sofort einbauen', () => this.autofit, (v) => (this.autofit = v));
    registerCommand({ name: 'car.rating', help: 'Leistungsstufe (LS) aller Autos mit ihren Teilen', run: () =>
      CARS.map((c) => `${c.id === this.d.current() ? '▶' : ' '} ${c.label.padEnd(16)} LS ${String(this.rating(c.id)).padStart(3)}${this.owned(c.id) ? '' : ` · ${CAR_SHOP[c.id]?.price.toLocaleString('de-DE')} Cr ab Stufe ${CAR_SHOP[c.id]?.level}`}`).join('\n') });
    registerCommand({ name: 'car.buy', help: 'Auto beim Händler kaufen (Credits, Stufe)', args: '<id>', complete: () => CARS.map((c) => c.id), run: ([id]) => this.buy(id ?? '') });
    registerCommand({ name: 'car.own', help: 'Auto ohne Kosten in die Garage stellen (Debug)', args: '<id>', complete: () => CARS.map((c) => c.id), run: ([id]) => {
      if (!findCar(id ?? '')) throw new Error('unbekanntes Auto');
      if (!this.owned(id)) this.d.save.data.cars.push(id);
      this.d.save.touch();
      return `${findCar(id)!.label} in der Garage`;
    } });
    registerCommand({ name: 'car.use', help: 'Eigenes Auto fahren (wird im Spielstand gemerkt)', args: '<id>', complete: () => this.d.save.data.cars, run: ([id]) => { void this.use(id ?? '').catch((e) => this.d.toast(String((e as Error).message), 2)); return id ?? ''; } });
    registerCommand({ name: 'garage.tp', help: 'Schnellreise zur Heimatgarage', run: () => goTo('home') });
    registerCommand({ name: 'dealer.tp', help: 'Zum Autohändler fahren (Schnellreise)', run: () => goTo('dealer') });
  }
}
