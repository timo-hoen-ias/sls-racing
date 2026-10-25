// The few Cloudflare Workers runtime types the online servers need (no @cloudflare/workers-types dependency).

export interface CfWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectState {
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): CfWebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

/** WebSocketPair, a Workers global. */
export function socketPair(): [WebSocket, CfWebSocket] {
  const Pair = (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, WebSocket> }).WebSocketPair;
  const p = new Pair();
  return [p[0], p[1] as CfWebSocket];
}

/** The 101 answer that hands the client end of a WebSocket back (Workers only). */
export const upgraded = (client: WebSocket) => new Response(null, { status: 101, webSocket: client } as ResponseInit);
