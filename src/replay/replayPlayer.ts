import * as THREE from 'three';
import type { ChaseCamera } from '../render/chaseCamera.ts';
import type { Recorder, Sample } from './recorder.ts';

// Plays back the recorder: pause, seek, speed, and three cameras (chase, trackside TV, free orbit).
// The physics is held while it runs; the car carries on where it was afterwards.

export type ReplayCam = 'chase' | 'tv' | 'free';
const CAMS: ReplayCam[] = ['chase', 'tv', 'free'];
const CAM_NAME: Record<ReplayCam, string> = { chase: 'Verfolger', tv: 'TV', free: 'Frei' };

export class ReplayPlayer {
  active = false;
  playing = true;
  speed = 1;
  cam: ReplayCam = 'tv';
  t = 0;
  readonly sample = {} as Sample;
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  /** Called when the player leaves the replay (Esc). */
  onEnd?: () => void;
  private rec: Recorder;
  private camera: THREE.PerspectiveCamera;
  private chase: ChaseCamera;
  private bar: HTMLDivElement;
  private tvPos = new THREE.Vector3();
  private tvSet = false;
  private orbit = { yaw: 0.6, pitch: 0.35, dist: 9 };
  private drag: { x: number; y: number } | null = null;
  private prev = new THREE.Vector3();

  constructor(rec: Recorder, camera: THREE.PerspectiveCamera, chase: ChaseCamera, canvas: HTMLElement) {
    this.rec = rec;
    this.camera = camera;
    this.chase = chase;
    this.bar = document.createElement('div');
    this.bar.hidden = true;
    this.bar.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:40;font:13px/1.4 system-ui,sans-serif;color:#fff;background:#000b;padding:6px 12px;border-radius:6px;white-space:nowrap;pointer-events:none';
    document.body.append(this.bar);
    window.addEventListener('keydown', (e) => this.key(e), true);
    canvas.addEventListener('pointerdown', (e) => { if (this.active && this.cam === 'free') this.drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointerup', () => (this.drag = null));
    window.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.orbit.yaw -= (e.clientX - this.drag.x) * 0.006;
      this.orbit.pitch = Math.min(1.4, Math.max(-0.1, this.orbit.pitch + (e.clientY - this.drag.y) * 0.005));
      this.drag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('wheel', (e) => { if (this.active && this.cam === 'free') this.orbit.dist = Math.min(60, Math.max(3, this.orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: true });
  }

  start(): string {
    if (this.rec.duration < 1) throw new Error('noch nichts aufgezeichnet');
    this.active = true;
    this.playing = true;
    this.rec.enabled = false;
    this.t = this.rec.firstTime;
    this.tvSet = false;
    this.bar.hidden = false;
    return `Replay: ${this.rec.duration.toFixed(1)} s · Leertaste Pause · ←/→ spulen · 1–3 Kamera · +/− Tempo · Esc Ende`;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.rec.enabled = true;
    this.bar.hidden = true;
    this.onEnd?.();
  }

  /** Advances the playback and places the camera. Returns the current sample. */
  update(dt: number): Sample {
    const r = this.rec;
    if (this.playing) this.t += dt * this.speed;
    if (this.t > r.lastTime) this.t = r.firstTime; // loop
    if (this.t < r.firstTime) this.t = r.firstTime;
    const s = r.at(this.t, this.sample);
    this.prev.copy(this.pos);
    this.pos.set(s.x, s.y, s.z);
    this.quat.set(s.qx, s.qy, s.qz, s.qw);
    this.placeCamera(s, dt);
    const rel = this.t - r.firstTime;
    this.bar.textContent = `${this.playing ? '▶' : '❚❚'} REPLAY ${rel.toFixed(1)} / ${r.duration.toFixed(1)} s · ×${this.speed} · Kamera ${CAM_NAME[this.cam]} · ${(Math.abs(s.speed) * 3.6).toFixed(0)} km/h`;
    return s;
  }

  private placeCamera(s: Sample, dt: number) {
    const cam = this.camera;
    if (this.cam === 'chase') {
      this.chase.update(this.pos, this.quat, s.speed, s.boost > 0.5, dt);
      return;
    }
    if (this.cam === 'free') {
      const o = this.orbit;
      cam.position.set(
        this.pos.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist,
        this.pos.y + 0.6 + Math.sin(o.pitch) * o.dist,
        this.pos.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist,
      );
      cam.lookAt(this.pos.x, this.pos.y + 0.6, this.pos.z);
      cam.fov = 55;
      cam.updateProjectionMatrix();
      return;
    }
    // Trackside TV camera: stands ahead beside the path, follows with a long lens, moves on once passed.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat).setY(0).normalize();
    const away = this.tvPos.distanceTo(this.pos);
    const behind = new THREE.Vector3().subVectors(this.tvPos, this.pos).dot(fwd) < -25;
    if (!this.tvSet || away > 70 || behind) {
      const side = new THREE.Vector3(fwd.z, 0, -fwd.x).multiplyScalar(Math.random() < 0.5 ? 7 : -7);
      const ahead = 25 + Math.min(40, Math.abs(s.speed) * 1.2);
      this.tvPos.copy(this.pos).addScaledVector(fwd, ahead).add(side).add(new THREE.Vector3(0, 1.4 + Math.random() * 2, 0));
      this.tvSet = true;
    }
    cam.position.copy(this.tvPos);
    cam.lookAt(this.pos.x, this.pos.y + 0.5, this.pos.z);
    cam.fov = THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan(4 / Math.max(1, away))), 12, 60);
    cam.updateProjectionMatrix();
  }

  private key(e: KeyboardEvent) {
    if (!this.active) return;
    const used = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.code) {
      case 'Space': this.playing = !this.playing; used(); break;
      case 'ArrowLeft': this.t -= 2; used(); break;
      case 'ArrowRight': this.t += 2; used(); break;
      case 'Digit1': case 'Digit2': case 'Digit3': this.cam = CAMS[Number(e.code.slice(5)) - 1]; this.tvSet = false; used(); break;
      case 'Equal': case 'NumpadAdd': this.speed = Math.min(4, this.speed * 2); used(); break;
      case 'Minus': case 'NumpadSubtract': this.speed = Math.max(0.125, this.speed / 2); used(); break;
      case 'Escape': case 'Enter': this.stop(); used(); break;
      default: // swallow driving keys while the replay runs
        if (/^(Key[WASDQEGBRCM]|Arrow|Shift)/.test(e.code)) used();
    }
  }

  get camNames() { return CAMS; }
}
