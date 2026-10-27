// Speed-camera challenge (2026-10-25): the mapped Blitzer columns (sights.json from pipeline/lib/sights.ts)
// measure the car as it passes. Every pass flashes; a new personal best pays by how far it beats the old one,
// a first pass over the limit pays by how far over it was. Bests live in the save's stats ("blitzer:<id>").

export interface SpeedCamera { id: string; x: number; y: number; z: number; limit: number; street: string; dx: number; dz: number }

/** Passing within this distance (m) of the column counts. */
const RANGE = 14;

export interface CameraPass { camera: SpeedCamera; kmh: number; best: number; record: boolean; over: number }

export class SpeedCameras {
  list: SpeedCamera[] = [];
  /** Best km/h per camera id. */
  best = new Map<string, number>();
  onPass?: (p: CameraPass) => void;
  /** Signed distance along each camera's road from the last frame, to see the car cross its line. */
  private side = new Map<string, number>();

  /** The camera line is crossed when the car's position along the road changes sign close to the column. */
  update(x: number, z: number, speedMs: number) {
    for (const c of this.list) {
      const ox = x - c.x, oz = z - c.z;
      if (Math.abs(ox) > 60 || Math.abs(oz) > 60) { this.side.delete(c.id); continue; }
      const along = ox * c.dx + oz * c.dz, across = Math.abs(-ox * c.dz + oz * c.dx);
      const before = this.side.get(c.id);
      this.side.set(c.id, along);
      if (before === undefined || Math.sign(before) === Math.sign(along) || across > RANGE) continue;
      const kmh = Math.round(speedMs * 3.6);
      if (kmh < 10) continue;
      const old = this.best.get(c.id) ?? 0;
      const record = kmh > old;
      if (record) this.best.set(c.id, kmh);
      this.onPass?.({ camera: c, kmh, best: Math.max(old, kmh), record: record && old > 0, over: Math.max(0, kmh - c.limit) });
    }
  }

  /** Reward for a pass: new record by the margin, a first pass by the amount over the limit. */
  static reward(p: CameraPass, previous: number): { xp: number; credits: number } {
    if (previous > 0 && p.kmh <= previous) return { xp: 0, credits: 0 };
    const gain = previous > 0 ? p.kmh - previous : p.over;
    return { xp: Math.min(400, gain * 4), credits: Math.min(1500, gain * 15) };
  }

  nearest(x: number, z: number) {
    let best: SpeedCamera | undefined, bd = Infinity;
    for (const c of this.list) { const d = Math.hypot(c.x - x, c.z - z); if (d < bd) { bd = d; best = c; } }
    return best;
  }
}

/** White camera flash over the screen. */
export function flashScreen() {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0.85;pointer-events:none;z-index:50;transition:opacity 0.45s ease-out';
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = '0'; }));
  setTimeout(() => el.remove(), 600);
}
