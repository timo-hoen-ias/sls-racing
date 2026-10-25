import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { parseNum, registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { Debris } from '../render/debris.ts';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import { LINEAR } from './propColliders.ts';
import { linearLength, type PropKind } from './propKinds.ts';
import { buildPropGeometries } from './propModels.ts';
import type { PropHit } from './props.ts';
import type { Knockable, KnockableSource } from './streamer.ts';

// Knocking things over: street lamps (and later bollards and signs) give way when the car hits them fast
// enough. The object leaves the world, its light goes out, and a loose copy tips over as debris. The car
// loses a little speed and takes a light hit. Below minSpeed the object stays solid.

/** What a knocked-over object looks like as debris. */
export type DebrisFactory = (k: Knockable) => THREE.Object3D[];

export class Knockdown {
  enabled = true;
  /** Speed (m/s) from which the car knocks objects over instead of stopping at them. */
  minSpeed = 4;
  /** Share of the car's speed an object takes. */
  speedLoss = 0.1;
  /** Called after each knock with the object, the impact speed and its direction (unit, world). */
  onKnock?: (k: Knockable, speed: number, dir: THREE.Vector3) => void;
  count = 0;
  private sources: { source: KnockableSource; debris: DebrisFactory; mass: number }[] = [];
  private world: RAPIER_NS.World;
  private car: CarPhysics;
  private debris: Debris;

  constructor(world: RAPIER_NS.World, car: CarPhysics, debris: Debris) {
    this.world = world;
    this.car = car;
    this.debris = debris;
  }

  /** Adds a kind of knockable object; mass (kg) of its debris. */
  addSource(source: KnockableSource, debris: DebrisFactory, mass: number) {
    this.sources.push({ source, debris, mass });
  }

  private find(c: RAPIER_NS.Collider) {
    for (const s of this.sources) {
      const k = s.source.lookup(c);
      if (k) return { s, k };
    }
    return undefined;
  }

  /** Call before world.step(): sweeps the car's body along its velocity and knocks over what it would hit. */
  step(dt: number) {
    if (!this.enabled || !this.sources.length) return;
    const body = this.car.body;
    const v = body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed < this.minSpeed) return;
    const col = body.collider(0);
    for (let n = 0; n < 4; n++) {
      const hit = this.world.castShape(col.translation(), col.rotation(), v, col.shape, 0, dt * 3, true, undefined, undefined, col, body, (c) => !!this.find(c));
      if (!hit) break;
      this.knock(hit.collider);
    }
  }

  /** Nearest knockable object within r of (x, z) at the car's height. */
  nearest(x: number, z: number, r: number) {
    const y = this.car.body.translation().y;
    let best: { collider: RAPIER_NS.Collider; k: Knockable; d: number } | undefined;
    this.world.collidersWithAabbIntersectingAabb({ x, y, z }, { x: r, y: 20, z: r }, (c) => {
      const f = this.find(c);
      const d = f ? Math.hypot(f.k.x - x, f.k.z - z) : Infinity;
      if (f && d < r && (!best || d < best.d)) best = { collider: c, k: f.k, d };
      return true;
    });
    return best;
  }

  /** Knocks one object over; dir is the push (world). */
  knock(collider: RAPIER_NS.Collider, push?: THREE.Vector3) {
    const f = this.find(collider);
    if (!f) return false;
    const { s, k } = f;
    const body = this.car.body;
    const lv = body.linvel();
    const vel = push ?? new THREE.Vector3(lv.x, 0, lv.z);
    const speed = vel.length();
    const dir = speed > 0.1 ? vel.clone().divideScalar(speed) : new THREE.Vector3(1, 0, 0);
    s.source.remove(collider);
    // The car pays for it with a little speed.
    if (!push) {
      const m = body.mass() * this.speedLoss;
      body.applyImpulse({ x: -lv.x * m, y: 0, z: -lv.z * m }, true);
    }
    // The loose object flies off with part of the car's speed and tips over away from it.
    const parts = s.debris(k);
    if (!parts.length) { this.count++; this.onKnock?.(k, speed, dir); return true; }
    const axis = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const v0 = dir.clone().multiplyScalar(speed * 0.55).add(new THREE.Vector3(0, 1.2, 0));
    const spin = axis.multiplyScalar(Math.min(6, 0.8 + speed / 5));
    this.debris.spawn(parts, new THREE.Matrix4(), v0, spin, s.mass);
    this.count++;
    this.onKnock?.(k, speed, dir);
    return true;
  }
}

/** Street lamp as debris: pole and (dark) head at the lamp's place. */
export function lampDebris(geo: { pole: THREE.BufferGeometry; head: THREE.BufferGeometry }, pole: THREE.Material, head: THREE.Material): DebrisFactory {
  return (k) => {
    const q = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.PI - k.heading);
    return [new THREE.Mesh(geo.pole, pole), new THREE.Mesh(geo.head, head)].map((m) => {
      m.position.set(k.x, k.y, k.z);
      m.quaternion.copy(q);
      m.castShadow = true;
      m.userData.sharedGeometry = true;
      return m;
    });
  };
}

/** Breakable street furniture (signs, bollards, bins …) from the prop layer as a knockable source. */
export function propSource(props: { lookup(c: RAPIER_NS.Collider): PropHit | undefined; remove(c: RAPIER_NS.Collider): unknown }): KnockableSource {
  return {
    lookup: (c) => {
      const h = props.lookup(c);
      return h?.breakable ? h : undefined;
    },
    remove: (c) => { props.remove(c); },
  };
}

/** Street furniture as debris, from the same models the prop layer draws. */
export function propDebris(): DebrisFactory {
  const geos = buildPropGeometries();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 });
  return (k) => {
    const g = geos[k.kind as PropKind];
    if (!g) return [];
    const m = new THREE.Mesh(g, mat);
    m.position.set(k.x, k.y, k.z);
    m.rotation.y = k.heading;
    if (LINEAR.has(k.kind as PropKind)) m.scale.z = linearLength(k.size);
    m.castShadow = true;
    m.userData.sharedGeometry = true;
    return [m];
  };
}

export function registerKnockCommands(kd: Knockdown, lamps: { lampsNear(x: number, z: number, r: number): RAPIER_NS.Collider[]; lookup(c: RAPIER_NS.Collider): Knockable | undefined; restoreLamps(): number; knockedCount: number }, carPos: () => { x: number; z: number }) {
  registerToggle('knock', 'Laternen, Schilder, Poller usw. umfahren an/aus', () => kd.enabled, (v) => { kd.enabled = v; });
  registerValue('knock.speed', 'Mindesttempo zum Umfahren (km/h); darunter bleibt die Laterne stehen', () => Math.round(kd.minSpeed * 3.6), (v) => { kd.minSpeed = v / 3.6; }, [0, 200]);
  registerValue('knock.loss', 'Tempoverlust des Autos je umgefahrenem Objekt (0..1)', () => kd.speedLoss, (v) => { kd.speedLoss = v; }, [0, 1]);
  registerCommand({ name: 'knock.info', help: 'Umgefahrene Objekte', run: () => `${kd.count} umgefahren · ${lamps.knockedCount} Laternen liegen` });
  registerCommand({
    name: 'knock.near',
    help: 'Nächstes umfahrbare Objekt im Umkreis umwerfen (Richtung zufällig): Laterne, Schild, Poller …',
    args: '[radius m]',
    run([r]) {
      const p = carPos();
      const hit = kd.nearest(p.x, p.z, r === undefined ? 40 : parseNum(r, 'Radius', 1, 300));
      if (!hit) throw new Error('nichts Umfahrbares in der Nähe');
      const a = Math.random() * Math.PI * 2;
      kd.knock(hit.collider, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(12));
      return `${hit.k.kind === 'lamp' ? 'Laterne' : `Objekt (${(hit.k as { name?: string }).name ?? hit.k.kind})`} in ${hit.d.toFixed(0)} m umgeworfen`;
    },
  });
  registerCommand({
    name: 'lamps.list',
    help: 'Stehende Laternen in der Nähe mit Position',
    args: '[radius m]',
    run([r]) {
      const p = carPos();
      const near = lamps.lampsNear(p.x, p.z, r === undefined ? 60 : parseNum(r, 'Radius', 1, 500))
        .map((c) => ({ t: c.translation(), h: lamps.lookup(c)?.heading ?? 0, d: Math.hypot(c.translation().x - p.x, c.translation().z - p.z) }))
        .sort((a, b) => a.d - b.d).slice(0, 8);
      if (!near.length) return 'keine Laterne in der Nähe';
      return near.map((n) => `${n.t.x.toFixed(1)} ${n.t.z.toFixed(1)} ${((n.h * 180) / Math.PI).toFixed(0)}° · ${n.d.toFixed(0)} m`).join('\n');
    },
  });
  registerCommand({ name: 'lamps.restore', help: 'Alle umgefahrenen Laternen wieder aufstellen', run: () => `${lamps.restoreLamps()} Laternen aufgestellt` });
}
