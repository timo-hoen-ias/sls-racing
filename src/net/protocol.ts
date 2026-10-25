// Online play (O2): the messages between the game and a server (worker/lobby.ts, or the local test server in
// src/net/localServer.ts). JSON over one WebSocket per player. The server only relays poses and runs the race
// timetable; every car drives on its own machine (friends only, so no cheat protection beyond sane values).

export const PROTOCOL = 1;
/** Players per server. */
export const MAX_PLAYERS = 8;
/** Seconds to join a race after it was announced. */
export const GATHER_SECONDS = 20;
/** Seconds left to gather once every player on the server is in. */
export const ALL_IN_SECONDS = 3;
/** Seconds from "everyone in" to the start signal: time to put the cars on the grid and load the tiles there. */
export const PREP_SECONDS = 9;
/** Seconds the others get to finish after the first car crossed the line. */
export const FINISH_GRACE = 45;
/** Seconds the results stay up before the server goes back to free roam. */
export const RESULT_SECONDS = 15;

/** Values in a pose: position, rotation, velocity, steering (rad), flags, race progress and metres to the next gate. */
export const POSE_LEN = 14;
export const PoseFlag = { brake: 1, boost: 2, reverse: 4, race: 8 } as const;

export interface PlayerInfo {
  id: number;
  name: string;
  /** Car id (vehicle/cars.ts) and paint colour. */
  car: string;
  color: string;
}

export type RacePhase = 'gather' | 'countdown' | 'running' | 'done';

export interface RaceResult {
  id: number;
  name: string;
  /** Race time (s); undefined: did not finish. */
  time?: number;
}

export interface RaceInfo {
  /** Event id (the same on every machine: events come from the same road graph). */
  event: string;
  name: string;
  host: number;
  phase: RacePhase;
  /** Players in the race, in grid order once the countdown runs. */
  entrants: number[];
  /** Server time (ms) of the start signal. */
  startAt?: number;
  /** Server time (ms) when the current phase ends on its own (gather, finish grace, results). */
  until?: number;
  /** Finishers in order, then the ones who did not finish. */
  results: RaceResult[];
}

export interface RoomSummary {
  id: string;
  name: string;
  players: number;
  max: number;
  /** Name of the race being gathered or driven. */
  race?: string;
  /** Always listed (the built-in servers), also when empty. */
  fixed?: boolean;
}

export type ClientMsg =
  | { t: 'hello'; v: number; car: string; color: string }
  | { t: 'look'; car: string; color: string }
  | { t: 's'; p: number[] }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number }
  /** Announce a race (any player, while none runs). */
  | { t: 'race'; event: string; name: string }
  | { t: 'join' }
  /** The host starts before the gather time is up. */
  | { t: 'go' }
  | { t: 'quit' }
  | { t: 'finish'; time: number };

export type ServerMsg =
  | { t: 'welcome'; v: number; id: number; room: string; now: number; players: PlayerInfo[]; race: RaceInfo | null }
  | { t: 'join'; player: PlayerInfo }
  | { t: 'leave'; id: number }
  | { t: 'look'; id: number; car: string; color: string }
  | { t: 's'; id: number; p: number[]; ts: number }
  | { t: 'chat'; id: number; name: string; text: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'race'; race: RaceInfo | null }
  | { t: 'error'; text: string };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Checks a message from a client; undefined for anything malformed. */
export function parseClient(raw: unknown): ClientMsg | undefined {
  let m: Record<string, unknown>;
  try { m = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>; } catch { return undefined; }
  if (!m || typeof m !== 'object') return undefined;
  switch (m.t) {
    case 'hello': case 'look': {
      const car = str(m.car, 40), color = str(m.color, 9);
      if (!car || !color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
      return m.t === 'hello' ? { t: 'hello', v: finite(m.v) ? m.v : 0, car, color } : { t: 'look', car, color };
    }
    case 's': {
      const p = m.p;
      if (!Array.isArray(p) || p.length !== POSE_LEN || !p.every(finite)) return undefined;
      // Inside Saarland and its sky: anything else is a broken client.
      if (p.some((v, i) => i < 3 && Math.abs(v) > 200_000)) return undefined;
      return { t: 's', p };
    }
    case 'chat': {
      const text = str(m.text, 200)?.trim();
      return text ? { t: 'chat', text } : undefined;
    }
    case 'ping': return finite(m.c) ? { t: 'ping', c: m.c } : undefined;
    case 'race': {
      const event = str(m.event, 80), name = str(m.name, 80);
      return event && name && /^[a-z0-9._-]+$/i.test(event) ? { t: 'race', event, name } : undefined;
    }
    case 'join': case 'go': case 'quit': return { t: m.t };
    case 'finish': return finite(m.time) && m.time > 0 && m.time < 7200 ? { t: 'finish', time: m.time } : undefined;
  }
  return undefined;
}

/** Rounds a pose for sending: centimetres, thousandths of rotation and steering. */
export function packPose(p: number[]): number[] {
  return p.map((v, i) => (i < 3 || (i >= 7 && i < 10) || i === 13 ? Math.round(v * 100) / 100 : i === 11 || i === 12 ? Math.round(v) : Math.round(v * 1000) / 1000));
}

/** Room ids: short, lower case, safe in URLs and Durable Object names. */
export const validRoomId = (s: string) => /^[a-z0-9-]{1,40}$/.test(s);
