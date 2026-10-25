import * as THREE from 'three';
import type { Quality } from '../quality.ts';

// Dynamic lights: the car's headlights, tail lights, nitro and backfire glow, and a small pool of
// point lights that follows the street lamps nearest to the car at night. All lights always
// exist (dark when unused), so switching them never recompiles shaders.

export class CarLights {
  readonly heads: THREE.SpotLight[] = [];
  private tail: THREE.PointLight;
  private nitro: THREE.PointLight;
  private flash: THREE.PointLight;
  private flashLevel = 0;

  /** headlights and exhausts in body space, as the car view reports them. */
  constructor(car: THREE.Object3D, headlights: THREE.Vector3[], exhausts: THREE.Vector3[]) {
    for (const p of headlights) {
      const h = new THREE.SpotLight('#fff3e0', 0, 90, 0.5, 0.55, 1.6);
      h.position.copy(p).setZ(p.z + 0.1);
      h.target.position.set(p.x * 1.5, p.y - 0.9, p.z + 22);
      car.add(h, h.target);
      this.heads.push(h);
    }
    const rear = exhausts.reduce((a, e) => a.add(e), new THREE.Vector3()).divideScalar(Math.max(1, exhausts.length));
    this.tail = new THREE.PointLight('#ff2a1a', 0, 9, 2);
    this.tail.position.set(0, rear.y + 0.4, rear.z - 0.3);
    this.nitro = new THREE.PointLight('#5ab8ff', 0, 14, 2);
    this.nitro.position.copy(rear).setZ(rear.z - 0.7);
    this.flash = new THREE.PointLight('#ff9a40', 0, 12, 2);
    this.flash.position.copy(rear).setZ(rear.z - 0.5);
    car.add(this.tail, this.nitro, this.flash);
  }

  /** Orange flash from an overrun pop. */
  backfire() {
    this.flashLevel = 1;
  }

  update(night: number, braking: boolean, boosting: boolean, dt: number) {
    // Low beams switch on at dusk.
    const on = THREE.MathUtils.smoothstep(night, 0.35, 0.6);
    for (const h of this.heads) h.intensity = 380 * on;
    this.tail.intensity = (braking ? 10 : 1.5) * Math.max(on, braking ? 0.4 : 0);
    this.nitro.intensity = boosting ? 35 * (0.75 + Math.random() * 0.5) : 0;
    this.flashLevel = Math.max(0, this.flashLevel - dt * 14);
    this.flash.intensity = 70 * this.flashLevel;
  }
}

export class LampLights {
  readonly root = new THREE.Group();
  readonly pool: THREE.PointLight[] = [];
  private headMat: THREE.MeshStandardMaterial;
  private timer = 0;
  private near: { x: number; y: number; z: number; d: number }[] = [];
  private cutoff = 1;

  constructor(q: Quality, headMat: THREE.MeshStandardMaterial) {
    this.headMat = headMat;
    const n = q.name === 'hoch' ? 10 : q.name === 'mittel' ? 6 : 0;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight('#ffc98a', 0, 30, 2);
      this.pool.push(l);
      this.root.add(l);
    }
  }

  /**
   * forEachLamp lists lamp heads; (x, z) is a point just ahead of the car. `lit` is how strongly the pool shines
   * (the night, or a tunnel's lights by day); the street lamp heads always follow the night.
   */
  update(night: number, x: number, z: number, forEachLamp: (fn: (x: number, y: number, z: number) => void) => void, dt: number, lit = night) {
    this.headMat.emissiveIntensity = THREE.MathUtils.lerp(0.4, 30, night);
    if (!this.pool.length) return;
    if (lit < 0.05) {
      for (const l of this.pool) l.intensity = 0;
      return;
    }
    if ((this.timer -= dt) <= 0) {
      this.timer = 0.15;
      const all: { x: number; y: number; z: number; d: number }[] = [];
      forEachLamp((lx, ly, lz) => {
        const d = Math.hypot(lx - x, lz - z);
        if (d < 120) all.push({ x: lx, y: ly, z: lz, d });
      });
      all.sort((a, b) => a.d - b.d);
      this.near = all.slice(0, this.pool.length);
      // Lights fade out before the next lamp takes their slot, so nothing pops.
      this.cutoff = all[this.pool.length]?.d ?? 120;
    }
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i];
      const p = this.near[i];
      if (!p) { l.intensity = 0; continue; }
      l.position.set(p.x, p.y - 0.3, p.z);
      const d = Math.hypot(p.x - x, p.z - z);
      l.intensity = 160 * lit * (1 - THREE.MathUtils.smoothstep(d, this.cutoff * 0.7, this.cutoff));
    }
  }
}
