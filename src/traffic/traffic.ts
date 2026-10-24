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

interface Solid {
  body: RAPIER_NS.RigidBody;
  collider?: RAPIER_NS.Collider;
  kind?: VehicleKind;
  agent?: Agent;
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

  constructor(R: typeof RAPIER_NS, world: RAPIER_NS.World, graph: RoadGraph, opts: { maxAgents: number; shadows: boolean }) {
    this.R = R;
    this.world = world;
    this.graph = graph;
    this.sim = new TrafficSim(graph, { maxAgents: opts.maxAgents });
    this.view = new TrafficView(opts.maxAgents + 20, opts.shadows);
    this.lights = new SignalView(graph, this.sim.signals, opts.shadows);
    this.view.root.add(this.lights.root);
    for (let i = 0; i < SOLID_BODIES; i++) {
      const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1000 - i * 10, 0));
      this.solids.push({ body });
    }
    this.sim.events.honk = (a) => this.sound?.honk(a);
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
    this.sim.update(dt, player, { x: cp.x, z: cp.z, fx: fwd.x / fl, fz: fwd.z / fl });
    this.view.root.visible = this.visible;
    this.view.update(this.visible ? this.sim.agents : [], this.time, cp);
    this.lights.update(camera);
    if (player) this.updateSolids(player);
    if (this.sound) {
      this.sound.setListener(cp.x, cp.y, cp.z, fwd.x, fwd.y, fwd.z, dt);
      this.sound.update(this.visible ? this.sim.agents : []);
    }
  }

  private updateSolids(p: PlayerState) {
    const agents = this.sim.agents;
    const near = (a: Agent) => Math.hypot(a.x - p.x, a.z - p.z);
    for (const s of this.solids) if (s.agent && (!agents.includes(s.agent) || near(s.agent) > SOLID_RANGE + 20 || !this.visible)) this.release(s);
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
    for (const s of this.solids) {
      const a = s.agent;
      if (!a) continue;
      q.setFromEuler(e.set(-a.pitch, a.yaw, 0));
      s.body.setNextKinematicTranslation({ x: a.x, y: a.y + a.spec.height / 2 + 0.1, z: a.z });
      s.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  private assign(s: Solid, a: Agent) {
    if (s.kind !== a.kind) {
      if (s.collider) this.world.removeCollider(s.collider, false);
      const { length, width, height } = a.spec;
      s.collider = this.world.createCollider(this.R.ColliderDesc.cuboid(width / 2, (height - 0.2) / 2, length / 2).setFriction(0.5).setRestitution(0.2), s.body);
      s.kind = a.kind;
    }
    s.agent = a;
    s.body.setTranslation({ x: a.x, y: a.y + a.spec.height / 2 + 0.1, z: a.z }, true);
  }

  private release(s: Solid) {
    s.agent = undefined;
    s.body.setTranslation({ x: 0, y: -1000 - this.solids.indexOf(s) * 10, z: 0 }, false);
  }

  get solidCount() {
    return this.solids.filter((s) => s.agent).length;
  }
}
