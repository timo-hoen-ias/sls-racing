// Event data: races (sprint, circuit), skills you drive through (speed trap, speed zone, drift zone,
// near-miss zone, slalom, jump) and missions (escape, delivery). Generated from the road graph of each region
// (generate.ts), optionally overridden per region by tiles/events.json.

export type EventType = 'sprint' | 'circuit' | 'duel' | 'speedtrap' | 'speedzone' | 'drift' | 'nearmiss' | 'slalom' | 'jump' | 'escape' | 'delivery';

/** Started from the map or a start marker, with a countdown (the rest start by driving through their gate). */
export const RACE_TYPES = new Set<EventType>(['sprint', 'circuit', 'duel', 'escape', 'delivery']);

export const EVENT_LABELS: Record<EventType, string> = {
  sprint: 'Sprint', circuit: 'Rundkurs', duel: 'Autobahn-Duell', speedtrap: 'Blitzer', speedzone: 'Tempozone', drift: 'Driftzone',
  nearmiss: 'Verkehrsslalom', slalom: 'Pylonen-Slalom', jump: 'Sprungschanze', escape: 'Flucht', delivery: 'Kurierfahrt',
};

/** A gate across the road: centre, direction of travel (unit x/z), half width. */
export interface Gate {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  w: number;
}

export interface GameEvent {
  id: string;
  type: EventType;
  name: string;
  /** Street (or district) for lists. */
  where: string;
  start: Gate;
  /** Checkpoints in order; the last is the finish. Skills: the end gate (none for speed traps and jumps). */
  gates: Gate[];
  laps?: number;
  /** Driving line as x, z pairs (zones, races): corridor checks and the map. */
  path?: number[];
  /** Medal thresholds bronze, silver, gold, platinum. */
  medals: [number, number, number, number];
  /** Larger results are better (speed, points); otherwise smaller (time). */
  higher: boolean;
  unit: 's' | 'km/h' | 'Pkt' | 'm' | '×';
  /** Player level from which the event is open. */
  level: number;
  /** AI rivals in races (V3). */
  rivals?: number;
  /** Time limit in seconds (zones, missions). */
  limit?: number;
  /** Slalom: cone pairs as gates; jump: the ramp. */
  /** runup: where fast travel puts the car for skills that need speed first (speed traps). */
  extra?: { runup?: Gate; cones?: Gate[]; ramp?: { x: number; y: number; z: number; heading: number; length: number; height: number } };
}

/** Result of a run: value in the event's unit, medal reached (0 = none). */
export interface EventResult {
  event: GameEvent;
  value: number;
  medal: 0 | 1 | 2 | 3 | 4;
  best: boolean;
  xp: number;
  credits: number;
  /** Position in a race with rivals (1 = won). */
  place?: number;
}

export function medalFor(e: GameEvent, value: number): 0 | 1 | 2 | 3 | 4 {
  let m: 0 | 1 | 2 | 3 | 4 = 0;
  for (let i = 0; i < 4; i++) if (e.higher ? value >= e.medals[i] : value <= e.medals[i]) m = (i + 1) as 1 | 2 | 3 | 4;
  return m;
}

export function formatValue(e: GameEvent, v: number) {
  if (e.unit === 's') {
    const m = Math.floor(v / 60);
    const s = v - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`.replace('.', ',');
  }
  if (e.unit === 'km/h') return `${Math.round(v)} km/h`;
  if (e.unit === 'm') return `${v.toFixed(1).replace('.', ',')} m`;
  if (e.unit === '×') return `${Math.round(v)}×`;
  return `${Math.round(v).toLocaleString('de-DE')} Pkt`;
}

/** Has the segment from (x0, z0) to (x1, z1) crossed the gate in its direction? */
export function crossed(g: Gate, x0: number, z0: number, x1: number, z1: number, slack = 0) {
  const a = (x0 - g.x) * g.dx + (z0 - g.z) * g.dz;
  const b = (x1 - g.x) * g.dx + (z1 - g.z) * g.dz;
  if (!(a < 0 && b >= 0)) return false;
  const t = a / (a - b);
  const cx = x0 + (x1 - x0) * t - g.x, cz = z0 + (z1 - z0) * t - g.z;
  return Math.abs(-cx * g.dz + cz * g.dx) <= g.w + slack;
}
