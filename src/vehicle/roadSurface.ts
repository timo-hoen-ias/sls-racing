import { Ground } from '../world/format.ts';
import type { RoadGraph } from '../world/roadGraph.ts';
import type { CarPhysics } from './carPhysics.ts';

// What each wheel is rolling on: asphalt, cobbles, gravel, grass, field, forest floor, pavement or water.
// Decided from the road graph (on a carriageway or not, road class) and the tile ground class.
// Sets the per-wheel grip and rolling drag on the car, and reports rumble, dust and kerb strikes.

export type SurfaceKind = 'asphalt' | 'pflaster' | 'gehweg' | 'schotter' | 'gras' | 'acker' | 'waldboden' | 'wasser';

export interface SurfaceSpec {
  label: string;
  /** Grip factor for the tyre model (asphalt = 1). */
  grip: number;
  /** Extra rolling resistance as a share of the wheel load. */
  rolling: number;
  /** Shaking 0..1 at speed. */
  rumble: number;
  /** Loose surface noise 0..1 (gravel crunch, grass swish). */
  crunch: number;
  /** Tyres squeal on it (sealed surfaces only). */
  squeal: number;
  /** Colour of the dust/spray thrown up, if any. */
  dust?: string;
}

export const SURFACES: Record<SurfaceKind, SurfaceSpec> = {
  asphalt: { label: 'Asphalt', grip: 1, rolling: 0, rumble: 0, crunch: 0, squeal: 1 },
  pflaster: { label: 'Kopfsteinpflaster', grip: 0.88, rolling: 0.008, rumble: 0.45, crunch: 0, squeal: 0.7 },
  gehweg: { label: 'Gehweg', grip: 0.95, rolling: 0.004, rumble: 0.12, crunch: 0, squeal: 0.9 },
  schotter: { label: 'Schotter', grip: 0.62, rolling: 0.035, rumble: 0.4, crunch: 1, squeal: 0, dust: '#b8a888' },
  gras: { label: 'Gras', grip: 0.5, rolling: 0.1, rumble: 0.3, crunch: 0.45, squeal: 0, dust: '#6f7f43' },
  acker: { label: 'Acker', grip: 0.5, rolling: 0.14, rumble: 0.55, crunch: 0.6, squeal: 0, dust: '#8a6f4e' },
  waldboden: { label: 'Waldboden', grip: 0.55, rolling: 0.11, rumble: 0.5, crunch: 0.55, squeal: 0, dust: '#5e4a36' },
  wasser: { label: 'Wasser', grip: 0.3, rolling: 0.35, rumble: 0.2, crunch: 0.3, squeal: 0, dust: '#d6e6f0' },
};

/** Carriageway half width by road class rank (see pipeline ROAD_CLASSES), with a little margin. */
const HALF_WIDTH = [1.8, 2.3, 3, 3.3, 3.1, 3.8, 4.1, 4.6, 5.3, 6];
/** Urban streets with a raised kerb along them. */
const KERBED = (rank: number) => rank >= 2 && rank <= 7;
/** Pavement width beside kerbed streets (pipeline SIDEWALK.width). */
const SIDEWALK = 2.2;

/** Classifies a point: road graph first, the terrain ground class off the road. */
export function classify(graph: RoadGraph, groundAt: (x: number, z: number) => number | undefined, x: number, z: number): { kind: SurfaceKind; rank: number } {
  const s = graph.snap(x, z, 8);
  if (s && s.dist <= (HALF_WIDTH[s.edge.rank] ?? 3)) {
    const rank = s.edge.rank;
    // Pedestrian zones and living streets in Saarlouis are paved with setts; tracks are gravel.
    return { kind: rank === 0 ? 'schotter' : rank === 2 ? 'pflaster' : 'asphalt', rank };
  }
  // Streets have a raised pavement along both sides.
  if (s && KERBED(s.edge.rank) && s.dist <= (HALF_WIDTH[s.edge.rank] ?? 3) + SIDEWALK) return { kind: 'gehweg', rank: s.edge.rank };
  const g = groundAt(x, z);
  const rank = s && s.dist < (HALF_WIDTH[s.edge.rank] ?? 3) + 4 ? s.edge.rank : -1;
  switch (g) {
    case Ground.urban: return { kind: 'gehweg', rank };
    case Ground.forest: return { kind: 'waldboden', rank };
    case Ground.farmland: return { kind: 'acker', rank };
    case Ground.water: return { kind: 'wasser', rank };
    default: return { kind: 'gras', rank };
  }
}

export class RoadSurface {
  readonly kinds: SurfaceKind[] = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  /** Debug override for all four wheels. */
  force: SurfaceKind | null = null;
  /** Shaking 0..1 and loose-surface noise 0..1 of the whole car, for sound and gamepad. */
  rumble = 0;
  crunch = 0;
  squeal = 1;
  /** Kerb strikes this frame, 0..1 each. */
  readonly kerbs: number[] = [];
  private graph: RoadGraph;
  private groundAt: (x: number, z: number) => number | undefined;
  private ranks = [-1, -1, -1, -1];

  constructor(graph: RoadGraph, groundAt: (x: number, z: number) => number | undefined) {
    this.graph = graph;
    this.groundAt = groundAt;
  }

  /**
   * Call once per frame before the physics steps.
   * extraGrip: per-wheel factor from elsewhere (puddles), multiplied in.
   */
  update(car: CarPhysics, extraGrip: readonly number[] = [1, 1, 1, 1]) {
    this.kerbs.length = 0;
    const speed = Math.abs(car.speed);
    let rumble = 0, crunch = 0, squeal = 0, n = 0;
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const prev = this.kinds[i];
      if (w.contact) {
        const c = this.force ? { kind: this.force, rank: -1 } : classify(this.graph, this.groundAt, w.p.x, w.p.z);
        // Up or down a kerb: road ↔ pavement along an urban street.
        const rank = Math.max(c.rank, this.ranks[i]);
        if (!this.force && speed > 2 && KERBED(rank) && ((prev === 'gehweg') !== (c.kind === 'gehweg')) && (prev === 'gehweg' || c.kind === 'gehweg')) {
          const k = Math.min(1, speed / 25);
          this.kerbs.push(k);
          car.bump(i, (c.kind === 'gehweg' ? 1 : 0.6) * (0.6 + 0.8 * k));
        }
        this.kinds[i] = c.kind;
        this.ranks[i] = c.rank;
      }
      const s = SURFACES[this.kinds[i]];
      car.wheelGrip[i] = s.grip * (extraGrip[i] ?? 1);
      car.wheelRolling[i] = s.rolling;
      car.wheelRumble[i] = s.rumble;
      if (w.contact) { rumble = Math.max(rumble, s.rumble); crunch = Math.max(crunch, s.crunch); squeal += s.squeal; n++; }
    }
    const v = Math.min(1, speed / 20);
    this.rumble = rumble * v;
    this.crunch = crunch * Math.min(1, speed / 8);
    this.squeal = n ? squeal / n : 1;
  }

  /** Text for the debug overlay. */
  describe() {
    const name = ['VL', 'VR', 'HL', 'HR'];
    return this.kinds.map((k, i) => `${name[i]} ${SURFACES[k].label}`).join(' · ');
  }
}
