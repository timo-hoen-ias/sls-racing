import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { DriveInput } from '../input/input.ts';
import { CAR } from './tuning.ts';

type R = typeof RAPIER_NS;

/** Approximate yaw inertia of the chassis box (kg·m²). */
const YAW_INERTIA = (CAR.mass * ((2 * CAR.halfExtents.x) ** 2 + (2 * CAR.halfExtents.z) ** 2)) / 12;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Raycast vehicle with arcade assists. Body space: +z forward, +x left, +y up. */
export class CarPhysics {
  readonly body: RAPIER_NS.RigidBody;
  readonly controller: RAPIER_NS.DynamicRayCastVehicleController;
  nitro = 1; // tank 0..1
  boosting = false;
  steer = 0;
  speed = 0; // m/s along forward
  gear = 1;
  rpm: number = CAR.rpm.idle;
  drifting = false;
  airborne = false;
  private R: R;

  constructor(R: R, world: RAPIER_NS.World, pos: { x: number; y: number; z: number }, heading: number) {
    this.R = R;
    const yaw = Math.PI - heading;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.05)
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
    const maxSteer = lerp(CAR.steer.lowSpeed, CAR.steer.highSpeed, clamp(absV / CAR.steer.fadeSpeed, 0, 1));
    this.steer += clamp(input.steer * maxSteer - this.steer, -CAR.steer.rate * dt, CAR.steer.rate * dt);
    // Body +x is left, so steering right is a negative angle.
    vc.setWheelSteering(0, -this.steer);
    vc.setWheelSteering(1, -this.steer);

    // Nitro.
    this.boosting = input.nitro && this.nitro > 0.02 && input.throttle > 0.1;
    if (this.boosting) this.nitro = Math.max(0, this.nitro - CAR.nitro.drain * dt);
    else this.nitro = Math.min(1, this.nitro + (this.drifting ? CAR.nitro.driftRefill : CAR.nitro.refill) * dt);
    const top = CAR.engine.topSpeed * (this.boosting ? CAR.nitro.topSpeed : 1);
    const force = CAR.engine.force * (this.boosting ? CAR.nitro.force : 1);

    // Engine and brakes. Brake pedal reverses once (nearly) stopped.
    let engine = 0;
    let brake = 0;
    if (input.throttle > 0) {
      if (v < -1) brake = CAR.brake.force * input.throttle;
      else engine = force * input.throttle * clamp(1 - v / top, 0, 1) ** 0.6;
    }
    if (input.brake > 0) {
      if (v > 1) brake = Math.max(brake, CAR.brake.force * input.brake);
      else if (input.throttle === 0) engine = -force * 0.5 * input.brake * clamp(1 + v / CAR.engine.reverseSpeed, 0, 1);
    }
    if (input.throttle === 0 && input.brake === 0) brake = 6; // engine braking / rolling resistance
    // All-wheel drive, 35 % front / 65 % rear.
    for (let i = 0; i < 4; i++) {
      vc.setWheelEngineForce(i, engine * (i < 2 ? 0.35 : 0.65) * 0.5);
      vc.setWheelBrake(i, brake * (i < 2 ? 0.6 : 0.4));
    }

    // Handbrake drift: lock and loosen the rear.
    this.drifting = input.handbrake && absV > 8;
    const rearGrip = input.handbrake ? CAR.grip.driftRear : CAR.grip.rear;
    vc.setWheelFrictionSlip(2, rearGrip);
    vc.setWheelFrictionSlip(3, rearGrip);
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
        const yawAssist = -this.steer * clamp(absV / 20, 0, 1) * (input.handbrake ? 1.1 : 0.6) * Math.sign(v) * mass * 0.9 * dt;
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
      const push = 1800 * dt;
      body.applyImpulse({ x: fwd.x * push, y: fwd.y * push, z: fwd.z * push }, true);
    }

    // Simple gearbox for the engine sound and the HUD.
    const ratios = CAR.gears;
    const wheelRpm = (absV / (2 * Math.PI * CAR.wheel.radius)) * 60;
    const rpmFor = (g: number) => wheelRpm * ratios[g] * 3.9;
    if (v < -0.5) this.gear = -1;
    else {
      if (this.gear < 1) this.gear = 1;
      if (rpmFor(this.gear) > CAR.rpm.max * 0.95 && this.gear < ratios.length - 1) this.gear++;
      else if (this.gear > 1 && rpmFor(this.gear - 1) < CAR.rpm.max * 0.6) this.gear--;
    }
    const target = this.gear === -1 ? wheelRpm * ratios[1] * 3.9 : rpmFor(this.gear);
    const free = CAR.rpm.idle + input.throttle * 2500;
    this.rpm = clamp(Math.max(target, this.airborne || (input.handbrake && input.throttle) ? free + 2000 : CAR.rpm.idle), CAR.rpm.idle, CAR.rpm.max);
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
