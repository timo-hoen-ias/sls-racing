import type * as THREE from 'three';
import type { GameSfx } from '../audio/gameSfx.ts';
import { registerChoice, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Navigation } from '../nav/navigation.ts';
import type { MapMarker } from '../ui/mapDraw.ts';
import { EventHud } from '../ui/eventHud.ts';
import { EventList, ProgressBadge, TitleMenu } from '../ui/gameMenus.ts';
import { type CarRow, type GarageData, GarageMenu } from '../ui/garageMenu.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { type BarrierView, findBarriers } from './events/barriers.ts';
import { generateEvents, mergeEvents } from './events/generate.ts';
import { GateView, TYPE_COLORS } from './events/gates.ts';
import { distanceToPath, EventRunner } from './events/runner.ts';
import { crossed, EVENT_LABELS, formatValue, type GameEvent, type Gate, RACE_TYPES } from './events/types.ts';
import { Progress } from './progress.ts';
import { MEDAL_NAMES, SaveGame } from './save.ts';
import { LineTracker, RIVAL_LEVELS, type RivalLevel, type Rivals } from './rivals.ts';
import type { StyleEvent } from './style.ts';
import { PlaceView } from './placeView.ts';
import { CAR_SHOP, findPlaces, PART_NAMES, type Place, ratingOf, recommendedLs, SLOT_LABELS, SLOTS, Workshop } from './workshop.ts';
import { CARS } from '../vehicle/cars.ts';

// The game around the driving (G1): spielstand, level and credits, the events in town with their gates and
// HUD, the title screen and the event list. main.ts feeds it the car each frame and asks it whether the
// controls are locked (countdown) and where a reset goes (the last checkpoint in a race).

export interface GameDeps {
  graph: RoadGraph;
  scene: THREE.Scene;
  hud: HTMLElement;
  start: HTMLButtonElement;
  nav: Navigation;
  sfx: GameSfx;
  tilesUrl: string;
  toast(text: string, seconds?: number): void;
  rumble(strength: number, ms: number): void;
  /** Puts the car at (x, z) facing heading; the world streams in first. */
  teleport(x: number, z: number, heading: number): void;
  /** True once the car stands on loaded ground (not while a teleport holds it). */
  ready(): boolean;
  /** The play button was pressed (audio starts there). */
  onPlay(): void;
  openOptions(): void;
  openGarage?(): void;
  /** AI rivals for races (V3). */
  rivals?: Rivals;
  /** Fences across side streets during races (S6). */
  barriers?: BarrierView;
  /** The player car's garage (vehicle/garage.ts): parts, dealer and home garage need it (P3, P4). */
  cars?: CarControl;
  /** Where the home garage goes (beside the start). */
  home?: { x: number; z: number };
  /** Ground height for markers. */
  groundAt?(x: number, z: number): number | undefined;
}

/** What the game needs from vehicle/garage.ts. */
export interface CarControl {
  current(): string;
  select(id: string): Promise<unknown>;
  retune(): void;
  /** Key figures of a car with its parts, 0..1 bars. */
  stats(id: string): CarRow['stats'];
}

export interface CarNow {
  x: number;
  z: number;
  /** m/s, along the ground. */
  speed: number;
  dt: number;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const headingOf = (g: Gate) => Math.atan2(g.dx, -g.dz);

export class Game {
  readonly save = new SaveGame();
  readonly progress = new Progress(this.save);
  readonly runner = new EventRunner();
  readonly gates = new GateView();
  readonly hud: EventHud;
  readonly title: TitleMenu;
  readonly list: EventList;
  readonly badge: ProgressBadge;
  events: GameEvent[] = [];
  /** Events in free roam: skill gates start runs, race starts show a prompt. */
  enabled = true;
  /** Checkpoint navigation in races (U4). */
  checkpointNav = true;
  /** Options menu or console open: menus here do not read the pad. */
  blocked = false;
  private d: GameDeps;
  private prev?: { x: number; z: number };
  private pending?: GameEvent;
  private promptEvent?: GameEvent;
  private savedDest?: { x: number; z: number };
  private navGate = -1;
  private badgeTimer = 0;
  private lastRace?: GameEvent;
  private track?: LineTracker;
  private retrack = false;
  /** Rivals per race; undefined: as the event says. */
  rivalCount?: number;
  /** Parts, dealer and home garage (P3, P4); without a car control (tests) there are none. */
  readonly workshop?: Workshop;
  readonly garageMenu?: GarageMenu;
  places: Place[] = [];
  private placeView = new PlaceView();
  private promptPlace?: Place;
  private menuMode: GarageData['mode'] = 'home';

  constructor(d: GameDeps) {
    this.d = d;
    d.scene.add(this.gates.root);
    this.hud = new EventHud(d.hud);
    this.badge = new ProgressBadge(d.hud);
    this.title = new TitleMenu(d.hud, d.start, {
      play: () => this.play(),
      events: () => this.openList(),
      garage: () => { this.play(); this.openGarage('home'); },
      options: () => d.openOptions(),
    });
    this.list = new EventList(d.hud, {
      navigate: (e) => { this.list.hide(); d.nav.setDestination(e.start.x, e.start.z, this.prev?.x ?? e.start.x, this.prev?.z ?? e.start.z); d.toast(`Navi: ${e.name}`, 1.5); },
      go: (e) => { this.list.hide(); this.goTo(e); },
      close: () => this.list.hide(),
    });
    const cars = d.cars;
    if (cars) {
      const shop = this.workshop = new Workshop({ save: this.save, progress: this.progress, current: () => cars.current(), select: (id) => cars.select(id), retune: () => cars.retune(), toast: d.toast });
      const after = () => this.garageMenu?.render();
      const act = (fn: () => unknown) => {
        try {
          const r = fn();
          if (typeof r === 'string') d.toast(r, 1.8);
          if (r instanceof Promise) void r.then(after, (e) => d.toast(String((e as Error).message), 2));
        } catch (e) { d.toast(String((e as Error).message), 2); }
        after();
      };
      this.garageMenu = new GarageMenu(d.hud, {
        use: (id) => act(() => shop.use(id)),
        buy: (id) => act(() => { const m = shop.buy(id); if (shop.owned(id)) void shop.use(id).then(after); return m; }),
        fit: (slot, level) => act(() => shop.fit(slot as (typeof SLOTS)[number], level)),
        fitBest: () => act(() => `${shop.fitBest()} Teile eingebaut`),
        close: () => this.garageMenu?.hide(),
      });
      d.scene.add(this.placeView.root);
      this.places = findPlaces(d.graph, d.home ?? { x: 0, z: 0 });
      this.placeView.set(this.places, (x, z) => d.groundAt?.(x, z) ?? d.graph.snap(x, z, 80)?.y);
    }
    this.hud.onRetry = () => { this.hud.hideCard(); this.runner.close(); this.endRivals(); if (this.lastRace) this.goTo(this.lastRace); };
    this.hud.onClose = () => { this.hud.hideCard(); this.runner.close(); this.endRivals(); };
    this.runner.best = (id) => this.save.data.events[id]?.best;
    this.wireRunner();
    this.progress.onLevelUp = (l) => { d.sfx.play('levelup'); d.toast(`Stufe ${l} erreicht!`, 2.5); d.rumble(0.6, 300); };
    this.save.onChange = () => (this.badgeTimer = 0);
    this.refreshBadge();
  }

  /** Builds the events from the road graph, plus hand-made ones from events.json. */
  async load() {
    const t = performance.now();
    const generated = generateEvents(this.d.graph);
    // events.json: hand-made events, and generated ones the event test (pipeline/eventtest.ts) left out.
    let file: { events?: GameEvent[]; drop?: string[] } = {};
    try {
      const r = await fetch(`${this.d.tilesUrl}/events.json`);
      if (r.ok && r.headers.get('content-type')?.includes('json')) file = await r.json();
    } catch { /* optional file */ }
    this.events = mergeEvents(generated, file.events, file.drop);
    console.info(`[events] ${this.events.length} Events in ${Math.round(performance.now() - t)} ms`);
  }

  get inGame() { return !this.title.open; }
  /** Overlays that take the input (title, list, result card). */
  get overlay() { return this.title.open || this.list.open || this.hud.cardOpen || !!this.garageMenu?.open; }
  /** Controls locked: countdown, or waiting to put the car on a race start. */
  get locked() { return this.runner.state === 'countdown' || !!this.pending; }
  get racing() { return this.runner.racing; }

  private play() {
    if (!this.title.open) return;
    this.title.open = false;
    this.d.start.hidden = true;
    this.d.onPlay();
  }

  openList() {
    if (this.runner.busy) { this.d.toast('Erst das laufende Event beenden', 2); return; }
    const p = this.prev ?? { x: 0, z: 0 };
    this.list.show(this.events, this.save.data, p.x, p.z, this.progress.level, this.workshop?.rating());
  }

  /** Home garage (parts, own cars) or dealer (buy cars). */
  openGarage(mode: GarageData['mode']) {
    const shop = this.workshop, menu = this.garageMenu, cars = this.d.cars;
    if (!shop || !menu || !cars) return;
    if (this.runner.busy) { this.d.toast('Erst das laufende Event beenden', 2); return; }
    this.menuMode = mode;
    const statCache = new Map<string, CarRow['stats']>();
    menu.show(() => {
      const cur = cars.current();
      const parts = shop.parts();
      const inv = shop.inventory();
      return {
        mode: this.menuMode,
        ls: shop.rating(),
        credits: this.progress.credits,
        cars: CARS.map((c) => {
          const sale = CAR_SHOP[c.id] ?? { price: 0, level: 1, ls: 120 };
          // Figures of the car in use change with its parts; the others are measured once per opening.
          const key = `${c.id}:${c.id === cur ? JSON.stringify(parts) : ''}`;
          if (!statCache.has(key)) statCache.set(key, cars.stats(c.id));
          return { id: c.id, label: c.label, info: c.info, owned: shop.owned(c.id), current: c.id === cur, ls: ratingOf(c.id, shop.parts(c.id)),
            price: sale.price, level: sale.level, locked: this.progress.level < sale.level, stats: statCache.get(key)! };
        }),
        slots: SLOTS.map((s) => ({ slot: s, label: SLOT_LABELS[s], level: parts[s] ?? 0, name: PART_NAMES[parts[s] ?? 0],
          spares: inv.filter(([slot]) => slot === s).map(([, l, n]) => ({ level: l, name: PART_NAMES[l], count: n })) })),
      };
    });
  }

  /** Fast travel to the home garage or the dealer. */
  goToPlace(id: Place['id']) {
    const p = this.places.find((x) => x.id === id);
    if (!p) throw new Error('Ort nicht gefunden');
    if (this.title.open) this.play();
    if (this.runner.busy) this.runner.abort('Abgebrochen');
    this.d.teleport(p.x - Math.sin(p.heading) * 10, p.z + Math.cos(p.heading) * 10, p.heading);
    this.prev = undefined;
    return p.name;
  }

  /** Fast travel to an event's start; races then start with a countdown. */
  goTo(e: GameEvent, force = false) {
    if (!force && e.level > this.progress.level) { this.d.toast(`${e.name}: ab Stufe ${e.level}`, 1.8); return; }
    if (this.title.open) this.play();
    if (this.runner.busy) this.runner.abort('Abgebrochen');
    const back = RACE_TYPES.has(e.type) ? (this.fieldOf(e) ? 14 : 6) : 60;
    // Speed traps start at their run-up, far enough back to reach the gold speed.
    const r = e.extra?.runup;
    if (r) this.d.teleport(r.x, r.z, headingOf(r));
    else this.d.teleport(e.start.x - e.start.dx * back, e.start.z - e.start.dz * back, headingOf(e.start));
    this.pending = RACE_TYPES.has(e.type) ? e : undefined;
    this.prev = undefined;
  }

  /** Where a reset puts the car during a race; undefined outside races. */
  resetSpot() {
    const g = this.runner.racing ? this.runner.lastGate : undefined;
    if (!g) return undefined;
    return { x: g.x + g.dx * 4, z: g.z + g.dz * 4, heading: headingOf(g) };
  }

  style(e: StyleEvent) {
    this.runner.style(e);
  }

  /** Called on 'interact' (F / pad →). */
  interact() {
    if (this.hud.cardOpen) { this.hud.onClose?.(); return; }
    if (this.garageMenu?.open) return;
    if (this.promptPlace && !this.runner.busy) { this.openGarage(this.promptPlace.id); return; }
    const e = this.promptEvent;
    if (!e || this.runner.busy) return;
    if (e.level > this.progress.level) { this.d.toast(`ab Stufe ${e.level}`, 1.5); return; }
    this.goTo(e);
  }

  update(car: CarNow) {
    const { dt } = car;
    const d = this.d;
    this.save.update(dt);
    if (!this.blocked) { this.title.poll(dt); this.list.poll(dt); this.hud.poll(dt); this.garageMenu?.poll(dt); }
    this.placeView.update(dt);
    if ((this.badgeTimer -= dt) <= 0) this.refreshBadge();
    this.badge.visible = this.inGame;
    const ready = d.ready();
    // A race waits until the car stands on its start, then counts down.
    if (this.pending && ready) {
      const e = this.pending;
      this.pending = undefined;
      this.lastRace = e;
      this.runner.startRace(e);
      this.startRivals(e);
      if (e.path && d.barriers) d.barriers.show(findBarriers(d.graph, e.path));
    }
    if (ready && this.inGame) {
      this.runner.update(dt, car);
      if (!this.runner.busy && this.enabled && this.prev && !this.pending) this.freeRoam(car);
      this.trackPlace(car);
      if (this.runner.racing && this.runner.state === 'running' && this.runner.event?.path && distanceToPath(this.runner.event.path, car.x, car.z) > 150) this.runner.abort('Strecke verlassen');
      this.prev = { x: car.x, z: car.z };
    } else if (!ready) { this.prev = undefined; this.runner.skip(); this.retrack = true; }
    this.gates.showActive(this.runner.busy ? this.runner.event : undefined, this.runner.next);
    this.gates.showMarkers(this.events, car.x, car.z, this.runner.busy || !this.enabled);
    this.gates.update(dt);
    this.hud.update(this.runner, dt);
    this.promptPlace = this.runner.busy || this.overlay || !this.inGame ? undefined : this.places.find((p) => Math.hypot(p.x - car.x, p.z - car.z) < 12);
    const pe = this.runner.busy || this.overlay || this.promptPlace ? undefined : this.promptEvent;
    const ls = this.workshop?.rating();
    this.hud.showPrompt(pe, 'F', !!pe && pe.level > this.progress.level, pe && ls !== undefined && ls < recommendedLs(pe) ? `empf. LS ${recommendedLs(pe)}, deins ${ls}` : undefined);
    this.hud.showPlace(this.promptPlace ? `${this.promptPlace.name} · F zum Betreten` : undefined);
    this.updateNav(car);
  }

  private fieldOf(e: GameEvent) {
    const n = this.rivalCount ?? e.rivals ?? 0;
    return this.d.rivals?.enabled && e.path && e.path.length >= 4 ? n : 0;
  }

  private startRivals(e: GameEvent) {
    const rv = this.d.rivals;
    this.track = undefined;
    if (!rv) return;
    const n = this.fieldOf(e);
    if (!n) { rv.clear(); return; }
    void rv.start(e.path!, e.laps, n);
    if (rv.line) this.track = new LineTracker(rv.line, -14);
    this.runner.field = rv.list.length + 1;
  }

  /** Player's place among the rivals. */
  private trackPlace(car: CarNow) {
    const rv = this.d.rivals;
    if (!rv?.active || !this.track || !this.runner.busy) return;
    if (this.retrack) { this.track.relocate(car.x, car.z); this.retrack = false; }
    else this.track.update(car.x, car.z);
    rv.setPlayer(this.track.raced);
    this.runner.place = rv.place(this.track.raced);
  }

  /** Rivals leave with the result card or a failed run. */
  private endRivals() {
    this.d.rivals?.clear();
    this.d.barriers?.clear();
    this.track = undefined;
  }

  /** Rivals drive (before world.step); they wait on the grid during the countdown. */
  stepRivals(dt: number, player: { x: number; z: number }) {
    this.d.rivals?.step(dt, this.runner.state === 'running' || this.runner.state === 'done', player);
  }

  private freeRoam(car: CarNow) {
    const p = this.prev!;
    let prompt: GameEvent | undefined;
    for (const e of this.events) {
      const g = e.start;
      if (Math.abs(g.x - car.x) > 60 || Math.abs(g.z - car.z) > 60) continue;
      if (RACE_TYPES.has(e.type)) {
        if (Math.hypot(g.x - car.x, g.z - car.z) < 14) prompt = e;
        continue;
      }
      if (!crossed(g, p.x, p.z, car.x, car.z, 1)) continue;
      if (e.level > this.progress.level) { this.d.toast(`${EVENT_LABELS[e.type]}: ab Stufe ${e.level}`, 1.5); continue; }
      this.runner.startSkill(e, car.speed);
      break;
    }
    this.promptEvent = prompt;
  }

  /** In races the navigation leads to the next checkpoint; afterwards the old destination comes back. */
  private updateNav(car: CarNow) {
    const nav = this.d.nav;
    const r = this.runner;
    const on = this.checkpointNav && r.racing && r.state !== 'countdown';
    if (on) {
      const key = r.next + r.lap * 1000;
      if (key !== this.navGate) {
        if (this.navGate < 0) this.savedDest = nav.destination ? { x: nav.destination.x, z: nav.destination.z } : undefined;
        this.navGate = key;
        const g = r.event!.gates[r.next];
        if (g) nav.setDestination(g.x, g.z, car.x, car.z);
      }
    } else if (this.navGate >= 0) {
      this.navGate = -1;
      if (this.savedDest) nav.setDestination(this.savedDest.x, this.savedDest.z, car.x, car.z);
      else nav.clear();
      this.savedDest = undefined;
    }
  }

  private wireRunner() {
    const r = this.runner;
    const { sfx, toast, rumble } = this.d;
    r.onStart = (e) => { if (!RACE_TYPES.has(e.type)) { sfx.play('go', 0.6); toast(`${EVENT_LABELS[e.type]}: ${e.name}`, 1.4); } };
    r.onCountdown = (n) => { this.hud.countdown(n); sfx.play('beep'); };
    r.onGo = () => { this.hud.countdown(0); sfx.play('go'); rumble(0.5, 200); };
    r.onGate = (i, lap) => {
      const e = r.event!;
      if (i < e.gates.length - 1 || (e.laps && lap < e.laps)) sfx.play('checkpoint');
    };
    r.onLap = (lap) => toast(`Runde ${lap}/${r.event?.laps}`, 1.2);
    r.onFail = (e, why) => { this.hud.fail(e, why); sfx.play('fail'); this.endRivals(); };
    r.onFinish = (res) => {
      const e = res.event;
      const rec = this.save.data.events[e.id];
      const before = this.progress.level;
      this.save.data.events[e.id] = {
        best: rec && !res.best ? rec.best : res.value,
        medal: Math.max(rec?.medal ?? 0, res.medal) as typeof res.medal,
        runs: (rec?.runs ?? 0) + 1,
      };
      if (res.medal) this.save.stat(`medal${res.medal}`);
      this.progress.reward(res.xp, res.credits, e.name);
      const part = this.workshop?.reward(e, res.medal);
      if (part) { toast(`Neues Teil: ${part}`, 2.5); sfx.play('discover', 0.7); }
      const after = this.progress.level;
      sfx.play(res.medal >= 3 ? 'medal' : res.medal ? 'finish' : 'fail');
      sfx.play('cash', 0.5);
      this.hud.result(res, RACE_TYPES.has(e.type), after > before ? ` · Stufe ${after}!` : '');
      if (!RACE_TYPES.has(e.type)) r.close();
    };
  }

  private refreshBadge() {
    this.badgeTimer = 1;
    const p = this.progress;
    this.badge.set(p.level, p.toNext, p.credits);
    const medals = Object.values(this.save.data.events).filter((x) => x.medal > 0).length;
    this.title.setStats(p.level, p.toNext, p.credits, medals);
  }

  /** Map icons: every event start, coloured by kind, ringed by the best medal. */
  markers(): MapMarker[] {
    return [
      ...this.events.map((e) => ({ x: e.start.x, z: e.start.z, color: hex(TYPE_COLORS[e.type]), medal: this.save.data.events[e.id]?.medal, big: RACE_TYPES.has(e.type) })),
      ...this.places.map((p) => ({ x: p.x, z: p.z, color: p.color, big: true })),
    ];
  }

  registerCommands(pos: () => { x: number; z: number }) {
    this.save.registerCommands();
    this.progress.registerCommands();
    this.workshop?.registerCommands((id) => this.goToPlace(id));
    registerCommand({ name: 'garage', help: 'Heimatgarage (Autos, Teile) oder Händler öffnen, ohne hinzufahren', args: '[home|dealer]', complete: () => ['home', 'dealer'], run: ([m]) => {
      this.openGarage(m === 'dealer' ? 'dealer' : 'home');
      return this.garageMenu ? 'geöffnet' : 'keine Garage';
    } });
    registerCommand({ name: 'places', help: 'Händler und Heimatgarage: Lage', run: () => this.places.map((p) => `${p.name}: ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`).join('\n') || 'keine Orte' });
    const find = (q: string) => {
      const n = Number(q);
      const e = Number.isInteger(n) ? this.byDistance(pos())[n] : this.events.find((x) => x.id === q) ?? this.events.find((x) => x.name.toLowerCase().includes(q.toLowerCase()));
      if (!e) throw new Error(`kein Event "${q}" (event.list zeigt alle)`);
      return e;
    };
    registerCommand({
      name: 'event.list', help: 'Events nach Entfernung: Nummer, Art, Name, Stufe, Medaille', args: '[art]',
      run: ([type]) => {
        const p = pos();
        const rows = this.byDistance(p).map((e, i) => [i, e] as const).filter(([, e]) => !type || e.type === type);
        const counts: Record<string, number> = {};
        for (const e of this.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
        return [`${this.events.length} Events: ${Object.entries(counts).map(([k, v]) => `${v} ${EVENT_LABELS[k as keyof typeof EVENT_LABELS]}`).join(', ')}`,
          ...rows.slice(0, 25).map(([i, e]) => {
            const rec = this.save.data.events[e.id];
            return `${i}: ${EVENT_LABELS[e.type]} · ${e.name} · ${Math.round(Math.hypot(e.start.x - p.x, e.start.z - p.z))} m · Stufe ${e.level}${rec ? ` · ${MEDAL_NAMES[rec.medal]} ${formatValue(e, rec.best)}` : ''}`;
          })].join('\n');
      },
    });
    registerCommand({ name: 'event.start', help: 'Zu einem Event fahren und starten (Nummer aus event.list, id oder Name)', args: '<nr|id|name>', run: (a) => { const e = find(a.join(' ')); this.goTo(e, true); return `${e.name}`; } });
    registerCommand({ name: 'event.near', help: 'Das nächste Event starten', args: '[art]', run: ([type]) => {
      const e = this.byDistance(pos()).find((x) => !type || x.type === type);
      if (!e) throw new Error('kein Event');
      this.goTo(e, true);
      return e.name;
    } });
    registerCommand({ name: 'event.win', help: 'Laufendes Event sofort mit einer Medaille beenden (0–4, Standard Gold)', args: '[medaille]', run: ([m]) => {
      const r = this.runner;
      if (!r.busy || !r.event) throw new Error('kein Event läuft');
      const e = r.event;
      const k = Math.max(0, Math.min(4, Number(m ?? 3)));
      const v = k ? e.medals[k - 1] : e.higher ? 0 : e.medals[0] * 2;
      if (r.state === 'countdown') r.state = 'running';
      r.finish(v);
      return `${e.name}: ${MEDAL_NAMES[k]}`;
    } });
    registerCommand({ name: 'event.abort', help: 'Laufendes Event abbrechen', run: () => { this.pending = undefined; this.runner.abort('Abgebrochen'); return 'abgebrochen'; } });
    registerCommand({ name: 'event.info', help: 'Zustand des laufenden Events', run: () => {
      const r = this.runner;
      if (!r.event) return `kein Event · ${this.events.length} in der Stadt`;
      return `${r.event.name} (${r.event.id}) · ${r.state} · ${r.time.toFixed(1)} s · Tor ${r.next + 1}/${r.event.gates.length} · Runde ${r.lap} · Wert ${formatValue(r.event, r.value())}`;
    } });
    registerCommand({ name: 'event.regen', help: 'Events neu erzeugen (anderer Zufallswert)', args: '[seed]', run: ([s]) => {
      this.events = generateEvents(this.d.graph, { seed: Number(s ?? Date.now() % 1e6) });
      return `${this.events.length} Events`;
    } });
    registerToggle('events', 'Events in der freien Fahrt (Tore, Marker, Start-Hinweise)', () => this.enabled, (v) => (this.enabled = v));
    registerToggle('event.navi', 'Navi führt im Rennen zum nächsten Checkpoint', () => this.checkpointNav, (v) => (this.checkpointNav = v));
    const rv = this.d.rivals;
    if (rv) {
      registerToggle('rivals', 'KI-Gegner in Rennen', () => rv.enabled, (v) => (rv.enabled = v));
      registerChoice('rivals.level', 'Stärke der KI-Gegner', Object.keys(RIVAL_LEVELS), () => rv.level, (v) => (rv.level = v as RivalLevel));
      registerValue('rivals.rubber', 'Gummiband 0..1: Gegner hinter dir holen auf, vor dir lassen sie etwas nach', () => rv.rubber, (v) => (rv.rubber = v), [0, 1]);
      registerValue('rivals.count', 'Gegner pro Rennen (-1: wie das Event sagt)', () => this.rivalCount ?? -1, (v) => (this.rivalCount = v < 0 ? undefined : Math.round(v)), [-1, 6]);
      registerCommand({ name: 'rivals.info', help: 'Stand der Gegner im laufenden Rennen', run: () => rv.info() });
    }
    const bv = this.d.barriers;
    if (bv) {
      registerToggle('event.barriers', 'Absperrgitter an den Seitenstraßen im Rennen', () => bv.enabled, (v) => { bv.enabled = v; if (!v) bv.clear(); });
      registerToggle('event.barriers.solid', 'Absperrgitter halten Auto und Gegner auf (aus: nur zu sehen)', () => bv.solid, (v) => (bv.solid = v));
      registerCommand({ name: 'event.barriers.info', help: 'Wie viele Absperrungen gerade stehen', run: () => `${bv.count} Absperrungen` });
    }
    registerCommand({ name: 'title', help: 'Titelbildschirm zeigen', run: () => { this.d.start.hidden = false; this.title.open = true; return 'Titel'; } });
  }

  private byDistance(p: { x: number; z: number }) {
    return [...this.events].sort((a, b) => Math.hypot(a.start.x - p.x, a.start.z - p.z) - Math.hypot(b.start.x - p.x, b.start.z - p.z));
  }
}
