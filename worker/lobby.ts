import { LobbyCore } from '../src/net/lobbyCore.ts';
import type { PlayerInfo, RaceInfo, ServerMsg } from '../src/net/protocol.ts';
import { type CfWebSocket, type DurableObjectNamespace, type DurableObjectState, socketPair, upgraded } from './cf.ts';

// One online server (O2) as a Durable Object: the WebSockets of up to eight players and the room logic in
// src/net/lobbyCore.ts. WebSockets use the hibernation API, so an empty or quiet server costs nothing; the
// players (id, name, car) ride on their sockets and the race on storage, and both come back on wake-up.
// Every change of players or race goes to the server list (directory.ts).

interface Env { DIRECTORY?: DurableObjectNamespace }
interface Attachment { key: string; info: PlayerInfo }

export class Lobby {
  private ctx: DurableObjectState;
  private env: Env;
  private core: LobbyCore;
  private room = '';
  private roomName = '';
  private sockets = new Map<number, CfWebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.core = new LobbyCore('');
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      this.sockets.set(a.info.id, ws);
      this.core.restore(a.key, a.info, this.sender(ws), this.closer(ws));
    }
    void ctx.blockConcurrencyWhile(async () => {
      this.core.race = (await ctx.storage.get<RaceInfo>('race')) ?? null;
      this.room = (await ctx.storage.get<string>('room')) ?? '';
      this.roomName = (await ctx.storage.get<string>('name')) ?? '';
      this.core.room = this.room;
    });
    this.core.onChange = () => void this.changed();
  }

  private sender(ws: CfWebSocket) {
    return (m: ServerMsg) => { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } };
  }

  private closer(ws: CfWebSocket) {
    return (why: string) => { try { ws.close(4001, why); } catch { /* closed */ } };
  }

  async fetch(req: Request): Promise<Response> {
    const header = (k: string) => { try { return decodeURIComponent(req.headers.get(k) ?? ''); } catch { return ''; } };
    const room = header('x-sls-room'), name = header('x-sls-room-name') || room;
    if (room && room !== this.room) {
      this.room = room;
      this.core.room = room;
      await this.ctx.storage.put('room', room);
    }
    if (name && name !== this.roomName) { this.roomName = name; await this.ctx.storage.put('name', name); }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return Response.json({ room: this.room, ...this.core.summary() });
    const key = header('x-sls-key'), player = header('x-sls-name') || 'Fahrer';
    const [client, server] = socketPair();
    this.ctx.acceptWebSocket(server);
    const peer = this.core.add(key, player, this.sender(server), this.closer(server));
    if (!peer) {
      server.send(JSON.stringify({ t: 'error', text: 'Server voll (8 Spieler)' } satisfies ServerMsg));
      server.close(4000, 'voll');
      return upgraded(client);
    }
    this.sockets.set(peer.info.id, server);
    server.serializeAttachment({ key, info: peer.info } satisfies Attachment);
    return upgraded(client);
  }

  private idOf(ws: CfWebSocket) {
    return (ws.deserializeAttachment() as Attachment | null)?.info.id;
  }

  async webSocketMessage(ws: CfWebSocket, msg: string | ArrayBuffer) {
    const id = this.idOf(ws);
    if (id === undefined || typeof msg !== 'string' || msg.length > 4000) return;
    this.core.message(id, msg);
    // Car and colour come with hello/look: keep them on the socket for a wake-up.
    if (msg.includes('"hello"') || msg.includes('"look"')) {
      const p = this.core.players.get(id);
      if (p) ws.serializeAttachment({ key: p.key, info: p.info } satisfies Attachment);
    }
    await this.schedule();
  }

  async webSocketClose(ws: CfWebSocket) {
    const id = this.idOf(ws);
    if (id !== undefined && this.sockets.get(id) === ws) { this.sockets.delete(id); this.core.remove(id); }
    try { ws.close(1000, 'bye'); } catch { /* closed */ }
  }

  async webSocketError(ws: CfWebSocket) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    this.core.tick();
    await this.schedule();
  }

  private async schedule() {
    const at = this.core.nextWake();
    if (at !== undefined) await this.ctx.storage.setAlarm(at);
  }

  private async changed() {
    await this.ctx.storage.put('race', this.core.race);
    await this.schedule();
    const dir = this.env.DIRECTORY;
    if (!dir || !this.room) return;
    await dir.get(dir.idFromName('main')).fetch('https://directory/update', {
      method: 'POST', body: JSON.stringify({ id: this.room, ...this.core.summary() }),
    }).catch(() => {});
  }
}
