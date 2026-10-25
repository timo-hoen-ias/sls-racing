import {
  ALL_IN_SECONDS, type ClientMsg, FINISH_GRACE, GATHER_SECONDS, MAX_PLAYERS, parseClient, type PlayerInfo, PREP_SECONDS, PROTOCOL,
  type RaceInfo, RESULT_SECONDS, type ServerMsg,
} from './protocol.ts';

// One online server (O2): up to eight players, the poses they send relayed to the others, chat, and the race
// timetable (announce → gather → countdown with a shared start time → running → results → free roam again).
// No I/O here: the Durable Object (worker/lobby.ts) and the local test server (localServer.ts) feed it
// connections and messages and call tick() now and then.

export interface Peer {
  info: PlayerInfo;
  /** Who is behind the connection (the Access e-mail on the real server): one connection per key. */
  key: string;
  /** Said hello (car and colour known): only then the others see the player. */
  ready: boolean;
  send(m: ServerMsg): void;
  close?(why: string): void;
  /** Flood limits (public servers): messages this second, last chat line, last race announced. */
  rate?: { t: number; n: number; chat: number; race: number };
}

/** Messages per second a player may send (poses at up to 30 Hz, pings, the odd chat line). */
export const MAX_MSG_PER_SEC = 60;
export const CHAT_GAP_MS = 1000;
export const RACE_GAP_MS = 10_000;

export class LobbyCore {
  readonly players = new Map<number, Peer>();
  race: RaceInfo | null = null;
  /** Players or race changed (server list, persistence). */
  onChange?: () => void;
  private nextId = 1;
  room: string;
  readonly now: () => number;

  constructor(room: string, now: () => number = Date.now) {
    this.room = room;
    this.now = now;
  }

  get count() { return this.players.size; }

  /** A new connection. A second one with the same key replaces the first; undefined when the server is full. */
  add(key: string, name: string, send: Peer['send'], close?: Peer['close'], id?: number): Peer | undefined {
    for (const p of [...this.players.values()]) if (p.key === key) { this.remove(p.info.id); p.close?.('Neu verbunden'); }
    if (this.players.size >= MAX_PLAYERS) return undefined;
    id ??= this.nextId;
    this.nextId = Math.max(this.nextId, id + 1);
    const peer: Peer = { info: { id, name: this.uniqueName(name), car: 'sportscar', color: '#c0141c' }, key, ready: false, send, close };
    this.players.set(id, peer);
    return peer;
  }

  /** Puts a known player back (the Durable Object woke from hibernation). */
  restore(key: string, info: PlayerInfo, send: Peer['send'], close?: Peer['close']) {
    this.players.set(info.id, { info, key, ready: true, send, close });
    this.nextId = Math.max(this.nextId, info.id + 1);
  }

  private uniqueName(name: string) {
    const taken = new Set([...this.players.values()].map((p) => p.info.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
  }

  remove(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.ready) this.broadcast({ t: 'leave', id });
    if (this.race) this.dropEntrant(id, p.info.name);
    this.onChange?.();
  }

  private broadcast(m: ServerMsg, except?: number) {
    for (const p of this.players.values()) if (p.ready && p.info.id !== except) p.send(m);
  }

  private raceChanged() {
    this.broadcast({ t: 'race', race: this.race });
    this.onChange?.();
  }

  message(id: number, raw: unknown) {
    const p = this.players.get(id);
    const m = parseClient(raw);
    if (!p || !m) return;
    const now = this.now();
    const r = (p.rate ??= { t: now, n: 0, chat: -Infinity, race: -Infinity });
    if (now - r.t >= 1000) { r.t = now; r.n = 0; }
    if (++r.n > MAX_MSG_PER_SEC) return;
    if (m.t === 'chat') {
      if (now - r.chat < CHAT_GAP_MS) { p.send({ t: 'error', text: 'Nicht so schnell schreiben' }); return; }
      r.chat = now;
    }
    if (m.t === 'race') {
      if (now - r.race < RACE_GAP_MS) { p.send({ t: 'error', text: 'Kurz warten, bevor du das nächste Rennen ankündigst' }); return; }
      r.race = now;
    }
    this.tick();
    this.handle(p, m);
  }

  private handle(p: Peer, m: ClientMsg) {
    const now = this.now();
    if (m.t === 'ping') { p.send({ t: 'pong', c: m.c, s: now }); return; }
    if (m.t === 'hello') {
      if (m.v !== PROTOCOL) { p.send({ t: 'error', text: 'Andere Spielversion: bitte neu laden' }); p.close?.('Version'); this.remove(p.info.id); return; }
      p.info.car = m.car;
      p.info.color = m.color;
      if (!p.ready) {
        p.ready = true;
        const players = [...this.players.values()].filter((x) => x.ready).map((x) => x.info);
        p.send({ t: 'welcome', v: PROTOCOL, id: p.info.id, room: this.room, now, players, race: this.race });
        this.broadcast({ t: 'join', player: p.info }, p.info.id);
        this.onChange?.();
      }
      return;
    }
    if (!p.ready) return;
    switch (m.t) {
      case 'look':
        p.info.car = m.car;
        p.info.color = m.color;
        this.broadcast({ t: 'look', id: p.info.id, car: m.car, color: m.color }, p.info.id);
        return;
      case 's':
        this.broadcast({ t: 's', id: p.info.id, p: m.p, ts: now }, p.info.id);
        return;
      case 'chat':
        this.broadcast({ t: 'chat', id: p.info.id, name: p.info.name, text: m.text });
        return;
      case 'race':
        if (this.race && this.race.phase !== 'done') { p.send({ t: 'error', text: `Es läuft schon ein Rennen: ${this.race.name}` }); return; }
        this.race = { event: m.event, name: m.name, host: p.info.id, phase: 'gather', entrants: [p.info.id], until: now + GATHER_SECONDS * 1000, results: [] };
        // Alone on the server: no one to wait for.
        if (this.everyoneIn()) this.race.until = now + ALL_IN_SECONDS * 1000;
        this.raceChanged();
        return;
      case 'join': {
        const r = this.race;
        if (!r || r.phase !== 'gather' || r.entrants.includes(p.info.id)) return;
        r.entrants.push(p.info.id);
        // Everyone is in: no need to wait for the rest of the gather time.
        if (this.everyoneIn()) r.until = Math.min(r.until ?? now, now + ALL_IN_SECONDS * 1000);
        this.raceChanged();
        return;
      }
      case 'go':
        if (this.race?.phase === 'gather' && this.race.host === p.info.id) { this.toCountdown(); this.raceChanged(); }
        return;
      case 'quit':
        if (this.race?.entrants.includes(p.info.id)) this.dropEntrant(p.info.id);
        return;
      case 'finish': {
        const r = this.race;
        if (!r || (r.phase !== 'running' && r.phase !== 'countdown') || !r.entrants.includes(p.info.id) || r.results.some((x) => x.id === p.info.id)) return;
        r.phase = 'running';
        r.results.push({ id: p.info.id, name: p.info.name, time: m.time });
        r.results.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
        if (r.results.filter((x) => x.time !== undefined).length === 1) r.until = now + FINISH_GRACE * 1000;
        if (this.allDone()) this.toResults();
        this.raceChanged();
      }
    }
  }

  private everyoneIn() {
    const r = this.race;
    return !!r && [...this.players.values()].filter((x) => x.ready).every((x) => r.entrants.includes(x.info.id));
  }

  private allDone() {
    const r = this.race!;
    return r.entrants.every((id) => r.results.some((x) => x.id === id));
  }

  private toCountdown() {
    const r = this.race!;
    r.phase = 'countdown';
    r.startAt = this.now() + PREP_SECONDS * 1000;
    r.until = undefined;
  }

  private toResults() {
    const r = this.race!;
    for (const id of r.entrants) if (!r.results.some((x) => x.id === id)) r.results.push({ id, name: this.players.get(id)?.info.name ?? '?' });
    r.phase = 'done';
    r.until = this.now() + RESULT_SECONDS * 1000;
  }

  /** A player left the race (quit or disconnected): out of the grid, a DNF once it has started. */
  private dropEntrant(id: number, name = this.players.get(id)?.info.name ?? '?') {
    const r = this.race!;
    if (r.phase === 'done' || !r.entrants.includes(id)) return;
    if (r.phase === 'gather') r.entrants = r.entrants.filter((x) => x !== id);
    else if (!r.results.some((x) => x.id === id)) r.results.push({ id, name });
    if (!r.entrants.length) this.race = null;
    else if (r.phase !== 'gather' && this.allDone()) this.toResults();
    else if (r.phase === 'gather' && r.host === id) r.host = r.entrants[0];
    this.raceChanged();
  }

  /** Moves the race on when its time is up; call every few hundred milliseconds or at nextWake(). */
  tick() {
    const r = this.race;
    if (!r) return;
    const now = this.now();
    if (r.phase === 'gather' && now >= (r.until ?? 0)) { this.toCountdown(); this.raceChanged(); }
    else if (r.phase === 'countdown' && now >= (r.startAt ?? 0)) { r.phase = 'running'; this.raceChanged(); }
    else if (r.phase === 'running' && r.until !== undefined && now >= r.until) { this.toResults(); this.raceChanged(); }
    else if (r.phase === 'done' && now >= (r.until ?? 0)) { this.race = null; this.raceChanged(); }
  }

  /** Server time of the next change tick() would make (for an alarm). */
  nextWake() {
    const r = this.race;
    if (!r) return undefined;
    return r.phase === 'countdown' ? r.startAt : r.until;
  }

  /** What the server list shows. */
  summary() {
    return { players: [...this.players.values()].filter((p) => p.ready).length, race: this.race && this.race.phase !== 'done' ? this.race.name : undefined };
  }
}
