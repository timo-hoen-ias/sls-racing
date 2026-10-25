// Expansion joints at both ends of every bridge deck (public/tiles/bridges.json): driving over one gives the
// "klack-klack" of the front and then the rear axle. Only a sound; the road surface has no step there.
import { parseNum, registerCommand, registerToggle } from '../debug/registry.ts';
import { type WorldInfo, utmToLocal } from '../world/format.ts';

interface Joint {
  /** Bridge way. */
  id: number;
  name?: string;
  x: number;
  y: number;
  z: number;
  /** Unit direction along the road, local x/z. */
  dx: number;
  dz: number;
  halfWidth: number;
}

/** Distance between the axles, for the second click (m). */
const WHEELBASE = 2.6;
/** Joints further than this (m) are not checked each frame. */
const NEAR = 40;

export class BridgeJoints {
  readonly joints: Joint[];
  enabled = true;
  /** Plays one axle crossing a joint, strength 0..1 by speed. */
  onClick?: (strength: number) => void;
  /** Last signed distance along each joint's road, to see the car cross it. */
  private side = new Map<Joint, number>();
  private pending: { t: number; k: number }[] = [];
  private clock = 0;
  crossings = 0;

  constructor(joints: Joint[]) {
    this.joints = joints;
    this.registerCommands();
  }

  static async fetch(tilesUrl: string, world: WorldInfo) {
    const res = await fetch(`${tilesUrl}/bridges.json`).catch(() => undefined);
    const data = res?.ok ? ((await res.json()) as { bridges: { id: number; name?: string; halfWidth: number; pts: number[] }[] }) : { bridges: [] };
    const joints: Joint[] = [];
    for (const b of data.bridges) {
      const p = b.pts;
      const n = p.length / 3;
      if (n < 2) continue;
      // Each end, with the direction pointing onto the bridge.
      for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
        const [x, z] = utmToLocal(world, p[i * 3], p[i * 3 + 1]);
        const [x2, z2] = utmToLocal(world, p[j * 3], p[j * 3 + 1]);
        const l = Math.hypot(x2 - x, z2 - z) || 1;
        joints.push({ id: b.id, name: b.name, x, y: p[i * 3 + 2], z, dx: (x2 - x) / l, dz: (z2 - z) / l, halfWidth: b.halfWidth });
      }
    }
    return new BridgeJoints(joints);
  }

  /** Car centre and speed (m/s); call once per frame. */
  update(dt: number, x: number, y: number, z: number, speed: number) {
    this.clock += dt;
    while (this.pending.length && this.pending[0].t <= this.clock) this.onClick?.(this.pending.shift()!.k);
    const v = Math.abs(speed);
    for (const j of this.joints) {
      const rx = x - j.x, rz = z - j.z;
      if (Math.abs(rx) > NEAR || Math.abs(rz) > NEAR) { this.side.delete(j); continue; }
      const along = rx * j.dx + rz * j.dz;
      const across = Math.abs(rx * j.dz - rz * j.dx);
      const before = this.side.get(j);
      this.side.set(j, along);
      // Crossed the joint line on the deck (not on a road below or beside it).
      if (before === undefined || (before < 0) === (along < 0) || across > j.halfWidth || Math.abs(y - j.y) > 2.5) continue;
      if (!this.enabled || v < 2) continue;
      this.crossings++;
      const k = Math.min(1, 0.25 + v / 40);
      this.onClick?.(k);
      this.pending.push({ t: this.clock + WHEELBASE / v, k: k * 0.9 });
    }
  }

  private registerCommands() {
    registerToggle('bridge.joints', 'Dehnfugen-Geräusch an Brückenenden an/aus', () => this.enabled, (v) => { this.enabled = v; });
    registerCommand({
      name: 'bridge.joint',
      help: 'Dehnfuge abspielen (Stärke 0..1) oder ohne Argument: nächste Fuge und Zahl der Überfahrten',
      args: '[stärke]',
      run: ([s]) => {
        if (s !== undefined) {
          this.onClick?.(parseNum(s, 'Stärke', 0, 1));
          return 'Klack';
        }
        return `${this.joints.length} Dehnfugen, ${this.crossings} Überfahrten`;
      },
    });
  }
}
