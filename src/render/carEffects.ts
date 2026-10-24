import * as THREE from 'three';
import type { Quality } from '../quality.ts';
import type { CarPhysics } from '../vehicle/carPhysics.ts';
import { CAR } from '../vehicle/tuning.ts';
import { Particles } from './particles.ts';
import { type SkidPoint, SkidMarks } from './skidMarks.ts';

// Tyre marks, tyre smoke, impact sparks, exhaust backfires and nitro exhaust for the player car.

/** Shortest segment (m) and the gap (m) after which a new mark starts. */
const SEG_MIN = 0.35;
const SEG_BREAK = 3;
/** Marks sit this far above the road along its normal (plus polygon offset). */
const LIFT = 0.025;
/** Slip from which a wheel leaves a mark / smokes. */
const MARK_FROM = 0.18;
const SMOKE_FROM = 0.35;

interface WheelTrail {
  active: boolean;
  p: SkidPoint;
  spare: SkidPoint;
  x: number; y: number; z: number;
  smokeAcc: number;
}

const point = (): SkidPoint => ({ lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, along: 0, alpha: 0 });
const tmp = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export class CarEffects {
  readonly root = new THREE.Group();
  private marks: SkidMarks;
  private particles: Particles;
  private trails: WheelTrail[] = [0, 1, 2, 3].map(() => ({ active: false, p: point(), spare: point(), x: 0, y: 0, z: 0, smokeAcc: 0 }));
  private smokeRate: number;
  private nitroAcc = 0;

  private exhausts: THREE.Vector3[];

  /** exhausts: tailpipe ends in body space. */
  constructor(q: Quality, exhausts: THREE.Vector3[]) {
    this.exhausts = exhausts;
    this.marks = new SkidMarks(q.effects.skids);
    this.particles = new Particles(q.effects.particles);
    this.smokeRate = 30 * q.effects.particles;
    this.root.add(this.marks.mesh, this.particles.root);
  }

  update(car: CarPhysics, pos: THREE.Vector3, quat: THREE.Quaternion, dt: number, time: number, camera: THREE.PerspectiveCamera, viewHeight: number) {
    this.marks.begin(time);
    const lv = car.body.linvel();
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const tr = this.trails[i];
      if (!w.contact || w.slip < MARK_FROM) {
        tr.active = false;
        tr.smokeAcc = 0;
        continue;
      }
      const n = w.n;
      const px = w.p.x + n.x * LIFT;
      const py = w.p.y + n.y * LIFT;
      const pz = w.p.z + n.z * LIFT;
      const dx = px - tr.x, dy = py - tr.y, dz = pz - tr.z;
      const dist = Math.hypot(dx, dy, dz);

      // Smoke from heavy slip: more at speed and with wheelspin.
      if (w.slip > SMOKE_FROM) {
        tr.smokeAcc += dt * this.smokeRate * (w.slip - SMOKE_FROM) * 1.6;
        while (tr.smokeAcc >= 1) {
          tr.smokeAcc -= 1;
          const spread = 0.6;
          this.particles.emit('smoke', {
            x: w.p.x + (Math.random() - 0.5) * 0.3,
            y: w.p.y + 0.15,
            z: w.p.z + (Math.random() - 0.5) * 0.3,
            vx: lv.x * 0.25 + (Math.random() - 0.5) * spread,
            vy: 0.6 + Math.random() * 0.8,
            vz: lv.z * 0.25 + (Math.random() - 0.5) * spread,
            life: 1.6 + Math.random() * 1.6,
            size: 0.7 + Math.random() * 0.4,
            grow: 5 + Math.random() * 2,
            color: '#cfd2d6',
            gravity: -0.25,
            drag: 1.4,
            alpha: 0.32 * Math.min(1, w.slip * 1.2),
          });
        }
      }

      if (tr.active && dist < SEG_MIN) continue;
      // Across the mark: travel direction × road normal.
      let fx = 0, fy = 0, fz = 1;
      if (tr.active && dist > 0.05) {
        fx = dx / dist; fy = dy / dist; fz = dz / dist;
      } else {
        tmp.set(0, 0, 1).applyQuaternion(quat);
        fx = tmp.x; fy = tmp.y; fz = tmp.z;
      }
      let sx = fy * n.z - fz * n.y;
      let sy = fz * n.x - fx * n.z;
      let sz = fx * n.y - fy * n.x;
      const sl = Math.hypot(sx, sy, sz) || 1;
      // A sideways-sliding tyre leaves a wider smear than a spinning one.
      const half = (CAR.wheel.width / 2) * (1 + Math.min(0.6, w.lateral / 12));
      sx = (sx / sl) * half; sy = (sy / sl) * half; sz = (sz / sl) * half;
      const cur = tr.spare;
      cur.lx = px - sx; cur.ly = py - sy; cur.lz = pz - sz;
      cur.rx = px + sx; cur.ry = py + sy; cur.rz = pz + sz;
      cur.along = tr.p.along + (tr.active ? dist : 0);
      cur.alpha = Math.min(0.85, 0.25 + w.slip * 0.7);
      if (tr.active && dist < SEG_BREAK + Math.abs(car.speed) * dt * 2) this.marks.segment(tr.p, cur, time);
      else cur.alpha = 0; // start of a mark: fade in
      tr.spare = tr.p;
      tr.p = cur;
      tr.x = px; tr.y = py; tr.z = pz;
      tr.active = true;
    }
    this.marks.end();

    // Nitro: blue-white exhaust flame particles.
    if (car.boosting) {
      this.nitroAcc += dt * 70;
      while (this.nitroAcc >= 1) {
        this.nitroAcc -= 1;
        this.exhaust(pos, quat, lv, Math.floor(Math.random() * this.exhausts.length), '#6fc4ff', 0.35, 0.12 + Math.random() * 0.08);
      }
    }
    this.particles.update(Math.min(dt, 0.05), viewHeight, camera.fov);
  }

  /** Orange flame burst from the tailpipes (overrun pops). */
  backfire(pos: THREE.Vector3, quat: THREE.Quaternion, lv: { x: number; y: number; z: number }) {
    for (let e = 0; e < this.exhausts.length; e++) for (let k = 0; k < 5; k++) this.exhaust(pos, quat, lv, e, k < 2 ? '#fff1b0' : '#ff8a2a', 0.28, 0.08 + Math.random() * 0.06);
  }

  /** Sparks and a puff of dust at a hit; strength 0..1. */
  impact(at: { x: number; y: number; z: number }, strength: number) {
    const n = Math.round(10 + 40 * strength);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 9 * strength;
      this.particles.emit('glow', {
        x: at.x, y: at.y, z: at.z,
        vx: Math.cos(a) * sp, vy: 1.5 + Math.random() * 4, vz: Math.sin(a) * sp,
        life: 0.3 + Math.random() * 0.5,
        size: 0.12 + Math.random() * 0.08,
        color: Math.random() < 0.5 ? '#ffd27a' : '#ff9a3c',
        gravity: 9.81,
        drag: 0.8,
      });
    }
    for (let i = 0; i < 6 * strength; i++) {
      this.particles.emit('smoke', {
        x: at.x, y: at.y, z: at.z,
        vx: (Math.random() - 0.5) * 2, vy: 0.5 + Math.random(), vz: (Math.random() - 0.5) * 2,
        life: 1.2 + Math.random(), size: 0.8, grow: 3, color: '#b9b4aa', gravity: -0.2, drag: 1.5, alpha: 0.3,
      });
    }
  }

  private exhaust(pos: THREE.Vector3, quat: THREE.Quaternion, lv: { x: number; y: number; z: number }, pipe: number, color: string, size: number, life: number) {
    tmp.copy(this.exhausts[pipe]).applyQuaternion(quat).add(pos);
    tmpQ.copy(quat);
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQ);
    const sp = 6 + Math.random() * 4;
    this.particles.emit('glow', {
      x: tmp.x, y: tmp.y, z: tmp.z,
      vx: lv.x + back.x * sp + (Math.random() - 0.5), vy: lv.y + back.y * sp + Math.random() * 0.5, vz: lv.z + back.z * sp + (Math.random() - 0.5),
      life, size, grow: 0.4, color, drag: 3,
    });
  }
}
