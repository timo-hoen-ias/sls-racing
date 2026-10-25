import { type ClientMsg, packPose, type PlayerInfo, POSE_LEN, PROTOCOL, type RaceInfo, type ServerMsg } from './protocol.ts';

// The game's end of an online server (O2): one connection (a WebSocket to the Worker, or the local test
// server), the other players with a short buffer of their poses, the server clock and the race the server
// runs. Poses go out a fixed number of times per second; the others are drawn a little in the past
// (interpolation delay) so their cars move smoothly between two received poses.

export interface Transport {
  send(m: ClientMsg): void;
  close(): void;
  onOpen?: () => void;
  onMessage?: (m: ServerMsg) => void;
  onClose?: (why: string) => void;
}

/** A WebSocket to /api/net/servers/<id>/ws (behind Cloudflare Access, the browser's Access cookie goes along). */
export class WsTransport implements Transport {
  private ws: WebSocket;
  onOpen?: () => void;
  onMessage?: (m: ServerMsg) => void;
  onClose?: (why: string) => void;
  private closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.onOpen?.();
    this.ws.onmessage = (e) => {
      try { this.onMessage?.(JSON.parse(String(e.data)) as ServerMsg); } catch { /* not ours */ }
    };
    this.ws.onclose = (e) => { if (!this.closed) { this.closed = true; this.onClose?.(e.reason || 'Verbindung getrennt'); } };
    this.ws.onerror = () => { /* onclose follows */ };
  }

  send(m: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.closed = true;
    this.ws.close(1000, 'verlassen');
  }
}

export interface Snapshot { t: number; p: number[] }

/** Another player: what the server said about them and their last poses. */
export class RemotePlayer {
  info: PlayerInfo;
  readonly snaps: Snapshot[] = [];
  /** Local time (ms) of the last pose. */
  seen = 0;
  constructor(info: PlayerInfo) {
    this.info = info;
  }

  push(t: number, p: number[], now: number) {
    // Out of order or a duplicate: keep the buffer sorted.
    const last = this.snaps[this.snaps.length - 1];
    if (last && t <= last.t) return;
    this.snaps.push({ t, p });
    if (this.snaps.length > 40) this.snaps.splice(0, this.snaps.length - 40);
    this.seen = now;
  }

  /** The newest pose. */
  get latest() { return this.snaps[this.snaps.length - 1]?.p; }
}

/** Longest stretch a pose is carried on with its velocity when nothing newer came (ms). */
export const MAX_EXTRAPOLATE = 350;

/**
 * Pose at server time t: between the two poses around it (positions, velocities and steering linear,
 * rotation normalised-linear), carried on with the velocity a little past the newest one. False without poses.
 */
export function sampleSnaps(snaps: readonly Snapshot[], t: number, out: number[]): boolean {
  const n = snaps.length;
  if (!n) return false;
  let i = n - 1;
  while (i > 0 && snaps[i].t > t) i--;
  const a = snaps[i], b = snaps[i + 1];
  for (let k = 0; k < POSE_LEN; k++) out[k] = a.p[k];
  if (!b) {
    if (t < a.t) return true;
    const dt = Math.min(t - a.t, MAX_EXTRAPOLATE) / 1000;
    for (let k = 0; k < 3; k++) out[k] = a.p[k] + a.p[7 + k] * dt;
    return true;
  }
  const f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
  for (const k of [0, 1, 2, 7, 8, 9, 10, 13]) out[k] = a.p[k] + (b.p[k] - a.p[k]) * f;
  const dot = a.p[3] * b.p[3] + a.p[4] * b.p[4] + a.p[5] * b.p[5] + a.p[6] * b.p[6];
  const s = dot < 0 ? -1 : 1;
  let len = 0;
  for (let k = 3; k < 7; k++) { out[k] = a.p[k] + (s * b.p[k] - a.p[k]) * f; len += out[k] * out[k]; }
  len = Math.sqrt(len) || 1;
  for (let k = 3; k < 7; k++) out[k] /= len;
  out[11] = b.p[11];
  out[12] = f < 0.5 ? a.p[12] : b.p[12];
  return true;
}

export type NetEvent =
  | { kind: 'status'; text: string }
  | { kind: 'join'; player: PlayerInfo }
  | { kind: 'leave'; player: PlayerInfo }
  | { kind: 'look'; player: PlayerInfo }
  | { kind: 'chat'; name: string; text: string; me: boolean }
  | { kind: 'race'; race: RaceInfo | null; prev: RaceInfo | null }
  | { kind: 'error'; text: string };

export class NetSession {
  status: 'off' | 'connecting' | 'online' = 'off';
  /** Why the connection ended (net). */
  reason = '';
  me?: PlayerInfo;
  room?: string;
  roomName = '';
  readonly players = new Map<number, RemotePlayer>();
  race: RaceInfo | null = null;
  /** Poses sent per second (net.rate). */
  rate = 15;
  /** The others are drawn this far in the past (ms, net.interp). */
  interp = 120;
  /** Server time minus local time (ms), and the round trip of the best recent ping. */
  offset = 0;
  rtt = 0;
  /** Messages and bytes sent and received (net.info). */
  stats = { sent: 0, recv: 0, bytesOut: 0 };
  onEvent?: (e: NetEvent) => void;
  private t?: Transport;
  private poseTimer = 0;
  private pingTimer = 0;
  private pings: { rtt: number; offset: number }[] = [];
  private clock: () => number;

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }

  get online() { return this.status === 'online'; }

  /** Server time now (ms). */
  serverNow() { return this.clock() + this.offset; }

  /** Server time the other cars are drawn at. */
  renderTime() { return this.serverNow() - this.interp; }

  connect(t: Transport, roomName: string, hello: { car: string; color: string }) {
    this.leave();
    this.t = t;
    this.status = 'connecting';
    this.roomName = roomName;
    this.reason = '';
    t.onOpen = () => this.send({ t: 'hello', v: PROTOCOL, car: hello.car, color: hello.color });
    t.onMessage = (m) => this.receive(m);
    t.onClose = (why) => {
      if (this.t !== t) return;
      this.reset(why);
      this.onEvent?.({ kind: 'status', text: `Verbindung beendet: ${why}` });
    };
  }

  leave() {
    const t = this.t;
    if (!t) return;
    this.t = undefined;
    t.close();
    this.reset('verlassen');
  }

  private reset(why: string) {
    this.t = undefined;
    this.status = 'off';
    this.reason = why;
    this.me = undefined;
    this.race = null;
    this.players.clear();
    this.pings = [];
  }

  send(m: ClientMsg) {
    if (!this.t) return;
    this.stats.sent++;
    if (m.t === 's') this.stats.bytesOut += m.p.length * 6 + 20;
    this.t.send(m);
  }

  /** Call every frame with the player's pose; sends it at the set rate. */
  update(dt: number, pose: () => number[]) {
    if (!this.online) return;
    this.poseTimer -= dt;
    if (this.poseTimer <= 0) {
      this.poseTimer += 1 / this.rate;
      if (this.poseTimer < 0) this.poseTimer = 1 / this.rate;
      this.send({ t: 's', p: packPose(pose()) });
    }
    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = 2;
      this.send({ t: 'ping', c: this.clock() });
    }
  }

  private receive(m: ServerMsg) {
    this.stats.recv++;
    const now = this.clock();
    switch (m.t) {
      case 'welcome':
        this.status = 'online';
        this.offset = m.now - now;
        this.room = m.room;
        this.me = m.players.find((p) => p.id === m.id);
        this.players.clear();
        for (const p of m.players) if (p.id !== m.id) this.players.set(p.id, new RemotePlayer(p));
        this.setRace(m.race);
        this.pingTimer = 0;
        this.onEvent?.({ kind: 'status', text: `Verbunden mit ${this.roomName} als ${this.me?.name ?? '?'} · ${m.players.length} Spieler` });
        return;
      case 'join':
        if (m.player.id === this.me?.id) return;
        this.players.set(m.player.id, new RemotePlayer(m.player));
        this.onEvent?.({ kind: 'join', player: m.player });
        return;
      case 'leave': {
        const p = this.players.get(m.id);
        this.players.delete(m.id);
        if (p) this.onEvent?.({ kind: 'leave', player: p.info });
        return;
      }
      case 'look': {
        const p = this.players.get(m.id);
        if (!p) return;
        p.info = { ...p.info, car: m.car, color: m.color };
        this.onEvent?.({ kind: 'look', player: p.info });
        return;
      }
      case 's':
        this.players.get(m.id)?.push(m.ts, m.p, now);
        return;
      case 'chat':
        this.onEvent?.({ kind: 'chat', name: m.name, text: m.text, me: m.id === this.me?.id });
        return;
      case 'pong': {
        const rtt = now - m.c;
        this.pings.push({ rtt, offset: m.s - (m.c + rtt / 2) });
        if (this.pings.length > 8) this.pings.shift();
        // The ping with the shortest round trip has the most honest clock.
        const best = this.pings.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.rtt = best.rtt;
        this.offset = best.offset;
        return;
      }
      case 'race':
        this.setRace(m.race);
        return;
      case 'error':
        this.onEvent?.({ kind: 'error', text: m.text });
    }
  }

  private setRace(race: RaceInfo | null) {
    const prev = this.race;
    this.race = race;
    this.onEvent?.({ kind: 'race', race, prev });
  }

  /** Name of a player (also yourself). */
  nameOf(id: number) {
    return id === this.me?.id ? this.me.name : this.players.get(id)?.info.name ?? '?';
  }
}
