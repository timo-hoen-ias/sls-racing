import type { RoadGraph } from '../world/roadGraph.ts';
import type { GameEvent, Gate } from './events/types.ts';

// Courier runs (E6): from the courier depot to a real house address (official house coordinates, the same
// data as the GPS), against the clock. The route is the road graph's shortest one; the medals and the time
// limit follow its length.

export interface Destination { label: string; x: number; z: number }

/** Average speeds (km/h) for bronze … platinum, and the one the time limit allows. */
const PACE = [50, 60, 70, 80];
const LIMIT_PACE = 40;

export function makeDelivery(graph: RoadGraph, from: { x: number; z: number }, to: Destination): GameEvent | undefined {
  const ok = (e: RoadGraph['edges'][number]) => !e.noCars;
  const a = graph.snap(from.x, from.z, 80, ok);
  const b = graph.snap(to.x, to.z, 80, ok);
  if (!a || !b) return undefined;
  const route = graph.route(a, b);
  if (!route || route.length < 300) return undefined;
  const pts = route.pts;
  const n = pts.length / 3;
  const path: number[] = [];
  for (let i = 0; i < n; i++) path.push(pts[i * 3], pts[i * 3 + 2]);
  const gateAt = (i: number, j: number, w: number): Gate => {
    const dx = pts[j * 3] - pts[i * 3], dz = pts[j * 3 + 2] - pts[i * 3 + 2], l = Math.hypot(dx, dz) || 1;
    const k = i < j ? i : j;
    return { x: pts[k * 3], y: pts[k * 3 + 1], z: pts[k * 3 + 2], dx: dx / l, dz: dz / l, w };
  };
  const start = gateAt(0, Math.min(n - 1, 1), 8);
  const end = gateAt(Math.max(0, n - 2), n - 1, 9);
  // The finish gate sits on the last route point, in front of the house.
  end.x = pts[(n - 1) * 3];
  end.y = pts[(n - 1) * 3 + 1];
  end.z = pts[(n - 1) * 3 + 2];
  const len = route.length;
  const t = (kmh: number) => Math.round(len / (kmh / 3.6));
  return {
    id: `delivery-${Math.round(to.x)}-${Math.round(to.z)}`,
    type: 'delivery',
    name: to.label,
    where: to.label,
    start,
    gates: [end],
    path,
    medals: [t(PACE[0]), t(PACE[1]), t(PACE[2]), t(PACE[3])],
    higher: false,
    unit: 's',
    level: 1,
    limit: t(LIMIT_PACE),
  };
}
