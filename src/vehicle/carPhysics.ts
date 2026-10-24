import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { DriveInput } from '../input/input.ts';
import { Drivetrain } from './drivetrain.ts';
import { ASSIST_PRESETS, type Assists, CAR, ENGINE } from './tuning.ts';
import { loadedMu, splitAxle, tyreForce, type TyreOutput, type TyreSpec } from './tyres.ts';

type R = typeof RAPIER_NS;
type V3 = { x: number; y: number; z: number };

/** Collision groups: the player car is membership 1; debris (membership 2) ignores it but hits the world. */
export const CAR_GROUPS = (0x0001 << 16) | 0xffff;
export const DEBRIS_GROUPS = (0x0002 << 16) | 0xfffe;

/** Approximate yaw inertia of the chassis box (kg·m²). */
const YAW_INERTIA = (CAR.mass * ((2 * CAR.halfExtents.x) ** 2 + (2 * CAR.halfExtents.z) ** 2)) / 12;
/** Static load on one wheel (N): the reference load of the tyre model. */
const REF_LOAD = (CAR.mass * 9.81) / 4;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Steering lock (rad) at a speed (m/s): shrinks with the square of the speed. */
export function maxSteerAngle(speed: number) {
  const s = CAR.steer;
  return s.highSpeed + (s.lowSpeed - s.highSpeed) / (1 + (Math.abs(speed) / s.fadeSpeed) ** 2);
}

/** Per-wheel contact state for tyre marks, smoke, sound and telemetry. */
export interface WheelState {
  contact: boolean;
  /** Contact point and surface normal (world). */
  p: V3;
  n: V3;
  /** Sideways sliding speed of the contact patch (m/s). */
  lateral: number;
  /** Longitudinal slip 0..1 (wheelspin or locked wheel). */
  long: number;
  /** Combined slip 0..1 as it would be heard and seen. */
  slip: number;
  /** Vertical load (N), slip angle (rad), tyre forces along and across the wheel (N), friction ellipse use (1 = limit). */
  load: number;
  alpha: number;
  fx: number;
  fy: number;
  usage: number;
  /** Spring compression (m, 0 = fully extended). */
  compression: number;
}

const wheelState = (): WheelState => ({
  contact: false, p: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 1, z: 0 }, lateral: 0, long: 0, slip: 0, load: 0, alpha: 0, fx: 0, fy: 0, usage: 0, compression: 0,
});

/**
 * Raycast vehicle: Rapier does the suspension, the tyre forces come from our own tyre model
 * (slip angle curve, friction ellipse, load sensitivity, anti-roll bars, limited-slip diffs).
 * Arcade feel comes from named driving aids that can be turned down to zero.
 * Body space: +z forward, +x left, +y up.
 */
export class CarPhysics {
  readonly body: RAPIER_NS.RigidBody;
  readonly controller: RAPIER_NS.DynamicRayCastVehicleController;
  nitro = 1; // tank 0..1
  boosting = false;
  steer = 0;
  speed = 0; // m/s along forward
  readonly drivetrain = new Drivetrain(ENGINE);
  readonly wheels: WheelState[] = [0, 1, 2, 3].map(wheelState);
  /** Strongest tyre slip of all four wheels, 0..1. */
  slip = 0;
  drifting = false;
  airborne = false;
  /** Road condition multipliers set by the weather each frame (1 = dry asphalt). */
  surface = { grip: 1, side: 1, traction: 1, brake: 1, steer: 1, accel: 1 };
  /** Extra grip factor per wheel (puddles, grass, cobbles …), 1 = the road under the whole car. */
  wheelGrip = [1, 1, 1, 1];
  /** Extra rolling resistance per wheel as a share of its load (grass, gravel …). */
  wheelRolling = [0, 0, 0, 0];
  /** Surface roughness per wheel 0..1: shakes the car at speed (cobbles, fields). */
  wheelRumble = [0, 0, 0, 0];
  /** Driving aids; see ASSIST_PRESETS. */
  assists: Assists = { ...ASSIST_PRESETS.arcade };
  /** Body-frame acceleration of the last step (m/s², x = left, z = forward) for telemetry and the cockpit camera. */
  readonly accel = { x: 0, y: 0, z: 0 };
  /** From damage: engine power factor and a steering offset (rad, + = right). */
  power = 1;
  steerPull = 0;
  private wheelspin = 0;
  private R: R;
  private tyreOut: TyreOutput = { fx: 0, fy: 0, alpha: 0, spin: 0, lock: 0, usage: 0 };
  private lastVel = { x: 0, y: 0, z: 0 };
  private bumps = [0, 0, 0, 0];

  constructor(R: R, world: RAPIER_NS.World, pos: V3, heading: number) {
    this.R = R;
    const yaw = Math.PI - heading;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.005)
      .setAngularDamping(0.4)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(desc);
    const h = CAR.halfExtents;
    const volume = 8 * h.x * h.y * h.z;
    world.createCollider(
      R.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(0, CAR.colliderY, 0).setDensity(CAR.mass / volume).setFriction(0.3).setRestitution(0.1).setCollisionGroups(CAR_GROUPS),
      this.body,
    );
    // Lower the centre of mass for stability.
    this.body.setAdditionalMassProperties(0, { x: 0, y: -0.25, z: 0.05 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, true);

    const vc = world.createVehicleController(this.body);
    vc.indexUpAxis = 1;
    (vc as any).setIndexForwardAxis = 2;
    const w = CAR.wheel;
    for (const [x, z] of [[w.x, w.front], [-w.x, w.front], [w.x, w.rear], [-w.x, w.rear]]) {
      vc.addWheel({ x, y: w.y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, w.rest, w.radius);
    }
    this.controller = vc;
    this.applySuspension();
    // Rapier's own tyre friction is off: it would fight the tyre model.
    for (let i = 0; i < 4; i++) {
      vc.setWheelFrictionSlip(i, 0);
      vc.setWheelSideFrictionStiffness(i, 0);
    }
  }

  /** Pushes CAR.suspension into Rapier (after a debug change). */
  applySuspension() {
    const vc = this.controller;
    const s = CAR.suspension;
    for (let i = 0; i < 4; i++) {
      vc.setWheelSuspensionStiffness(i, s.stiffness);
      vc.setWheelSuspensionCompression(i, s.compression);
      vc.setWheelSuspensionRelaxation(i, s.relaxation);
      vc.setWheelMaxSuspensionForce(i, s.maxForce);
      vc.setWheelMaxSuspensionTravel(i, CAR.wheel.travel);
    }
  }

  /** A kerb or pothole under wheel i: kicks that corner up next step; strength ~1 for a kerb at town speed. */
  bump(i: number, strength: number) {
    this.bumps[i] = Math.max(this.bumps[i], strength);
  }

  /** Call before world.step(). */
  update(input: DriveInput, dt: number) {
    const vc = this.controller;
    const as = this.assists;
    this.speed = vc.currentVehicleSpeed();
    const v = this.speed;
    const absV = Math.abs(v);
    let contacts = 0;
    for (let i = 0; i < 4; i++) if (vc.wheelIsInContact(i)) contacts++;
    this.airborne = contacts === 0;

    // Speed-sensitive steering: full lock when parking, only a few degrees at motorway speed,
    // and the wheel turns slower the faster the car goes. The handbrake keeps enough lock to drift.
    let maxSteer = maxSteerAngle(absV);
    if (input.handbrake) maxSteer = Math.max(maxSteer, CAR.steer.drift);
    const sf = this.surface;
    const rate = (CAR.steer.rate * sf.steer) / (1 + absV / CAR.steer.rateSpeed);
    const pull = this.steerPull * clamp(absV / 8, 0, 1);
    this.steer += clamp(input.steer * maxSteer + pull - this.steer, -rate * dt, rate * dt);
    // Body +x is left, so steering right is a negative angle.
    vc.setWheelSteering(0, -this.steer);
    vc.setWheelSteering(1, -this.steer);

    // Nitro.
    this.boosting = input.nitro && this.nitro > 0.02 && input.throttle > 0.1;
    if (this.boosting) this.nitro = Math.max(0, this.nitro - CAR.nitro.drain * dt);
    else this.nitro = Math.min(1, this.nitro + (this.drifting ? CAR.nitro.driftRefill : CAR.nitro.refill) * dt);

    // Pedals: the brake pedal selects reverse once (nearly) stopped, the gas pedal brakes while reversing.
    const dt0 = this.drivetrain;
    const reversing = input.throttle === 0 && ((v < 1 && input.brake > 0) || (v < -0.5 && dt0.gear === -1));
    let brake = 0;
    if (input.throttle > 0 && v < -1) brake = CAR.brake.force * input.throttle;
    if (input.brake > 0 && v > 1) brake = Math.max(brake, CAR.brake.force * input.brake);
    const hold = input.throttle === 0 && input.brake === 0 && absV < 1;
    brake *= sf.brake;
    const pedal = reversing ? input.brake * clamp((CAR.reverseSpeed + v) / 2, 0, 1) : v < -1 ? 0 : input.throttle;
    dt0.update({
      speed: v,
      throttle: pedal,
      brake: reversing ? 0 : input.brake,
      reverse: reversing,
      airborne: this.airborne,
      freeRev: input.handbrake && input.throttle > 0 && absV < 25,
      boost: this.boosting ? CAR.nitro.torque : 1,
      wheelspin: this.wheelspin,
      dt,
    });

    // Suspension only: Rapier's engine, brakes and friction stay at zero.
    vc.updateVehicle(dt);
    this.tyres(input, brake, hold, dt0.force * sf.accel * (dt0.force > 0 ? this.power : 1), dt);

    const body = this.body;
    const rot = body.rotation();
    const up = rotate(rot, 0, 1, 0);
    const fwd = rotate(rot, 0, 0, 1);
    const left = rotate(rot, 1, 0, 0);
    const mass = body.mass();
    this.drifting = input.handbrake && absV > 8;
    if (!this.airborne) {
      // Downforce on each axle, so the aero balance shifts grip between front and rear.
      const df = CAR.aero.downforce * v * v * dt;
      const t = body.translation();
      for (const [z, share] of [[CAR.wheel.front, CAR.aero.balance], [CAR.wheel.rear, 1 - CAR.aero.balance]]) {
        const p = { x: t.x + fwd.x * z, y: t.y + fwd.y * z, z: t.z + fwd.z * z };
        body.applyImpulseAtPoint({ x: -up.x * df * share, y: -up.y * df * share, z: -up.z * df * share }, p, true);
      }
      // Drift assist: a little extra yaw while steering so the car feels eager, more with the handbrake.
      if (absV > 3 && as.drift > 0) {
        const fade = input.handbrake ? 1 : clamp(1.5 - absV / 40, 0.35, 1);
        const yawAssist = -this.steer * clamp(absV / 20, 0, 1) * fade * (input.handbrake ? 1.1 : 0.45) * as.drift * Math.sign(v) * mass * 0.9 * dt;
        body.applyTorqueImpulse({ x: up.x * yawAssist, y: up.y * yawAssist, z: up.z * yawAssist }, true);
      }
      const lv = body.linvel();
      const fv = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
      const sv = lv.x * left.x + lv.y * left.y + lv.z * left.z;
      if (fv > 5) {
        // Stability control: past ~40° of drift angle the car is pulled back towards its direction of travel.
        const slip = Math.atan2(sv, fv);
        const cap = 0.7 + (1 - as.esp) * 1.2;
        if (as.esp > 0 && Math.abs(slip) > cap) {
          const k = (slip - Math.sign(slip) * cap) * YAW_INERTIA * 4 * as.esp * dt;
          body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
        }
        // Drift assist: bleed a little sideways speed into forward speed while drifting.
        if (this.drifting && as.drift > 0) {
          const bleed = sv * 0.9 * as.drift * dt;
          body.applyImpulse({ x: (-left.x * bleed + fwd.x * Math.abs(bleed) * 0.6) * mass, y: 0, z: (-left.z * bleed + fwd.z * Math.abs(bleed) * 0.6) * mass }, true);
        }
      }
      // Stability control: damp yaw rate above what still feels controllable.
      if (as.esp > 0) {
        const w = body.angvel();
        const yawRate = w.x * up.x + w.y * up.y + w.z * up.z;
        const maxYaw = input.handbrake ? 2.4 : 1.7;
        if (Math.abs(yawRate) > maxYaw) {
          const k = -(yawRate - Math.sign(yawRate) * maxYaw) * YAW_INERTIA * 0.5 * as.esp;
          body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
        }
      }
    } else {
      // Air control: pitch with throttle/brake, yaw with steering.
      const right = rotate(rot, -1, 0, 0);
      const pitch = (input.brake - input.throttle) * CAR.airControl * dt;
      const yaw = -input.steer * CAR.airControl * dt;
      body.applyTorqueImpulse({ x: right.x * pitch + up.x * yaw, y: right.y * pitch + up.y * yaw, z: right.z * pitch + up.z * yaw }, true);
    }
    if (this.boosting && !this.airborne) {
      const push = CAR.nitro.push * dt;
      body.applyImpulse({ x: fwd.x * push, y: fwd.y * push, z: fwd.z * push }, true);
    }
    // Air drag and rolling resistance oppose the velocity.
    const lv = body.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    if (sp > 0.3) {
      const f = (CAR.aero.drag * sp * sp + (this.airborne ? 0 : CAR.aero.rolling * mass * 9.81)) * dt;
      body.applyImpulse({ x: (-lv.x / sp) * f, y: (-lv.y / sp) * f, z: (-lv.z / sp) * f }, true);
    }
    // Acceleration in the body frame (from the last step's velocity change).
    const ax = (lv.x - this.lastVel.x) / dt, ay = (lv.y - this.lastVel.y) / dt, az = (lv.z - this.lastVel.z) / dt;
    this.accel.x = ax * left.x + ay * left.y + az * left.z;
    this.accel.y = ax * up.x + ay * up.y + az * up.z;
    this.accel.z = ax * fwd.x + ay * fwd.y + az * fwd.z;
    this.lastVel.x = lv.x; this.lastVel.y = lv.y; this.lastVel.z = lv.z;
  }

  /** Tyre forces for all four wheels, applied as impulses at the contact patches. */
  private tyres(input: DriveInput, brake: number, hold: boolean, drive: number, dt: number) {
    const vc = this.controller;
    const body = this.body;
    const rot = body.rotation();
    const up = rotate(rot, 0, 1, 0);
    const lv = body.linvel();
    const av = body.angvel();
    const com = body.worldCom();
    const sf = this.surface;
    const as = this.assists;
    const ty = CAR.tyre;
    const spec: TyreSpec = ty;
    const mass = body.mass();

    // Loads: spring force plus the anti-roll bars, which move load from the inner to the outer wheel.
    const loads = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.contact = vc.wheelIsInContact(i);
      w.compression = w.contact ? CAR.wheel.rest - (vc.wheelSuspensionLength(i) ?? CAR.wheel.rest) : 0;
      loads[i] = w.contact ? Math.max(0, vc.wheelSuspensionForce(i) ?? 0) : 0;
    }
    for (const [a, b, k] of [[0, 1, CAR.arb.front], [2, 3, CAR.arb.rear]]) {
      if (!this.wheels[a].contact || !this.wheels[b].contact) continue;
      const f = clamp(k * (this.wheels[a].compression - this.wheels[b].compression), -loads[a], loads[b]);
      loads[a] += f;
      loads[b] -= f;
      const ha = vc.wheelHardPoint(a)!;
      const hb = vc.wheelHardPoint(b)!;
      body.applyImpulseAtPoint({ x: up.x * f * dt, y: up.y * f * dt, z: up.z * f * dt }, ha, true);
      body.applyImpulseAtPoint({ x: -up.x * f * dt, y: -up.y * f * dt, z: -up.z * f * dt }, hb, true);
    }

    // Grip per wheel for driving (traction) and cornering.
    const capX = [0, 0, 0, 0];
    const capY = [0, 0, 0, 0];
    const tractionBoost = this.boosting ? CAR.nitro.traction : 1;
    for (let i = 0; i < 4; i++) {
      const mu = loadedMu(spec, loads[i], REF_LOAD) * sf.grip * this.wheelGrip[i] * (i >= 2 ? ty.rearMu : 1);
      capX[i] = mu * loads[i] * sf.traction * tractionBoost;
      capY[i] = mu * loads[i] * sf.side;
    }

    // Centre split, then a limited-slip diff per axle.
    const front = splitAxle(drive * CAR.frontDrive, capX[0], capX[1], CAR.diff.front);
    const rear = splitAxle(drive * (1 - CAR.frontDrive), capX[2], capX[3], CAR.diff.rear);
    const drives = [front[0], front[1], rear[0], rear[1]];
    // Traction control: drive beyond the grip is cut (fully at 1, not at all at 0).
    const tcLimit = 1.02 + (1 - as.tcs) * 4;
    for (let i = 0; i < 4; i++) if (drives[i] > 0) drives[i] = Math.min(drives[i], capX[i] * tcLimit);
    // Rapier would ignore the brakes on a driven wheel; here drive and brake add up, so drop drive when braking hard.
    if (brake > 500) for (let i = 0; i < 4; i++) drives[i] = Math.min(drives[i], 0);

    let spinRear = 0;
    let max = 0;
    const absV = Math.abs(this.speed);
    // Rough surfaces and kerbs: vertical kicks at the wheels, filtered by the springs into shaking.
    for (let i = 0; i < 4; i++) {
      const rough = this.wheels[i].contact ? this.wheelRumble[i] * clamp(absV / 15, 0, 1) * (Math.random() * 2 - 1) * REF_LOAD * 0.7 * dt : 0;
      const kick = this.bumps[i] * mass * 0.25 * 0.9;
      this.bumps[i] = 0;
      if (!rough && !kick) continue;
      const hp = vc.wheelHardPoint(i)!;
      const f = rough + kick;
      body.applyImpulseAtPoint({ x: up.x * f, y: up.y * f, z: up.z * f }, hp, true);
    }
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.contact) { w.lateral = 0; w.long = 0; w.slip = 0; w.load = 0; w.fx = 0; w.fy = 0; w.usage = 0; w.alpha = 0; continue; }
      const p = vc.wheelContactPoint(i);
      const n = vc.wheelContactNormal(i);
      if (!p || !n) { w.contact = false; continue; }
      w.p.x = p.x; w.p.y = p.y; w.p.z = p.z;
      w.n.x = n.x; w.n.y = n.y; w.n.z = n.z;
      // Wheel axes on the road plane.
      const a = vc.wheelSteering(i) ?? 0;
      const f0 = rotate(rot, Math.sin(a), 0, Math.cos(a));
      const fn = f0.x * n.x + f0.y * n.y + f0.z * n.z;
      let fx = f0.x - n.x * fn, fy = f0.y - n.y * fn, fz = f0.z - n.z * fn;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      const sx = n.y * fz - n.z * fy, sy = n.z * fx - n.x * fz, sz = n.x * fy - n.y * fx;
      // Patch velocity.
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      const vx = lv.x + av.y * rz - av.z * ry;
      const vy = lv.y + av.z * rx - av.x * rz;
      const vz = lv.z + av.x * ry - av.y * rx;
      const vLong = vx * fx + vy * fy + vz * fz;
      const vLat = vx * sx + vy * sy + vz * sz;

      const rearAxle = i >= 2;
      let wheelBrake = (brake * (rearAxle ? 1 - CAR.brake.bias : CAR.brake.bias)) / 2;
      let abs = as.abs;
      if (hold) wheelBrake = CAR.brake.hold / 4;
      if (rearAxle && input.handbrake) { wheelBrake += CAR.brake.handbrake / 2; abs = false; }
      // Soft ground drags the tyres like a light brake.
      wheelBrake += this.wheelRolling[i] * loads[i];
      const o = tyreForce({ vx: vLong, vy: vLat, load: loads[i], capX: capX[i], capY: capY[i], drive: drives[i], brake: wheelBrake, abs, mass: mass / 4, dt }, spec, this.tyreOut);

      // Apply at the patch, partly lifted towards the centre of mass (less roll and pitch than a real car).
      const ru = rx * up.x + ry * up.y + rz * up.z;
      const lift = (k: number) => -ru * (1 - k);
      const pl = lift(ty.pitch), sl = lift(ty.roll);
      body.applyImpulseAtPoint({ x: fx * o.fx * dt, y: fy * o.fx * dt, z: fz * o.fx * dt }, { x: p.x + up.x * pl, y: p.y + up.y * pl, z: p.z + up.z * pl }, true);
      body.applyImpulseAtPoint({ x: sx * o.fy * dt, y: sy * o.fy * dt, z: sz * o.fy * dt }, { x: p.x + up.x * sl, y: p.y + up.y * sl, z: p.z + up.z * sl }, true);

      w.load = loads[i];
      w.alpha = o.alpha;
      w.fx = o.fx;
      w.fy = o.fy;
      w.usage = o.usage;
      w.lateral = Math.abs(vLat);
      let long = Math.max(o.spin, o.lock);
      if (rearAxle && input.handbrake && absV > 3) long = Math.max(long, 0.8);
      w.long = long;
      if (rearAxle) spinRear = Math.max(spinRear, o.spin);
      // Visible/audible slip: past the peak slip angle, or spinning/locked.
      const past = clamp((Math.abs(o.alpha) / ty.peakSlip - 0.85) / 1.6, 0, 1) * clamp(absV / 6, 0, 1);
      w.slip = Math.max(past, long, clamp((o.usage - 1) * 1.5, 0, 1) * clamp(absV / 4, 0, 1));
      max = Math.max(max, w.slip);
    }
    this.slip = max;
    this.wheelspin = absV < 40 ? spinRear : 0;
  }

  get rpm() { return this.drivetrain.rpm; }
  get gear() { return this.drivetrain.gear; }

  /** Puts the car upright at a position, facing heading (0 = north). */
  reset(pos: { x: number; y: number; z: number }, heading: number) {
    const yaw = Math.PI - heading;
    this.body.setTranslation(pos, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.lastVel = { x: 0, y: 0, z: 0 };
    this.bumps.fill(0);
  }

  /** Heading in the world frame, 0 = north, clockwise positive. */
  heading() {
    const f = rotate(this.body.rotation(), 0, 0, 1);
    return Math.atan2(f.x, -f.z);
  }
}

export function rotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number) {
  // v' = q v q*
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
