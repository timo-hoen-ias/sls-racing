import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { DriveInput } from '../input/input.ts';
import { Drivetrain } from './drivetrain.ts';
import { ASSIST_PRESETS, type Assists, CAR, ENGINE } from './tuning.ts';
import { loadedMu, splitAxle, tyreForce, type TyreOutput, type TyreSpec } from './tyres.ts';

type R = typeof RAPIER_NS;
type V3 = { x: number; y: number; z: number };

/**
 * Collision groups: the player car is membership 1; debris (membership 2) ignores it but hits the world.
 * Road and pavement surfaces (membership 4) carry the wheels (their rays) but not the chassis, so
 * kerbs do not catch the body; the terrain under them still does.
 */
export const CAR_GROUPS = (0x0001 << 16) | (0xffff & ~0x0004);
export const ROAD_GROUPS = (0x0004 << 16) | 0xffff;
export const DEBRIS_GROUPS = (0x0002 << 16) | 0xfffe;

/** Approximate roll and yaw inertia of the chassis box (kg·m²), and the static load on one wheel (N, the tyre model's reference). */
function chassisConstants() {
  const h = CAR.halfExtents;
  return {
    roll: (CAR.mass * ((2 * h.x) ** 2 + (2 * h.y) ** 2)) / 12,
    yaw: (CAR.mass * ((2 * h.x) ** 2 + (2 * h.z) ** 2)) / 12,
    refLoad: (CAR.mass * 9.81) / 4,
  };
}

/** Wheel mounting points in body space: front left, front right, rear left, rear right (+x is left). */
function wheelMounts(): V3[] {
  const w = CAR.wheel;
  return [[w.x, w.front], [-w.x, w.front], [w.x, w.rear], [-w.x, w.rear]].map(([x, z]) => ({ x, y: w.y, z }));
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

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
  /**
   * Arcade feel on top of the tuning (feel.* commands, src/game/feel.ts): engine torque and downforce factors,
   * air drag factor (higher top speed below 1), self-levelling in the air and a soft landing (0..1),
   * arcade brakes: extra deceleration in g on top of what the tyres can hold, at full pedal,
   * road hold 0..1: bumps and crests do not throw the car into the air (feel.stick),
   * step assist 0..1: low edges that catch the body are climbed instead of stopping the car (feel.step),
   * straight braking 0..1: both wheels of an axle brake alike and the car does not yaw away (feel.straight),
   * and a coasting brake in g off both pedals, three times that when rolling against the gear (feel.coast).
   */
  feel = { torque: 1, downforce: 1, drag: 1, airLevel: 0, landing: 0, brake: 0, stick: 0, step: 0, straight: 0, coast: 0 };
  /** A short tap on nitro fires a burst instead of the steady boost (feel.burst). */
  burst = { enabled: true, tap: 0.22, kick: 5, cost: 0.14 };
  /** Nitro gained from style moves since the last frame (near misses, jumps …), added by the game. */
  nitroGain = 0;
  /** Seconds the current burst still pushes. */
  bursting = 0;
  /** Seconds the car has been in the air (0 on the ground). */
  airTime = 0;
  /**
   * Drift on a button (F2): a short pull on the handbrake at speed starts a drift that holds without it.
   * Throttle opens the angle, steering into the drift opens it more, steering against it closes it;
   * lifting off, braking or slowing down ends it. angle: largest drift angle (rad); grip: rear side grip
   * while drifting; hold: how firmly the assist keeps the angle.
   */
  driftKit = { enabled: true, angle: 0.65, grip: 0.6, hold: 1, minSpeed: 12 };
  /** Running drift from driftKit: direction (+1 right, -1 left), 0 = none. */
  driftDir = 0;
  private driftTime = 0;
  private driftLow = 0;
  private lastSlip = 0;
  private rearSide = 1;
  private nitroHeld = 0;
  private wheelspin = 0;
  private R: R;
  private tyreOut: TyreOutput = { fx: 0, fy: 0, alpha: 0, spin: 0, lock: 0, usage: 0 };
  private lastVel = { x: 0, y: 0, z: 0 };
  private bumps = [0, 0, 0, 0];
  private k = chassisConstants();
  private world: RAPIER_NS.World;
  private stickRay!: RAPIER_NS.Ray;
  /**
   * Road hold tuning (feel.stick scales it): normal speed left alone (m/s), damping rate (1/s), press-down with a
   * wheel in the air (g), extra gravity in the air (g) for this long after take-off (s) while the road is within reach (m),
   * unless the car came off a ramp: climbed more than rampRise (m) and left climbing faster than hopVy (m/s).
   */
  stick = { free: 0.25, damp: 18, press: 0.6, gravity: 1.5, window: 0.4, reach: 1.6, hopVy: 2.5, rampRise: 0.6 };
  private climb = 0;
  private launched = false;
  /**
   * Step assist tuning (feel.step scales it): highest edge above the underbody that is climbed (m), share of the speed
   * before the hit that is given back, and the pause before the next lift (s).
   */
  stepAssist = { height: 0.3, keep: 0.9, cooldown: 0.12 };
  private stepCooldown = 0;
  /** Times the step assist lifted the car (step.info). */
  steps = 0;
  private lastFwd = 0;
  private stepLocal = { x: 0, y: 0, z: 0 };
  private stepNormal = { x: 0, y: 0, z: 0 };
  private chassis!: RAPIER_NS.Collider;

  constructor(R: R, world: RAPIER_NS.World, pos: V3, heading: number) {
    this.R = R;
    this.world = world;
    this.stickRay = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const yaw = Math.PI - heading;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.005)
      .setAngularDamping(0.4)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(desc);
    this.addChassis();

    const vc = world.createVehicleController(this.body);
    vc.indexUpAxis = 1;
    (vc as any).setIndexForwardAxis = 2;
    for (const p of wheelMounts()) vc.addWheel(p, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, CAR.wheel.rest, CAR.wheel.radius);
    this.controller = vc;
    this.applySuspension();
    // Rapier's own tyre friction is off: it would fight the tyre model.
    for (let i = 0; i < 4; i++) {
      vc.setWheelFrictionSlip(i, 0);
      vc.setWheelSideFrictionStiffness(i, 0);
    }
  }

  private addChassis() {
    const h = CAR.halfExtents;
    const volume = 8 * h.x * h.y * h.z;
    this.chassis = this.world.createCollider(
      this.R.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(0, CAR.colliderY, 0).setDensity(CAR.mass / volume).setFriction(0.3).setRestitution(0.1).setCollisionGroups(CAR_GROUPS),
      this.body,
    );
    // Lower the centre of mass for stability.
    this.body.setAdditionalMassProperties(0, { x: 0, y: -0.25, z: 0.05 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, true);
  }

  /** Takes over a changed CAR (another car picked): chassis box and mass, wheel positions and size, springs. */
  rebuild() {
    this.world.removeCollider(this.chassis, false);
    this.addChassis();
    this.k = chassisConstants();
    const vc = this.controller;
    wheelMounts().forEach((p, i) => {
      vc.setWheelChassisConnectionPointCs(i, p);
      vc.setWheelRadius(i, CAR.wheel.radius);
      vc.setWheelSuspensionRestLength(i, CAR.wheel.rest);
    });
    this.applySuspension();
    const d = this.drivetrain;
    d.gear = Math.min(Math.max(d.gear, 1), ENGINE.gears.length);
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
    if (this.feel.step > 0) this.stepOver(dt);
    this.speed = vc.currentVehicleSpeed();
    const v = this.speed;
    const absV = Math.abs(v);
    let contacts = 0;
    for (let i = 0; i < 4; i++) if (vc.wheelIsInContact(i)) contacts++;
    const wasAirborne = this.airborne;
    this.airborne = contacts === 0;
    this.airTime = this.airborne ? this.airTime + dt : 0;
    // Height climbed on the ground just before take-off: a ramp is a long climb, a bump a short kick.
    const vy0 = this.body.linvel().y;
    if (!this.airborne) this.climb = vy0 > 0.5 ? this.climb + vy0 * dt : vy0 < 0.2 ? 0 : this.climb;
    if (this.airborne && !wasAirborne) this.launched = vy0 > this.stick.hopVy && this.climb > this.stick.rampRise;
    if (wasAirborne && !this.airborne && this.feel.landing > 0) this.land();

    // Speed-sensitive steering: full lock when parking, only a few degrees at motorway speed,
    // and the wheel turns slower the faster the car goes. The handbrake keeps enough lock to drift.
    let maxSteer = maxSteerAngle(absV);
    if (input.handbrake || this.driftDir) maxSteer = Math.max(maxSteer, CAR.steer.drift);
    const sf = this.surface;
    const rate = (CAR.steer.rate * sf.steer) / (1 + absV / CAR.steer.rateSpeed);
    let target = input.steer * maxSteer;
    if (as.steer > 0 && absV > 4 && !input.handbrake && !this.driftDir) {
      // Steering assist: no more lock than puts the front tyres at their peak slip angle (they would
      // only push wide past it). Countersteer is never limited.
      const front = this.wheels.slice(0, 2).filter((w) => w.contact);
      if (front.length) {
        const kin = this.steer - front.reduce((a, w) => a + w.alpha, 0) / front.length;
        const lim = CAR.tyre.peakSlip;
        let capped = target;
        if (target > 0) capped = Math.min(target, Math.max(0, kin + lim));
        else if (target < 0) capped = Math.max(target, Math.min(0, kin - lim));
        target += (capped - target) * as.steer;
      }
    }
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    // Body +x is left, so steering right is a negative angle.
    vc.setWheelSteering(0, -this.steer);
    vc.setWheelSteering(1, -this.steer);

    // Nitro: holding boosts steadily; a short tap fires a burst (a quick kick forward for a share of the tank).
    const bu = this.burst;
    if (input.nitro) this.nitroHeld += dt;
    else {
      if (bu.enabled && this.nitroHeld > 0 && this.nitroHeld < bu.tap && this.nitro > bu.cost * 0.5 && !this.airborne) {
        this.nitro = Math.max(0, this.nitro - bu.cost);
        this.bursting = 0.35;
        const f = rotate(this.body.rotation(), 0, 0, 1);
        const m = this.body.mass() * bu.kick;
        this.body.applyImpulse({ x: f.x * m, y: 0, z: f.z * m }, true);
      }
      this.nitroHeld = 0;
    }
    this.bursting = Math.max(0, this.bursting - dt);
    // Below the tap time the press may still turn into a burst, so the steady boost starts after it.
    const held = !bu.enabled || this.nitroHeld >= bu.tap;
    this.boosting = (input.nitro && held && this.nitro > 0.02 && input.throttle > 0.1) || this.bursting > 0;
    if (this.boosting && this.bursting <= 0) this.nitro = Math.max(0, this.nitro - CAR.nitro.drain * dt);
    else if (!this.boosting) this.nitro = Math.min(1, this.nitro + (this.drifting ? CAR.nitro.driftRefill : CAR.nitro.refill) * dt);
    this.nitro = Math.min(1, this.nitro + this.nitroGain);
    this.nitroGain = 0;

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
      boost: (this.boosting ? CAR.nitro.torque : 1) * this.feel.torque,
      wheelspin: this.wheelspin,
      dt,
    });

    // Suspension only: Rapier's engine, brakes and friction stay at zero.
    vc.updateVehicle(dt);
    this.tyres(input, brake, hold, dt0.force * sf.accel, dt);

    const body = this.body;
    const rot = body.rotation();
    const up = rotate(rot, 0, 1, 0);
    const fwd = rotate(rot, 0, 0, 1);
    const left = rotate(rot, 1, 0, 0);
    const mass = body.mass();
    this.updateDrift(input, absV, dt);
    this.drifting = (input.handbrake && absV > 8) || this.driftDir !== 0;
    if (!this.airborne) {
      // Downforce on each axle, so the aero balance shifts grip between front and rear.
      const df = CAR.aero.downforce * this.feel.downforce * v * v * dt;
      const t = body.translation();
      for (const [z, share] of [[CAR.wheel.front, CAR.aero.balance], [CAR.wheel.rear, 1 - CAR.aero.balance]]) {
        const p = { x: t.x + fwd.x * z, y: t.y + fwd.y * z, z: t.z + fwd.z * z };
        body.applyImpulseAtPoint({ x: -up.x * df * share, y: -up.y * df * share, z: -up.z * df * share }, p, true);
      }
      if (this.feel.stick > 0) this.holdRoad(contacts, absV, mass, dt);
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
          const k = (slip - Math.sign(slip) * cap) * this.k.yaw * 4 * as.esp * dt;
          body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
        }
        // Drift on a button: steer the drift angle towards its target with the throttle and steering.
        const dk = this.driftKit;
        if (this.driftDir && !input.handbrake) {
          const d = this.driftDir;
          const open = clamp(0.4 + 0.4 * input.throttle + 0.35 * (this.steer / CAR.steer.drift) * d, 0.12, 1);
          const target = d * dk.angle * open;
          const rate = (slip - this.lastSlip) / dt;
          const k = (-(target - slip) * 3 + rate * 0.35) * this.k.yaw * dk.hold * dt;
          body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
        }
        this.lastSlip = slip;
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
        // Without the handbrake no more than the tyres can hold (a bit over their grip at this speed), so turn-in does not overshoot.
        const maxYaw = input.handbrake || this.driftDir ? 2.4 : Math.min(1.9, (1.3 * CAR.tyre.mu * 9.81) / Math.max(absV, 1));
        if (Math.abs(yawRate) > maxYaw) {
          const k = -(yawRate - Math.sign(yawRate) * maxYaw) * this.k.yaw * 0.5 * as.esp;
          body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
        }
      }
      // Roll damping (with stability control): kerb strikes and hard turn-ins rock the car but do not tip it over.
      if (as.esp > 0) {
        const w = body.angvel();
        const rollRate = w.x * fwd.x + w.y * fwd.y + w.z * fwd.z;
        const k = -rollRate * this.k.roll * Math.min(1, 8 * as.esp * dt);
        body.applyTorqueImpulse({ x: fwd.x * k, y: fwd.y * k, z: fwd.z * k }, true);
      }
    } else {
      if (this.feel.stick > 0) this.pullDown(mass, dt);
      // Air control: pitch with throttle/brake, yaw with steering.
      const right = rotate(rot, -1, 0, 0);
      const pitch = (input.brake - input.throttle) * CAR.airControl * dt;
      const yaw = -input.steer * CAR.airControl * dt;
      body.applyTorqueImpulse({ x: right.x * pitch + up.x * yaw, y: right.y * pitch + up.y * yaw, z: right.z * pitch + up.z * yaw }, true);
      // Self-levelling: turns the car's up axis back towards the sky (a spring on up × world-up), damped,
      // so jumps end on four wheels. Pitch input still wins while the player holds gas or brake.
      const lv0 = this.feel.airLevel;
      if (lv0 > 0) {
        const ax = -up.z, az = up.x; // up × (0, 1, 0)
        const w = body.angvel();
        const free = 1 - 0.6 * Math.min(1, Math.abs(input.brake - input.throttle));
        const k = this.k.roll * 14 * lv0 * free * dt;
        const d = this.k.roll * 3 * lv0 * free * dt;
        const ww = w.x * up.x + w.y * up.y + w.z * up.z;
        body.applyTorqueImpulse({ x: ax * k - (w.x - up.x * ww) * d, y: -(w.y - up.y * ww) * d, z: az * k - (w.z - up.z * ww) * d }, true);
      }
    }
    if (this.boosting && !this.airborne) {
      const push = CAR.nitro.push * dt;
      body.applyImpulse({ x: fwd.x * push, y: fwd.y * push, z: fwd.z * push }, true);
    }
    // Arcade brakes: extra deceleration past the tyre grip, against the velocity along the road, so the car
    // stops hard without locking or lurching sideways. Fades out just above standstill (no jump into reverse).
    const brakePedal = input.brake > 0 && v > 1 ? input.brake : input.throttle > 0 && v < -1 ? input.throttle : 0;
    // Straight braking: without steering input the yaw rate is damped away, so a camber, a puddle or a kerb
    // under one side does not pull the car round.
    const straight = this.feel.straight;
    if (brakePedal > 0.05 && straight > 0 && contacts >= 2 && Math.abs(input.steer) < 0.1 && !input.handbrake && !this.driftDir) {
      const w = body.angvel();
      const yawRate = w.x * up.x + w.y * up.y + w.z * up.z;
      const k = -yawRate * this.k.yaw * Math.min(1, 10 * straight * brakePedal * dt);
      body.applyTorqueImpulse({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
    }
    let decelG = brakePedal > 0 ? this.feel.brake * brakePedal * sf.brake : 0;
    // Coasting brake: off both pedals the car slows down by itself, harder when it rolls against its gear
    // (backwards in a forward gear after a crash, or forwards in reverse).
    if (this.feel.coast > 0 && input.throttle < 0.05 && input.brake < 0.05 && !input.handbrake && !this.driftDir) {
      const against = (dt0.gear > 0 && v < -1) || (dt0.gear < 0 && v > 1);
      decelG = Math.max(decelG, this.feel.coast * (against ? 3 : 1) * Math.max(sf.brake, 0.5));
    }
    if (decelG > 0 && contacts > 0) {
      const lv = body.linvel();
      const un = lv.x * up.x + lv.y * up.y + lv.z * up.z;
      const px = lv.x - up.x * un, py = lv.y - up.y * un, pz = lv.z - up.z * un;
      const sp = Math.hypot(px, py, pz);
      if (sp > 0.5) {
        const decel = decelG * 9.81 * (contacts / 4) * clamp((sp - 0.5) / 2.5, 0, 1);
        const j = (Math.min(decel * dt, sp - 0.5) * mass) / sp;
        body.applyImpulse({ x: -px * j, y: -py * j, z: -pz * j }, true);
      }
    }
    // Air drag and rolling resistance oppose the velocity.
    const lv = body.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    if (sp > 0.3) {
      const f = (CAR.aero.drag * this.feel.drag * sp * sp + (this.airborne ? 0 : CAR.aero.rolling * mass * 9.81)) * dt;
      body.applyImpulse({ x: (-lv.x / sp) * f, y: (-lv.y / sp) * f, z: (-lv.z / sp) * f }, true);
    }
    // Acceleration in the body frame (from the last step's velocity change).
    const ax = (lv.x - this.lastVel.x) / dt, ay = (lv.y - this.lastVel.y) / dt, az = (lv.z - this.lastVel.z) / dt;
    this.accel.x = ax * left.x + ay * left.y + az * left.z;
    this.accel.y = ax * up.x + ay * up.y + az * up.z;
    this.accel.z = ax * fwd.x + ay * fwd.y + az * fwd.z;
    this.lastVel.x = lv.x; this.lastVel.y = lv.y; this.lastVel.z = lv.z;
    // Speed along the car before the next contact (the step assist gives it back after a snag); a hit lowers it only slowly.
    const fNow = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.lastFwd = Math.abs(fNow) >= Math.abs(this.lastFwd) || Math.sign(fNow) !== Math.sign(this.lastFwd) ? fNow : this.lastFwd + (fNow - this.lastFwd) * Math.min(1, 6 * dt);
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
      const mu = loadedMu(spec, loads[i], this.k.refLoad) * this.wheelGrip[i] * (i >= 2 ? ty.rearMu : 1);
      // The weather's grip, traction and side factors describe the same road, so they do not stack.
      capX[i] = mu * loads[i] * Math.min(sf.grip, sf.traction) * tractionBoost;
      capY[i] = mu * loads[i] * Math.min(sf.grip, sf.side) * (i >= 2 ? this.rearSide : 1);
    }

    // Centre split, then a limited-slip diff per axle.
    const front = splitAxle(drive * CAR.frontDrive, capX[0], capX[1], CAR.diff.front);
    const rear = splitAxle(drive * (1 - CAR.frontDrive), capX[2], capX[3], CAR.diff.rear);
    const drives = [front[0], front[1], rear[0], rear[1]];
    // Traction control: drive beyond the grip is cut (fully at 1, not at all at 0).
    // It also leaves the cornering force its share of the friction circle (from the last step's side force).
    const tcLimit = 1.02 + (1 - as.tcs) * 4;
    for (let i = 0; i < 4; i++) {
      if (drives[i] <= 0) continue;
      const side = capY[i] > 0 ? Math.min(1, Math.abs(this.wheels[i].fy) / capY[i]) : 0;
      const room = 1 - as.tcs + as.tcs * Math.max(0.2, Math.sqrt(1 - side * side));
      drives[i] = Math.min(drives[i], capX[i] * tcLimit * room);
    }
    // Rapier would ignore the brakes on a driven wheel; here drive and brake add up, so drop drive when braking hard.
    if (brake > 500) for (let i = 0; i < 4; i++) drives[i] = Math.min(drives[i], 0);

    let spinRear = 0;
    let max = 0;
    const absV = Math.abs(this.speed);
    // Rough surfaces and kerbs: vertical kicks at the wheels, filtered by the springs into shaking.
    for (let i = 0; i < 4; i++) {
      const rough = this.wheels[i].contact ? this.wheelRumble[i] * clamp(absV / 15, 0, 1) * (Math.random() * 2 - 1) * this.k.refLoad * 0.7 * dt : 0;
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
      // Straight braking: anti-lock holds both wheels of the axle to what the weaker one can take, so the
      // brake forces stay alike left and right (otherwise the side with more load or grip pulls).
      if (abs && this.feel.straight > 0 && wheelBrake > 0) {
        const o = i ^ 1;
        const weak = this.wheels[o].contact ? Math.min(capX[i], capX[o]) : capX[i];
        wheelBrake = Math.min(wheelBrake, lerp(capX[i], weak, this.feel.straight) * 0.97);
      }
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

  /** Starts, holds and ends the button drift (driftKit). */
  private updateDrift(input: DriveInput, absV: number, dt: number) {
    const dk = this.driftKit;
    if (!dk.enabled || this.airborne) { this.driftDir = 0; this.rearSide = 1; return; }
    if (input.handbrake && absV > dk.minSpeed && Math.abs(input.steer) > 0.2 && this.speed > 0) {
      if (!this.driftDir) { this.driftTime = 0; this.driftLow = 0; }
      this.driftDir = Math.sign(input.steer);
    }
    if (this.driftDir) {
      this.driftTime += dt;
      const angle = Math.abs(this.lastSlip);
      this.driftLow = angle < 0.1 ? this.driftLow + dt : 0;
      const off = !input.handbrake && (input.throttle < 0.1 || input.brake > 0.3);
      if (off || absV < dk.minSpeed * 0.6 || (this.driftTime > 0.6 && this.driftLow > 0.4)) this.driftDir = 0;
    }
    // Rear tyres give a little while the drift runs, so it does not grip up on its own.
    const target = this.driftDir && !input.handbrake ? dk.grip : 1;
    this.rearSide += (target - this.rearSide) * Math.min(1, dt * 6);
  }

  /**
   * Step assist (feel.step): when only the lowest part of the body touches fixed geometry in front of (or, reversing,
   * behind) the car, such as a high kerb, a terrain step or a seam in the road mesh, the car is lifted over it and
   * gets back most of the speed the hit took. Walls, rails and traffic touch the body higher up and are left alone.
   */
  private stepOver(dt: number) {
    const body = this.body;
    const st = this.stepAssist;
    const h = CAR.halfExtents;
    const dir = Math.sign(this.lastFwd);
    if (this.stepCooldown > 0) { this.stepCooldown -= dt; return; }
    if (Math.abs(this.lastFwd) < 1) return;
    let top = -Infinity;
    let low = true;
    const p = this.stepLocal, n = this.stepNormal;
    this.world.contactPairsWith(this.chassis, (other) => {
      if (!low) return;
      const parent = other.parent();
      if (parent && !parent.isFixed()) return;
      this.world.contactPair(this.chassis, other, (m, flipped) => {
        const nn = flipped ? m.localNormal2(n) : m.localNormal1(n);
        // The normal points from the body to the obstacle: it has to face the way the car is going.
        if (nn.z * dir < 0.5) return;
        for (let i = 0; i < m.numContacts(); i++) {
          if (m.contactDist(i) > 0.03) continue;
          const c = flipped ? m.localContactPoint2(i, p) : m.localContactPoint1(i, p);
          if (!c) continue;
          const y = c.y + h.y;
          if (y > st.height * this.feel.step) low = false;
          else top = Math.max(top, y);
        }
      });
    });
    if (!low || top === -Infinity) return;
    const rot = body.rotation();
    const up = rotate(rot, 0, 1, 0);
    const fwd = rotate(rot, 0, 0, 1);
    // Up by the height of the edge in one go (the springs take out the jolt), then the speed back.
    const lift = top + 0.03;
    this.stepCooldown = st.cooldown;
    const t = body.translation();
    body.setTranslation({ x: t.x + up.x * lift, y: t.y + up.y * lift, z: t.z + up.z * lift }, true);
    const lv = body.linvel();
    const fv = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const want = this.lastFwd * st.keep * this.feel.step;
    const add = Math.abs(fv) < Math.abs(want) ? want - fv : 0;
    const uv = lv.x * up.x + lv.y * up.y + lv.z * up.z;
    const upCut = Math.max(0, uv);
    body.setLinvel({ x: lv.x + fwd.x * add - up.x * upCut, y: lv.y + fwd.y * add - up.y * upCut, z: lv.z + fwd.z * add - up.z * upCut }, true);
    this.steps++;
  }

  /**
   * Road hold (feel.stick): on the ground the speed away from the road (along the mean contact normal) is
   * taken out, so a bump or a crest does not launch the car; driving up a ramp is along the road and keeps
   * its jump. With a wheel in the air the car is pressed down onto the others.
   */
  private holdRoad(contacts: number, absV: number, mass: number, dt: number) {
    const vc = this.controller;
    const body = this.body;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < 4; i++) {
      if (!vc.wheelIsInContact(i)) continue;
      const n = vc.wheelContactNormal(i);
      if (n) { nx += n.x; ny += n.y; nz += n.z; }
    }
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-3) return;
    nx /= nl; ny /= nl; nz /= nl;
    const st = this.stick;
    const lv = body.linvel();
    const vn = lv.x * nx + lv.y * ny + lv.z * nz;
    if (vn > st.free) {
      const j = (vn - st.free) * (1 - Math.exp(-st.damp * this.feel.stick * dt)) * mass;
      body.applyImpulse({ x: -nx * j, y: -ny * j, z: -nz * j }, true);
    }
    if (contacts < 4 && absV > 5 && lv.y < st.hopVy) {
      const f = st.press * 9.81 * this.feel.stick * mass * clamp((absV - 5) / 10, 0, 1) * dt;
      body.applyImpulse({ x: -nx * f, y: -ny * f, z: -nz * f }, true);
    }
  }

  /**
   * Road hold in the air: just after a hop with the road close below, extra gravity puts the car back on it.
   * A ramp (a climb of more than rampRise ending faster than hopVy upwards) keeps its full jump.
   */
  private pullDown(mass: number, dt: number) {
    const st = this.stick;
    if (this.airTime > st.window || this.launched) return;
    const t = this.body.worldCom();
    this.stickRay.origin = { x: t.x, y: t.y, z: t.z };
    const hit = this.world.castRay(this.stickRay, st.reach, true, undefined, undefined, undefined, this.body);
    if (!hit) return;
    const f = st.gravity * 9.81 * this.feel.stick * mass * dt;
    this.body.applyImpulse({ x: 0, y: -f, z: 0 }, true);
  }

  /** Touch-down after a jump: takes out most of the bounce and the roll/pitch tumble (feel.landing). */
  private land() {
    const k = this.feel.landing;
    const b = this.body;
    const v = b.linvel();
    if (v.y < 0) b.setLinvel({ x: v.x, y: v.y * (1 - 0.7 * k), z: v.z }, true);
    const w = b.angvel();
    const up = rotate(b.rotation(), 0, 1, 0);
    const yaw = w.x * up.x + w.y * up.y + w.z * up.z;
    const keep = 1 - 0.8 * k;
    b.setAngvel({ x: up.x * yaw + (w.x - up.x * yaw) * keep, y: up.y * yaw + (w.y - up.y * yaw) * keep, z: up.z * yaw + (w.z - up.z * yaw) * keep }, true);
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
    this.driftDir = 0;
    this.rearSide = 1;
  }

  /** Takes the car out of the world (rivals after a race). */
  dispose() {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
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
