import * as THREE from 'three';
import { registerCommand, registerToggle, registerValue } from '../debug/registry.ts';

// Photo mode (K3): the game stands still, the HUD goes away and the camera flies freely around the car:
// orbit, distance, height, zoom and tilt, by mouse, keyboard or gamepad. "Kino" lets it circle slowly on its
// own, for showroom shots and short clips. Enter saves the picture as a PNG.

export const PHOTO_HELP = 'Maus ziehen / WASD drehen · Rad / R F Abstand · Q E Höhe · + − Zoom · Z X neigen · Leertaste Kino · Enter speichern · H Hinweis · O / Esc zurück';

export class PhotoMode {
  active = false;
  /** Orbit around the car: yaw (rad, world direction, 0 = camera south of the car), pitch (rad), distance (m), extra height of the target (m). */
  readonly orbit = { yaw: 0.7, pitch: 0.18, dist: 7, lift: 0 };
  /** Vertical field of view in degrees and roll in degrees. */
  fov = 40;
  roll = 0;
  /** Cinematic: circles the car by itself (rad/s). */
  spin = 0;
  spinSpeed = 0.18;
  onToggle?: (on: boolean) => void;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private bar: HTMLDivElement;
  private keys = new Set<string>();
  private drag: { x: number; y: number } | null = null;
  private shot = false;
  private pad: boolean[] = [];

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
    this.bar = document.createElement('div');
    this.bar.id = 'photo-bar';
    this.bar.hidden = true;
    this.bar.textContent = `📷 Fotomodus · ${PHOTO_HELP}`;
    document.body.append(this.bar);
    window.addEventListener('keydown', (e) => this.key(e, true), true);
    window.addEventListener('keyup', (e) => this.key(e, false), true);
    canvas.addEventListener('pointerdown', (e) => { if (this.active) this.drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointerup', () => (this.drag = null));
    window.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.orbit.yaw -= (e.clientX - this.drag.x) * 0.006;
      this.pitchBy((e.clientY - this.drag.y) * 0.005);
      this.drag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('wheel', (e) => { if (this.active) this.distBy(e.deltaY > 0 ? 1.1 : 0.9); }, { passive: true });
  }

  /** Turns photo mode on or off; the yaw starts from the current view so the picture does not jump. */
  toggle(on = !this.active, carPos?: THREE.Vector3) {
    if (on === this.active) return;
    this.active = on;
    this.keys.clear();
    this.drag = null;
    if (on && carPos) {
      const d = this.camera.position.clone().sub(carPos);
      this.orbit.yaw = Math.atan2(d.x, d.z);
      this.orbit.dist = THREE.MathUtils.clamp(Math.hypot(d.x, d.z), 3, 40);
      this.orbit.pitch = THREE.MathUtils.clamp(Math.atan2(d.y - 0.6, Math.hypot(d.x, d.z)), -0.05, 1.4);
    }
    document.body.classList.toggle('photo', on);
    this.bar.hidden = !on;
    if (!on) this.camera.up.set(0, 1, 0);
    this.onToggle?.(on);
  }

  /** Places the camera; call every frame while active, instead of the chase camera. */
  update(dt: number, carPos: THREE.Vector3) {
    this.readPad(dt);
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const o = this.orbit;
    o.yaw += ((k('KeyA') + k('ArrowLeft')) - (k('KeyD') + k('ArrowRight'))) * dt * 1.2 + this.spin * dt;
    this.pitchBy(((k('KeyW') + k('ArrowUp')) - (k('KeyS') + k('ArrowDown'))) * dt * 0.8);
    if (k('KeyR')) this.distBy(1 - dt * 1.2);
    if (k('KeyF')) this.distBy(1 + dt * 1.2);
    o.lift = THREE.MathUtils.clamp(o.lift + (k('KeyE') - k('KeyQ')) * dt * 1.5, -0.5, 4);
    this.fov = THREE.MathUtils.clamp(this.fov + (k('Minus') + k('NumpadSubtract') - k('Equal') - k('NumpadAdd')) * dt * 25, 10, 90);
    this.roll = THREE.MathUtils.clamp(this.roll + (k('KeyX') - k('KeyZ')) * dt * 20, -30, 30);
    const target = new THREE.Vector3(carPos.x, carPos.y + 0.6 + o.lift, carPos.z);
    const cam = this.camera;
    cam.position.set(
      target.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist,
      target.y + Math.sin(o.pitch) * o.dist,
      target.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    cam.rotateZ(THREE.MathUtils.degToRad(this.roll));
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
  }

  /** Asks for a picture of the next rendered frame (call takeShot right after rendering). */
  requestShot() { this.shot = true; }

  /** Saves the frame just rendered, if one was asked for. */
  takeShot() {
    if (!this.shot) return;
    this.shot = false;
    // Called in the same task as the render, so the drawing buffer still holds the frame.
    this.canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const t = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      a.download = `saarlouis-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }

  private pitchBy(d: number) { this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + d, -0.05, 1.4); }
  private distBy(f: number) { this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * f, 2.5, 60); }

  /** Gamepad: right stick orbits, left stick distance and height, shoulders zoom, A saves, B or Start leaves. */
  private readPad(dt: number) {
    const gp = navigator.getGamepads?.().find((g) => g?.connected);
    if (!gp) return;
    const ax = (i: number) => (Math.abs(gp.axes[i] ?? 0) > 0.15 ? gp.axes[i] : 0);
    this.orbit.yaw -= ax(2) * dt * 1.8;
    this.pitchBy(ax(3) * dt * 1.2);
    this.distBy(1 + ax(1) * dt * 1.2);
    this.orbit.lift = THREE.MathUtils.clamp(this.orbit.lift + ((gp.buttons[12]?.pressed ? 1 : 0) - (gp.buttons[13]?.pressed ? 1 : 0)) * dt * 1.5, -0.5, 4);
    this.fov = THREE.MathUtils.clamp(this.fov + ((gp.buttons[6]?.value ?? 0) - (gp.buttons[7]?.value ?? 0)) * dt * 25, 10, 90);
    this.roll = THREE.MathUtils.clamp(this.roll + ((gp.buttons[5]?.pressed ? 1 : 0) - (gp.buttons[4]?.pressed ? 1 : 0)) * dt * 20, -30, 30);
    const pressed = (i: number) => !!gp.buttons[i]?.pressed && !this.pad[i];
    if (pressed(0)) this.requestShot();
    if (pressed(3)) this.spin = this.spin ? 0 : this.spinSpeed;
    if (pressed(1) || pressed(9)) this.toggle(false);
    this.pad = gp.buttons.map((b) => b.pressed);
  }

  private key(e: KeyboardEvent, down: boolean) {
    if (!this.active || e.target instanceof HTMLInputElement) return;
    // The debug console keeps its keys.
    if (e.code === 'F1' || e.code === 'Backquote') return;
    e.preventDefault();
    e.stopPropagation();
    if (!down) { this.keys.delete(e.code); return; }
    if (e.repeat) return;
    this.keys.add(e.code);
    switch (e.code) {
      case 'Enter': case 'NumpadEnter': this.requestShot(); break;
      case 'Space': this.spin = this.spin ? 0 : this.spinSpeed; break;
      case 'KeyH': this.bar.hidden = !this.bar.hidden; break;
      case 'Digit0': this.fov = 40; this.roll = 0; this.orbit.lift = 0; break;
      case 'Escape': case 'KeyO': this.toggle(false); break;
    }
  }

  registerCommands(carPos: () => THREE.Vector3) {
    registerToggle('photo', 'Fotomodus: Spiel hält an, HUD weg, freie Kamera ums Auto (Taste O)', () => this.active, (v) => this.toggle(v, carPos()));
    registerValue('photo.fov', 'Fotomodus: Bildwinkel in Grad (klein = Tele)', () => this.fov, (v) => (this.fov = v), [10, 90]);
    registerValue('photo.roll', 'Fotomodus: Kamera neigen in Grad', () => this.roll, (v) => (this.roll = v), [-30, 30]);
    registerValue('photo.dist', 'Fotomodus: Abstand zum Auto in m', () => this.orbit.dist, (v) => (this.orbit.dist = v), [2.5, 60]);
    registerValue('photo.angle', 'Fotomodus: Winkel der Kamera ums Auto in Grad (Weltrichtung, 0 = Süden)', () => THREE.MathUtils.radToDeg(this.orbit.yaw), (v) => (this.orbit.yaw = THREE.MathUtils.degToRad(v)), [-360, 360]);
    registerValue('photo.spin', 'Fotomodus Kino: Kamera kreist von selbst, in Grad pro Sekunde (0 = aus)', () => THREE.MathUtils.radToDeg(this.spin), (v) => (this.spin = THREE.MathUtils.degToRad(v)), [-60, 60]);
    registerCommand({ name: 'photo.shot', help: 'Fotomodus: Bild als PNG speichern', run: () => {
      if (!this.active) throw new Error('erst den Fotomodus einschalten (photo on)');
      this.requestShot();
      return 'gespeichert';
    } });
  }
}
