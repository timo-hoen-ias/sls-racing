import { project, type RoadGraph, type Route, type Snap } from '../world/roadGraph.ts';

export interface NavState {
  /** Remaining distance to the destination, metres. */
  remaining: number;
  /** Next turn, if any: distance from the car, signed angle (positive = right), street after the turn. */
  next?: { in: number; angle: number; street: string };
  arrived: boolean;
}

/** GPS: holds the destination and route, tracks progress and reroutes when the car leaves the route. */
export class Navigation {
  readonly graph: RoadGraph;
  route?: Route;
  destination?: Snap;
  /** Distance along the route the car has covered. */
  progress = 0;
  /** Bumped whenever the route changes, so views can rebuild. */
  version = 0;
  private offRoute = 0;
  private rerouteCooldown = 0;

  constructor(graph: RoadGraph) {
    this.graph = graph;
  }

  /** Sets a destination near (x, z); returns false when no road is close enough. */
  setDestination(x: number, z: number, carX: number, carZ: number): boolean {
    const dest = this.graph.snap(x, z, 150);
    if (!dest) return false;
    this.destination = dest;
    this.reroute(carX, carZ);
    return true;
  }

  clear() {
    this.destination = undefined;
    this.route = undefined;
    this.version++;
  }

  private reroute(carX: number, carZ: number) {
    if (!this.destination) return;
    const from = this.graph.snap(carX, carZ, 200);
    this.route = from ? this.graph.route(from, this.destination) : undefined;
    this.progress = 0;
    this.offRoute = 0;
    this.rerouteCooldown = 1;
    this.version++;
  }

  update(carX: number, carZ: number, dt: number): NavState | undefined {
    const r = this.route;
    if (!r) return undefined;
    const p = project(r.pts, r.cum, carX, carZ);
    // Only move forward along the route, so loops near the car do not confuse it.
    if (p.along > this.progress - 30) this.progress = Math.max(this.progress, p.along);
    this.rerouteCooldown -= dt;
    this.offRoute = p.dist > 30 ? this.offRoute + dt : 0;
    if (this.offRoute > 1.2 && this.rerouteCooldown <= 0) this.reroute(carX, carZ);

    const remaining = Math.max(0, r.length - this.progress);
    if (remaining < 18) {
      this.clear();
      return { remaining: 0, arrived: true };
    }
    const t = r.turns.find((t) => t.at > this.progress - 4);
    return { remaining, arrived: false, next: t && { in: Math.max(0, t.at - this.progress), angle: t.angle, street: t.street } };
  }
}

export function formatDistance(m: number) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} km`;
  return `${Math.max(10, Math.round(m / 10) * 10)} m`;
}

export function turnWord(angle: number) {
  const a = Math.abs(angle);
  const side = angle > 0 ? 'rechts' : 'links';
  if (a > 2.4) return 'Wenden';
  if (a > 1.1) return `${side} abbiegen`;
  return `leicht ${side}`;
}
