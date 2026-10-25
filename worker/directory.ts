import { MAX_PLAYERS, type RoomSummary, validRoomId } from '../src/net/protocol.ts';
import { hasBlocked } from '../src/net/names.ts';
import type { DurableObjectState } from './cf.ts';

// The server list (O2): one Durable Object that knows every online server, its player count and the race
// running there. Three servers always exist; players can open more, which go away once they have been
// empty for a while. The servers report changes themselves (lobby.ts).

export const FIXED_ROOMS: { id: string; name: string }[] = [
  { id: 'saarlouis-1', name: 'Saarlouis 1' },
  { id: 'saarlouis-2', name: 'Saarlouis 2' },
  { id: 'saarlouis-3', name: 'Saarlouis 3' },
];
/** Player-made servers at most, and how long an empty one stays listed. */
const MAX_ROOMS = 24;
const EMPTY_MS = 15 * 60_000;
/** Servers one address may open per ten minutes (public play). */
const CREATE_PER_IP = 3;
const CREATE_WINDOW = 10 * 60_000;

interface Room { name: string; players: number; race?: string; updated: number }

const validName = (s: unknown): s is string => typeof s === 'string' && /^[\p{L}\p{N} ._!?'-]{2,30}$/u.test(s.trim());

export function slug(name: string) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return base || 'server';
}

export class Directory {
  private ctx: DurableObjectState;
  private rooms: Record<string, Room> = {};
  private loaded = false;
  private created = new Map<string, number[]>();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async load() {
    if (this.loaded) return;
    this.rooms = (await this.ctx.storage.get<Record<string, Room>>('rooms')) ?? {};
    this.loaded = true;
  }

  private save() {
    return this.ctx.storage.put('rooms', this.rooms);
  }

  private prune(now = Date.now()) {
    for (const [id, r] of Object.entries(this.rooms)) {
      if (!FIXED_ROOMS.some((f) => f.id === id) && r.players <= 0 && now - r.updated > EMPTY_MS) delete this.rooms[id];
    }
  }

  list(): RoomSummary[] {
    this.prune();
    const fixed = FIXED_ROOMS.map((f) => ({ id: f.id, name: f.name, players: this.rooms[f.id]?.players ?? 0, race: this.rooms[f.id]?.race, max: MAX_PLAYERS, fixed: true }));
    const made = Object.entries(this.rooms).filter(([id]) => !FIXED_ROOMS.some((f) => f.id === id))
      .map(([id, r]) => ({ id, name: r.name, players: r.players, race: r.race, max: MAX_PLAYERS }))
      .sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
    return [...fixed, ...made];
  }

  room(id: string) {
    const f = FIXED_ROOMS.find((x) => x.id === id);
    if (f) return { id, name: f.name };
    const r = this.rooms[id];
    return r ? { id, name: r.name } : undefined;
  }

  async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'list') return Response.json({ servers: this.list() });
    if (parts[0] === 'room' && parts[1]) {
      const r = this.room(parts[1]);
      return r ? Response.json(r) : Response.json({ error: 'Server gibt es nicht (mehr)' }, { status: 404 });
    }
    if (parts[0] === 'create' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (!validName(body.name) || hasBlocked(body.name)) return Response.json({ error: 'Name: 2 bis 30 Zeichen' }, { status: 400 });
      this.prune();
      const ip = req.headers.get('x-sls-ip') ?? '';
      const now = Date.now();
      const recent = (this.created.get(ip) ?? []).filter((t) => now - t < CREATE_WINDOW);
      if (recent.length >= CREATE_PER_IP) return Response.json({ error: 'Gerade schon genug Server eröffnet, bitte später' }, { status: 429 });
      recent.push(now);
      this.created.set(ip, recent);
      if (Object.keys(this.rooms).filter((id) => !FIXED_ROOMS.some((f) => f.id === id)).length >= MAX_ROOMS) return Response.json({ error: 'Zu viele Server offen' }, { status: 429 });
      const name = body.name.trim();
      let id = slug(name);
      while (this.room(id)) id = `${slug(name)}-${Math.random().toString(36).slice(2, 6)}`;
      this.rooms[id] = { name, players: 0, updated: Date.now() };
      await this.save();
      return Response.json({ id, name });
    }
    if (parts[0] === 'update' && req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { id?: unknown; players?: unknown; race?: unknown };
      if (typeof b.id !== 'string' || !validRoomId(b.id) || typeof b.players !== 'number') return Response.json({ error: 'bad' }, { status: 400 });
      const known = this.room(b.id);
      if (!known) return Response.json({ ok: false });
      this.rooms[b.id] = { name: known.name, players: Math.max(0, Math.min(MAX_PLAYERS, b.players)), race: typeof b.race === 'string' ? b.race.slice(0, 80) : undefined, updated: Date.now() };
      await this.save();
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'unbekannt' }, { status: 404 });
  }
}
