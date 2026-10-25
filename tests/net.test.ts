import { describe, expect, it } from 'vitest';
import type { GameEvent, Gate } from '../src/game/events/types.ts';
import { Bot } from '../src/net/bots.ts';
import { gridSlot } from '../src/net/grid.ts';
import { LobbyCore } from '../src/net/lobbyCore.ts';
import { NetSession, sampleSnaps, type Transport } from '../src/net/netSession.ts';
import { ALL_IN_SECONDS, type ClientMsg, GATHER_SECONDS, MAX_PLAYERS, packPose, parseClient, POSE_LEN, PREP_SECONDS, PROTOCOL, RESULT_SECONDS, type ServerMsg } from '../src/net/protocol.ts';
import { RoadGraph } from '../src/world/roadGraph.ts';
import type { RoadGraphData } from '../src/world/format.ts';
import { Directory, FIXED_ROOMS, slug } from '../worker/directory.ts';
import { handleNet, playerKey } from '../worker/net.ts';
import worker from '../worker/index.ts';

const pose = (x = 0, z = 0) => [x, 1, z, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];

/** A server on a hand-wound clock and players that keep what they receive. */
function room() {
  let t = 1000;
  const core = new LobbyCore('test', () => t);
  const inbox = new Map<number, ServerMsg[]>();
  const join = (key: string, name = key) => {
    const box: ServerMsg[] = [];
    const p = core.add(key, name, (m) => box.push(structuredClone(m)));
    if (!p) return undefined;
    inbox.set(p.info.id, box);
    core.message(p.info.id, { t: 'hello', v: PROTOCOL, car: 'gt', color: '#123456' });
    return p.info.id;
  };
  return { core, inbox, join, advance: (ms: number) => { t += ms; core.tick(); }, now: () => t };
}

describe('online protocol (O2)', () => {
  it('accepts only sane messages', () => {
    expect(parseClient('{"t":"s","p":[1,2,3,0,0,0,1,0,0,0,0,0,0,0]}')).toEqual({ t: 's', p: [1, 2, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] });
    expect(parseClient({ t: 's', p: [1, 2, 3] })).toBeUndefined();
    expect(parseClient({ t: 's', p: [1e9, 2, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] })).toBeUndefined();
    expect(parseClient({ t: 's', p: [NaN, 2, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] })).toBeUndefined();
    expect(parseClient({ t: 'hello', v: 1, car: 'gt', color: 'red' })).toBeUndefined();
    expect(parseClient({ t: 'race', event: '../x', name: 'x' })).toBeUndefined();
    expect(parseClient({ t: 'chat', text: '  ' })).toBeUndefined();
    expect(parseClient({ t: 'chat', text: 'x'.repeat(500) })).toEqual({ t: 'chat', text: 'x'.repeat(200) });
    expect(parseClient('kein json')).toBeUndefined();
    expect(packPose([1.23456, 2, 3, 0.70710678, 0, 0, 0.7071, 12.345, 0, 0, 0.1234, 3, 7, 12.3456]).join()).toBe('1.23,2,3,0.707,0,0,0.707,12.35,0,0,0.123,3,7,12.35');
  });

  it('lets eight players in, relays poses to the others and replaces a second tab of the same player', () => {
    const r = room();
    const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => r.join(`p${i}`, i < 2 ? 'Timo' : `P${i}`));
    expect(ids.every((x) => x !== undefined)).toBe(true);
    expect(r.join('p9')).toBeUndefined();
    // Two players called the same get told apart.
    expect(r.core.players.get(ids[1]!)!.info.name).toBe('Timo 2');
    const welcome = r.inbox.get(ids[7]!)!.find((m) => m.t === 'welcome');
    expect(welcome && welcome.t === 'welcome' && welcome.players.length).toBe(8);
    r.core.message(ids[0]!, { t: 's', p: pose(5, 6) });
    const got = r.inbox.get(ids[3]!)!.filter((m) => m.t === 's');
    expect(got).toEqual([{ t: 's', id: ids[0], p: pose(5, 6), ts: r.now() }]);
    expect(r.inbox.get(ids[0]!)!.some((m) => m.t === 's')).toBe(false);
    // The same player again: the old connection goes, the others hear it left.
    r.core.remove(ids[7]!);
    const again = r.join('p0', 'Timo');
    expect(again).toBeDefined();
    expect(r.core.count).toBe(7);
    expect(r.inbox.get(ids[3]!)!.some((m) => m.t === 'leave' && m.id === ids[0])).toBe(true);
  });

  it('runs a race: announce, gather, shared start, finish order, results, back to free roam', () => {
    const r = room();
    const a = r.join('a', 'Anna')!, b = r.join('b', 'Ben')!, c = r.join('c', 'Cem')!;
    r.core.message(a, { t: 'race', event: 'sprint-1', name: 'Sprint Altstadt' });
    expect(r.core.race?.phase).toBe('gather');
    // A second race cannot start while one runs.
    r.core.message(b, { t: 'race', event: 'sprint-2', name: 'Anderer' });
    expect(r.core.race?.event).toBe('sprint-1');
    expect(r.inbox.get(b)!.some((m) => m.t === 'error')).toBe(true);
    r.core.message(b, { t: 'join' });
    expect(r.core.race?.entrants).toEqual([a, b]);
    // Only the host can start early; then the countdown runs to a start time everyone shares.
    r.core.message(b, { t: 'go' });
    expect(r.core.race?.phase).toBe('gather');
    r.core.message(a, { t: 'go' });
    expect(r.core.race?.phase).toBe('countdown');
    expect(r.core.race?.startAt).toBe(r.now() + PREP_SECONDS * 1000);
    // Too late to join now.
    r.core.message(c, { t: 'join' });
    expect(r.core.race?.entrants).toEqual([a, b]);
    r.advance(PREP_SECONDS * 1000);
    expect(r.core.race?.phase).toBe('running');
    r.core.message(b, { t: 'finish', time: 61.5 });
    expect(r.core.race?.results.map((x) => x.name)).toEqual(['Ben']);
    r.core.message(b, { t: 'finish', time: 50 });
    r.core.message(c, { t: 'finish', time: 10 });
    r.core.message(a, { t: 'finish', time: 63 });
    expect(r.core.race?.phase).toBe('done');
    expect(r.core.race?.results.map((x) => [x.name, x.time])).toEqual([['Ben', 61.5], ['Anna', 63]]);
    expect(r.core.summary().race).toBeUndefined();
    r.advance(RESULT_SECONDS * 1000);
    expect(r.core.race).toBeNull();
    expect(r.inbox.get(c)!.filter((m) => m.t === 'race').at(-1)).toEqual({ t: 'race', race: null });
  });

  it('starts sooner when everyone joined, ends after the grace time and counts leavers as not finished', () => {
    const r = room();
    const a = r.join('a')!, b = r.join('b')!, c = r.join('c')!;
    r.core.message(a, { t: 'race', event: 'circuit-1', name: 'Ring' });
    r.core.message(b, { t: 'join' });
    r.advance(ALL_IN_SECONDS * 1000);
    expect(r.core.race?.phase).toBe('gather');
    r.core.message(c, { t: 'join' });
    r.advance(ALL_IN_SECONDS * 1000);
    expect(r.core.race?.phase).toBe('countdown');
    expect(r.core.race?.entrants).toEqual([a, b, c]);
    r.advance(PREP_SECONDS * 1000);
    r.core.remove(c);
    expect(r.core.race?.results).toEqual([{ id: c, name: 'c' }]);
    r.core.message(a, { t: 'finish', time: 80 });
    r.advance(46_000);
    expect(r.core.race?.phase).toBe('done');
    expect(r.core.race?.results.map((x) => [x.id, x.time])).toEqual([[a, 80], [c, undefined], [b, undefined]]);
    // A race nobody joined goes away after the gather time.
    r.advance(RESULT_SECONDS * 1000);
    r.core.message(a, { t: 'race', event: 'x', name: 'x' });
    r.core.message(a, { t: 'quit' });
    expect(r.core.race).toBeNull();
    expect(GATHER_SECONDS).toBeGreaterThan(ALL_IN_SECONDS);
  });
});

describe('online session (O2)', () => {
  it('draws the others between their poses and a little ahead of the newest', () => {
    const out = new Array(POSE_LEN).fill(0);
    const a = [0, 0, 0, 0, 0, 0, 1, 10, 0, 0, 0, 1, 2, 30], b = [10, 0, 0, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 10, 0, 0, 0.2, 3, 3, 20];
    const snaps = [{ t: 1000, p: a }, { t: 2000, p: b }];
    expect(sampleSnaps(snaps, 1500, out)).toBe(true);
    expect(out[0]).toBeCloseTo(5);
    expect(out[10]).toBeCloseTo(0.1);
    expect(Math.hypot(out[3], out[4], out[5], out[6])).toBeCloseTo(1);
    expect(out[11]).toBe(3);
    sampleSnaps(snaps, 2100, out);
    expect(out[0]).toBeCloseTo(11);
    // Not further than the extrapolation limit.
    sampleSnaps(snaps, 9000, out);
    expect(out[0]).toBeCloseTo(13.5);
    expect(sampleSnaps([], 0, out)).toBe(false);
  });

  it('connects, learns the others and the clock, and follows the race', () => {
    let t = 50_000;
    const core = new LobbyCore('r1', () => t + 7000);
    /** Synchronous transport straight into the room. */
    const transport = (name: string): Transport => {
      const tr: Transport & { id?: number } = {
        send: (m: ClientMsg) => core.message(tr.id!, m),
        close: () => core.remove(tr.id!),
      };
      queueMicrotask(() => {
        tr.id = core.add(name, name, (m) => tr.onMessage?.(structuredClone(m)))!.info.id;
        tr.onOpen?.();
      });
      return tr;
    };
    const s1 = new NetSession(() => t), s2 = new NetSession(() => t);
    const events: string[] = [];
    s1.onEvent = (e) => events.push(e.kind);
    s1.connect(transport('Anna'), 'Server 1', { car: 'gt', color: '#ff0000' });
    s2.connect(transport('Ben'), 'Server 1', { car: 'rally', color: '#00ff00' });
    return new Promise<void>((done) => queueMicrotask(() => queueMicrotask(() => {
      expect(s1.online && s2.online).toBe(true);
      expect(s1.offset).toBe(7000);
      expect([...s1.players.values()].map((p) => p.info.name)).toEqual(['Ben']);
      expect(s2.players.get(s1.me!.id)?.info.car).toBe('gt');
      s1.update(0.1, () => pose(3, 4));
      expect(s2.players.get(s1.me!.id)?.latest?.[0]).toBe(3);
      s2.send({ t: 'race', event: 'e1', name: 'E1' });
      expect(s1.race?.host).toBe(s2.me!.id);
      expect(events).toContain('race');
      s2.leave();
      expect(s1.players.size).toBe(0);
      expect(s1.race).toBeNull();
      done();
    })));
  });
});

/** A 400 m square of streets around (0, 0)…(400, 400). */
function squareTown() {
  const corners = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const data: RoadGraphData = { v: 1, names: ['Ring'], nodes: corners.flatMap(([x, z]) => [x, 0, z]), edges: [] };
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const p: number[] = [];
    for (let k = 0; k <= 20; k++) p.push(ax + ((bx - ax) * k) / 20, 0, az + ((bz - az) * k) / 20);
    data.edges.push({ a: i, b: (i + 1) % 4, n: 0, c: 4, w: 8, p });
  }
  return new RoadGraph(data);
}

const gate = (x: number, z: number, dx: number, dz: number): Gate => ({ x, y: 0, z, dx, dz, w: 8 });

describe('test players (net.local)', () => {
  it('cruise the streets, join a race, start from the grid and finish it', () => {
    const graph = squareTown();
    const race: GameEvent = {
      id: 'sprint-test', type: 'sprint', name: 'Testsprint', where: 'Ring', start: gate(20, 0, 1, 0),
      gates: [gate(390, 0, 1, 0), gate(400, 200, 0, 1), gate(400, 390, 0, 1)],
      path: [20, 0, 400, 0, 400, 400], medals: [60, 50, 40, 30], higher: false, unit: 's', level: 1,
    };
    let t = 0;
    const core = new LobbyCore('lokal', () => t);
    const deps = { graph, events: () => [race], near: () => ({ x: 0, z: 0 }) };
    const bots = [0, 1, 2].map((i) => new Bot(core, deps, i));
    const human = core.add('me', 'Du', () => {})!;
    core.message(human.info.id, { t: 'hello', v: PROTOCOL, car: 'gt', color: '#ffffff' });
    const step = (sec: number) => { for (let k = 0; k < sec * 20; k++) { t += 50; core.tick(); for (const b of bots) b.step(0.05); } };
    step(5);
    // Free roam: on the ring (within a lane of its edges).
    for (const b of bots) {
      const p = core.players.get(b.id)!;
      expect(p.ready).toBe(true);
    }
    core.message(human.info.id, { t: 'race', event: race.id, name: race.name });
    step(7);
    expect(core.race?.entrants.length).toBe(4);
    expect(core.race?.phase).toBe('countdown');
    core.message(human.info.id, { t: 'quit' });
    for (let k = 0; k < 120 && core.race?.phase !== 'done'; k++) step(1);
    const res = core.race?.results ?? [];
    expect(res.filter((x) => x.time !== undefined).length).toBe(3);
    for (const x of res.filter((y) => y.time !== undefined)) expect(x.time!).toBeGreaterThan(15);
    expect(core.race?.phase).toBe('done');
  });

  it('puts the grid two by two behind the start, facing along it', () => {
    const e = { start: gate(100, 50, 1, 0) } as GameEvent;
    const s0 = gridSlot(e, 0), s1 = gridSlot(e, 1), s2 = gridSlot(e, 2);
    expect(s0.x).toBeCloseTo(94);
    expect(s0.z).not.toBeCloseTo(s1.z);
    expect(s2.x).toBeCloseTo(86);
    expect(s0.heading).toBeCloseTo(Math.PI / 2);
  });
});

/** Durable Object storage in memory. */
function storage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); },
    delete: async (k: string) => m.delete(k),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

describe('server list and Worker routes (O2)', () => {
  it('lists the fixed servers, opens and names new ones and keeps player counts', async () => {
    const dir = new Directory({ storage: storage(), acceptWebSocket() {}, getWebSockets: () => [], blockConcurrencyWhile: (f) => f() });
    const list = async () => ((await (await dir.fetch(new Request('https://d/list'))).json()) as { servers: { id: string; players: number; name: string }[] }).servers;
    expect((await list()).map((x) => x.id)).toEqual(FIXED_ROOMS.map((f) => f.id));
    const made = (await (await dir.fetch(new Request('https://d/create', { method: 'POST', body: JSON.stringify({ name: 'Timos Straßenrennen' }) }))).json()) as { id: string };
    expect(made.id).toBe('timos-strassenrennen');
    const again = (await (await dir.fetch(new Request('https://d/create', { method: 'POST', body: JSON.stringify({ name: 'Timos Straßenrennen' }) }))).json()) as { id: string };
    expect(again.id).not.toBe(made.id);
    expect((await dir.fetch(new Request('https://d/create', { method: 'POST', body: JSON.stringify({ name: '<script>' }) }))).status).toBe(400);
    await dir.fetch(new Request('https://d/update', { method: 'POST', body: JSON.stringify({ id: made.id, players: 3, race: 'Sprint' }) }));
    const l = await list();
    expect(l.find((x) => x.id === made.id)).toMatchObject({ players: 3, name: 'Timos Straßenrennen' });
    expect((await dir.fetch(new Request('https://d/room/gibts-nicht'))).status).toBe(404);
    expect(slug('Ärger & Spaß!')).toBe('arger-spass');
  });

  it('keeps online play shut without Access and Durable Objects, and never hands the e-mail to a server', async () => {
    const env = { ASSETS: { fetch: async () => new Response('x') }, ACCESS_TEAM: '', ACCESS_AUD: '' };
    expect((await worker.fetch(new Request('https://x/api/net/servers'), env)).status).toBe(503);
    const dev = { ...env, DEV_NO_AUTH: '1' };
    const r = await worker.fetch(new Request('https://x/api/net/servers'), dev);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toContain('Online-Server');
    // Forwarded to the lobby: hashed key and name, not the address.
    let seen: Request | undefined;
    const ns = (fetcher: (req: Request) => Promise<Response>) => ({ idFromName: (n: string) => n, get: () => ({ fetch: (i: Request | string, init?: RequestInit) => fetcher(typeof i === 'string' ? new Request(i, init) : i) }) });
    const net = {
      DIRECTORY: ns(async () => Response.json({ id: 'saarlouis-1', name: 'Saarlouis 1' })),
      LOBBY: ns(async (req) => { seen = req; return new Response('ok'); }),
    };
    const ws = new Request('https://x/api/net/servers/saarlouis-1/ws', { headers: { upgrade: 'websocket' } });
    await handleNet(ws, net, { key: await playerKey('timo@x.de'), name: 'Tímo' });
    expect(seen?.headers.get('x-sls-key')).toMatch(/^[0-9a-f]{24}$/);
    expect(decodeURIComponent(seen!.headers.get('x-sls-name')!)).toBe('Tímo');
    expect([...seen!.headers.values()].join()).not.toContain('@');
    expect((await handleNet(new Request('https://x/api/net/servers/saarlouis-1/ws'), net, { key: 'k', name: 'n' })).status).toBe(426);
  });
});

describe('public online play (O2)', () => {
  it('filters names and lets anyone in with their own id', async () => {
    const { cleanName } = await import('../src/net/names.ts');
    expect(cleanName('  Timo   S. ')).toBe('Timo S.');
    expect(cleanName('Jürgen_77')).toBe('Jürgen_77');
    expect(cleanName('x')).toBeUndefined();
    expect(cleanName('N4Z1 Fahrer')).toBeUndefined();
    expect(cleanName('<b>hi</b>')).toBeUndefined();
    expect(cleanName('Heiligenwald')).toBe('Heiligenwald');
    let seen: Request | undefined;
    const ns = (fetcher: (req: Request) => Promise<Response>) => ({ idFromName: (n: string) => n, get: () => ({ fetch: (i: Request | string, init?: RequestInit) => fetcher(typeof i === 'string' ? new Request(i, init) : i) }) });
    const env = {
      ASSETS: { fetch: async () => new Response('x') }, ACCESS_TEAM: '', ACCESS_AUD: '', ONLINE_PUBLIC: '1',
      DIRECTORY: ns(async () => Response.json({ id: 'saarlouis-1', name: 'Saarlouis 1' })),
      LOBBY: ns(async (req) => { seen = req; return new Response('ok'); }),
    };
    const ws = (q: string) => new Request(`https://x/api/net/servers/saarlouis-1/ws?${q}`, { headers: { upgrade: 'websocket' } });
    await worker.fetch(ws('pid=abcdefghijklmnop1234&name=Anna'), env);
    const k1 = seen!.headers.get('x-sls-key');
    expect(decodeURIComponent(seen!.headers.get('x-sls-name')!)).toBe('Anna');
    await worker.fetch(ws('pid=abcdefghijklmnop1234&name=fuck'), env);
    expect(seen!.headers.get('x-sls-key')).toBe(k1);
    expect(decodeURIComponent(seen!.headers.get('x-sls-name')!)).toBe('Fahrer');
    await worker.fetch(ws('pid=zzzzzzzzzzzzzzzz9999&name=Ben'), env);
    expect(seen!.headers.get('x-sls-key')).not.toBe(k1);
    // The leaderboards stay shut.
    expect((await worker.fetch(new Request('https://x/api/me'), env)).status).toBe(503);
  });

  it('limits floods, chat spam, race spam and opening servers', async () => {
    const r = room();
    const a = r.join('a')!, b = r.join('b')!;
    for (let i = 0; i < 100; i++) r.core.message(a, { t: 's', p: pose(i, 0) });
    // The hello counted in the same second.
    expect(r.inbox.get(b)!.filter((m) => m.t === 's').length).toBe(59);
    r.advance(1000);
    r.core.message(a, { t: 'chat', text: 'hallo' });
    r.core.message(a, { t: 'chat', text: 'hallo' });
    expect(r.inbox.get(b)!.filter((m) => m.t === 'chat').length).toBe(1);
    r.core.message(a, { t: 'race', event: 'e', name: 'E' });
    r.core.message(a, { t: 'quit' });
    r.core.message(a, { t: 'race', event: 'e', name: 'E' });
    expect(r.core.race).toBeNull();
    const dir = new Directory({ storage: storage(), acceptWebSocket() {}, getWebSockets: () => [], blockConcurrencyWhile: (f) => f() });
    const make = (n: string) => dir.fetch(new Request('https://d/create', { method: 'POST', body: JSON.stringify({ name: n }), headers: { 'x-sls-ip': 'ip1' } }));
    for (const n of ['Eins', 'Zwei', 'Drei']) expect((await make(n)).status).toBe(200);
    expect((await make('Vier')).status).toBe(429);
    expect((await dir.fetch(new Request('https://d/create', { method: 'POST', body: JSON.stringify({ name: 'Hitler Rennen' }) }))).status).toBe(400);
  });
});
