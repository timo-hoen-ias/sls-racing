import type * as THREE from 'three';
import type { GameSfx } from '../audio/gameSfx.ts';
import { registerChoice, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import { addTeleportPlace } from '../debug/gameCommands.ts';
import type { Navigation } from '../nav/navigation.ts';
import type { MapMarker } from '../ui/mapDraw.ts';
import { EventHud } from '../ui/eventHud.ts';
import { EventList, ProgressBadge, TitleMenu } from '../ui/gameMenus.ts';
import { type CarRow, type GarageData, GarageMenu } from '../ui/garageMenu.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { type BarrierView, findBarriers } from './events/barriers.ts';
import type { JumpRamp } from '../world/jumpRamps.ts';
import { generateEvents, mergeEvents } from './events/generate.ts';
import { GateView, TYPE_COLORS } from './events/gates.ts';
import { distanceToPath, EventRunner } from './events/runner.ts';
import { crossed, EVENT_LABELS, type EventResult, formatValue, type GameEvent, type Gate, RACE_TYPES } from './events/types.ts';
import { Progress } from './progress.ts';
import { MEDAL_NAMES, SaveGame } from './save.ts';
import { LineTracker, RIVAL_LEVELS, type RivalLevel, type Rivals } from './rivals.ts';
import type { StyleEvent } from './style.ts';
import { PlaceView } from './placeView.ts';
import { CAR_SHOP, findPlaces, PART_NAMES, type Place, ratingOf, recommendedLs, SLOT_LABELS, SLOTS, SPEC_INFO, SPEC_LABELS, SPEC_SHOP, SPECS, type Spec, Workshop } from './workshop.ts';
import { CARS } from '../vehicle/cars.ts';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import { BUST, type PlayerNow, type Police } from './police.ts';
import { WantedHud } from '../ui/wantedHud.ts';
import { applySignal, type DailySignal, describeTask, drawDaily, taskGoal, today } from './daily.ts';
import { Collectibles, DISTRICT_BONUS, placeTokens, TOKEN_REWARD } from './collectibles.ts';
import { STEPS, Tutorial } from './tutorial.ts';
import { type Destination, makeDelivery } from './delivery.ts';
import { Discovery, DISTRICT_REWARD, type District, type Viewpoint, VIEWPOINT_REWARD } from './discovery.ts';
import { flashScreen, type SpeedCamera, SpeedCameras } from './speedCameras.ts';
import type { BellTower } from '../audio/bells.ts';
import { Online } from '../net/online.ts';
import { GhostRecorder, type GhostRun, ghostStore, GhostView, type Pose } from './ghost.ts';

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
  /** The online menu (O2). */
  openOnline?(): void;
  /** AI rivals for races (V3). */
  rivals?: Rivals;
  /** Fences across side streets during races (S6). */
  barriers?: BarrierView;
  /** Jump ramps in the world (W3): one jump event each. */
  ramps?: JumpRamp[];
  /** The player car's garage (vehicle/garage.ts): parts, dealer and home garage need it (P3, P4). */
  cars?: CarControl;
  /** Leaderboards and friends' ghosts (O1); absent or unavailable = offline. */
  online?: Online;
  /** Where the home garage goes (beside the start). */
  home?: { x: number; z: number };
  /** Ground height for markers. */
  groundAt?(x: number, z: number): number | undefined;
  /** Police patrols and chases in free roam (V4). */
  police?: Police;
  /** The player car's pose (physics body, interpolated) and a car model for the ghost (E5). */
  pose?(): Pose;
  ghostModel?(): Promise<THREE.Object3D | undefined>;
  /** A random house address between min and max metres from a point (E6). */
  destination?(near: { x: number; z: number }, min: number, max: number): Promise<Destination | undefined>;
  /** Landmarks to find (W5). */
  viewpoints?: Viewpoint[];
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
  /** Online play (O2): another open overlay, a claim on the interact key, and the end of every race run. */
  overlayHook?: () => boolean;
  interactHook?: () => boolean;
  onRaceEnd?: (e: GameEvent, result?: EventResult) => void;
  /** Online race waiting for its start: milliseconds to the shared start signal. */
  private netStart?: () => number;
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
      online: () => { this.play(); d.openOnline?.(); },
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
        spec: (id) => act(() => shop.buySpec(id as Spec)),
        look: (patch) => { shop.setLook(patch); this.garageMenu?.render(); },
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
    if (d.police) this.wirePolice(d.police);
    this.wireDiscovery();
    this.wireTutorial();
    if (d.ghostModel) {
      this.ghostView = new GhostView(d.ghostModel);
      d.scene.add(this.ghostView.root);
    }
    this.progress.onLevelUp = (l) => { d.sfx.play('levelup'); d.toast(`Stufe ${l} erreicht!`, 2.5); d.rumble(0.6, 300); };
    this.save.onChange = () => (this.badgeTimer = 0);
    this.refreshBadge();
  }

  /** Builds the events from the road graph, plus hand-made ones from events.json. */
  async load() {
    const t = performance.now();
    const generated = generateEvents(this.d.graph, { ramps: this.d.ramps });
    // events.json: hand-made events, and generated ones the event test (pipeline/eventtest.ts) left out.
    let file: { events?: GameEvent[]; drop?: string[] } = {};
    try {
      const r = await fetch(`${this.d.tilesUrl}/events.json`);
      if (r.ok && r.headers.get('content-type')?.includes('json')) file = await r.json();
    } catch { /* optional file */ }
    this.events = mergeEvents(generated, file.events, file.drop);
    try {
      const r = await fetch(`${this.d.tilesUrl}/districts.json`);
      if (r.ok && r.headers.get('content-type')?.includes('json')) this.discovery.districts = ((await r.json()) as { districts?: District[] }).districts ?? [];
    } catch { /* optional file (older worlds) */ }
    // "tp <ort>" for every town, village and district of the world.
    for (const dd of this.discovery.districts) addTeleportPlace(dd.name, dd.x, dd.z);
    this.collectibles.set(placeTokens(this.d.graph, this.discovery.districts));
    // sights.json (pipeline/lib/sights.ts): named sights and stations join the viewpoints, speed cameras, churches.
    try {
      const r = await fetch(`${this.d.tilesUrl}/sights.json`);
      if (r.ok && r.headers.get('content-type')?.includes('json')) {
        const f = (await r.json()) as { sights?: { id: string; kind: string; name: string; x: number; z: number }[]; churches?: BellTower[]; cameras?: SpeedCamera[] };
        const sights = (f.sights ?? []).map((v) => ({ id: v.id, name: v.name === v.kind ? v.kind : `${v.name} (${v.kind})`, x: v.x, z: v.z, radius: 6 }));
        this.discovery.viewpoints = [...this.discovery.viewpoints.filter((v) => !v.id.startsWith('osm-')), ...sights];
        this.cameras.list = f.cameras ?? [];
        this.churches = f.churches ?? [];
      }
    } catch { /* optional file (older worlds) */ }
    console.info(`[events] ${this.events.length} Events in ${Math.round(performance.now() - t)} ms`);
  }

  get inGame() { return !this.title.open; }
  /** Overlays that take the input (title, list, result card). */
  get overlay() { return this.title.open || this.list.open || this.hud.cardOpen || !!this.garageMenu?.open || !!this.overlayHook?.(); }
  /** Controls locked: countdown, or waiting to put the car on a race start. */
  get locked() { return this.runner.state === 'countdown' || !!this.pending; }
  get racing() { return this.runner.racing; }
  /** Route of the running race (traffic thins out there, V1). */
  get racePath() { return this.runner.racing ? this.runner.event?.path : undefined; }

  private play() {
    if (!this.title.open) return;
    this.title.open = false;
    this.d.start.hidden = true;
    this.d.onPlay();
    this.tutorial.refresh();
    const tasks = this.daily();
    if (tasks.some((t) => !t.done)) this.d.toast(`Tagesaufgaben: ${tasks.filter((t) => !t.done).map((t) => describeTask(t)).join(' · ')}`, 4);
  }

  /** Today's three challenges (P6), drawn on the first call of the day. */
  daily() {
    const dd = this.save.data.daily;
    if (dd.day !== today()) {
      this.save.data.daily = { day: today(), tasks: drawDaily(today(), this.discovery.districts.map((x) => x.name)) };
      this.save.touch();
    }
    return this.save.data.daily.tasks;
  }

  private signal(s: DailySignal) {
    for (const { task, xp, credits } of applySignal(this.daily(), s)) {
      this.d.toast(`Tagesaufgabe geschafft: ${describeTask(task)}`, 2.5);
      this.d.sfx.play('medal', 0.6);
      this.progress.reward(xp, credits, 'Tagesaufgabe');
      this.save.touch();
    }
  }

  openList() {
    if (this.runner.busy) { this.d.toast('Erst das laufende Event beenden', 2); return; }
    const p = this.prev ?? { x: 0, z: 0 };
    this.list.show(this.events, this.save.data, p.x, p.z, this.progress.level, this.workshop?.rating());
  }

  /** Home garage (parts, own cars) or dealer (buy cars). */
  openGarage(mode: GarageData['mode']) {
    this.tutorial.mark('garage');
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
          const key = `${c.id}:${c.id === cur ? shop.spec() + JSON.stringify(parts) : ''}`;
          if (!statCache.has(key)) statCache.set(key, cars.stats(c.id));
          return { id: c.id, label: c.label, info: c.info, owned: shop.owned(c.id), current: c.id === cur, ls: ratingOf(c.id, shop.parts(c.id)),
            price: sale.price, level: sale.level, locked: this.progress.level < sale.level, stats: statCache.get(key)! };
        }),
        look: shop.look(),
        specs: SPECS.map((sp) => {
          const sale = sp === 'street' ? { price: 0, level: 1 } : SPEC_SHOP[sp];
          return { id: sp, label: SPEC_LABELS[sp], info: SPEC_INFO[sp], owned: shop.hasSpec(cur, sp), current: shop.spec() === sp,
            price: sale.price, level: sale.level, locked: this.progress.level < sale.level };
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

  /** A courier run from the depot to a real address (E6); starts with the countdown where the car stands. */
  async startDelivery() {
    const depot = this.places.find((p) => p.id === 'courier');
    if (!depot || !this.d.destination || this.runner.busy || this.pending) return 'kein Kurierdienst';
    for (let tries = 0; tries < 5; tries++) {
      const to = await this.d.destination(depot, 700, 2200);
      if (!to) break;
      const e = makeDelivery(this.d.graph, depot, to);
      if (!e) continue;
      this.d.toast(`Auftrag: ${to.label} · ${Math.round(e.limit ?? 0)} s`, 2.5);
      this.lastRace = e;
      this.pending = e;
      this.prev = undefined;
      return e.name;
    }
    this.d.toast('Gerade keine Aufträge', 1.5);
    return 'keine Adresse gefunden';
  }

  /** Fast travel to an event's start; races then start with a countdown. */
  goTo(e: GameEvent, force = false) {
    if (!force && e.level > this.progress.level) { this.d.toast(`${e.name}: ab Stufe ${e.level}`, 1.8); return; }
    if (this.title.open) this.play();
    if (this.runner.busy) this.runner.abort('Abgebrochen');
    this.netStart = undefined;
    const back = RACE_TYPES.has(e.type) ? (this.fieldOf(e) ? 14 : 6) : 60;
    // Speed traps start at their run-up, far enough back to reach the gold speed.
    const r = e.extra?.runup;
    if (r) this.d.teleport(r.x, r.z, headingOf(r));
    else this.d.teleport(e.start.x - e.start.dx * back, e.start.z - e.start.dz * back, headingOf(e.start));
    this.pending = RACE_TYPES.has(e.type) ? e : undefined;
    this.prev = undefined;
  }

  /**
   * An online race (O2): the car goes onto its grid slot and the countdown ends at the server's start signal
   * (remaining() ms from now). No AI rivals: the other players are the field.
   */
  startNetRace(e: GameEvent, slot: { x: number; z: number; heading: number }, remaining: () => number) {
    if (this.title.open) this.play();
    if (this.runner.busy) this.runner.abort('Abgebrochen');
    this.list.hide();
    this.d.teleport(slot.x, slot.z, slot.heading);
    this.pending = e;
    this.netStart = remaining;
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
    const at = this.prev ? this.discovery.at(this.prev.x, this.prev.z)?.name : undefined;
    this.signal({ kind: 'style', style: e.kind, points: e.points, value: e.value, district: at });
    this.tutorial.mark('skill');
  }

  /** Called on 'interact' (F / pad →). */
  interact() {
    if (this.hud.cardOpen) { this.hud.onClose?.(); return; }
    if (this.interactHook?.()) return;
    if (this.garageMenu?.open) return;
    if (this.promptPlace?.id === 'courier' && !this.runner.busy) { void this.startDelivery(); return; }
    if (this.promptPlace && !this.runner.busy && this.promptPlace.id !== 'courier') { this.openGarage(this.promptPlace.id); return; }
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
      const net = this.netStart;
      this.netStart = undefined;
      if (net) {
        // Online: count down to the shared start; a late car starts with the time already running.
        const left = net() / 1000;
        this.d.rivals?.clear();
        this.track = undefined;
        this.runner.startRace(e, Math.max(0.01, left));
        if (left < 0) this.runner.time = -left;
      } else {
        this.runner.startRace(e);
        this.startRivals(e);
      }
      if (e.path && d.barriers && e.type !== 'delivery') d.barriers.show(findBarriers(d.graph, e.path));
    }
    if (ready && this.inGame) {
      this.runner.update(dt, car);
      if (!this.runner.busy && this.enabled && this.prev && !this.pending) this.freeRoam(car);
      this.trackPlace(car);
      this.updateGhost();
      if (!this.runner.busy) this.discovery.update(car.x, car.z, car.speed);
      if (!this.runner.busy) this.cameras.update(car.x, car.z, car.speed);
      this.collectibles.update(this.runner.busy ? 0 : dt, this.runner.busy ? Infinity : car.x, car.z);
      if (car.speed * 3.6 > 60 && !this.tutorial.finished) this.tutorial.mark('drive');
      if (this.hint) this.hint.style.visibility = this.runner.busy || this.overlay ? 'hidden' : '';
      if (car.speed * 3.6 > 200 && (this.speedTick -= dt) <= 0) { this.speedTick = 0.5; this.signal({ kind: 'speed', kmh: car.speed * 3.6 }); }
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
    this.hud.showPlace(this.promptPlace ? `${this.promptPlace.name} · F ${this.promptPlace.id === 'courier' ? 'für einen Auftrag' : 'zum Betreten'}` : undefined);
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

  private wantedHud?: WantedHud;
  private speedTick = 0;
  /** First-minutes hints (E8). */
  readonly tutorial = new Tutorial();
  private hint?: HTMLElement;

  private wireTutorial() {
    const tu = this.tutorial;
    tu.done = new Set(this.save.data.tutorial);
    // Saves from before the hints existed have played already.
    if (!tu.done.size && Object.keys(this.save.data.events).length) for (const x of STEPS) tu.done.add(x.id);
    const hint = (this.hint = document.createElement('div'));
    hint.id = 'tutorial-hint';
    hint.hidden = true;
    this.d.hud.append(hint);
    tu.onStep = (text, i, total) => {
      this.save.data.tutorial = [...tu.done];
      this.save.touch();
      hint.hidden = !text;
      if (text) hint.innerHTML = `<b>Einstieg ${i + 1}/${total}</b> ${text.replace(/[<>&]/g, '')}`;
    };
    tu.onFinish = () => {
      this.d.toast('Einstieg geschafft! Die Stadt gehört dir.', 3);
      this.d.sfx.play('levelup', 0.6);
      this.progress.reward(200, 2000, 'Einstieg');
    };
  }

  /** The player fired the nitro (from main). */
  nitroUsed() {
    if (!this.tutorial.finished) this.tutorial.mark('nitro');
  }
  /** Districts and viewpoints to find (W5). */
  readonly discovery = new Discovery();
  /** Hidden tokens in every district (E7). */
  readonly collectibles = new Collectibles();
  /** Mapped speed cameras as a challenge (sights.json). */
  readonly cameras = new SpeedCameras();
  /** Churches whose bells strike the hour (src/audio/bells.ts, wired in main). */
  churches: BellTower[] = [];

  private wireDiscovery() {
    const { toast, sfx } = this.d;
    const disc = this.discovery;
    disc.found = new Set(this.save.data.discovered);
    disc.viewpoints = this.d.viewpoints ?? [];
    const keep = () => { this.save.data.discovered = [...disc.found]; this.save.touch(); };
    disc.onDistrict = (dd, n, total) => {
      keep();
      toast(`Stadtteil entdeckt: ${dd.name} (${n}/${total})`, 2.5);
      sfx.play('discover', 0.8);
      this.progress.reward(DISTRICT_REWARD.xp, DISTRICT_REWARD.credits, dd.name);
    };
    const col = this.collectibles;
    col.found = new Set(this.save.data.collected);
    this.d.scene.add(col.root);
    col.onPick = (t, n, total, districtDone) => {
      this.save.data.collected = [...col.found];
      this.save.touch();
      sfx.play('point', 0.9);
      this.progress.reward(TOKEN_REWARD.xp, TOKEN_REWARD.credits, 'Sammelstück');
      if (districtDone) {
        toast(`Alle Sammelstücke in ${t.district}! (${n}/${total})`, 2.5);
        this.progress.reward(DISTRICT_BONUS.xp, DISTRICT_BONUS.credits, t.district);
        sfx.play('medal', 0.7);
      } else toast(`Sammelstück ${n}/${total}`, 1.5);
    };
    const cams = this.cameras;
    for (const [k, v] of Object.entries(this.save.data.stats)) if (k.startsWith('blitzer:')) cams.best.set(k.slice(8), v);
    cams.onPass = (p) => {
      const previous = this.save.data.stats[`blitzer:${p.camera.id}`] ?? 0;
      flashScreen();
      sfx.play('point', 0.5);
      const where = p.camera.street ? `Blitzer ${p.camera.street}` : 'Blitzer';
      toast(`${where}: ${p.kmh} km/h${p.over > 0 ? ` (${p.over} zu schnell)` : ''} · Bestwert ${p.best}`, 2.2);
      const r = SpeedCameras.reward(p, previous);
      if (p.kmh > previous) { this.save.data.stats[`blitzer:${p.camera.id}`] = p.kmh; this.save.touch(); }
      if (r.xp) this.progress.reward(r.xp, r.credits, where);
    };
    disc.onViewpoint = (v, n, total) => {
      keep();
      toast(`Aussichtspunkt: ${v.name} (${n}/${total})`, 2.2);
      sfx.play('discover', 0.6);
      this.progress.reward(VIEWPOINT_REWARD.xp, VIEWPOINT_REWARD.credits, v.name);
    };
  }

  /** Progress for the big map's bar (U2). */
  mapStats() {
    const d = this.discovery, medals = Object.values(this.save.data.events).filter((x) => x.medal > 0).length;
    return `Stadtteile ${d.districtsFound}/${d.districts.length} · Aussichtspunkte ${d.viewpointsFound}/${d.viewpoints.length} · Sammelstücke ${this.collectibles.count}/${this.collectibles.tokens.length} · Events mit Medaille ${medals}/${this.events.length}`;
  }

  /** District names for the map: found ones bright, the others as "?". */
  areas(): { name: string; x: number; z: number; found: boolean }[] {
    return this.discovery.districts.map((dd: District) => ({ ...dd, found: this.discovery.found.has(`district:${dd.name}`) }));
  }
  /** Ghost of the best run in time races (E5). */
  ghosts = true;
  private ghostView?: GhostView;
  private ghostRec = new GhostRecorder();
  private ghostRun?: GhostRun;

  private ghostEvent(e?: GameEvent) {
    return !!e && (e.type === 'sprint' || e.type === 'circuit' || e.type === 'duel') && !e.higher;
  }

  /** Records the running race and moves the ghost along its best run. */
  private updateGhost() {
    const r = this.runner;
    const on = r.state === 'running' && this.ghostEvent(r.event);
    const pose = on ? this.d.pose?.() : undefined;
    if (pose) this.ghostRec.sample(r.time, pose);
    this.ghostView?.show(on && this.ghosts ? this.ghostRun : undefined, r.time);
  }

  /** Chases end with a reward for getting away, or a fine when caught (V4). */
  private wirePolice(police: Police) {
    const { toast, sfx, rumble } = this.d;
    this.wantedHud = new WantedHud(this.d.hud);
    const w = police.wanted;
    w.onChange = (h, why) => { toast(`${'★'.repeat(h)} Fahndung: ${why}`, 2); sfx.play('fail', 0.5); rumble(0.3, 150); };
    w.onEscape = (h, t) => {
      const xp = 120 * h + Math.round(t * 2), credits = 400 * h + Math.round(t * 10);
      toast(`Entkommen! ${'★'.repeat(h)} · ${Math.round(t)} s Verfolgung`, 2.5);
      sfx.play('levelup', 0.6);
      this.progress.reward(xp, credits, 'Polizei entkommen');
      this.signal({ kind: 'escape', heat: h });
    };
    w.onBust = (h) => {
      const fine = Math.min(this.progress.credits, 500 * h);
      if (fine) this.progress.spend(fine);
      toast(`Gestellt! Bußgeld ${fine.toLocaleString('de-DE')} Cr`, 2.5);
      sfx.play('fail');
      rumble(0.8, 300);
    };
    police.onRam = () => rumble(0.5, 160);
    police.onSpikes = () => { toast('Nagelband! Reifen platt', 2); rumble(0.9, 400); };
  }

  /** Police drive (before world.step); only in free roam, a started event ends any chase. */
  stepPolice(dt: number, player: PlayerNow, car: CarPhysics) {
    const police = this.d.police;
    if (!police) return;
    if (!this.inGame || this.runner.busy) {
      if (police.units.length || police.heat) { police.wanted.clear(); police.clear(); }
      this.wantedHud?.set(0, 0, 0);
      return;
    }
    police.step(dt, player, car);
    const w = police.wanted;
    this.wantedHud?.set(w.heat, w.heat ? w.hidden / w.escapeNeeded : 0, w.heat ? w.boxed / BUST : 0);
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

  /** The running event, else the last race (online.board). */
  currentEventId() { return this.runner.event?.id ?? this.lastRace?.id; }

  /** A result as the event shows it (time, km/h, m …). */
  formatResult(id: string, v: number) {
    const ev = this.events.find((x) => x.id === id);
    return ev ? formatValue(ev, v) : String(v);
  }

  /** In races: the fastest friend's ghost replaces your own when it beats it (O1). */
  private async friendGhost(e: GameEvent) {
    const on = this.d.online;
    if (!on?.available || !on.friendGhosts || !this.ghosts || !this.ghostEvent(e)) return;
    try {
      const rival = Online.rivalOf(await on.board(e.id), this.ghostRun?.value);
      if (!rival) return;
      const run = await on.ghost(e.id, rival.name);
      if (this.runner.event?.id !== e.id || this.runner.state === 'done') return;
      this.ghostRun = run;
      this.d.toast(`Geist: ${rival.name} ${formatValue(e, run.value)}`, 1.8);
    } catch (err) { console.info('[online] kein Geist', (err as Error).message); }
  }

  /** Sends the result (and the run's ghost) to the friends' leaderboard and tells the rank (O1). */
  private async sendResult(e: GameEvent, value: number) {
    const on = this.d.online;
    if (!on?.available || !on.send) return;
    try {
      const ghost = this.ghostEvent(e) ? this.ghostRec.finish(value) : undefined;
      const r = await on.submit(e.id, value, e.higher, this.d.cars?.current(), ghost);
      this.d.toast(`Bestenliste: Platz ${r.rank}${r.best ? ' · neue Bestleistung' : ''}`, 2);
    } catch (err) { console.info('[online] Ergebnis nicht gesendet', (err as Error).message); }
  }

  private wireRunner() {
    const r = this.runner;
    const { sfx, toast, rumble } = this.d;
    r.onStart = (e) => {
      this.ghostRec.start();
      this.ghostRun = this.ghostEvent(e) ? ghostStore.load(e.id) : undefined;
      if (this.ghostRun && this.ghosts) toast(`Geist: deine Bestzeit ${formatValue(e, this.ghostRun.value)}`, 1.6);
      void this.friendGhost(e);
      if (!RACE_TYPES.has(e.type)) { sfx.play('go', 0.6); toast(`${EVENT_LABELS[e.type]}: ${e.name}`, 1.4); } };
    r.onCountdown = (n) => { this.hud.countdown(n); sfx.play('beep'); };
    r.onGo = () => { this.hud.countdown(0); sfx.play('go'); rumble(0.5, 200); };
    r.onGate = (i, lap) => {
      const e = r.event!;
      if (i < e.gates.length - 1 || (e.laps && lap < e.laps)) sfx.play('checkpoint');
    };
    r.onLap = (lap) => toast(`Runde ${lap}/${r.event?.laps}`, 1.2);
    r.onFail = (e, why) => { this.hud.fail(e, why); sfx.play('fail'); this.endRivals(); this.onRaceEnd?.(e); };
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
      this.signal({ kind: 'medal', medal: res.medal, type: e.type });
      this.tutorial.mark('event');
      if (res.best && this.ghostEvent(e)) ghostStore.save(e.id, this.ghostRec.finish(res.value));
      void this.sendResult(e, res.value);
      this.progress.reward(res.xp, res.credits, e.name);
      const part = this.workshop?.reward(e, res.medal);
      if (part) { toast(`Neues Teil: ${part}`, 2.5); sfx.play('discover', 0.7); }
      const after = this.progress.level;
      sfx.play(res.medal >= 3 ? 'medal' : res.medal ? 'finish' : 'fail');
      sfx.play('cash', 0.5);
      this.hud.result(res, RACE_TYPES.has(e.type), after > before ? ` · Stufe ${after}!` : '');
      if (!RACE_TYPES.has(e.type)) r.close();
      this.onRaceEnd?.(e, res);
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
      ...this.events.map((e) => ({ x: e.start.x, z: e.start.z, color: hex(TYPE_COLORS[e.type]), medal: this.save.data.events[e.id]?.medal, big: RACE_TYPES.has(e.type), group: RACE_TYPES.has(e.type) ? 'race' as const : 'skill' as const })),
      ...this.places.map((p) => ({ x: p.x, z: p.z, color: p.color, big: true, group: 'place' as const })),
      ...this.discovery.viewpoints.map((v) => ({ x: v.x, z: v.z, color: this.discovery.found.has(`view:${v.id}`) ? '#ffd60a' : '#7d8794', group: 'view' as const })),
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
    registerCommand({ name: 'event.abort', help: 'Laufendes Event abbrechen', run: () => { this.pending = undefined; this.netStart = undefined; this.runner.abort('Abgebrochen'); return 'abgebrochen'; } });
    registerCommand({ name: 'event.info', help: 'Zustand des laufenden Events', run: () => {
      const r = this.runner;
      if (!r.event) return `kein Event · ${this.events.length} in der Stadt`;
      return `${r.event.name} (${r.event.id}) · ${r.state} · ${r.time.toFixed(1)} s · Tor ${r.next + 1}/${r.event.gates.length} · Runde ${r.lap} · Wert ${formatValue(r.event, r.value())}`;
    } });
    registerCommand({ name: 'event.regen', help: 'Events neu erzeugen (anderer Zufallswert)', args: '[seed]', run: ([s]) => {
      this.events = generateEvents(this.d.graph, { seed: Number(s ?? Date.now() % 1e6), ramps: this.d.ramps });
      return `${this.events.length} Events`;
    } });
    registerToggle('events', 'Events in der freien Fahrt (Tore, Marker, Start-Hinweise)', () => this.enabled, (v) => (this.enabled = v));
    registerCommand({ name: 'courier', help: 'Kurierfahrt vom Kurierdienst zu einer zufälligen echten Adresse starten', run: () => { this.goToPlace('courier'); void this.startDelivery(); return 'Auftrag wird gesucht'; } });
    registerCommand({ name: 'tutorial', help: 'Einstieg: Schritte und Stand', run: () => STEPS.map((x) => `${this.tutorial.done.has(x.id) ? '✓' : '·'} ${x.text}`).join('\n') });
    registerCommand({ name: 'tutorial.skip', help: 'Einstieg überspringen', run: () => { this.tutorial.mark('skip'); return 'Einstieg übersprungen'; } });
    registerCommand({ name: 'tutorial.reset', help: 'Einstieg von vorn (nach dem nächsten Spielstart)', run: () => { this.tutorial.done.clear(); this.save.data.tutorial = []; this.save.touch(); this.tutorial.refresh(); return 'Einstieg zurückgesetzt'; } });
    registerCommand({ name: 'daily', help: 'Tagesaufgaben von heute mit Fortschritt', run: () => this.daily().map((t) => `${t.done ? '✓' : '·'} ${describeTask(t)} (${Math.round(t.progress)}/${taskGoal(t)})`).join('\n') });
    registerCommand({ name: 'daily.reroll', help: 'Tagesaufgaben neu ziehen (Debug: anderer Tag)', args: '[tag]', run: ([day]) => {
      this.save.data.daily = { day: today(), tasks: drawDaily(day ?? String(Math.random()), this.discovery.districts.map((x) => x.name)) };
      this.save.touch();
      return this.daily().map((t) => describeTask(t)).join('\n');
    } });
    registerCommand({ name: 'discover.list', help: 'Stadtteile und Aussichtspunkte: gefunden oder offen', run: () => {
      const disc = this.discovery;
      const row = (id: string, name: string) => `${disc.found.has(id) ? '✓' : '·'} ${name}`;
      return [`Stadtteile ${disc.districtsFound}/${disc.districts.length} · Aussichtspunkte ${disc.viewpointsFound}/${disc.viewpoints.length}`,
        ...disc.districts.map((dd) => row(`district:${dd.name}`, dd.name)), ...disc.viewpoints.map((v) => row(`view:${v.id}`, v.name))].join('\n');
    } });
    registerCommand({ name: 'collect.list', help: 'Sammelstücke je Stadtteil: gefunden/alle', run: () => {
      const col = this.collectibles;
      const per = new Map<string, [number, number]>();
      for (const t of col.tokens) { const v = per.get(t.district) ?? [0, 0]; v[1]++; if (col.found.has(t.id)) v[0]++; per.set(t.district, v); }
      return [`Sammelstücke ${col.count}/${col.tokens.length}`, ...[...per].map(([k, [a, b]]) => `${k}: ${a}/${b}`)].join('\n');
    } });
    registerCommand({ name: 'collect.next', help: 'Navi zum nächsten nicht gefundenen Sammelstück (Debug)', run: () => {
      const p = pos();
      const t = this.collectibles.tokens.filter((x) => !this.collectibles.found.has(x.id)).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      if (!t) return 'alle gefunden';
      this.d.nav.setDestination(t.x, t.z, p.x, p.z);
      return `${t.district}: ${Math.round(Math.hypot(t.x - p.x, t.z - p.z))} m`;
    } });
    registerCommand({ name: 'collect.reset', help: 'Gefundene Sammelstücke vergessen', run: () => { this.collectibles.found.clear(); this.save.data.collected = []; this.save.touch(); return 'alle wieder versteckt'; } });
    registerCommand({
      name: 'blitzer',
      help: 'Blitzer aus OSM: Bestwerte, Tempolimit und Entfernung (die Kamera misst beim Vorbeifahren)',
      run: () => {
        const p = pos(), cams = this.cameras.list;
        if (!cams.length) return 'Keine Blitzer in dieser Welt.';
        return cams.map((c, i) => `${i + 1}. ${c.street || '–'} · Limit ${c.limit} · Bestwert ${this.cameras.best.get(c.id) ?? '–'} km/h · ${Math.hypot(c.x - p.x, c.z - p.z).toFixed(0)} m`).join('\n');
      },
    });
    registerCommand({ name: 'discover.reset', help: 'Entdeckte Stadtteile und Aussichtspunkte vergessen', run: () => { this.discovery.found.clear(); this.save.data.discovered = []; this.save.touch(); return 'alles wieder unentdeckt'; } });
    registerToggle('ghost', 'Geist der eigenen Bestfahrt in Sprints und Rundkursen', () => this.ghosts, (v) => (this.ghosts = v));
    registerCommand({ name: 'ghost.clear', help: 'Gespeicherte Geister löschen (alle oder eines)', args: '[event-id]', run: ([id]) => { ghostStore.clear(id); return id ? `Geist ${id} gelöscht` : 'alle Geister gelöscht'; } });
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
