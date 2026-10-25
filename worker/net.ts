import { validRoomId } from '../src/net/protocol.ts';
import type { DurableObjectNamespace } from './cf.ts';

// Online play routes (O2), for a player who got past Cloudflare Access:
// GET /api/net/servers (server list), POST /api/net/servers {name} (open a server),
// GET /api/net/servers/<id>/ws (WebSocket into that server's Durable Object).
// The Durable Objects only ever see a hash of the e-mail address and the player's name.

export interface NetEnv {
  LOBBY?: DurableObjectNamespace;
  DIRECTORY?: DurableObjectNamespace;
}

export interface NetPlayer {
  /** Hash of the Access e-mail: the same person on two tabs is one player. */
  key: string;
  name: string;
  /** Hash of the address the request came from (limits on opening servers). */
  ip?: string;
}

/** Short hash of an e-mail address (hex). */
export async function playerKey(email: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sls:${email}`)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

export async function handleNet(req: Request, env: NetEnv, player: NetPlayer): Promise<Response> {
  const { LOBBY, DIRECTORY } = env;
  if (!LOBBY || !DIRECTORY) return fail(503, 'Online-Server noch nicht eingerichtet');
  const dir = DIRECTORY.get(DIRECTORY.idFromName('main'));
  const parts = new URL(req.url).pathname.split('/').filter(Boolean).slice(2);
  if (parts[0] !== 'servers') return fail(404, 'unbekannter Aufruf');
  if (parts.length === 1 && req.method === 'GET') {
    const r = await dir.fetch('https://directory/list');
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  if (parts.length === 1 && req.method === 'POST') {
    return dir.fetch('https://directory/create', { method: 'POST', body: await req.text(), headers: { 'x-sls-ip': player.ip ?? '' } });
  }
  if (parts.length === 3 && parts[2] === 'ws' && validRoomId(parts[1])) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'WebSocket erwartet');
    const room = await dir.fetch(`https://directory/room/${parts[1]}`);
    if (!room.ok) return fail(404, 'Server gibt es nicht (mehr)');
    const { name } = (await room.json()) as { name: string };
    const headers = new Headers(req.headers);
    headers.set('x-sls-key', player.key);
    headers.set('x-sls-name', encodeURIComponent(player.name));
    headers.set('x-sls-room', parts[1]);
    headers.set('x-sls-room-name', encodeURIComponent(name));
    return LOBBY.get(LOBBY.idFromName(parts[1])).fetch(new Request(req.url, { headers }));
  }
  return fail(404, 'unbekannter Aufruf');
}
