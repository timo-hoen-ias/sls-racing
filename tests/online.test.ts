import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { type Db, handleApi, type Stmt } from '../worker/api.ts';
import { accessEmail, resetKeyCache } from '../worker/auth.ts';
import { Online } from '../src/net/online.ts';

/** D1-like adapter over node:sqlite. */
function memoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt: Stmt = {
        bind: (...v: unknown[]) => { args = v; return stmt; },
        first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T) ?? null,
        all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
        run: async () => db.prepare(sql).run(...(args as never[])),
      };
      return stmt;
    },
  };
}

const call = async (db: Db, email: string, method: string, path: string, body?: unknown) => {
  const res = await handleApi(new Request(`https://x/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined }), db, email);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('leaderboard API (O1)', () => {
  it('keeps each player best, ranks lower times first and hands out ghosts by name', async () => {
    const db = memoryDb();
    expect((await call(db, 'timo@x.de', 'GET', 'me')).body.name).toBe('timo');
    expect((await call(db, 'timo@y.de', 'GET', 'me')).body.name).toBe('timo2');
    expect((await call(db, 'timo@y.de', 'PUT', 'me', { name: 'timo' })).status).toBe(409);
    expect((await call(db, 'timo@y.de', 'PUT', 'me', { name: 'Max' })).body.name).toBe('Max');
    const ghost = { poses: [1, 2, 3, 0, 0, 0, 1000] };
    expect((await call(db, 'timo@x.de', 'POST', 'board/sprint-1-2', { value: 62.5, higher: false, ghost })).body).toEqual({ best: true, rank: 1 });
    expect((await call(db, 'timo@y.de', 'POST', 'board/sprint-1-2', { value: 58, higher: false, ghost })).body).toEqual({ best: true, rank: 1 });
    // A slower run does not replace the best.
    expect((await call(db, 'timo@x.de', 'POST', 'board/sprint-1-2', { value: 70, higher: false })).body).toEqual({ best: false, rank: 2 });
    const board = (await call(db, 'timo@x.de', 'GET', 'board/sprint-1-2')).body as { entries: { name: string; value: number; me: boolean; ghost: boolean }[] };
    expect(board.entries.map((e) => [e.name, e.value, e.me])).toEqual([['Max', 58, false], ['timo', 62.5, true]]);
    expect(JSON.stringify(board)).not.toContain('@');
    const g = (await call(db, 'timo@x.de', 'GET', 'ghost/sprint-1-2/Max')).body;
    expect(g).toEqual({ value: 58, poses: ghost.poses });
    expect((await call(db, 'timo@x.de', 'GET', 'ghost/sprint-1-2/nobody')).status).toBe(404);
    // Higher is better for jumps.
    await call(db, 'timo@x.de', 'POST', 'board/jump-1', { value: 40, higher: true });
    expect((await call(db, 'timo@y.de', 'POST', 'board/jump-1', { value: 30, higher: true })).body).toEqual({ best: true, rank: 2 });
    expect((await call(db, 'timo@x.de', 'POST', 'board/x', { value: 'schnell' })).status).toBe(400);
    expect((await call(db, 'timo@x.de', 'POST', 'board/x', { value: 1, ghost: { poses: new Array(200_000).fill(123) } })).status).toBe(413);
  });

  it('picks the best friend ghost that beats your own', () => {
    const board = { event: 'e', higher: false, entries: [
      { rank: 1, name: 'me', value: 50, at: 0, ghost: true, me: true },
      { rank: 2, name: 'a', value: 55, at: 0, ghost: false, me: false },
      { rank: 3, name: 'b', value: 56, at: 0, ghost: true, me: false },
    ] };
    expect(Online.rivalOf(board, 60)?.name).toBe('b');
    expect(Online.rivalOf(board, 55)).toBeUndefined();
    expect(Online.rivalOf(board)?.name).toBe('b');
  });
});

describe('Access token check (O1)', () => {
  it('accepts only a token signed by the team, for this app, not expired', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' } as { kid: string; kty: string; n: string; e: string };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const sign = async (body: object) => {
      const head = enc({ alg: 'RS256', kid: 'k1' }), payload = enc(body);
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${payload}`));
      return `${head}.${payload}.${Buffer.from(sig).toString('base64url')}`;
    };
    const cfg = { team: 'team.cloudflareaccess.com', aud: 'aud1' };
    const keys = async () => [jwk];
    const now = 1_800_000_000;
    const good = { aud: ['aud1'], iss: 'https://team.cloudflareaccess.com', exp: now + 600, email: 'Timo@X.de' };
    resetKeyCache();
    expect(await accessEmail(await sign(good), cfg, keys, now)).toBe('timo@x.de');
    expect(await accessEmail(await sign({ ...good, aud: ['other'] }), cfg, keys, now)).toBeUndefined();
    expect(await accessEmail(await sign({ ...good, exp: now - 1 }), cfg, keys, now)).toBeUndefined();
    expect(await accessEmail(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }), cfg, keys, now)).toBeUndefined();
    const t = await sign(good);
    expect(await accessEmail(t.slice(0, -4) + 'AAAA', cfg, keys, now)).toBeUndefined();
    expect(await accessEmail(null, cfg, keys, now)).toBeUndefined();
  });
});
