import * as THREE from 'three';

export type CamMode = 'chase' | 'far' | 'hood' | 'cockpit';
const MODES: CamMode[] = ['chase', 'far', 'hood', 'cockpit'];
/** Driver's eye in body space (left-hand drive: +x is left). */
const EYE = new THREE.Vector3(0.37, 0.69, -0.46);
const UP = new THREE.Vector3(0, 1, 0);

/** Third-person camera with speed feel: wider FOV and a little shake when fast or boosting. */
export class ChaseCamera {
  mode: CamMode = 'chase';
  /** Showroom view (cam.orbit): fixed angle around the car in rad (0 = behind, π = in front), or null. */
  orbit: number | null = null;
  /**
   * Vertical field of view at standstill (cam.basefov; the options offset cam.fov adds to it), chase/far/hood and cockpit. Three.js FOV is vertical:
   * 52° is about 82° horizontal on 16:9. Wider angles push the road away and make it look narrow.
   */
  fov = { chase: 52, cockpit: 58 };
  /** Cockpit head movement from g-forces, 0..1. */
  headbob = 1;
  /** Options menu: added to the base field of view (this.fov) in degrees (cam.fov). */
  fovOffset = 0;
  /** Options menu: how much speed and nitro widen the view, 0..2 (cam.speedfov). */
  speedFov = 1;
  /** Options menu: camera shake at high speed and under nitro, 0..2 (cam.shake). */
  shake = 1;
  /** Body-frame acceleration (m/s², x = left, z = forward), steering and yaw rate (rad/s, + = left), set each frame. */
  motion = { ax: 0, az: 0, steer: 0, yaw: 0 };
  /**
   * Chase view feel (cam.style arcade|ruhig, cam.lag, cam.swing, cam.height): how far the camera drops back
   * under acceleration, how much it swings out and looks into corners, and its height above the road.
   */
  feel = { lag: 1, swing: 1, height: 1.8, dist: 5.8, speedFov: 0.06, boostFov: 9, maxKmh: 280 };
  private lag = 0;
  private swingAngle = 0;
  private head = new THREE.Vector3();
  private headVel = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private initialised = false;
  /** Current swing around the car (rad): 0 = behind, π = in front looking back. */
  private yaw = 0;
  private wasLookBack = false;
  private camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  private showroom(carPos: THREE.Vector3, carQuat: THREE.Quaternion) {
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat).setY(0).normalize().applyAxisAngle(UP, this.orbit!);
    this.camera.position.copy(carPos).addScaledVector(dir, -5.8).add(new THREE.Vector3(0, 1.3, 0));
    this.camera.lookAt(carPos.x, carPos.y + 0.3, carPos.z);
    this.camera.fov = 45;
    this.camera.updateProjectionMatrix();
    this.initialised = false;
  }

  /** Jump straight to the resting position behind the car on the next update (after teleports and resets), instead of gliding there. */
  snap() {
    this.initialised = false;
    this.yaw = 0;
    this.head.set(0, 0, 0);
    this.headVel.set(0, 0, 0);
  }

  next() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
  }

  /**
   * reversing: swings the camera round to look where the car is going.
   * lookBack: held button, snaps to a rear view at once.
   */
  update(carPos: THREE.Vector3, carQuat: THREE.Quaternion, speed: number, boosting: boolean, dt: number, reversing = false, lookBack = false) {
    this.camera.near = this.mode === 'cockpit' ? 0.04 : 0.3;
    if (this.orbit !== null) { this.showroom(carPos, carQuat); return; }
    if (this.mode === 'cockpit') { this.cockpit(carPos, carQuat, speed, dt, lookBack); return; }
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    fwd.y *= 0.3;
    fwd.normalize();
    const want = reversing !== lookBack ? Math.PI : 0;
    if (lookBack !== this.wasLookBack) {
      this.yaw = want;
      this.initialised = false;
      this.wasLookBack = lookBack;
    } else {
      this.yaw += (want - this.yaw) * (1 - Math.exp(-dt * 3));
    }
    if (Math.abs(this.yaw) > 1e-4) fwd.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const kmh = Math.abs(speed) * 3.6;
    let desired: THREE.Vector3;
    let target: THREE.Vector3;
    if (this.mode === 'hood') {
      desired = carPos.clone().addScaledVector(fwd, 0.6).add(new THREE.Vector3(0, 1.25, 0));
      target = carPos.clone().addScaledVector(fwd, 20).add(new THREE.Vector3(0, 1.0, 0));
    } else {
      const far = this.mode === 'far';
      const fe = this.feel;
      // Drops back when accelerating (more under nitro), closes in when braking.
      const lagTarget = Math.max(-1, Math.min(1.6, this.motion.az * 0.07 + (boosting ? 0.8 : 0))) * fe.lag;
      this.lag += (lagTarget - this.lag) * (1 - Math.exp(-dt * 2.5));
      const dist = (far ? 9 : fe.dist) + Math.min(kmh, 220) * 0.01 + this.lag;
      // Swings out of the corner a little, so the camera looks into the turn.
      const swingTarget = Math.max(-0.35, Math.min(0.35, this.motion.yaw * 0.22)) * fe.swing * Math.min(1, kmh / 40);
      this.swingAngle += (swingTarget - this.swingAngle) * (1 - Math.exp(-dt * 3));
      const back = fwd.clone().applyAxisAngle(UP, -this.swingAngle);
      desired = carPos.clone().addScaledVector(back, -dist).add(new THREE.Vector3(0, far ? 3.2 : fe.height, 0));
      target = carPos.clone().addScaledVector(fwd, 4 + Math.min(kmh, 200) * 0.01).add(new THREE.Vector3(0, 1.0, 0));
    }
    if (!this.initialised) {
      this.pos.copy(desired);
      this.look.copy(target);
      this.initialised = true;
    }
    const k = this.mode === 'hood' ? 1 : 1 - Math.exp(-dt * 7);
    this.pos.lerp(desired, k);
    this.look.lerp(target, 1 - Math.exp(-dt * 12));
    this.camera.position.copy(this.pos);
    if (boosting || kmh > 150) {
      const s = ((boosting ? 0.05 : 0) + Math.max(0, kmh - 150) * 0.0004) * this.shake;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, 0));
    }
    this.camera.lookAt(this.look);
    const fov = this.fov.chase + this.fovOffset + (Math.min(kmh, this.feel.maxKmh) * this.feel.speedFov + (boosting ? this.feel.boostFov : 0)) * this.speedFov;
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 4));
    this.camera.updateProjectionMatrix();
  }

  /** Driver's view: the head sways against the g-forces on a soft spring and looks a little into corners. */
  private cockpit(carPos: THREE.Vector3, carQuat: THREE.Quaternion, speed: number, dt: number, lookBack: boolean) {
    const k = this.headbob;
    const m = this.motion;
    // Target offset: pushed outwards in corners, forwards under braking, back under acceleration (≈ 1.2 cm per m/s²).
    const target = new THREE.Vector3(-m.ax * 0.012 * k, 0, -m.az * 0.01 * k).clampLength(0, 0.12);
    // Spring-damper (≈ 2.5 Hz, slightly underdamped) so the head lags and settles like a neck.
    const w = 16, z = 0.7;
    const h = Math.min(dt, 0.05);
    this.headVel.addScaledVector(new THREE.Vector3().subVectors(target, this.head), w * w * h).multiplyScalar(Math.max(0, 1 - 2 * z * w * h));
    this.head.addScaledVector(this.headVel, h);
    const eye = EYE.clone().add(this.head).applyQuaternion(carQuat).add(carPos);
    this.camera.position.copy(eye);
    // Camera looks down -z; the car's forward is +z: turn round, then look into the corner and tilt with the head.
    const look = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI + (lookBack ? Math.PI : 0) + m.steer * 0.35 * k);
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.head.z * 0.6, 0, this.head.x * 1.2));
    this.camera.quaternion.copy(carQuat).multiply(look).multiply(tilt);
    const fov = this.fov.cockpit + this.fovOffset + Math.min(Math.abs(speed) * 3.6, 250) * 0.02 * this.speedFov;
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 4));
    this.camera.updateProjectionMatrix();
    this.initialised = false;
  }
}
