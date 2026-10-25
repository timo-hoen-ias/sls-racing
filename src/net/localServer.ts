import { Bot, type BotDeps } from './bots.ts';
import { LobbyCore } from './lobbyCore.ts';
import type { NetSession, Transport } from './netSession.ts';
import { type ClientMsg, MAX_PLAYERS, type ServerMsg } from './protocol.ts';

// Local test mode of online play (net.local): the same server logic as the Durable Object, running in the
// browser, with test players (bots.ts) and an adjustable delay. Works with the plain dev server and while
// Cloudflare Access is not set up yet.

export class LocalServer {
  readonly core = new LobbyCore('lokal');
  readonly bots: Bot[] = [];
  /** One-way delay of every message (ms, net.lag). */
  lag = 30;
  private timer: ReturnType<typeof setInterval>;
  private d: BotDeps;

  constructor(d: BotDeps) {
    this.d = d;
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      this.core.tick();
      for (const b of this.bots) b.step(dt);
    }, 50);
  }

  /** Brings the bots up to n (leaves room for the player). */
  setBots(n: number) {
    n = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.round(n)));
    while (this.bots.length > n) this.bots.pop()!.leave();
    while (this.bots.length < n && this.core.count < MAX_PLAYERS) this.bots.push(new Bot(this.core, this.d, this.bots.length));
    return this.bots.length;
  }

  stop() {
    clearInterval(this.timer);
    for (const b of this.bots) b.leave();
    this.bots.length = 0;
  }
}

/** The player's connection to a LocalServer: JSON round trip and the delay, like a real socket. */
export class LocalTransport implements Transport {
  onOpen?: () => void;
  onMessage?: (m: ServerMsg) => void;
  onClose?: (why: string) => void;
  private id?: number;
  private server: LocalServer;

  constructor(server: LocalServer, name: string) {
    this.server = server;
    setTimeout(() => {
      const peer = server.core.add('me', name, (m) => this.deliver(m), (why) => this.onClose?.(why));
      if (!peer) { this.onClose?.('Server voll (8 Spieler)'); return; }
      this.id = peer.info.id;
      this.onOpen?.();
    }, server.lag);
  }

  private deliver(m: ServerMsg) {
    const copy = JSON.stringify(m);
    setTimeout(() => this.onMessage?.(JSON.parse(copy) as ServerMsg), this.server.lag);
  }

  send(m: ClientMsg) {
    const copy = JSON.stringify(m);
    setTimeout(() => { if (this.id !== undefined) this.server.core.message(this.id, copy); }, this.server.lag);
  }

  close() {
    if (this.id !== undefined) this.server.core.remove(this.id);
    this.id = undefined;
  }
}

/** Starts a session on a new local server with n bots. */
export function startLocal(session: NetSession, d: BotDeps, name: string, look: { car: string; color: string }, bots: number) {
  const server = new LocalServer(d);
  session.connect(new LocalTransport(server, name), 'Lokaler Testserver', look);
  // The bots come after the player, so they spread out around where the player is.
  setTimeout(() => server.setBots(bots), server.lag * 3);
  return server;
}
