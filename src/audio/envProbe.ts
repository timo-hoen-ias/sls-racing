import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { type Surroundings, WALL_RANGE } from './envReverb.ts';

// Measures the car's surroundings with raycasts against the physics world: walls left and right and a roof above
// for the reverb, and a wider ring of rays that tells buildings from trees for the city ambience.

export type HitKind = 'building' | 'tree' | 'pole' | 'vehicle' | 'other';

export interface AreaSample {
  /** 0..1: how built-up the area around the car is. */
  urban: number;
  /** 0..1: trees and open country. */
  green: number;
  /** Ray hits per kind in the last ring. */
  hits: Record<HitKind, number>;
}

const RING = 16;
const RING_RANGE = 80;

export class EnvProbe {
  surroundings: Surroundings = { left: Infinity, right: Infinity, up: Infinity };
  area: AreaSample = { urban: 0, green: 0.5, hits: { building: 0, tree: 0, pole: 0, vehicle: 0, other: 0 } };
  /** Ray segments of the last measurement for the debug view: x0, y0, z0, x1, y1, z1, hit (1/0). */
  rays: number[] = [];
  private R: typeof RAPIER_NS;
  private world: RAPIER_NS.World;
  private ray: RAPIER_NS.Ray;
  private ignore: (c: RAPIER_NS.Collider) => boolean;
  private exclude: RAPIER_NS.RigidBody;
  private ringStep = 0;
  private ringHits: (HitKind | null)[] = new Array(RING).fill(null);
  private ringDist: number[] = new Array(RING).fill(RING_RANGE);

  /** `ignore` filters colliders that do not reflect sound (e.g. traffic); `exclude` is the car itself. */
  constructor(R: typeof RAPIER_NS, world: RAPIER_NS.World, exclude: RAPIER_NS.RigidBody, ignore: (c: RAPIER_NS.Collider) => boolean = () => false) {
    this.R = R;
    this.world = world;
    this.exclude = exclude;
    this.ignore = ignore;
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  }

  private cast(x: number, y: number, z: number, dx: number, dy: number, dz: number, max: number) {
    this.ray.origin = { x, y, z };
    this.ray.dir = { x: dx, y: dy, z: dz };
    const hit = this.world.castRay(this.ray, max, true, undefined, undefined, undefined, this.exclude, (c) => !this.ignore(c));
    const d = hit ? hit.timeOfImpact : Infinity;
    this.rays.push(x, y, z, x + dx * Math.min(d, max), y + dy * Math.min(d, max), z + dz * Math.min(d, max), hit ? 1 : 0);
    return { d, collider: hit ? this.world.getCollider(hit.collider.handle) : undefined };
  }

  /** Walls left/right (three rays per side, median against lamp posts) and the roof. Heading as CarPhysics.heading(). */
  measure(x: number, y: number, z: number, heading: number) {
    this.rays.length = 0;
    const rx = Math.cos(heading), rz = Math.sin(heading);
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    const side = (s: number) => {
      const ds: number[] = [];
      for (const k of [-0.35, 0, 0.35]) {
        const dx = rx * s + fx * k, dz = rz * s + fz * k;
        const l = Math.hypot(dx, dz);
        // Perpendicular distance to the wall.
        ds.push(this.cast(x, y + 1.2, z, dx / l, 0, dz / l, WALL_RANGE).d / l);
      }
      ds.sort((a, b) => a - b);
      return ds[1];
    };
    const up = Math.min(this.cast(x, y + 1.2, z, 0, 1, 0, 30).d, this.cast(x + fx * 4, y + 1.2, z + fz * 4, 0, 1, 0, 30).d);
    this.surroundings = { left: side(-1), right: side(1), up };
    return this.surroundings;
  }

  /** Casts a quarter of the ring each call; the area estimate is complete after four calls. */
  sampleArea(x: number, y: number, z: number) {
    for (let i = this.ringStep; i < RING; i += 4) {
      const a = (i / RING) * Math.PI * 2;
      const h = this.cast(x, y + 2.5, z, Math.cos(a), 0, Math.sin(a), RING_RANGE);
      this.ringHits[i] = h.collider ? this.classify(h.collider) : null;
      this.ringDist[i] = h.d;
    }
    this.ringStep = (this.ringStep + 1) % 4;
    const hits: Record<HitKind, number> = { building: 0, tree: 0, pole: 0, vehicle: 0, other: 0 };
    let urban = 0;
    for (let i = 0; i < RING; i++) {
      const k = this.ringHits[i];
      if (!k) continue;
      hits[k]++;
      if (k === 'building') urban += 1 - 0.6 * (this.ringDist[i] / RING_RANGE);
    }
    urban = Math.min(1, urban / (RING * 0.6));
    const green = Math.min(1, hits.tree / 4 + (1 - urban) * 0.55);
    this.area = { urban, green, hits };
    return this.area;
  }

  classify(c: RAPIER_NS.Collider): HitKind {
    const T = this.R.ShapeType;
    const s = c.shape;
    if (s.type === T.TriMesh) return 'building';
    if (s.type === T.Cylinder) return (s as RAPIER_NS.Cylinder).radius <= 0.16 ? 'pole' : 'tree';
    if (s.type === T.Cuboid) {
      const b = c.parent();
      return b && !b.isFixed() ? 'vehicle' : 'other';
    }
    return 'other';
  }

  /** What the car touches right now (for impact sounds): the nearest collider kind around it. */
  touching(x: number, y: number, z: number, heading: number, radius = 3): HitKind | undefined {
    const shape = new this.R.Cuboid(1.1, 0.7, radius);
    const rot = { x: 0, y: Math.sin(-heading / 2), z: 0, w: Math.cos(-heading / 2) };
    let best: HitKind | undefined;
    const rank: Record<HitKind, number> = { vehicle: 5, pole: 4, tree: 3, building: 2, other: 1 };
    this.world.intersectionsWithShape({ x, y: y + 0.4, z }, rot, shape, (c) => {
      const k = this.classify(c);
      // Terrain is a trimesh too; only count trimesh hits that stand up from the road (walls).
      if (k === 'building' && c.parent()?.isFixed() && !this.wallNear(x, y, z)) return true;
      if (!best || rank[k] > rank[best]) best = k;
      return true;
    }, undefined, undefined, undefined, this.exclude, (c) => !this.ignore(c));
    return best;
  }

  private wallNear(x: number, y: number, z: number) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.ray.origin = { x, y: y + 0.8, z };
      this.ray.dir = { x: Math.cos(a), y: 0, z: Math.sin(a) };
      if (this.world.castRay(this.ray, 3.5, true, undefined, undefined, undefined, this.exclude)) return true;
    }
    return false;
  }
}
