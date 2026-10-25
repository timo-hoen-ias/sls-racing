import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Game } from '../game/game.ts';
import { EVENT_LABELS } from '../game/events/types.ts';
import type { MapMarker } from '../ui/mapDraw.ts';
import { type BrowserState, fmtTime, NetHud, ServerBrowser, type Standing } from '../ui/netMenus.ts';
import { findCar } from '../vehicle/cars.ts';
import type { SportsCarModel } from '../vehicle/sportsCarModel.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import { gridSlot } from './grid.ts';
import { type LocalServer, startLocal } from './localServer.ts';
import { type NetEvent, NetSession, WsTransport } from './netSession.ts';
import { PoseFlag, POSE_LEN, type RaceInfo, type RoomSummary } from './protocol.ts';
import { RemoteCars } from './remoteCars.ts';

// Online play in the game (O2): the server browser and lobby, the other players' cars, shared races and the
// net.* debug commands. Real servers need the Worker behind Cloudflare Access (worker/net.ts); until that is
// set up the menu says why and the local test server with bots (net.local) shows everything working.

export interface NetPlayDeps {
  R: typeof RAPIER_NS;
  world: RAPIER_NS.World;
  scene: THREE.Scene;
  hud: HTMLElement;
  graph: RoadGraph;
  game: Game;
  /** The player car now: interpolated pose, velocity, steering and flags (POSE_LEN values without progress). */
  pose(): number[];
  pos(): { x: number; z: number };
  /** Car id and paint colour of the player's car. */
  look(): { car: string; color: string };
  makeModel(url: string, color: string): Promise<SportsCarModel | undefined>;
  toast(text: string, seconds?: number): void;
  print(text: string): void;
  teleport(x: number, z: number, heading: number): void;
}

const RACE_KINDS = new Set(['sprint', 'circuit', 'duel']);
const API = `${import.meta.env?.BASE_URL ?? '/'}api/net`;

export class NetPlay {
  readonly session = new NetSession();
  readonly cars: RemoteCars;
  readonly browser: ServerBrowser;
  readonly hud: NetHud;
  /** The local test server while it runs (net.local). */
  local?: LocalServer;
  /** Bots on a new local server (net.local). */
  botCount = 3;
  private d: NetPlayDeps;
  private chat: string[] = [];
  /** The race this machine drives in (its event id), from the countdown until it ends here. */
  private racing?: string;
  private sentLook = '';
  private menuTimer = 0;
  private servers: RoomSummary[] = [];
  private poseBuf = new Array<number>(POSE_LEN).fill(0);

  constructor(d: NetPlayDeps) {
    this.d = d;
    this.cars = new RemoteCars({
      R: d.R, world: d.world,
      makeModel: (car, color) => d.makeModel(findCar(car)?.url ?? findCar('sportscar')!.url, color),
    });
    d.scene.add(this.cars.root);
    this.hud = new NetHud(d.hud);
    this.browser = new ServerBrowser(d.hud, {
      list: () => this.list(),
      join: (r) => this.join(r),
      create: async (name) => { const r = await this.create(name); this.join(r); },
      local: () => this.startLocal(),
      leave: () => this.leave(),
      race: (id) => this.announce(id),
      joinRace: () => this.joinRace(),
      go: () => this.session.send({ t: 'go' }),
      quitRace: () => this.quitRace(),
      chat: (text) => this.session.send({ t: 'chat', text }),
      close: () => this.browser.hide(),
    }, () => this.browserState());
    this.session.onEvent = (e) => this.onEvent(e);
    const g = d.game;
    g.overlayHook = () => this.browser.open;
    g.interactHook = () => {
      const r = this.session.race;
      if (!this.session.online || r?.phase !== 'gather' || this.inRace(r)) return false;
      this.joinRace();
      return true;
    };
    g.onRaceEnd = (e, res) => {
      if (this.racing !== e.id) return;
      if (res) this.session.send({ t: 'finish', time: res.value });
      else this.session.send({ t: 'quit' });
      if (!res) this.racing = undefined;
    };
  }

  get online() { return this.session.online; }

  private inRace(r: RaceInfo | null) {
    const me = this.session.me?.id;
    return !!r && me !== undefined && r.entrants.includes(me);
  }

  // --- server list and connection -------------------------------------------------------------------

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers }, credentials: 'same-origin' });
    if (!(r.headers.get('content-type') ?? '').includes('json')) throw new Error('kein Online-Dienst (nur die Spieldateien)');
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  }

  async list() {
    const r = await this.api<{ servers: RoomSummary[] }>(`/servers${devAs()}`);
    this.servers = r.servers;
    return r.servers;
  }

  create(name: string) {
    return this.api<RoomSummary>(`/servers${devAs()}`, { method: 'POST', body: JSON.stringify({ name }) });
  }

  join(room: { id: string; name: string }) {
    this.stopLocal();
    const base = new URL(`${API}/servers/${encodeURIComponent(room.id)}/ws${devAs()}`, location.href);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    this.session.connect(new WsTransport(base.href), room.name, this.d.look());
    this.sentLook = '';
    this.browser.render();
    return `verbinde mit ${room.name} …`;
  }

  startLocal(bots = this.botCount) {
    this.stopLocal();
    this.local = startLocal(this.session, { graph: this.d.graph, events: () => this.d.game.events, near: () => this.d.pos() }, 'Du', this.d.look(), bots);
    this.sentLook = '';
    this.browser.render();
    return `lokaler Testserver mit ${bots} Bots`;
  }

  private stopLocal() {
    if (!this.local) return;
    this.session.leave();
    this.local.stop();
    this.local = undefined;
  }

  leave() {
    if (this.racing) this.d.game.runner.abort('Server verlassen');
    this.racing = undefined;
    this.session.leave();
    this.stopLocal();
    this.cars.clear();
    this.browser.render();
    return 'offline';
  }

  // --- races -----------------------------------------------------------------------------------------

  /** Race events near the player, for the race picker. */
  raceChoices() {
    const p = this.d.pos();
    return this.d.game.events.filter((e) => RACE_KINDS.has(e.type) && e.path)
      .map((e) => ({ id: e.id, name: e.name, kind: EVENT_LABELS[e.type], dist: Math.hypot(e.start.x - p.x, e.start.z - p.z) }))
      .sort((a, b) => a.dist - b.dist).slice(0, 12);
  }

  announce(id?: string) {
    if (!this.online) throw new Error('nicht verbunden (net.menu)');
    const e = id ? this.findEvent(id) : this.d.game.events.find((x) => x.id === this.raceChoices()[0]?.id);
    if (!e) throw new Error('kein Rennen gefunden');
    this.session.send({ t: 'race', event: e.id, name: e.name });
    return `Rennen angekündigt: ${e.name}`;
  }

  private findEvent(q: string) {
    const n = Number(q);
    if (Number.isInteger(n) && n >= 0 && n < 12) return this.d.game.events.find((x) => x.id === this.raceChoices()[n]?.id);
    return this.d.game.events.find((x) => x.id === q) ?? this.d.game.events.find((x) => RACE_KINDS.has(x.type) && x.name.toLowerCase().includes(q.toLowerCase()));
  }

  joinRace() {
    this.session.send({ t: 'join' });
    this.d.toast('Du fährst mit', 1.4);
  }

  quitRace() {
    if (this.racing) this.d.game.runner.abort('Rennen verlassen');
    this.racing = undefined;
    this.session.send({ t: 'quit' });
  }

  private onEvent(e: NetEvent) {
    const say = (text: string, sec = 8) => { this.chat.push(text); if (this.chat.length > 30) this.chat.shift(); this.hud.say(text, sec); };
    switch (e.kind) {
      case 'status': say(e.text, 5); this.d.toast(e.text.split(' · ')[0], 2); if (!this.session.online) { this.cars.clear(); if (this.racing) this.d.game.runner.abort('Verbindung verloren'); this.racing = undefined; } break;
      case 'join': say(`${e.player.name} ist dazugekommen`); break;
      case 'leave': say(`${e.player.name} ist gegangen`); break;
      case 'chat': say(`${e.name}: ${e.text}`, 14); break;
      case 'error': say(`⚠ ${e.text}`); this.d.toast(e.text, 2); break;
      case 'race': this.onRace(e.race, e.prev, say); break;
    }
    this.browser.render();
  }

  private onRace(r: RaceInfo | null, prev: RaceInfo | null, say: (t: string, s?: number) => void) {
    const s = this.session;
    const g = this.d.game;
    if (r && r.phase === 'gather' && prev?.phase !== 'gather') {
      const host = s.nameOf(r.host);
      if (this.inRace(r)) say(`Du hast ${r.name} angekündigt: die anderen können mitfahren`);
      else { say(`${host} startet „${r.name}“ · F zum Mitfahren`, 15); this.d.toast(`${host} startet ${r.name} · F zum Mitfahren`, 3); }
    }
    if (r && r.phase === 'countdown' && this.inRace(r) && this.racing !== r.event) {
      const e = g.events.find((x) => x.id === r.event);
      if (!e) { say(`⚠ Rennen ${r.name} gibt es hier nicht (andere Weltversion?)`); s.send({ t: 'quit' }); return; }
      this.racing = e.id;
      const slot = gridSlot(e, r.entrants.indexOf(s.me!.id));
      g.startNetRace(e, slot, () => (s.race?.startAt ?? s.serverNow()) - s.serverNow());
      say(`${r.name}: Startplatz ${r.entrants.indexOf(s.me!.id) + 1} von ${r.entrants.length}`, 6);
    }
    if (r?.phase === 'done' && prev?.phase !== 'done') {
      say(`Ergebnis ${r.name}: ${r.results.map((x, i) => `${i + 1}. ${x.name}${x.time !== undefined ? ` ${fmtTime(x.time)}` : ' –'}`).join(' · ')}`, 15);
      if (this.racing === r.event && g.runner.busy && g.runner.event?.id === r.event) g.runner.abort('Zeit abgelaufen');
    }
    if (!r) this.racing = undefined;
  }

  /** Place among the entrants and the standings rows (race progress from the poses everyone sends). */
  private standings(): { rows: Standing[]; place?: number; field: number } {
    const s = this.session, r = s.race, me = s.me;
    if (!r || !me || r.phase === 'gather') return { rows: [], field: 1 };
    const run = this.d.game.runner;
    const mine = this.progress();
    const entries = r.entrants.map((id) => {
      const res = r.results.find((x) => x.id === id);
      const p = id === me.id ? mine : s.players.get(id)?.latest;
      const prog = id === me.id ? mine[0] : p ? p[12] : -1;
      const gap = id === me.id ? mine[1] : p ? p[13] : 0;
      const info = id === me.id ? me : s.players.get(id)?.info;
      return { id, name: info?.name ?? '?', color: info?.color ?? '#888', res, prog, gap };
    });
    const rank = (a: (typeof entries)[number]) => (a.res ? (a.res.time !== undefined ? -1e9 + a.res.time : 1e12) : -a.prog * 1e4 + a.gap);
    entries.sort((a, b) => rank(a) - rank(b));
    const rows = entries.map((x, i) => ({
      place: i + 1, name: x.name, color: x.color, me: x.id === me.id,
      note: x.res ? (x.res.time !== undefined ? fmtTime(x.res.time) : 'raus') : x.id === me.id && run.busy ? fmtTime(Math.max(0, run.time)) : '',
    }));
    return { rows, place: rows.findIndex((x) => x.me) + 1 || undefined, field: entries.length };
  }

  /** The player's race progress: gates passed (laps included) and metres to the next gate. */
  private progress(): [number, number] {
    const run = this.d.game.runner, e = run.event;
    if (!e || this.racing !== e.id) return [0, 0];
    if (run.state === 'done') return [1e6, 0];
    const g = e.gates[run.next];
    const p = this.d.pos();
    return [(run.lap - 1) * e.gates.length + run.next, g ? Math.hypot(g.x - p.x, g.z - p.z) : 0];
  }

  // --- per frame -------------------------------------------------------------------------------------

  /** Before world.step, every physics step. */
  step(dt: number) {
    if (this.cars.count) this.cars.step(dt);
  }

  update(dt: number, night: number, time: number, eye: THREE.Vector3) {
    const s = this.session;
    if (s.online) {
      const look = this.d.look();
      const key = `${look.car}|${look.color}`;
      if (key !== this.sentLook) {
        if (this.sentLook) s.send({ t: 'look', car: look.car, color: look.color });
        this.sentLook = key;
      }
    }
    s.update(dt, () => {
      const p = this.d.pose();
      const buf = this.poseBuf;
      for (let i = 0; i < 12; i++) buf[i] = p[i] ?? 0;
      const [prog, gap] = this.progress();
      if (this.racing) buf[11] |= PoseFlag.race;
      buf[12] = prog;
      buf[13] = gap;
      return buf;
    });
    this.cars.sync(s.players, s.renderTime(), dt, night, time, eye, performance.now());
    const st = this.standings();
    const run = this.d.game.runner;
    if (this.racing && run.event?.id === this.racing && run.busy) {
      run.field = st.field;
      run.place = st.field > 1 ? st.place : undefined;
    }
    let rows = st.rows;
    if (!rows.length && s.online) {
      const p = this.d.pos();
      rows = [...s.players.values()].map((pl) => ({ pl, d: pl.latest ? Math.hypot(pl.latest[0] - p.x, pl.latest[2] - p.z) : Infinity }))
        .sort((a, b) => a.d - b.d).slice(0, 7)
        .map(({ pl, d }) => ({ place: 0, name: pl.info.name, color: pl.info.color, me: false, note: Number.isFinite(d) ? (d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1).replace('.', ',')} km`) : '' }));
    }
    const r = s.race;
    const raceNote = r && r.phase !== 'done' ? ` · ${r.name}` : '';
    this.hud.update(s.online, `${s.roomName} · ${s.players.size + 1}/8${s.rtt ? ` · ${Math.round(s.rtt)} ms` : ''}${raceNote}`, rows);
    if (this.browser.open && (this.menuTimer -= dt) <= 0) { this.menuTimer = 0.5; this.browser.render(); }
  }

  /** Other players on the minimap and the big map. */
  markers(): MapMarker[] {
    const out: MapMarker[] = [];
    for (const [, pl] of this.session.players) {
      const p = pl.latest;
      if (p) out.push({ x: p[0], z: p[2], color: pl.info.color, group: 'player', label: pl.info.name });
    }
    return out;
  }

  private browserState(): BrowserState {
    const s = this.session;
    const r = s.race;
    const me = s.me?.id;
    const players = s.me ? [{ ...s.me, me: true }, ...[...s.players.values()].map((p) => ({ ...p.info, me: false }))] : [];
    const clockEnd = r?.phase === 'countdown' ? r.startAt : r?.until;
    return {
      status: s.status,
      line: s.online ? `Verbunden: ${s.roomName} als ${s.me?.name}${s.rtt ? ` · Ping ${Math.round(s.rtt)} ms` : ''}${this.local ? ' · Testmodus' : ''}`
        : s.status === 'connecting' ? `Verbinde mit ${s.roomName} …` : `Nicht verbunden${s.reason && s.reason !== 'verlassen' ? ` (${s.reason})` : ''}. Bis zu 8 Spieler pro Server.`,
      available: this.servers.length > 0,
      me,
      players: players.map((p) => ({ id: p.id, name: p.name, car: findCar(p.car)?.label ?? p.car, color: p.color, me: p.me, inRace: this.inRace(r) && !!r?.entrants.includes(p.id) })),
      race: r,
      races: this.raceChoices(),
      chat: this.chat,
      raceClock: clockEnd !== undefined ? (clockEnd - s.serverNow()) / 1000 : undefined,
    };
  }

  toggleMenu(open = !this.browser.open) {
    if (open) this.browser.show();
    else this.browser.hide();
  }

  /** Enter while driving: the menu with the chat line focused (online only). */
  openChat() {
    if (!this.online) return;
    this.browser.show();
    this.browser.focusChat();
  }

  // --- debug commands --------------------------------------------------------------------------------

  registerCommands() {
    const later = (p: Promise<string>) => { p.then((t) => this.d.print(t), (e) => this.d.print(`Fehler: ${(e as Error).message}`)); return '…'; };
    const s = this.session;
    registerCommand({ name: 'net', help: 'Online: Verbindung, Server, Spieler, Rennen', run: () => {
      if (!s.online) return `${s.status === 'connecting' ? 'verbinde …' : 'offline'}${s.reason ? ` (${s.reason})` : ''} · net.menu öffnet die Serverliste, net.local den Testserver`;
      const r = s.race;
      return [`${s.roomName} (${s.room}) als ${s.me?.name} · ${s.players.size + 1}/8 · Ping ${Math.round(s.rtt)} ms${this.local ? ' · lokal' : ''}`,
        ...[...s.players.values()].map((p) => `  ${p.info.name} · ${p.info.car} · ${p.snaps.length} Posen`),
        r ? `Rennen ${r.name} (${r.event}) · ${r.phase} · ${r.entrants.map((id) => s.nameOf(id)).join(', ')}` : 'kein Rennen'].join('\n');
    } });
    registerCommand({ name: 'net.menu', help: 'Online-Menü (Serverliste / Lobby) öffnen oder schließen (Taste N)', run: () => { this.toggleMenu(); return this.browser.open ? 'offen' : 'zu'; } });
    registerCommand({ name: 'net.servers', help: 'Online-Server mit Spielerzahl (über den Worker)', run: () => later(this.list().then((l) => l.map((r, i) => `${i}: ${r.name} (${r.id}) · ${r.players}/${r.max}${r.race ? ` · ${r.race}` : ''}`).join('\n') || 'keine Server')) });
    registerCommand({ name: 'net.join', help: 'Einem Server beitreten (Nummer aus net.servers oder id)', args: '<nr|id>', run: ([q]) => {
      if (!q) throw new Error('Server fehlt');
      const n = Number(q);
      const r = Number.isInteger(n) ? this.servers[n] : this.servers.find((x) => x.id === q) ?? { id: q, name: q };
      if (!r) throw new Error('erst net.servers');
      return this.join(r);
    } });
    registerCommand({ name: 'net.create', help: 'Eigenen Server eröffnen und beitreten', args: '<name>', run: (w) => later(this.create(w.join(' ')).then((r) => this.join(r))) });
    registerCommand({ name: 'net.leave', help: 'Server verlassen', run: () => this.leave() });
    registerCommand({ name: 'net.local', help: 'Lokaler Testserver im Browser mit Bots (ohne Worker und Access)', args: '[bots 0..7]', run: ([n]) => this.startLocal(n === undefined ? this.botCount : parseNum(n, 'Bots', 0, 7)) });
    registerCommand({ name: 'net.bots', help: 'Anzahl der Bots auf dem lokalen Testserver', args: '[0..7]', run: ([n]) => {
      if (!this.local) throw new Error('kein lokaler Testserver (net.local)');
      if (n === undefined) return `${this.local.bots.length} Bots`;
      return `${this.local.setBots(parseNum(n, 'Bots', 0, 7))} Bots`;
    } });
    registerValue('net.lag', 'Verzögerung pro Richtung auf dem lokalen Testserver (ms)', () => this.local?.lag ?? 0, (v) => { if (!this.local) throw new Error('kein lokaler Testserver (net.local)'); this.local.lag = v; }, [0, 1000]);
    registerCommand({ name: 'net.say', help: 'Chatnachricht an alle auf dem Server', args: '<text>', run: (w) => { if (!s.online) throw new Error('nicht verbunden'); s.send({ t: 'chat', text: w.join(' ') }); return 'gesendet'; } });
    registerCommand({ name: 'net.race', help: 'Gemeinsames Rennen ankündigen (ohne Argument: das nächste Rennen; Nummer aus net.races, id oder Name)', args: '[nr|id|name]', run: (w) => this.announce(w.length ? w.join(' ') : undefined) });
    registerCommand({ name: 'net.races', help: 'Rennen in der Nähe für net.race', run: () => this.raceChoices().map((c, i) => `${i}: ${c.name} · ${c.kind} · ${Math.round(c.dist)} m · ${c.id}`).join('\n') || 'keine Rennen' });
    registerCommand({ name: 'net.race.join', help: 'Beim angekündigten Rennen mitfahren (Taste F)', run: () => { this.joinRace(); return 'angemeldet'; } });
    registerCommand({ name: 'net.race.go', help: 'Als Gastgeber das Rennen sofort starten', run: () => { s.send({ t: 'go' }); return 'Start'; } });
    registerCommand({ name: 'net.race.quit', help: 'Gemeinsames Rennen verlassen', run: () => { this.quitRace(); return 'verlassen'; } });
    registerToggle('net.collide', 'Zusammenstöße mit den Autos der anderen Spieler', () => this.cars.collide, (v) => (this.cars.collide = v));
    registerToggle('net.tags', 'Namensschilder über den Autos der anderen', () => this.cars.tags, (v) => (this.cars.tags = v));
    registerToggle('net.hud', 'Online-Anzeige links (Server, Spieler, Rennstand, Chat)', () => this.hud.visible, (v) => (this.hud.visible = v));
    registerValue('net.interp', 'Andere Autos so viele ms in der Vergangenheit zeigen (glatter, aber später)', () => s.interp, (v) => (s.interp = v), [0, 600]);
    registerValue('net.rate', 'Eigene Position so oft pro Sekunde senden', () => s.rate, (v) => (s.rate = v), [2, 30]);
    registerCommand({ name: 'net.info', help: 'Netzwerk: Ping, Uhrabgleich, Nachrichten, Daten', run: () =>
      `Ping ${s.rtt.toFixed(0)} ms · Uhr ${s.offset.toFixed(0)} ms · gesendet ${s.stats.sent} (${(s.stats.bytesOut / 1024).toFixed(0)} KB Posen) · empfangen ${s.stats.recv} · ${s.rate} Hz · Puffer ${s.interp} ms · ${this.cars.count} Autos` });
    registerCommand({ name: 'net.tp', help: 'Zu einem anderen Spieler teleportieren', args: '<name>', complete: () => [...s.players.values()].map((p) => p.info.name), run: (w) => {
      const q = w.join(' ').toLowerCase();
      const pl = [...s.players.values()].find((p) => p.info.name.toLowerCase().includes(q));
      const p = pl?.latest;
      if (!pl || !p) throw new Error('Spieler nicht gefunden');
      // Behind them, facing their way.
      const h = Math.atan2(p[7], -p[9]);
      this.d.teleport(p[0] - Math.sin(h) * 12, p[2] + Math.cos(h) * 12, Number.isFinite(h) && Math.hypot(p[7], p[9]) > 1 ? h : 0);
      return `zu ${pl.info.name}`;
    } });
  }
}

/** Local `wrangler dev` (DEV_NO_AUTH): ?as=name@x.de in the page address picks the test player. */
function devAs() {
  const as = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('as') : null;
  return as ? `?as=${encodeURIComponent(as)}` : '';
}

