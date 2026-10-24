// Reverb that follows the surroundings: three impulse responses (open road, street canyon, underpass/tunnel)
// crossfaded by how enclosed the car is, plus a stereo slap-back echo from the nearest wall on each side.
// The game measures the surroundings with raycasts (see reverbProbe.ts) and calls set() a few times a second.

export interface Surroundings {
  /** Distance to the nearest wall on the left and right (m), Infinity when nothing is there. */
  left: number;
  right: number;
  /** Clearance above the car (m), Infinity under open sky. */
  up: number;
}

export interface ReverbMix {
  open: number;
  street: number;
  tunnel: number;
  /** Overall wet level. */
  wet: number;
  /** Slap-back delays (ms) and levels per side. */
  slapL: number;
  slapR: number;
  slapGainL: number;
  slapGainR: number;
}

const SPEED_OF_SOUND = 343;
/** Walls further away than this do not count. */
export const WALL_RANGE = 40;

/** Pure mapping from measured surroundings to the reverb mix, so it can be tested and printed. */
export function reverbMix(s: Surroundings): ReverbMix {
  const wall = (d: number) => Math.min(1, Math.max(0, (WALL_RANGE - d) / (WALL_RANGE - 4)));
  const wl = wall(s.left), wr = wall(s.right);
  const enclosure = (wl + wr) / 2;
  const covered = s.up < 14 ? Math.min(1, (14 - s.up) / 6) : 0;
  const tunnel = covered * Math.max(0.5, enclosure);
  const street = (1 - tunnel) * enclosure;
  const open = Math.max(0, 1 - tunnel - street);
  const slap = (d: number) => (Number.isFinite(d) ? Math.min(250, (2 * d * 1000) / SPEED_OF_SOUND) : 0);
  return {
    open, street, tunnel,
    wet: 0.1 + 0.22 * enclosure + 0.3 * tunnel,
    slapL: slap(s.left), slapR: slap(s.right),
    slapGainL: 0.32 * wl * wl, slapGainR: 0.32 * wr * wr,
  };
}

export class EnvReverb {
  /** 'auto' follows the surroundings, 'off' is dry, a number is a fixed street reverb level 0..1. */
  mode: 'auto' | 'off' | number = 'auto';
  last: ReverbMix = reverbMix({ left: Infinity, right: Infinity, up: Infinity });
  private ctx: AudioContext;
  private wet: GainNode;
  private beds: { open: GainNode; street: GainNode; tunnel: GainNode };
  private slap: { delay: DelayNode; gain: GainNode }[] = [];

  constructor(ctx: AudioContext, input: AudioNode, output: AudioNode) {
    this.ctx = ctx;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.15;
    this.wet.connect(output);
    const bed = (ir: AudioBuffer, level: number) => {
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const g = ctx.createGain();
      g.gain.value = level;
      input.connect(conv).connect(g).connect(this.wet);
      return g;
    };
    this.beds = {
      open: bed(impulse(ctx, { length: 0.5, decay: 9, early: [[17, 0.25], [41, 0.12]], dark: 0.35 }), 1),
      street: bed(impulse(ctx, { length: 1.3, decay: 4.2, early: [[11, 0.5], [23, 0.35], [37, 0.3], [58, 0.22], [83, 0.15]], dark: 0.5 }), 0),
      tunnel: bed(impulse(ctx, { length: 2.6, decay: 1.9, early: [[7, 0.6], [15, 0.5], [26, 0.45], [33, 0.4], [47, 0.35], [61, 0.3]], dark: 0.65 }), 0),
    };
    // Slap-back: a darker single echo per side, panned to that side.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    input.connect(lp);
    for (const pan of [-1, 1]) {
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.05;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const p = ctx.createStereoPanner();
      p.pan.value = pan * 0.8;
      lp.connect(delay).connect(gain).connect(p).connect(output);
      this.slap.push({ delay, gain });
    }
  }

  /** Updates the mix from fresh measurements. */
  set(s: Surroundings) {
    const t = this.ctx.currentTime;
    let m = reverbMix(s);
    if (this.mode === 'off') m = { ...m, wet: 0, slapGainL: 0, slapGainR: 0 };
    else if (typeof this.mode === 'number') m = { ...m, open: 0, street: 1, tunnel: 0, wet: 0.45 * this.mode, slapGainL: 0, slapGainR: 0 };
    this.last = m;
    const tau = 0.25;
    this.wet.gain.setTargetAtTime(m.wet, t, tau);
    this.beds.open.gain.setTargetAtTime(m.open, t, tau);
    this.beds.street.gain.setTargetAtTime(m.street, t, tau);
    this.beds.tunnel.gain.setTargetAtTime(m.tunnel, t, tau);
    const [l, r] = this.slap;
    if (m.slapL) l.delay.delayTime.setTargetAtTime(m.slapL / 1000, t, 0.08);
    if (m.slapR) r.delay.delayTime.setTargetAtTime(m.slapR / 1000, t, 0.08);
    l.gain.gain.setTargetAtTime(m.slapGainL, t, 0.12);
    r.gain.gain.setTargetAtTime(m.slapGainR, t, 0.12);
  }
}

/** Procedural impulse response: early reflections and a diffuse tail that gets darker as it decays. */
function impulse(ctx: AudioContext, o: { length: number; decay: number; early: [number, number][]; dark: number }) {
  const len = Math.floor(ctx.sampleRate * o.length);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const a = o.dark * Math.exp(-t * 3) + 0.06;
      lp += a * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * o.decay) * 0.6;
    }
    for (const [ms, g] of o.early) {
      const i = Math.floor(((ms + ch * 3.7) / 1000) * ctx.sampleRate);
      if (i < len) d[i] += g * (ch ? -1 : 1);
    }
  }
  return b;
}
