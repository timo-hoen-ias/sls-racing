// Church bells (2026-10-25): the churches from sights.json strike the full hour of the game clock (1–12
// strokes). Each stroke is synthesised from the inharmonic partials of a church bell (hum, prime, tierce,
// quint, nominal …), its level and low-pass falling with the distance.

export interface BellTower { x: number; y: number; z: number; name: string; big: boolean }

/** Bells are heard up to this distance (m). */
export const BELL_RANGE = 900;
/** Seconds between strokes. */
const STROKE = 2.4;
/** Partials of a tuned bell relative to the nominal's octave below (hum 0.5 … ), with their levels and decays (s). */
const PARTIALS: [number, number, number][] = [[0.5, 0.5, 9], [1, 0.8, 6], [1.2, 0.5, 4], [1.5, 0.35, 3], [2, 0.7, 3.5], [2.5, 0.25, 2], [3, 0.2, 1.6], [4.2, 0.12, 1]];

/** Strokes for a game-clock hour (0..24): 1 to 12. */
export const strokesFor = (hour: number) => ((Math.round(hour) + 11) % 12) + 1;

export class ChurchBells {
  towers: BellTower[] = [];
  enabled = true;
  private ctx: AudioContext;
  private out: GainNode;
  private lastHour = -1;
  private queue: { at: number; tower: BellTower; gain: number }[] = [];

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.5;
    this.out.connect(destination);
  }

  /** Call every frame with the game clock (hours) and the listener's position. */
  update(hours: number, x: number, z: number) {
    const hour = Math.floor(hours);
    const minute = (hours - hour) * 60;
    if (this.lastHour < 0) this.lastHour = hour;
    if (hour !== this.lastHour && minute < 2) {
      this.lastHour = hour;
      if (this.enabled) this.ring(strokesFor(hour), x, z);
    } else if (hour !== this.lastHour) this.lastHour = hour;
    const now = this.ctx.currentTime;
    while (this.queue.length && this.queue[0].at <= now + 0.05) {
      const q = this.queue.shift()!;
      this.strike(q.tower, q.gain, Math.max(now, q.at));
    }
  }

  /** Strokes from every tower in range, each a little out of step with the others. */
  ring(strokes: number, x: number, z: number) {
    const now = this.ctx.currentTime;
    this.towers.forEach((t, i) => {
      const d = Math.hypot(t.x - x, t.z - z);
      if (d > BELL_RANGE) return;
      const gain = Math.min(1, 60 / Math.max(60, d)) * (t.big ? 1 : 0.6);
      // Sound travels: 343 m/s, plus a fixed offset per tower.
      const start = now + 0.2 + d / 343 + (i % 5) * 0.37;
      for (let k = 0; k < strokes; k++) this.queue.push({ at: start + k * STROKE, tower: t, gain });
    });
    this.queue.sort((a, b) => a.at - b.at);
  }

  private strike(t: BellTower, gain: number, at: number) {
    const ctx = this.ctx;
    // Big church bells around 200 Hz nominal, chapel bells higher.
    const f = (t.big ? 196 : 330) * (1 + ((t.x * 7 + t.z * 3) % 7) * 0.01);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900 + 5000 * gain;
    lp.connect(this.out);
    for (const [ratio, level, decay] of PARTIALS) {
      const o = ctx.createOscillator();
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(level * gain * 0.18, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      o.connect(g).connect(lp);
      o.start(at);
      o.stop(at + decay + 0.05);
      o.onended = () => g.disconnect();
    }
    setTimeout(() => lp.disconnect(), 10000);
  }
}
