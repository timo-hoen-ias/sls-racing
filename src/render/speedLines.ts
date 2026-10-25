import { registerToggle, registerValue } from '../debug/registry.ts';

// Speed lines: thin white streaks rushing from the vanishing point to the screen edges, from about
// 140 km/h and stronger under nitro. A 2D canvas over the game canvas, so they cost almost nothing.

interface Streak { a: number; r: number; v: number; len: number; w: number }

export class SpeedLines {
  enabled = true;
  /** Speed (km/h) where the lines start, and how strong they get (fx.speedlines.*). */
  from = 140;
  strength = 1;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private streaks: Streak[] = [];
  private level = 0;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'speedlines';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    for (let i = 0; i < 90; i++) this.streaks.push(this.spawn(Math.random()));
  }

  private spawn(r = 0.25): Streak {
    return { a: Math.random() * Math.PI * 2, r, v: 0.6 + Math.random() * 0.9, len: 0.05 + Math.random() * 0.12, w: 0.6 + Math.random() * 1.6 };
  }

  update(dt: number, kmh: number, boost: number) {
    const target = this.enabled ? Math.min(1, Math.max(0, (kmh - this.from) / 140) + boost * 0.6) * this.strength : 0;
    this.level += (target - this.level) * (1 - Math.exp(-dt * 4));
    const c = this.canvas;
    const w = innerWidth, h = innerHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = this.ctx;
    g.clearRect(0, 0, w, h);
    if (this.level < 0.02) return;
    const cx = w / 2, cy = h * 0.42;
    const R = Math.hypot(w, h) * 0.6;
    g.lineCap = 'round';
    for (const s of this.streaks) {
      s.r += s.v * dt * (0.8 + this.level * 1.6);
      if (s.r > 1) Object.assign(s, this.spawn());
      // Only the outer part of the screen: the road ahead stays clear.
      if (s.r < 0.32) continue;
      const r0 = s.r * R, r1 = (s.r + s.len * (0.5 + this.level)) * R;
      const ca = Math.cos(s.a), sa = Math.sin(s.a);
      const alpha = Math.min(1, (s.r - 0.32) * 3) * this.level * 0.35;
      g.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      g.lineWidth = s.w;
      g.beginPath();
      g.moveTo(cx + ca * r0, cy + sa * r0 * 0.75);
      g.lineTo(cx + ca * r1, cy + sa * r1 * 0.75);
      g.stroke();
    }
  }

  registerCommands() {
    registerToggle('fx.speedlines', 'Tempo-Linien am Bildrand ab hohem Tempo und bei Nitro', () => this.enabled, (v) => { this.enabled = v; });
    registerValue('fx.speedlines.from', 'Ab diesem Tempo (km/h) erscheinen die Tempo-Linien', () => this.from, (v) => { this.from = v; }, [0, 400]);
    registerValue('fx.speedlines.strength', 'Stärke der Tempo-Linien 0..2', () => this.strength, (v) => { this.strength = v; }, [0, 2]);
  }
}
