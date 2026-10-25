import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { RoadGraph } from '../world/roadGraph.ts';
import { type Agent, type PlayerState, TrafficSim, type VehicleKind } from './trafficSim.ts';
import { TrafficSound } from './trafficSound.ts';
import { SignalView } from './signalView.ts';
import { TrafficView } from './trafficView.ts';

/** Vehicles closer than this get a solid body the player can crash into. */
const SOLID_RANGE = 110;
const SOLID_BODIES = 24;
/** Real masses (kg); traffic.mass scales them so the player's car can shove them out of the way. */
const MASS: Record<VehicleKind, number> = { car: 1300, van: 2200, bus: 12000, truck: 14000 };
/** Following traffic only touches the player's car (membership 8); a wreck collides with everything. */
const FOLLOW_GROUPS = (0x0008 << 16) | 0x0001;
const WRECK_GROUPS = (0x0008 << 16) | 0xffff;

interface Solid {
  body: RAPIER_NS.RigidBody;
  collider?: RAPIER_NS.Collider;
  kind?: VehicleKind;
  agent?: Agent;
  /** Seconds since the player knocked it out of traffic; it tumbles freely until removed. */
  wreck?: number;
}

/** AI traffic: simulation, instanced rendering, kinematic bodies near the player and positional sound. */
export class Traffic {
  readonly sim: TrafficSim;
  readonly view: TrafficView;
  readonly lights: SignalView;
  readonly graph: RoadGraph;
  sound?: TrafficSound;
  /** Draws vehicles; the simulation keeps running when off. */
  visible = true;
  private R: typeof RAPIER_NS;
  private world: RAPIER_NS.World;
  private solids: Solid[] = [];
  private time = 0;
  /** Hits push traffic out of the way: the hit vehicle leaves the traffic and slides as a loose wreck (traffic.punt). */
  punt = true;
  /** Factor on the vehicles' real mass for collisions (traffic.mass): below 1 the player's car keeps more speed. */
  massScale = 0.5;
  /** Seconds a wreck stays before it is cleared away (sooner once out of sight behind the player). */
  wreckTime = 20;
  /** Called when the player knocks a vehicle out of traffic (style points, sound). */
  onWreck?: (a: Agent, strength: number) => void;

  constructor(R: typeof RAPIER_NS, world: RAPIER_NS.World, graph: RoadGraph, opts: { maxAgents: number; shadows: boolean }) {
    this.R = R;
    this.world = world;
    this.graph = graph;
    this.sim = new TrafficSim(graph, { maxAgents: opts.maxAgents });
    this.view = new TrafficView(opts.maxAgents + 20, opts.shadows);
    this.lights = new SignalView(graph, this.sim.signals, opts.shadows);
    this.view.root.add(this.lights.root);
    // Dynamic bodies that are steered onto their vehicle's pose each frame: a hit then exchanges momentum
    // with real masses instead of stopping the player's car like a wall.
    for (let i = 0; i < SOLID_BODIES; i++) {
      const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, -1000 - i * 10, 0).setGravityScale(0).setCanSleep(false).lockRotations());
      this.solids.push({ body });
    }
    this.sim.events.honk = (a) => this.sound?.honk(a);
    this.sim.events.crash = (a, strength) => { if (this.punt) this.wreck(a, strength); };
  }

  /** Vehicles knocked out of traffic, drawn with their tumbling pose. */
  get wrecks(): Agent[] {
    return this.solids.filter((s) => s.wreck !== undefined).map((s) => s.agent!);
  }

  /** Takes a hit vehicle out of the traffic: its body is let loose (gravity, rotation, all collisions). */
  wreck(a: Agent, strength = 0.5) {
    const s = this.solids.find((x) => x.agent === a && x.wreck === undefined);
    if (!s) return false;
    const i = this.sim.agents.indexOf(a);
    if (i >= 0) this.sim.agents.splice(i, 1);
    s.wreck = 0;
    a.crashed = 1e9;
    a.state = 'crashed';
    a.braking = true;
    const b = s.body;
    b.setGravityScale(1, true);
    b.setEnabledRotations(true, true, true, true);
    b.setLinearDamping(0.35);
    b.setAngularDamping(0.9);
    s.collider?.setCollisionGroups(WRECK_GROUPS);
    // A little lift and spin so it visibly gets knocked away.
    const m = b.mass();
    b.applyImpulse({ x: 0, y: m * (0.6 + strength * 1.6), z: 0 }, true);
    b.applyTorqueImpulse({ x: 0, y: m * (Math.random() - 0.5) * 3 * strength, z: m * (Math.random() - 0.5) * strength }, true);
    this.onWreck?.(a, strength);
    return true;
  }

  /** Clears all wrecks away (traffic.clear). */
  clearWrecks() {
    for (const s of this.solids) if (s.wreck !== undefined) this.release(s);
  }

  /** Hooks traffic sound into the game's audio graph (after the first user gesture). */
  attachAudio(ctx: AudioContext, destination: AudioNode) {
    this.sound ??= new TrafficSound(ctx, destination);
  }

  isSolid(body: RAPIER_NS.RigidBody | null | undefined) {
    return !!body && this.solids.some((s) => s.body === body);
  }

  update(dt: number, player: PlayerState | undefined, camera: THREE.Camera) {
    this.time += dt;
    const cp = camera.position;
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    this.sim.wrecks = this.wreckObstacles();
    this.sim.update(dt, player, { x: cp.x, z: cp.z, fx: fwd.x / fl, fz: fwd.z / fl });
    this.view.root.visible = this.visible;
    if (player) this.updateSolids(player, dt);
    this.view.update(this.visible ? [...this.sim.agents, ...this.wrecks] : [], this.time, cp);
    this.lights.update(camera);
    if (this.sound) {
      this.sound.setListener(cp.x, cp.y, cp.z, fwd.x, fwd.y, fwd.z, dt);
      this.sound.update(this.visible ? this.sim.agents : []);
    }
  }

  private wreckObstacles(): PlayerState[] {
    return this.wrecks.map((a) => ({ x: a.x, z: a.z, vx: 0, vz: 0, halfLength: a.spec.length / 2, halfWidth: a.spec.width / 2 }));
  }

  private updateSolids(p: PlayerState, dt: number) {
    const agents = this.sim.agents;
    const near = (a: Agent) => Math.hypot(a.x - p.x, a.z - p.z);
    // Wrecks: read the pose back from the loose body, clear them away after a while.
    const qa = new THREE.Quaternion();
    const up = new THREE.Vector3();
    for (const s of this.solids) {
      if (s.wreck === undefined) continue;
      const a = s.agent!;
      s.wreck += dt;
      const t = s.body.translation();
      const r = s.body.rotation();
      qa.set(r.x, r.y, r.z, r.w);
      up.set(0, 1, 0).applyQuaternion(qa).multiplyScalar(a.spec.height / 2 + 0.1);
      a.x = t.x - up.x; a.y = t.y - up.y; a.z = t.z - up.z;
      a.quat = { x: r.x, y: r.y, z: r.z, w: r.w };
      const d = near(a);
      if (!this.visible || s.wreck > this.wreckTime * 2 || (s.wreck > this.wreckTime && d > 40) || d > SOLID_RANGE + 60 || t.y < -500) this.release(s);
    }
    for (const s of this.solids) if (s.agent && s.wreck === undefined && (!agents.includes(s.agent) || near(s.agent) > SOLID_RANGE + 20 || !this.visible)) this.release(s);
    if (this.visible) {
      const taken = new Set(this.solids.map((s) => s.agent).filter(Boolean));
      const want = agents.filter((a) => !taken.has(a) && near(a) < SOLID_RANGE).sort((a, b) => near(a) - near(b));
      for (const a of want) {
        const free = this.solids.find((s) => !s.agent);
        if (!free) break;
        this.assign(free, a);
      }
    }
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    // Steer each body onto its vehicle: velocity towards the pose (so contacts see a moving mass), rotation set.
    const step = Math.max(dt, 1 / 120);
    for (const s of this.solids) {
      const a = s.agent;
      if (!a || s.wreck !== undefined) continue;
      q.setFromEuler(e.set(-a.pitch, a.yaw, 0));
      const t = s.body.translation();
      const tx = a.x, ty = a.y + a.spec.height / 2 + 0.1, tz = a.z;
      const off = Math.hypot(tx - t.x, ty - t.y, tz - t.z);
      if (off > 6) s.body.setTranslation({ x: tx, y: ty, z: tz }, true);
      const k = Math.min(1, 40 / Math.max(off / step, 1e-6));
      s.body.setLinvel({ x: ((tx - t.x) / step) * k, y: ((ty - t.y) / step) * k, z: ((tz - t.z) / step) * k }, true);
      s.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    }
  }

  /** Collision mass of a vehicle kind: scaled for punting, practically immovable with punting off. */
  private massOf(kind: VehicleKind) {
    return MASS[kind] * (this.punt ? this.massScale : 1000);
  }

  /** After traffic.punt or traffic.mass changed: new masses on all bodies. */
  applyMass() {
    for (const s of this.solids) if (s.collider && s.kind) s.collider.setMass(this.massOf(s.kind));
  }

  private assign(s: Solid, a: Agent) {
    if (s.kind !== a.kind) {
      if (s.collider) this.world.removeCollider(s.collider, false);
      const { length, width, height } = a.spec;
      s.collider = this.world.createCollider(this.R.ColliderDesc.cuboid(width / 2, (height - 0.2) / 2, length / 2).setFriction(0.5).setRestitution(0.2).setMass(this.massOf(a.kind)).setCollisionGroups(FOLLOW_GROUPS), s.body);
      s.kind = a.kind;
    }
    s.agent = a;
    s.body.setTranslation({ x: a.x, y: a.y + a.spec.height / 2 + 0.1, z: a.z }, true);
    s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  private release(s: Solid) {
    if (s.wreck !== undefined) {
      s.wreck = undefined;
      const b = s.body;
      b.setGravityScale(0, true);
      b.setEnabledRotations(false, false, false, true);
      b.setLinearDamping(0);
      b.setAngularDamping(0);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      s.collider?.setCollisionGroups(FOLLOW_GROUPS);
    }
    s.agent = undefined;
    s.body.setTranslation({ x: 0, y: -1000 - this.solids.indexOf(s) * 10, z: 0 }, false);
    s.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  }

  get solidCount() {
    return this.solids.filter((s) => s.agent).length;
  }
}
