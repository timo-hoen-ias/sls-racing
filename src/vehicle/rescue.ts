import { registerCommand, registerToggle, registerValue } from '../debug/registry.ts';
import type { DriveInput } from '../input/input.ts';
import type { Recorder } from '../replay/recorder.ts';
import { type CarPhysics, rotate } from './carPhysics.ts';

// Getting out of trouble: an automatic reset when the car lies on its roof or is wedged, and a rewind that
// puts the car back where it was a few seconds ago (from the replay recording), speed included.

export type RescueReason = 'flip' | 'stuck';

export class Rescue {
  /** Reset automatically when flipped or stuck. */
  auto = true;
  /** Seconds on the roof or side before the reset. */
  flipSeconds = 2;
  /** Seconds of pedal without getting anywhere before the reset. */
  stuckSeconds = 5;
  /** How far one rewind goes back (s). */
  rewindSeconds = 4;
  private flipT = 0;
  private stuckT = 0;
  private anchor = { x: 0, z: 0 };

  /** Call once per frame; returns why the car should be reset now, or null. */
  update(car: CarPhysics, drive: DriveInput, dt: number): RescueReason | null {
    if (!this.auto) { this.clear(car); return null; }
    const up = rotate(car.body.rotation(), 0, 1, 0);
    this.flipT = up.y < 0.35 && Math.abs(car.speed) < 3 ? this.flipT + dt : 0;
    if (this.flipT > this.flipSeconds) { this.clear(car); return 'flip'; }
    // Wedged: the player keeps a pedal down but the car stays within 1.5 m.
    const p = car.body.translation();
    const trying = drive.throttle > 0.3 || drive.brake > 0.3;
    if (!trying || Math.hypot(p.x - this.anchor.x, p.z - this.anchor.z) > 1.5) {
      this.stuckT = 0;
      this.anchor = { x: p.x, z: p.z };
    } else this.stuckT += dt;
    if (this.stuckT > this.stuckSeconds) { this.clear(car); return 'stuck'; }
    return null;
  }

  /** Forget timers (after any reset). */
  clear(car: CarPhysics) {
    const p = car.body.translation();
    this.flipT = this.stuckT = 0;
    this.anchor = { x: p.x, z: p.z };
  }

  /** Puts the car where it was rewindSeconds ago, moving as it was then. False when there is too little recorded. */
  rewind(car: CarPhysics, recorder: Recorder): boolean {
    if (recorder.duration < 0.5) return false;
    const t = Math.max(recorder.firstTime, recorder.lastTime - this.rewindSeconds);
    const s = recorder.at(t);
    const q = { x: s.qx, y: s.qy, z: s.qz, w: s.qw };
    const f = rotate(q, 0, 0, 1);
    car.reset({ x: s.x, y: s.y + 0.05, z: s.z }, Math.atan2(f.x, -f.z));
    car.body.setRotation(q, true);
    car.body.setLinvel({ x: f.x * s.speed, y: f.y * s.speed, z: f.z * s.speed }, true);
    car.nitro = s.nitro;
    recorder.truncate(t);
    this.clear(car);
    return true;
  }
}

export function registerRescueCommands(r: Rescue, rewind: () => string) {
  registerCommand({ name: 'rewind', help: 'Zurückspulen (wie Rücktaste)', run: rewind });
  registerToggle('rescue.auto', 'Automatisch zurücksetzen, wenn das Auto auf dem Dach liegt oder feststeckt', () => r.auto, (v) => { r.auto = v; });
  registerValue('rescue.flip', 'Sekunden auf dem Dach bis zum automatischen Zurücksetzen', () => r.flipSeconds, (v) => { r.flipSeconds = v; }, [0.5, 30]);
  registerValue('rescue.stuck', 'Sekunden mit Gas/Bremse ohne Fortkommen bis zum automatischen Zurücksetzen', () => r.stuckSeconds, (v) => { r.stuckSeconds = v; }, [1, 60]);
  registerValue('rewind.seconds', 'So weit spult Rücktaste/Steuerkreuz links zurück (s)', () => r.rewindSeconds, (v) => { r.rewindSeconds = v; }, [1, 25]);
}
