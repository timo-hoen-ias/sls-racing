// Records the last seconds of driving into a ring buffer: pose for the replay and the channels
// for the telemetry graphs. One row per rendered frame (capped at RATE), interpolated on read.

/** Channels of one row, in order. */
export const CHANNELS = [
  't',
  'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw',
  'speed', 'rpm', 'gear', 'load', 'throttle', 'brake', 'steer',
  'slip0', 'slip1', 'slip2', 'slip3',
  'comp0', 'comp1', 'comp2', 'comp3',
  'latG', 'longG', 'boost', 'nitro', 'wheelRot',
] as const;
export type Channel = (typeof CHANNELS)[number];
export type Sample = Record<Channel, number>;

const W = CHANNELS.length;
const COL = Object.fromEntries(CHANNELS.map((c, i) => [c, i])) as Record<Channel, number>;
/** Rows per second at most. */
const RATE = 60;

export class Recorder {
  readonly seconds: number;
  private data: Float32Array;
  private cap: number;
  private start = 0;
  private count = 0;
  private lastT = -Infinity;
  /** Paused while a replay runs. */
  enabled = true;

  constructor(seconds = 30) {
    this.seconds = seconds;
    this.cap = seconds * RATE + 1;
    this.data = new Float32Array(this.cap * W);
  }

  get length() { return this.count; }
  get firstTime() { return this.count ? this.data[this.start * W] : 0; }
  get lastTime() { return this.count ? this.data[((this.start + this.count - 1) % this.cap) * W] : 0; }
  get duration() { return this.lastTime - this.firstTime; }

  clear() {
    this.start = 0;
    this.count = 0;
    this.lastT = -Infinity;
  }

  push(s: Sample) {
    if (!this.enabled || s.t - this.lastT < 1 / RATE - 1e-4) return;
    this.lastT = s.t;
    let row: number;
    if (this.count < this.cap) row = (this.start + this.count++) % this.cap;
    else { row = this.start; this.start = (this.start + 1) % this.cap; }
    const o = row * W;
    for (let i = 0; i < W; i++) this.data[o + i] = s[CHANNELS[i]];
    // Keep only the last `seconds`, whatever the frame rate.
    while (this.count > 2 && s.t - this.data[this.start * W] > this.seconds) {
      this.start = (this.start + 1) % this.cap;
      this.count--;
    }
  }

  /** Raw value of row i (0 = oldest). */
  value(i: number, c: Channel) {
    return this.data[((this.start + i) % this.cap) * W + COL[c]];
  }

  /** Interpolated sample at time t (clamped to the recording); the quaternion is nlerped. */
  at(t: number, out: Sample = {} as Sample): Sample {
    if (!this.count) { for (const c of CHANNELS) out[c] = 0; out.qw = 1; return out; }
    // Binary search for the last row with time ≤ t.
    let lo = 0, hi = this.count - 1;
    if (t <= this.value(0, 't')) hi = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.value(mid, 't') <= t) lo = mid; else hi = mid - 1;
    }
    const i = lo, j = Math.min(i + 1, this.count - 1);
    const t0 = this.value(i, 't'), t1 = this.value(j, 't');
    const k = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    for (const c of CHANNELS) {
      const a = this.value(i, c), b = this.value(j, c);
      out[c] = c === 'gear' ? (k < 0.5 ? a : b) : a + (b - a) * k;
    }
    // Shortest-path quaternion blend.
    const qa = [this.value(i, 'qx'), this.value(i, 'qy'), this.value(i, 'qz'), this.value(i, 'qw')];
    let qb = [this.value(j, 'qx'), this.value(j, 'qy'), this.value(j, 'qz'), this.value(j, 'qw')];
    if (qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0) qb = qb.map((v) => -v);
    const q = qa.map((v, n) => v + (qb[n] - v) * k);
    const l = Math.hypot(...q) || 1;
    out.qx = q[0] / l; out.qy = q[1] / l; out.qz = q[2] / l; out.qw = q[3] / l;
    return out;
  }

  /** The recording as plain JSON (for replay.save). */
  toJSON() {
    const rows: number[][] = [];
    for (let i = 0; i < this.count; i++) rows.push(CHANNELS.map((c) => +this.value(i, c).toFixed(4)));
    return { v: 1, channels: CHANNELS, rows };
  }

  /** Loads a recording made by toJSON(). */
  load(json: { channels: string[]; rows: number[][] }) {
    this.clear();
    const idx = CHANNELS.map((c) => json.channels.indexOf(c));
    for (const r of json.rows.slice(-(this.cap))) {
      const s = {} as Sample;
      CHANNELS.forEach((c, n) => (s[c] = idx[n] >= 0 ? r[idx[n]] : 0));
      const e = this.enabled;
      this.enabled = true;
      this.lastT = -Infinity;
      this.push(s);
      this.enabled = e;
    }
  }
}
