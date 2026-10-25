// Leaderboards and friends' ghosts (O1): one best result per player and event, with the ghost of that run.
// Only invited friends get here (Cloudflare Access in front, token checked in auth.ts); the e-mail address
// identifies a player and never leaves the Worker, the others only see the chosen name.

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
  'CREATE TABLE IF NOT EXISTS players (email TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)',
  'CREATE TABLE IF NOT EXISTS scores (event TEXT NOT NULL, email TEXT NOT NULL, value REAL NOT NULL, higher INTEGER NOT NULL, car TEXT, at INTEGER NOT NULL, ghost TEXT, PRIMARY KEY (event, email))',
];
/** Largest ghost accepted (characters of JSON): about ten minutes of driving. */
export const MAX_GHOST = 400_000;
const TOP = 20;

let ready: Db | undefined;
async function schema(db: Db) {
  if (ready === db) return;
  for (const s of SCHEMA) await db.prepare(s).run();
  ready = db;
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string) => reply({ error }, status);
const validName = (s: unknown): s is string => typeof s === 'string' && /^[\p{L}\p{N} ._-]{2,20}$/u.test(s.trim());
const validEvent = (s: string) => /^[a-z0-9._-]{1,80}$/i.test(s);

/** The player's name: chosen once, else the part of the address before the @ (made unique). */
async function nameOf(db: Db, email: string): Promise<string> {
  const row = await db.prepare('SELECT name FROM players WHERE email = ?').bind(email).first<{ name: string }>();
  if (row) return row.name;
  const base = (email.split('@')[0].replace(/[^\p{L}\p{N}._-]/gu, '') || 'Fahrer').slice(0, 16);
  for (let i = 0; i < 50; i++) {
    const name = i ? `${base}${i + 1}` : base;
    const taken = await db.prepare('SELECT 1 AS x FROM players WHERE name = ?').bind(name).first();
    if (!taken) {
      await db.prepare('INSERT INTO players (email, name) VALUES (?, ?)').bind(email, name).run();
      return name;
    }
  }
  throw new Error('kein freier Name');
}

/**
 * Routes under /api for a signed-in player:
 * GET /api/me, PUT /api/me {name}, GET /api/board/<event>, POST /api/board/<event> {value, higher, car?, ghost?},
 * GET /api/ghost/<event>/<name>.
 */
export async function handleApi(req: Request, db: Db, email: string): Promise<Response> {
  await schema(db);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '').split('/').slice(2).map(decodeURIComponent);
  const me = await nameOf(db, email);

  if (path[0] === 'me' && path.length === 1) {
    if (req.method === 'GET') return reply({ name: me });
    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (!validName(body.name)) return fail(400, 'Name: 2 bis 20 Zeichen, Buchstaben, Ziffern, Leerzeichen . _ -');
      const name = body.name.trim();
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
