import type * as THREE from 'three';
import type { GameSfx } from '../audio/gameSfx.ts';
import { registerCommand, registerToggle } from '../debug/registry.ts';
import type { Navigation } from '../nav/navigation.ts';
import type { MapMarker } from '../ui/mapDraw.ts';
import { EventHud } from '../ui/eventHud.ts';
import { EventList, ProgressBadge, TitleMenu } from '../ui/gameMenus.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { generateEvents, mergeEvents } from './events/generate.ts';
import { GateView, TYPE_COLORS } from './events/gates.ts';
import { distanceToPath, EventRunner } from './events/runner.ts';
import { crossed, EVENT_LABELS, formatValue, type GameEvent, type Gate, RACE_TYPES } from './events/types.ts';
import { Progress } from './progress.ts';
import { MEDAL_NAMES, SaveGame } from './save.ts';
import type { StyleEvent } from './style.ts';

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

  constructor(d: GameDeps) {
    this.d = d;
    d.scene.add(this.gates.root);
    this.hud = new EventHud(d.hud);
    this.badge = new ProgressBadge(d.hud);
    this.title = new TitleMenu(d.hud, d.start, {
      play: () => this.play(),
      events: () => this.openList(),
      garage: () => (d.openGarage ? (this.play(), d.openGarage()) : d.toast('Garage: kommt mit dem Tuning', 1.5)),
      options: () => d.openOptions(),
    });
    this.list = new EventList(d.hud, {
      navigate: (e) => { this.list.hide(); d.nav.setDestination(e.start.x, e.start.z, this.prev?.x ?? e.start.x, this.prev?.z ?? e.start.z); d.toast(`Navi: ${e.name}`, 1.5); },
      go: (e) => { this.list.hide(); this.goTo(e); },
      close: () => this.list.hide(),
    });
    this.hud.onRetry = () => { this.hud.hideCard(); this.runner.close(); if (this.lastRace) this.goTo(this.lastRace); };
    this.hud.onClose = () => { this.hud.hideCard(); this.runner.close(); };
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
    let custom: GameEvent[] | undefined;
    try {
      const r = await fetch(`${this.d.tilesUrl}/events.json`);
      if (r.ok && r.headers.get('content-type')?.includes('json')) custom = ((await r.json()) as { events: GameEvent[] }).events;
    } catch { /* optional file */ }
    this.events = mergeEvents(generated, custom);
    console.info(`[events] ${this.events.length} Events in ${Math.round(performance.now() - t)} ms`);
  }

  get inGame() { return !this.title.open; }
  /** Overlays that take the input (title, list, result card). */
  get overlay() { return this.title.open || this.list.open || this.hud.cardOpen; }
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
    this.list.show(this.events, this.save.data, p.x, p.z, this.progress.level);
  }

  /** Fast travel to an event's start; races then start with a countdown. */
  goTo(e: GameEvent) {
    if (e.level > this.progress.level) { this.d.toast(`${e.name}: ab Stufe ${e.level}`, 1.8); return; }
    if (this.title.open) this.play();
    if (this.runner.busy) this.runner.abort('Abgebrochen');
    const back = RACE_TYPES.has(e.type) ? 6 : 60;
    this.d.teleport(e.start.x - e.start.dx * back, e.start.z - e.start.dz * back, headingOf(e.start));
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
    const e = this.promptEvent;
    if (!e || this.runner.busy) return;
    if (e.level > this.progress.level) { this.d.toast(`ab Stufe ${e.level}`, 1.5); return; }
    this.goTo(e);
  }

  update(car: CarNow) {
    const { dt } = car;
    const d = this.d;
    this.save.update(dt);
    if (!this.blocked) { this.title.poll(dt); this.list.poll(dt); this.hud.poll(dt); }
    if ((this.badgeTimer -= dt) <= 0) this.refreshBadge();
    this.badge.visible = this.inGame;
    const ready = d.ready();
    // A race waits until the car stands on its start, then counts down.
    if (this.pending && ready) {
      const e = this.pending;
      this.pending = undefined;
      this.lastRace = e;
      this.runner.startRace(e);
    }
    if (ready && this.inGame) {
      this.runner.update(dt, car);
      if (!this.runner.busy && this.enabled && this.prev && !this.pending) this.freeRoam(car);
      if (this.runner.racing && this.runner.state === 'running' && this.runner.event?.path && distanceToPath(this.runner.event.path, car.x, car.z) > 150) this.runner.abort('Strecke verlassen');
      this.prev = { x: car.x, z: car.z };
    } else if (!ready) { this.prev = undefined; this.runner.skip(); }
    this.gates.showActive(this.runner.busy ? this.runner.event : undefined, this.runner.next);
    this.gates.showMarkers(this.events, car.x, car.z, this.runner.busy || !this.enabled);
    this.gates.update(dt);
    this.hud.update(this.runner, dt);
    this.hud.showPrompt(this.runner.busy || this.overlay ? undefined : this.promptEvent, 'F', !!this.promptEvent && this.promptEvent.level > this.progress.level);
    this.updateNav(car);
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
    r.onFail = (e, why) => { this.hud.fail(e, why); sfx.play('fail'); };
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
    return this.events.map((e) => ({ x: e.start.x, z: e.start.z, color: hex(TYPE_COLORS[e.type]), medal: this.save.data.events[e.id]?.medal, big: RACE_TYPES.has(e.type) }));
  }

  registerCommands(pos: () => { x: number; z: number }) {
    this.save.registerCommands();
    this.progress.registerCommands();
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
    registerCommand({ name: 'event.start', help: 'Zu einem Event fahren und starten (Nummer aus event.list, id oder Name)', args: '<nr|id|name>', run: (a) => { const e = find(a.join(' ')); this.goTo(e); return `${e.name}`; } });
    registerCommand({ name: 'event.near', help: 'Das nächste Event starten', args: '[art]', run: ([type]) => {
      const e = this.byDistance(pos()).find((x) => !type || x.type === type);
      if (!e) throw new Error('kein Event');
      this.goTo(e);
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
    registerCommand({ name: 'title', help: 'Titelbildschirm zeigen', run: () => { this.d.start.hidden = false; this.title.open = true; return 'Titel'; } });
  }

  private byDistance(p: { x: number; z: number }) {
    return [...this.events].sort((a, b) => Math.hypot(a.start.x - p.x, a.start.z - p.z) - Math.hypot(b.start.x - p.x, b.start.z - p.z));
  }
}
