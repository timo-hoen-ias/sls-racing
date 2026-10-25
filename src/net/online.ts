import { registerCommand, registerToggle } from '../debug/registry.ts';
import type { GhostRun } from '../game/ghost.ts';
import { identityQuery, setPlayerName } from './identity.ts';

// Leaderboards (O1): results and ghosts go to the Worker (worker/api.ts), public since 2026-10-25 with the same
// random id and name as online play (identity.ts); behind Cloudflare Access the id is ignored.
// Everything is asynchronous and optional: without the Worker API (dev server, Access not set up yet, offline)
// the game plays as before and only says so in the console.

export interface BoardEntry { rank: number; name: string; value: number; car?: string; at: number; ghost: boolean; me: boolean }
export interface Board { event: string; higher: boolean; entries: BoardEntry[] }

export class Online {
  /** The API answered (public, or signed in through Access). */
  available = false;
  /** Results and ghosts are sent (online.send). */
  send = true;
  /** In races the best friend's ghost drives along instead of your own when it is faster (online.ghosts). */
  friendGhosts = true;
  name?: string;
  /** Why the API is not there (shown by "online"). */
  reason = 'noch nicht verbunden';
  private base: string;

  constructor(base = `${import.meta.env?.BASE_URL ?? '/'}api`) {
    this.base = base.replace(/\/+$/, '');
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${this.base}${path}${path.includes('?') ? '&' : '?'}${identityQuery()}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers }, credentials: 'same-origin' });
    if (!(r.headers.get('content-type') ?? '').includes('json')) throw new Error('kein Online-Dienst (nur die Spieldateien)');
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  }

  /** Asks the API who is signed in; marks the service available on success. */
  async connect() {
    try {
      const me = await this.call<{ name: string }>('/me');
      this.name = me.name;
      this.available = true;
      this.reason = '';
    } catch (e) {
      this.available = false;
      this.reason = (e as Error).message;
    }
    return this.available;
  }

  board(event: string) {
    return this.call<Board>(`/board/${encodeURIComponent(event)}`);
  }

  /** Sends a result (and the ghost of the run); the server keeps it when it beats the player's best. */
  submit(event: string, value: number, higher: boolean, car?: string, ghost?: GhostRun) {
    return this.call<{ best: boolean; rank: number }>(`/board/${encodeURIComponent(event)}`, {
      method: 'POST', body: JSON.stringify({ value, higher, car, ghost: ghost ? { poses: ghost.poses } : undefined }),
    });
  }

  async ghost(event: string, name: string): Promise<GhostRun> {
    const g = await this.call<{ value: number; poses: number[] }>(`/ghost/${encodeURIComponent(event)}/${encodeURIComponent(name)}`);
    return { value: g.value, poses: g.poses };
  }

  /** The best entry of someone else with a ghost that beats `own` (or any, without own). */
  static rivalOf(board: Board, own?: number): BoardEntry | undefined {
    const beats = (v: number) => own === undefined || (board.higher ? v > own : v < own);
    return board.entries.find((e) => !e.me && e.ghost && beats(e.value));
  }

  async rename(name: string) {
    // Online play shows the same name; the filter there also decides here.
    setPlayerName(name);
    const r = await this.call<{ name: string }>('/me', { method: 'PUT', body: JSON.stringify({ name }) });
    this.name = r.name;
    return r.name;
  }

  registerCommands(currentEvent: () => string | undefined, print: (s: string) => void, format: (event: string, v: number) => string) {
    const later = (p: Promise<string>) => { p.then(print, (e) => print(`Fehler: ${(e as Error).message}`)); return '…'; };
    registerCommand({ name: 'online', help: 'Bestenlisten: Verbindung und Name (verbindet neu)', run: () => later(this.connect().then((ok) =>
      ok ? `verbunden als ${this.name}` : `nicht verbunden: ${this.reason}`)) });
    registerCommand({ name: 'online.name', help: 'Deinen Namen in den Bestenlisten ändern', args: '<name>', run: ([...w]) => {
      if (!w.length) return this.name ?? 'nicht verbunden';
      return later(this.rename(w.join(' ')).then((n) => `Name: ${n}`));
    } });
    registerCommand({ name: 'online.board', help: 'Bestenliste eines Events (ohne Argument: das laufende oder letzte)', args: '[event-id]', run: ([id]) => {
      const ev = id ?? currentEvent();
      if (!ev) throw new Error('kein Event');
      return later(this.board(ev).then((b) => b.entries.map((e) => `${e.me ? '▶' : ' '} ${e.rank}. ${e.name.padEnd(14)} ${format(ev, e.value)}${e.ghost ? ' · Geist' : ''}`).join('\n') || 'noch keine Einträge'));
    } });
    registerToggle('online.send', 'Ergebnisse und Geister an die Bestenliste senden', () => this.send, (v) => (this.send = v));
    registerToggle('online.ghosts', 'Im Rennen fährt der Geist des besten Freundes mit, wenn er schneller ist als du', () => this.friendGhosts, (v) => (this.friendGhosts = v));
  }
}
