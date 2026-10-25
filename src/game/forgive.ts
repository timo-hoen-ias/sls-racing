import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { registerToggle, registerValue } from '../debug/registry.ts';

// Forgiving collisions: when the car scrapes along a wall, a guard rail or a house at a shallow angle, it
// glides along instead of bouncing off and stopping. Runs after each physics step on the velocity change
// the step caused; head-on hits stay hard.

type V3 = { x: number; y: number; z: number };

export class WallGlide {
  enabled = true;
  /** Share of the speed along the wall the car keeps (forgive.keep). */
  keep = 0.92;
  /** Widest angle to the wall (degrees) that still counts as glancing (forgive.angle). */
  angle = 50;
  /** Glancing hits so far (forgive.info via the console). */
  count = 0;

  /**
   * before: velocity before the step. Returns true when it changed the car's velocity.
   * A glancing hit keeps most of the speed along the wall and a small push away from it; spin is damped.
   */
  apply(body: RAPIER_NS.RigidBody, before: V3): boolean {
    if (!this.enabled) return false;
    const after = body.linvel();
    const dx = after.x - before.x, dz = after.z - before.z;
    const dv = Math.hypot(dx, dz);
    if (dv < 3) return false;
    // The wall's normal points along the push the step gave the car.
    const nx = dx / dv, nz = dz / dv;
    const into = -(before.x * nx + before.z * nz);
    if (into <= 0) return false;
    const tx = before.x + nx * into, tz = before.z + nz * into;
    const along = Math.hypot(tx, tz);
    // Glancing: the angle between the path and the wall is small.
    const deg = (Math.atan2(into, along) * 180) / Math.PI;
    if (deg > this.angle || along < 4) return false;
    const away = Math.min(2.5, into * 0.3);
    body.setLinvel({ x: tx * this.keep + nx * away, y: after.y, z: tz * this.keep + nz * away }, true);
    const w = body.angvel();
    body.setAngvel({ x: w.x * 0.6, y: w.y * 0.45, z: w.z * 0.6 }, true);
    this.count++;
    return true;
  }

  registerCommands() {
    registerToggle('forgive', 'An Wänden und Planken entlanggleiten statt abzuprallen (streifende Treffer)', () => this.enabled, (v) => { this.enabled = v; });
    registerValue('forgive.keep', 'Anteil des Tempos entlang der Wand, den das Auto behält 0..1', () => this.keep, (v) => { this.keep = v; }, [0, 1]);
    registerValue('forgive.angle', 'Bis zu diesem Winkel (Grad) zur Wand zählt ein Treffer als streifend', () => this.angle, (v) => { this.angle = v; }, [5, 85]);
  }
}
