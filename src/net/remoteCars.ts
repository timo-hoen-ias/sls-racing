import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import { CarView, RIDE_HEIGHT } from '../vehicle/carView.ts';
import type { SportsCarModel } from '../vehicle/sportsCarModel.ts';
import { CAR, VEHICLE } from '../vehicle/tuning.ts';
import { type RemotePlayer, sampleSnaps } from './netSession.ts';
import { PoseFlag, POSE_LEN } from './protocol.ts';

// The other players' cars (O2): their own car model and paint, placed on the interpolated pose with turning
// wheels, steering, brake lights and nitro flames, a name tag above, and a body that steers onto the pose
// each physics step, so the own car bumps into them like into a real car (net.collide).

type R = typeof RAPIER_NS;

export interface RemoteCarDeps {
  R: R;
  world: RAPIER_NS.World;
  /** Model of a car id in a colour (undefined: the procedural car). */
  makeModel(car: string, color: string): Promise<SportsCarModel | undefined>;
}

/** Remote bodies only touch the player's car (membership 8, as following traffic). */
const REMOTE_GROUPS = (0x0008 << 16) | 0x0001;
/** A car with no pose for this long disappears (ms of local time). */
const STALE_MS = 4000;

interface RemoteCar {
  key: string;
  view?: CarView;
  wheels: { controller: { wheelChassisConnectionPointCs(i: number): { x: number; y: number; z: number } } };
  radius: number;
  tag: THREE.Sprite;
  tagName: string;
  body?: RAPIER_NS.RigidBody;
  pose: number[];
  shown: boolean;
  spin: number;
}

const lengths = [0, 0, 0, 0];

/** Where the four wheels sit on a body without physics: from the model's geometry, at the vehicle scale. */
function mounts(model: SportsCarModel | undefined) {
  const g = model?.geometry;
  const s = VEHICLE.scale;
  const front = g?.wheel.front ?? 1.27, rear = g?.wheel.rear ?? -1.2;
  const x = g ? (g.wheel.track < 1.2 ? g.wheel.track : g.wheel.track / 2) : 0.8;
  const radius = g?.wheel.radius ?? 0.33;
  // Wheel centre at its radius above the ground; the body origin rides RIDE_HEIGHT above it.
  const y = (radius - RIDE_HEIGHT) * s;
  const pts = [[x, front], [-x, front], [x, rear], [-x, rear]].map(([px, pz]) => ({ x: px * s, y, z: pz * s }));
  return { controller: { wheelChassisConnectionPointCs: (i: number) => pts[i] }, radius: radius * s };
}

function nameTag(name: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.font = '700 46px system-ui, sans-serif';
  const w = Math.min(500, g.measureText(name).width + 60);
  g.fillStyle = '#0b1520d0';
  g.beginPath();
  g.roundRect((512 - w) / 2, 14, w, 68, 16);
  g.fill();
  g.fillStyle = color;
  g.fillRect((512 - w) / 2 + 14, 34, 10, 28);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, 256 + 10, 49);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
  s.scale.set(0.2, 0.0375, 1);
  s.renderOrder = 10;
  return s;
}

export class RemoteCars {
  readonly root = new THREE.Group();
  /** Bump into the others (net.collide). */
  collide = true;
  /** Name tags above the cars and how far they show (net.tags). */
  tags = true;
  tagRange = 500;
  private cars = new Map<number, RemoteCar>();
  private d: RemoteCarDeps;
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();

  constructor(d: RemoteCarDeps) {
    this.d = d;
    this.root.name = 'remote-cars';
  }

  get count() { return this.cars.size; }

  /** Places every remote car at server time t; drops the cars of players who left. */
  sync(players: Map<number, RemotePlayer>, t: number, dt: number, night: number, time: number, eye: THREE.Vector3, nowMs: number) {
    for (const [id, car] of this.cars) if (!players.has(id)) this.drop(id, car);
    for (const [id, pl] of players) {
      let car = this.cars.get(id);
      const key = `${pl.info.car}|${pl.info.color}`;
      if (!car || car.key !== key) car = this.build(id, pl, car);
      if (car.tagName !== pl.info.name) this.retag(car, pl.info.name, pl.info.color);
      const fresh = nowMs - pl.seen < STALE_MS && sampleSnaps(pl.snaps, t, car.pose);
      car.shown = !!fresh && !!car.view;
      if (car.view) car.view.root.visible = car.shown;
      car.tag.visible = car.shown && this.tags;
      if (!car.shown || !car.view) continue;
      const p = car.pose;
      this.p.set(p[0], p[1], p[2]);
      this.q.set(p[3], p[4], p[5], p[6]);
      const v = car.view;
      // Wheels turn with the speed along the car's nose.
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.q);
      const along = p[7] * fwd.x + p[8] * fwd.y + p[9] * fwd.z;
      car.spin += (along / Math.max(0.1, car.radius)) * dt;
      const rot = [car.spin, car.spin, car.spin, car.spin];
      v.setNight(night);
      v.pose(car.wheels as unknown as CarPhysics, this.p, this.q, p[10], lengths, rot, (p[11] & PoseFlag.brake) !== 0, (p[11] & PoseFlag.boost) !== 0, time);
      car.tag.position.set(p[0], p[1] + 1.55, p[2]);
      if (car.tag.visible) car.tag.visible = eye.distanceTo(this.p) < this.tagRange;
    }
  }

  private build(id: number, pl: RemotePlayer, old?: RemoteCar): RemoteCar {
    if (old) this.drop(id, old);
    const key = `${pl.info.car}|${pl.info.color}`;
    const car: RemoteCar = { key, wheels: mounts(undefined), radius: 0.3, tag: nameTag(pl.info.name, pl.info.color), tagName: pl.info.name, pose: new Array(POSE_LEN).fill(0), shown: false, spin: 0 };
    car.radius = (car.wheels as ReturnType<typeof mounts>).radius;
    this.cars.set(id, car);
    this.root.add(car.tag);
    void this.d.makeModel(pl.info.car, pl.info.color).catch(() => undefined).then((model) => {
      if (this.cars.get(id) !== car) return;
      const view = new CarView(pl.info.color, model);
      view.root.name = `remote-${pl.info.name}`;
      if (model) view.setColor(pl.info.color);
      const m = mounts(model);
      car.wheels = m;
      car.radius = m.radius;
      car.view = view;
      view.root.visible = false;
      this.root.add(view.root);
    });
    return car;
  }

  private retag(car: RemoteCar, name: string, color: string) {
    this.root.remove(car.tag);
    car.tag.material.map?.dispose();
    car.tag.material.dispose();
    car.tag = nameTag(name, color);
    car.tagName = name;
    this.root.add(car.tag);
  }

  private drop(id: number, car: RemoteCar) {
    this.cars.delete(id);
    if (car.view) this.root.remove(car.view.root);
    this.root.remove(car.tag);
    car.tag.material.map?.dispose();
    car.tag.material.dispose();
    if (car.body) this.d.world.removeRigidBody(car.body);
  }

  /** Before world.step: steer each body onto its car's pose (velocity towards it, so a hit meets a moving mass). */
  step(step: number) {
    const { R, world } = this.d;
    for (const car of this.cars.values()) {
      const want = this.collide && car.shown;
      if (!want) {
        if (car.body) { world.removeRigidBody(car.body); car.body = undefined; }
        continue;
      }
      const p = car.pose;
      if (!car.body) {
        const h = CAR.halfExtents;
        car.body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p[0], p[1], p[2]).setGravityScale(0).setCanSleep(false).lockRotations());
        world.createCollider(R.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(0, CAR.colliderY, 0).setMass(1400).setFriction(0.4).setRestitution(0.15).setCollisionGroups(REMOTE_GROUPS), car.body);
      }
      const b = car.body;
      const t = b.translation();
      const off = Math.hypot(p[0] - t.x, p[1] - t.y, p[2] - t.z);
      if (off > 5) b.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
      const k = Math.min(1, 40 / Math.max(off / step, 1e-6));
      b.setLinvel({ x: ((p[0] - t.x) / step) * k, y: ((p[1] - t.y) / step) * k, z: ((p[2] - t.z) / step) * k }, true);
      b.setRotation({ x: p[3], y: p[4], z: p[5], w: p[6] }, true);
    }
  }

  isRemote(body: RAPIER_NS.RigidBody | null | undefined) {
    if (!body) return false;
    for (const c of this.cars.values()) if (c.body === body) return true;
    return false;
  }

  /** Every car on screen: player id, car id (vehicle/cars.ts) and its pose (for the engine sounds). */
  forShown(fn: (id: number, car: string, pose: readonly number[]) => void) {
    for (const [id, c] of this.cars) if (c.shown) fn(id, c.key.slice(0, c.key.lastIndexOf('|')), c.pose);
  }

  /** Pose of a player's car as drawn (for the map and the race standings). */
  poseOf(id: number) {
    const c = this.cars.get(id);
    return c?.shown ? c.pose : undefined;
  }

  clear() {
    for (const [id, car] of [...this.cars]) this.drop(id, car);
  }
}
