import type { GameEvent } from '../game/events/types.ts';

// Starting grid of an online race (O2): two cars per row behind the start gate, the same on every machine.

export const GRID_ROW = 8;
export const GRID_SIDE = 1.8;

/** Where grid slot i (0 = pole) stands, facing along the start gate. */
export function gridSlot(e: GameEvent, i: number) {
  const g = e.start;
  const back = 6 + GRID_ROW * Math.floor(i / 2);
  const side = (i % 2 ? 1 : -1) * GRID_SIDE;
  // Right of the direction of travel (x east, z south): (-dz, dx).
  return { x: g.x - g.dx * back - g.dz * side, z: g.z - g.dz * back + g.dx * side, heading: Math.atan2(g.dx, -g.dz), side };
}
