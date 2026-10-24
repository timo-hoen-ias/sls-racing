import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { DriveInput } from '../input/input.ts';
import { Drivetrain } from './drivetrain.ts';
import { CAR, ENGINE } from './tuning.ts';

type R = typeof RAPIER_NS;

/** Approximate yaw inertia of the chassis box (kg·m²). */
const YAW_INERTIA = (CAR.mass * ((2 * CAR.halfExtents.x) ** 2 + (2 * CAR.halfExtents.z) ** 2)) / 12;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Steering lock (rad) at a speed (m/s): shrinks with the square of the speed. */
export function maxSteerAngle(speed: number) {
  const s = CAR.steer;
  return s.highSpeed + (s.lowSpeed - s.highSpeed) / (1 + (Math.abs(speed) / s.fadeSpeed) ** 2);
}

/** Per-wheel contact state for tyre marks, smoke and sound. */
export interface WheelState {
  contact: boolean;
  /** Contact point and surface normal (world). */
  p: { x: number; y: number; z: number };
  n: { x: number; y: number; z: number };
  /** Sideways sliding speed of the contact patch (m/s). */
  lateral: number;
  /** Longitudinal slip 0..1 (wheelspin or locked wheel). */
  long: number;
  /** Combined slip 0..1 as it would be heard and seen. */
  slip: number;
}

/** Raycast vehicle with arcade assists. Body space: +z forward, +x left, +y up. */
export class CarPhysics {
  readonly body: RAPIER_NS.RigidBody;
  readonly controller: RAPIER_NS.DynamicRayCastVehicleController;
  nitro = 1; // tank 0..1
  boosting = false;
  steer = 0;
  speed = 0; // m/s along forward
  readonly drivetrain = new Drivetrain(ENGINE);
  readonly wheels: WheelState[] = [0, 1, 2, 3].map(() => ({ contact: false, p: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 1, z: 0 }, lateral: 0, long: 0, slip: 0 }));
  /** Strongest tyre slip of all four wheels, 0..1. */
  slip = 0;
  drifting = false;
  airborne = false;
  /** Road condition multipliers set by the weather each frame (1 = dry asphalt). */
  surface = { grip: 1, side: 1, traction: 1, brake: 1, steer: 1, accel: 1 };
  private wheelspin = 0;
  private R: R;

  constructor(R: R, world: RAPIER_NS.World, pos: { x: number; y: number; z: number }, heading: number) {
    this.R = R;
    const yaw = Math.PI - heading;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.005)
      .setAngularDamping(0.8)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(desc);
    const h = CAR.halfExtents;
    const volume = 8 * h.x * h.y * h.z;
    world.createCollider(
      R.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(0, CAR.colliderY, 0).setDensity(CAR.mass / volume).setFriction(0.3).setRestitution(0.1),
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
    for (let i = 0; i < 4; i++) {
      vc.setWheelSuspensionStiffness(i, CAR.suspension.stiffness);
      vc.setWheelSuspensionCompression(i, CAR.suspension.compression);
      vc.setWheelSuspensionRelaxation(i, CAR.suspension.relaxation);
      vc.setWheelMaxSuspensionForce(i, CAR.suspension.maxForce);
      vc.setWheelMaxSuspensionTravel(i, w.travel);
      vc.setWheelFrictionSlip(i, i < 2 ? CAR.grip.front : CAR.grip.rear);
      vc.setWheelSideFrictionStiffness(i, CAR.grip.side);
    }
    this.controller = vc;
  }

  /** Call before world.step(). */
  update(input: DriveInput, dt: number) {
    const vc = this.controller;
    this.speed = vc.currentVehicleSpeed();
    const v = this.speed;
    const absV = Math.abs(v);
    const contacts = [0, 1, 2, 3].filter((i) => vc.wheelIsInContact(i)).length;
    this.airborne = contacts === 0;

    // Steering: less lock at speed, smoothed.
    // Speed-sensitive steering: full lock when parking, only a few degrees at motorway speed,
    // and the wheel turns slower the faster the car goes. The handbrake keeps enough lock to drift.
    let maxSteer = maxSteerAngle(absV);
    if (input.handbrake) maxSteer = Math.max(maxSteer, CAR.steer.drift);
    const sf = this.surface;
    const rate = (CAR.steer.rate * sf.steer) / (1 + absV / CAR.steer.rateSpeed);
    this.steer += clamp(input.steer * maxSteer - this.steer, -rate * dt, rate * dt);
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
    if (input.throttle > 0 && v < -1) brake = CAR.brake.force * sf.brake * input.throttle;
    if (input.brake > 0 && v > 1) brake = Math.max(brake, CAR.brake.force * sf.brake * input.brake);
    if (input.throttle === 0 && input.brake === 0 && absV < 1) brake = 6; // holds the car on slopes
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
    // Arcade traction control: what the tyres cannot put down spins them instead.
    const tractionLimit = CAR.traction * sf.traction * CAR.mass * 9.81 * (contacts / 4) * (this.boosting ? CAR.nitro.traction : 1);
    const wanted = dt0.force * sf.accel;
    // Rapier ignores the brakes on a wheel with engine force, so braking overrides engine braking.
    const engine = brake > 6 ? 0 : Math.sign(wanted) * Math.min(Math.abs(wanted), tractionLimit);
    const spin = wanted > 0 && tractionLimit > 0 ? clamp((wanted / tractionLimit - 1.15) / 0.9, 0, 1) : 0;
    this.wheelspin = absV < 30 ? spin : 0;
    // Rear-biased all-wheel drive.
    for (let i = 0; i < 4; i++) {
      vc.setWheelEngineForce(i, engine * (i < 2 ? CAR.frontDrive : 1 - CAR.frontDrive) * 0.5);
      vc.setWheelBrake(i, brake * (i < 2 ? 0.6 : 0.4));
    }

    // Handbrake drift: lock and loosen the rear.
    this.drifting = input.handbrake && absV > 8;
    const rearGrip = (input.handbrake ? CAR.grip.driftRear : CAR.grip.rear) * sf.grip;
    vc.setWheelFrictionSlip(0, CAR.grip.front * sf.grip);
    vc.setWheelFrictionSlip(1, CAR.grip.front * sf.grip);
    vc.setWheelFrictionSlip(2, rearGrip);
    vc.setWheelFrictionSlip(3, rearGrip);
    for (let i = 0; i < 4; i++) vc.setWheelSideFrictionStiffness(i, CAR.grip.side * sf.side);
    if (input.handbrake) { vc.setWheelBrake(2, CAR.brake.handbrake); vc.setWheelBrake(3, CAR.brake.handbrake); }

    vc.updateVehicle(dt);

    const body = this.body;
    const rot = body.rotation();
    const up = rotate(rot, 0, 1, 0);
    const fwd = rotate(rot, 0, 0, 1);
    const mass = body.mass();
    if (!this.airborne) {
      // Downforce keeps the car planted at speed.
      const df = CAR.downforce * v * v * dt;
      body.applyImpulse({ x: -up.x * df, y: -up.y * df, z: -up.z * df }, true);
      // Yaw assist: a gentle extra turn at speed so the car feels responsive.
      if (absV > 3) {
        // Fades out at high speed so the car stays planted instead of darting.
        const fade = input.handbrake ? 1 : clamp(1.5 - absV / 40, 0.35, 1);
        const yawAssist = -this.steer * clamp(absV / 20, 0, 1) * fade * (input.handbrake ? 1.1 : 0.6) * Math.sign(v) * mass * 0.9 * dt;
        body.applyTorqueImpulse({ x: up.x * yawAssist, y: up.y * yawAssist, z: up.z * yawAssist }, true);
      }
      // Drift angle cap: past ~40° the car is pulled back towards its direction of travel.
      const lv = body.linvel();
      const left = rotate(rot, 1, 0, 0);
      const fv = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
      const sv = lv.x * left.x + lv.y * left.y + lv.z * left.z;
      if (fv > 5) {
        const slip = Math.atan2(sv, fv);
        const cap = 0.7;
        if (Math.abs(slip) > cap) {
          const k = (slip - Math.sign(slip) * cap) * YAW_INERTIA * 4 * dt;
          body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
        }
        // Arcade grip: bleed a little sideways speed into forward speed while drifting.
        if (this.drifting) {
          const bleed = sv * 0.9 * dt;
          body.applyImpulse({ x: (-left.x * bleed + fwd.x * Math.abs(bleed) * 0.6) * mass, y: 0, z: (-left.z * bleed + fwd.z * Math.abs(bleed) * 0.6) * mass }, true);
        }
      }
      // Spin limiter: damp yaw rate above what still feels controllable.
      const w = body.angvel();
      const yawRate = w.x * up.x + w.y * up.y + w.z * up.z;
      const maxYaw = input.handbrake ? 2.4 : 1.7;
      if (Math.abs(yawRate) > maxYaw) {
        const k = -(yawRate - Math.sign(yawRate) * maxYaw) * YAW_INERTIA * 0.5;
        body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
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
    {
      const lv = body.linvel();
      const sp = Math.hypot(lv.x, lv.y, lv.z);
      if (sp > 0.3) {
        const f = (CAR.aero.drag * sp * sp + (this.airborne ? 0 : CAR.aero.rolling * mass * 9.81)) * dt;
        body.applyImpulse({ x: (-lv.x / sp) * f, y: (-lv.y / sp) * f, z: (-lv.z / sp) * f }, true);
      }
    }
    this.measureWheels(input, rot);
  }

  get rpm() { return this.drivetrain.rpm; }
  get gear() { return this.drivetrain.gear; }

  /** Contact patches and their slip, from the body's velocity at each wheel. */
  private measureWheels(input: DriveInput, rot: { x: number; y: number; z: number; w: number }) {
    const vc = this.controller;
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const c = this.body.translation();
    const absV = Math.abs(this.speed);
    // ABS lets the wheels lock briefly under a full stop from speed.
    const lockBrake = input.brake > 0.75 && this.speed > 12 ? (input.brake - 0.75) * 2.4 : 0;
    let max = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.contact = vc.wheelIsInContact(i);
      if (!w.contact) { w.lateral = 0; w.long = 0; w.slip = 0; continue; }
      const p = vc.wheelContactPoint(i);
      const n = vc.wheelContactNormal(i);
      if (!p || !n) { w.contact = false; continue; }
      w.p.x = p.x; w.p.y = p.y; w.p.z = p.z;
      w.n.x = n.x; w.n.y = n.y; w.n.z = n.z;
      const rx = p.x - c.x, ry = p.y - c.y, rz = p.z - c.z;
      const vx = lv.x + av.y * rz - av.z * ry;
      const vy = lv.y + av.z * rx - av.x * rz;
      const vz = lv.z + av.x * ry - av.y * rx;
      const a = vc.wheelSteering(i) ?? 0;
      const axle = rotate(rot, Math.cos(a), 0, -Math.sin(a));
      w.lateral = Math.abs(vx * axle.x + vy * axle.y + vz * axle.z);
      const rear = i >= 2;
      let long = Math.max(this.wheelspin * (rear ? 1 : 0.6), lockBrake);
      if (rear && input.handbrake && absV > 3) long = Math.max(long, 0.8);
      w.long = clamp(long, 0, 1);
      w.slip = Math.max(clamp((w.lateral - 2.2) / 6, 0, 1), w.long);
      max = Math.max(max, w.slip);
    }
    this.slip = max;
  }

  /** Puts the car upright at a position, facing heading (0 = north). */
  reset(pos: { x: number; y: number; z: number }, heading: number) {
    const yaw = Math.PI - heading;
    this.body.setTranslation(pos, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
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
