import { Ground } from '../world/format.ts';
import type { Edge, RoadGraph } from '../world/roadGraph.ts';
import type { CarPhysics } from './carPhysics.ts';
import { CAR } from './tuning.ts';

// What each wheel is rolling on: asphalt, cobbles, gravel, grass, field, forest floor, pavement or water.
// Decided from the road graph (on a carriageway or not, road class) and the tile ground class.
// Sets the per-wheel grip and rolling drag on the car, and reports rumble, dust and kerb strikes.

export type SurfaceKind = 'asphalt' | 'pflaster' | 'gehweg' | 'fussweg' | 'feldweg' | 'schotter' | 'gras' | 'acker' | 'waldboden' | 'wasser';

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
  /** Side grip of the rear wheels relative to `grip` (below 1: the tail steps out under power, rally style). */
  rearSide?: number;
}

export const SURFACES: Record<SurfaceKind, SurfaceSpec> = {
  asphalt: { label: 'Asphalt', grip: 1, rolling: 0, rumble: 0, crunch: 0, squeal: 1 },
  pflaster: { label: 'Kopfsteinpflaster', grip: 0.88, rolling: 0.008, rumble: 0.45, crunch: 0, squeal: 0.7 },
  gehweg: { label: 'Gehweg', grip: 0.95, rolling: 0.004, rumble: 0.12, crunch: 0, squeal: 0.9 },
  // Paved footpath away from the street: like a pavement, but no kerb on the way there.
  fussweg: { label: 'Fußweg', grip: 0.95, rolling: 0.004, rumble: 0.14, crunch: 0, squeal: 0.9 },
  // Feldweg (track with wheel ruts): loose but predictable, the tail steps out under power and comes back
  // (rally); little rolling drag so the car keeps its speed. feldweg.* commands.
  feldweg: { label: 'Feldweg', grip: 0.8, rolling: 0.012, rumble: 0.28, crunch: 0.9, squeal: 0, dust: '#a89272', rearSide: 0.86 },
  schotter: { label: 'Schotter', grip: 0.62, rolling: 0.035, rumble: 0.4, crunch: 1, squeal: 0, dust: '#b8a888' },
  gras: { label: 'Gras', grip: 0.5, rolling: 0.1, rumble: 0.3, crunch: 0.45, squeal: 0, dust: '#6f7f43' },
  acker: { label: 'Acker', grip: 0.5, rolling: 0.14, rumble: 0.55, crunch: 0.6, squeal: 0, dust: '#8a6f4e' },
  waldboden: { label: 'Waldboden', grip: 0.55, rolling: 0.11, rumble: 0.5, crunch: 0.55, squeal: 0, dust: '#5e4a36' },
  wasser: { label: 'Wasser', grip: 0.3, rolling: 0.35, rumble: 0.2, crunch: 0.3, squeal: 0, dust: '#d6e6f0' },
};

/** Wheel surface per road atlas surface (SURFACE in render/pbr/roadCode.ts) on paths. */
const PATH_SURFACE: SurfaceKind[] = ['asphalt', 'asphalt', 'asphalt', 'pflaster', 'fussweg', 'fussweg', 'schotter', 'fussweg'];

/** Carriageway half width of an edge, with a little margin. */
const halfWidth = (e: Edge) => e.width / 2 + (e.field ? FIELD_VERGE : 0.3);
/** A Feldweg's grassy edge still drives like the way (no sudden drag when a wheel runs wide), metres. */
const FIELD_VERGE = 0.8;
/** Urban streets with a raised kerb along them (graphs without pavement sides: by class). */
const KERBED = (rank: number) => rank >= 2 && rank <= 7;
/** Whether the edge has a kerb and pavement on the side of (x, z) (graph field k, see pipeline kerbs.ts). */
function kerbSide(s: { edge: Edge; x: number; z: number; dx: number; dz: number }, x: number, z: number) {
  if (s.edge.kerb < 0) return KERBED(s.edge.rank);
  // Right of a → b is (-dz, dx).
  const right = (x - s.x) * -s.dz + (z - s.z) * s.dx > 0;
  return (s.edge.kerb & (right ? 1 : 2)) !== 0;
}
/** Pavement width beside kerbed streets (pipeline SIDEWALK.width). */
const SIDEWALK = 2.2;

/** Classifies a point: road graph first, the terrain ground class off the road. */
export function classify(graph: RoadGraph, groundAt: (x: number, z: number) => number | undefined, x: number, z: number): { kind: SurfaceKind; rank: number; kerb?: boolean } {
  const s = graph.snap(x, z, 8);
  if (s && s.dist <= halfWidth(s.edge)) {
    const rank = s.edge.rank;
    // Pedestrian zones and living streets in Saarlouis are paved with setts; unpaved tracks are Feldwege.
    return { kind: s.edge.field ? 'feldweg' : rank === 2 ? 'pflaster' : 'asphalt', rank };
  }
  // Footpaths, cycle paths and steps (not part of the network), by their surface.
  const path = graph.pathNear(x, z, 6);
  if (path && path.dist <= path.path.width / 2 + 0.2) return { kind: PATH_SURFACE[path.path.surface] ?? 'fussweg', rank: -1 };
  // Streets in town have a raised pavement along the sides the pipeline gave them.
  if (s && s.dist <= halfWidth(s.edge) + SIDEWALK && kerbSide(s, x, z)) return { kind: 'gehweg', rank: s.edge.rank, kerb: true };
  const g = groundAt(x, z);
  const rank = s && s.dist < halfWidth(s.edge) + 4 ? s.edge.rank : -1;
  switch (g) {
    case Ground.urban: return { kind: 'gehweg', rank };
    case Ground.forest: return { kind: 'waldboden', rank };
    case Ground.farmland: return { kind: 'acker', rank };
    case Ground.water: return { kind: 'wasser', rank };
    default: return { kind: 'gras', rank };
  }
}

/** Unpaved ground where the tread decides the grip. */
const LOOSE = new Set<SurfaceKind>(['schotter', 'gras', 'acker', 'waldboden', 'feldweg']);

export class RoadSurface {
  readonly kinds: SurfaceKind[] = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  /** Debug override for all four wheels. */
  force: SurfaceKind | null = null;
  /** Shaking 0..1 and loose-surface noise 0..1 of the whole car, for sound and gamepad. */
  rumble = 0;
  crunch = 0;
  squeal = 1;
  /** Factor on the jolt when a wheel goes up or down a kerb (kerb.bump; 0.1 in the fun feel, 1 real). */
  kerbBump = 1;
  /** Kerb strikes this frame, 0..1 each. */
  readonly kerbs: number[] = [];
  private graph: RoadGraph;
  private groundAt: (x: number, z: number) => number | undefined;
  private kerbed = [false, false, false, false];

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
        const c = this.force ? { kind: this.force, rank: -1, kerb: false } : classify(this.graph, this.groundAt, w.p.x, w.p.z);
        // Up or down a kerb: road ↔ pavement along an urban street.
        const kerb = !!c.kerb;
        if (!this.force && speed > 2 && kerb !== this.kerbed[i] && (prev === 'asphalt' || prev === 'pflaster' || (this.kerbed[i] && (c.kind === 'asphalt' || c.kind === 'pflaster')))) {
          const k = Math.min(1, speed / 25);
          this.kerbs.push(k);
          car.bump(i, (c.kind === 'gehweg' ? 1 : 0.6) * (0.6 + 0.8 * k) * this.kerbBump);
        }
        this.kinds[i] = c.kind;
        this.kerbed[i] = kerb;
      }
      const s = SURFACES[this.kinds[i]];
      // All-terrain tyres (CAR.tyre.loose) keep more grip and roll easier on loose ground.
      const loose = LOOSE.has(this.kinds[i]) ? CAR.tyre.loose : 0;
      car.wheelGrip[i] = (s.grip + (1 - s.grip) * loose) * (extraGrip[i] ?? 1);
      car.wheelSide[i] = i >= 2 ? s.rearSide ?? 1 : 1;
      car.wheelRolling[i] = s.rolling * (1 - 0.5 * loose);
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
