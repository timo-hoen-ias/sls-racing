import * as THREE from 'three';

type Mode = 'chase' | 'far' | 'hood';
const MODES: Mode[] = ['chase', 'far', 'hood'];

/** Third-person camera with speed feel: wider FOV and a little shake when fast or boosting. */
export class ChaseCamera {
  mode: Mode = 'chase';
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

  next() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
  }

  /**
   * reversing: swings the camera round to look where the car is going.
   * lookBack: held button, snaps to a rear view at once.
   */
  update(carPos: THREE.Vector3, carQuat: THREE.Quaternion, speed: number, boosting: boolean, dt: number, reversing = false, lookBack = false) {
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
      const dist = (far ? 9 : 6) + Math.min(kmh, 200) * 0.012;
      desired = carPos.clone().addScaledVector(fwd, -dist).add(new THREE.Vector3(0, far ? 3.2 : 2.1, 0));
      target = carPos.clone().addScaledVector(fwd, 4).add(new THREE.Vector3(0, 1.1, 0));
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
      const s = (boosting ? 0.05 : 0) + Math.max(0, kmh - 150) * 0.0004;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, 0));
    }
    this.camera.lookAt(this.look);
    const fov = 62 + Math.min(kmh, 220) * 0.07 + (boosting ? 8 : 0);
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 4));
    this.camera.updateProjectionMatrix();
  }
}
