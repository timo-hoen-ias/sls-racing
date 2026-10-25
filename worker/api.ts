// Leaderboards and friends' ghosts (O1): one best result per player and event, with the ghost of that run.
// Behind Cloudflare Access the e-mail address identifies a player (token checked in auth.ts). In public mode
// (ONLINE_PUBLIC, timo 2026-10-25) it is the hashed random id of the browser instead, the name comes from the
// game and goes through the name filter, and a few limits keep one person from flooding the tables. Either way
// the id never leaves the Worker, the others only see the name.
import { cleanName } from '../src/net/names.ts';


/** The part of a D1 database the API uses (also met by the node:sqlite adapter in the tests). */
export interface Db {
  prepare(sql: string): Stmt;
}
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS players (email TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, ip TEXT, at INTEGER)',
  'CREATE TABLE IF NOT EXISTS scores (event TEXT NOT NULL, email TEXT NOT NULL, value REAL NOT NULL, higher INTEGER NOT NULL, car TEXT, at INTEGER NOT NULL, ghost TEXT, PRIMARY KEY (event, email))',
];
/** Largest ghost accepted (characters of JSON): about ten minutes of driving. */
export const MAX_GHOST = 400_000;
const TOP = 20;
/** Public mode: new players per address and day, results per player and minute. */
export const NEW_PLAYERS_PER_DAY = 6;
export const POSTS_PER_MINUTE = 20;

/** Public mode: who is calling (hashed address) and the name the game sends. */
export interface PublicPlayer { ip: string; name?: string }

let ready: Db | undefined;
async function schema(db: Db) {
  if (ready === db) return;
  for (const s of SCHEMA) await db.prepare(s).run();
  // Tables from before the public mode lack these columns (local wrangler dev databases).
  for (const col of ['ip TEXT', 'at INTEGER']) await db.prepare(`ALTER TABLE players ADD COLUMN ${col}`).run().catch(() => undefined);
  ready = db;
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string) => reply({ error }, status);
const validName = (s: unknown): s is string => typeof s === 'string' && /^[\p{L}\p{N} ._-]{2,20}$/u.test(s.trim());
const validEvent = (s: string) => /^[a-z0-9._-]{1,80}$/i.test(s);

class Refused extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const freeName = async (db: Db, name: string, email: string) => {
  const row = await db.prepare('SELECT email FROM players WHERE name = ?').bind(name).first<{ email: string }>();
  return !row || row.email === email;
};

/**
 * The player's name: chosen once, else the part of the address before the @ (made unique). In public mode the
 * name the game sends wins whenever it is free, so renaming in the online menu carries over to the boards.
 */
async function nameOf(db: Db, email: string, pub?: PublicPlayer): Promise<string> {
  const row = await db.prepare('SELECT name FROM players WHERE email = ?').bind(email).first<{ name: string }>();
  const wanted = pub ? cleanName(pub.name) : undefined;
  if (row) {
    if (wanted && wanted !== row.name && await freeName(db, wanted, email)) {
      await db.prepare('UPDATE players SET name = ? WHERE email = ?').bind(wanted, email).run();
      return wanted;
    }
    return row.name;
  }
  if (pub) {
    const fresh = await db.prepare('SELECT COUNT(*) AS n FROM players WHERE ip = ? AND at > ?').bind(pub.ip, Date.now() - 86_400_000).first<{ n: number }>();
    if ((fresh?.n ?? 0) >= NEW_PLAYERS_PER_DAY) throw new Refused(429, 'zu viele neue Spieler von dieser Adresse, morgen wieder');
  }
  const base = (wanted ?? ((pub ? '' : email.split('@')[0].replace(/[^\p{L}\p{N}._-]/gu, '')) || 'Fahrer')).slice(0, pub ? 13 : 16);
  for (let i = 0; i < 50; i++) {
    const name = i ? `${base}${pub ? ' ' : ''}${i + 1}` : base;
    if (await freeName(db, name, email)) {
      await db.prepare('INSERT INTO players (email, name, ip, at) VALUES (?, ?, ?, ?)').bind(email, name, pub?.ip ?? null, Date.now()).run();
      return name;
    }
  }
  throw new Error('kein freier Name');
}

/** The player's name for online play (O2): the same as on the leaderboards. */
export async function playerName(db: Db, email: string) {
  await schema(db);
  return nameOf(db, email);
}

/**
 * Routes under /api for a signed-in player:
 * GET /api/me, PUT /api/me {name}, GET /api/board/<event>, POST /api/board/<event> {value, higher, car?, ghost?},
 * GET /api/ghost/<event>/<name>.
 */
export async function handleApi(req: Request, db: Db, email: string, pub?: PublicPlayer): Promise<Response> {
  try {
    return await route(req, db, email, pub);
  } catch (e) {
    if (e instanceof Refused) return fail(e.status, e.message);
    throw e;
  }
}

async function route(req: Request, db: Db, email: string, pub?: PublicPlayer): Promise<Response> {
  await schema(db);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '').split('/').slice(2).map(decodeURIComponent);
  const me = await nameOf(db, email, pub);

  if (path[0] === 'me' && path.length === 1) {
    if (req.method === 'GET') return reply({ name: me });
    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      const name = pub ? cleanName(body.name) : validName(body.name) ? body.name.trim() : undefined;
      if (!name) return fail(400, pub ? 'Name: 2 bis 16 Zeichen (Buchstaben, Ziffern, Leerzeichen . _ -), keine Beleidigungen' : 'Name: 2 bis 20 Zeichen, Buchstaben, Ziffern, Leerzeichen . _ -');
      const taken = await db.prepare('SELECT email FROM players WHERE name = ?').bind(name).first<{ email: string }>();
      if (taken && taken.email !== email) return fail(409, 'Name schon vergeben');
      await db.prepare('UPDATE players SET name = ? WHERE email = ?').bind(name, email).run();
      return reply({ name });
    }
  }

  if (path[0] === 'board' && path.length === 2 && validEvent(path[1])) {
    const event = path[1];
    if (req.method === 'GET') {
      const any = await db.prepare('SELECT higher FROM scores WHERE event = ? LIMIT 1').bind(event).first<{ higher: number }>();
      const order = any?.higher ? 'DESC' : 'ASC';
      const rows = (await db.prepare(
        `SELECT p.name AS name, s.value AS value, s.car AS car, s.at AS at, s.ghost IS NOT NULL AS ghost, s.email = ? AS me
         FROM scores s JOIN players p ON p.email = s.email WHERE s.event = ? ORDER BY s.value ${order}, s.at ASC LIMIT ${TOP}`,
      ).bind(email, event).all<{ name: string; value: number; car: string | null; at: number; ghost: number; me: number }>()).results;
      return reply({ event, higher: !!any?.higher, entries: rows.map((r, i) => ({ rank: i + 1, name: r.name, value: r.value, car: r.car ?? undefined, at: r.at, ghost: !!r.ghost, me: !!r.me })) });
    }
    if (req.method === 'POST') {
      if (pub) {
        const recent = await db.prepare('SELECT COUNT(*) AS n FROM scores WHERE email = ? AND at > ?').bind(email, Date.now() - 60_000).first<{ n: number }>();
        if ((recent?.n ?? 0) >= POSTS_PER_MINUTE) return fail(429, 'zu viele Ergebnisse in kurzer Zeit');
      }
      const body = (await req.json().catch(() => ({}))) as { value?: unknown; higher?: unknown; car?: unknown; ghost?: unknown };
      if (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0) return fail(400, 'value fehlt');
      const higher = body.higher ? 1 : 0;
      const ghost = body.ghost === undefined ? null : JSON.stringify(body.ghost);
      if (ghost && ghost.length > MAX_GHOST) return fail(413, 'Geist zu groß');
      const car = typeof body.car === 'string' ? body.car.slice(0, 40) : null;
      const old = await db.prepare('SELECT value FROM scores WHERE event = ? AND email = ?').bind(event, email).first<{ value: number }>();
      const better = !old || (higher ? body.value > old.value : body.value < old.value);
      if (better) {
        await db.prepare('INSERT OR REPLACE INTO scores (event, email, value, higher, car, at, ghost) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(event, email, body.value, higher, car, Date.now(), ghost).run();
      }
      const rank = await db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE event = ? AND value ${higher ? '>' : '<'} ?`)
        .bind(event, better ? body.value : old!.value).first<{ n: number }>();
      return reply({ best: better, rank: (rank?.n ?? 0) + 1 });
    }
  }

  if (path[0] === 'ghost' && path.length === 3 && validEvent(path[1]) && req.method === 'GET') {
    const row = await db.prepare('SELECT s.ghost AS ghost, s.value AS value FROM scores s JOIN players p ON p.email = s.email WHERE s.event = ? AND p.name = ?')
      .bind(path[1], path[2]).first<{ ghost: string | null; value: number }>();
    if (!row?.ghost) return fail(404, 'kein Geist');
    return reply({ value: row.value, ...JSON.parse(row.ghost) });
  }

  return fail(404, 'unbekannter Aufruf');
}
