import type { Channel, Recorder } from '../replay/recorder.ts';

// Live graphs from the recorder for tuning the physics: speed and revs, pedals and steering,
// tyre slip, spring travel and g-forces. Follows the replay time while a replay runs.

interface Line { c: Channel; color: string; scale?: number }
interface Panel { title: string; min: number; max: number; lines: Line[] }

const WHEEL_COLORS = ['#ff6b6b', '#ffd166', '#4dd2ff', '#8ce99a'];
const PANELS: Panel[] = [
  { title: 'km/h · 1000/min', min: 0, max: 300, lines: [{ c: 'speed', color: '#fff', scale: 3.6 }, { c: 'rpm', color: '#ff9f43', scale: 0.0333 }] },
  { title: 'Gas · Bremse · Lenkung', min: -1, max: 1, lines: [{ c: 'throttle', color: '#2ecc71' }, { c: 'brake', color: '#ff4d4d' }, { c: 'steer', color: '#4dd2ff', scale: 1 / 0.6 }] },
  { title: 'Schlupf VL VR HL HR', min: 0, max: 1, lines: [0, 1, 2, 3].map((i) => ({ c: `slip${i}` as Channel, color: WHEEL_COLORS[i] })) },
  { title: 'Federweg (mm)', min: 0, max: 180, lines: [0, 1, 2, 3].map((i) => ({ c: `comp${i}` as Channel, color: WHEEL_COLORS[i], scale: 1000 })) },
  { title: 'g quer · längs', min: -1.6, max: 1.6, lines: [{ c: 'latG', color: '#c78bff' }, { c: 'longG', color: '#ffd166' }] },
];

export class Telemetry {
  readonly canvas = document.createElement('canvas');
  window = 10;
  private ctx: CanvasRenderingContext2D;
  private rec: Recorder;
  private timer = 0;

  constructor(rec: Recorder) {
    this.rec = rec;
    const c = this.canvas;
    c.width = 380;
    c.height = PANELS.length * 62 + 8;
    c.hidden = true;
    c.style.cssText = 'position:fixed;right:12px;top:12px;z-index:30;background:#000c;border-radius:6px;pointer-events:none';
    document.body.append(c);
    this.ctx = c.getContext('2d')!;
  }

  get visible() { return !this.canvas.hidden; }
  set visible(v: boolean) { this.canvas.hidden = !v; }

  /** now: the time the right edge shows (live: newest sample; replay: playback time). */
  update(dt: number, now?: number) {
    if (this.canvas.hidden || (this.timer -= dt) > 0) return;
    this.timer = 0.05;
    const g = this.ctx;
    const r = this.rec;
    const W = this.canvas.width;
    g.clearRect(0, 0, W, this.canvas.height);
    const end = now ?? r.lastTime;
    const start = end - this.window;
    // Rows inside the window.
    let first = 0;
    while (first < r.length && r.value(first, 't') < start) first++;
    PANELS.forEach((p, n) => {
      const y0 = 8 + n * 62, h = 50, x0 = 8, w = W - 16;
      g.fillStyle = '#ffffff14';
      g.fillRect(x0, y0, w, h);
      g.fillStyle = '#ffffffb0';
      g.font = '11px system-ui, sans-serif';
      g.fillText(p.title, x0 + 4, y0 + 12);
      if (p.min < 0) {
        g.fillStyle = '#ffffff30';
        g.fillRect(x0, y0 + h * (p.max / (p.max - p.min)), w, 1);
      }
      for (const l of p.lines) {
        g.strokeStyle = l.color;
        g.lineWidth = 1.4;
        g.beginPath();
        let moved = false;
        for (let i = first; i < r.length; i++) {
          const t = r.value(i, 't');
          if (t > end) break;
          const v = r.value(i, l.c) * (l.scale ?? 1);
          const x = x0 + ((t - start) / this.window) * w;
          const y = y0 + h - ((Math.min(p.max, Math.max(p.min, v)) - p.min) / (p.max - p.min)) * h;
          if (moved) g.lineTo(x, y); else { g.moveTo(x, y); moved = true; }
        }
        g.stroke();
      }
    });
  }
}
